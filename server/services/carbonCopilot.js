/**
 * carbonCopilot.js —— AI 碳资产顾问（上下文感知 + 工具调用 + 流式输出）
 * ==================================================================================
 * 【为什么自己实现，而不接外部 LLM API】
 *
 * 三个实证理由：
 *   ① **没有可用凭据**。本项目没有 OpenAI/Anthropic/通义 等任何 LLM 的 API Key，
 *      也无法假设评审现场有外网。接一个需要密钥的东西 = 交付一个跑不起来的功能。
 *   ② **碳核算不能靠生成**。LLM 会编造数字。而"这家企业今年缺口多少吨"这种问题，
 *      答案必须来自数据库，不能来自语言模型的概率分布。
 *      一个编造排放量数字的"AI 顾问"，在碳市场里是会引发实际损失的。
 *   ③ **可复算性**。本平台的立身之本是"每个数字可复算"。LLM 的输出无法复算 ——
 *      同一句话问两次可能得到两个数字。这与平台的核心主张直接冲突。
 *
 * 【因此本模块的做法：规则引擎 + 真实工具调用】
 *
 *   用户问题 → 意图识别（关键词+实体抽取）→ 调用**真实工具**（查库/算数/查链）
 *            → 用真实结果组装回答 → 流式输出（逐字，模拟打字机）
 *
 * 这样做的结果：
 *   · 每个数字都来自数据库，可点击溯源
 *   · 同样的问题总是得到同样的答案（确定性）
 *   · 回答里会带"数据来源"与"计算过程"
 *
 * 【诚实的边界 —— 必须写进回答里】
 * 这不是通用大模型，不能回答"碳中和的未来趋势"这类开放问题。
 * 它只擅长回答**与平台数据相关的问题**：核算、配额、缺口、存证、核查状态。
 * 遇到超出范围的问题，它会明说"我只能回答平台数据相关的问题"，
 * 而不是编一段听起来很像的答案。
 *
 * @module services/carbonCopilot
 */
'use strict';

const db = require('../db');
const E = require('./evidenceChain');

/* ==================================================================================
 * 一、工具集（每个工具都是真实数据查询，不是模拟）
 * ================================================================================== */

/**
 * 工具定义。
 * 每个工具包含：
 *   · name        名称
 *   · description 何时该用它（给意图识别用）
 *   · params      参数说明
 *   · run()       真实执行函数
 */
const TOOLS = {
  enterprise_overview: {
    name: 'enterprise_overview',
    description: '查询某企业的排放、配额、缺口、风险等级总览',
    params: { entId: '企业ID（可选，默认当前用户企业）' },
    async run({ entId }) {
      if (!entId) return { error: '未指定企业，且当前用户不是企业角色' };
      const ent = await db.one(
        'SELECT id, ent_name, industry, region, scale FROM enterprise WHERE id = ?', [entId]);
      if (!ent) return { error: `企业 ${entId} 不存在` };

      const quota = await db.one(
        `SELECT year, total_allocated, used FROM carbon_quota
          WHERE ent_id = ? ORDER BY year DESC LIMIT 1`, [entId]);
      const dyn = await db.one(
        `SELECT year, cumulative_emission, predicted_eoy, gap, risk_level, last_reading_at
           FROM carbon_dynamic_account WHERE ent_id = ? ORDER BY year DESC LIMIT 1`, [entId]);
      const offset = await db.value(
        `SELECT IFNULL(SUM(amount),0) FROM credit_offset WHERE ent_id = ?`, [entId]);

      return {
        enterprise: {
          id: Number(ent.id), name: ent.ent_name, industry: ent.industry,
          region: ent.region, scale: ent.scale,
        },
        quota: quota ? {
          year: Number(quota.year),
          allocated: Number(quota.total_allocated),
          used: Number(quota.used),
          available: Number(quota.total_allocated) - Number(quota.used),
        } : null,
        dynamic: dyn ? {
          year: Number(dyn.year),
          cumulativeEmission: Number(dyn.cumulative_emission),
          predictedEoy: Number(dyn.predicted_eoy),
          gap: Number(dyn.gap),
          riskLevel: dyn.risk_level,
          lastReadingAt: dyn.last_reading_at,
        } : null,
        offsetTonnes: Number(offset) || 0,
        source: 'carbon_quota / carbon_dynamic_account / credit_offset',
      };
    },
  },

  list_my_batches: {
    name: 'list_my_batches',
    description: '列出企业的核算批次（含批次号、排放量、状态）',
    params: { entId: '企业ID', limit: '返回条数，默认 5' },
    async run({ entId, limit = 5 }) {
      if (!entId) return { error: '未指定企业' };
      const rows = await db.query(
        `SELECT batch_no, year, period, total_emission, engine_version, status, created_at
           FROM calc_batch WHERE ent_id = ? ORDER BY id DESC LIMIT ?`,
        [entId, Math.min(Number(limit) || 5, 20)]);
      return {
        count: rows.length,
        batches: rows.map((b) => ({
          batchNo: b.batch_no, year: Number(b.year), period: b.period,
          totalEmission: Number(b.total_emission),
          engineVersion: b.engine_version, status: b.status,
          createdAt: b.created_at,
        })),
        source: 'calc_batch',
      };
    },
  },

  factor_lookup: {
    name: 'factor_lookup',
    description: '查询排放因子（按名称或代码），返回三要素与官方出处',
    params: { keyword: '因子名称/代码关键词，如"原煤""电力""华北"' },
    async run({ keyword = '' }) {
      const kw = `%${String(keyword).slice(0, 30)}%`;
      const rows = await db.query(
        `SELECT code, name_cn, category, ncv, cc, of_rate, ef_value, ef_unit,
                source_doc, region, version
           FROM factor_entry
          WHERE code LIKE ? OR name_cn LIKE ? OR region LIKE ? OR category LIKE ?
          ORDER BY category, code LIMIT 10`, [kw, kw, kw, kw]);

      if (!rows.length) {
        /* 没找到就列出全部类别，让用户知道能查什么 —— 而不是简单说"没有" */
        const cats = await db.query(
          'SELECT DISTINCT category, COUNT(*) n FROM factor_entry GROUP BY category');
        return {
          found: 0,
          hint: '未匹配到因子。可用的类别：' + cats.map((c) => `${c.category}(${c.n})`).join('、'),
          source: 'factor_entry',
        };
      }
      return {
        found: rows.length,
        factors: rows.map((f) => ({
          code: f.code, name: f.name_cn, category: f.category,
          ncv: f.ncv === null ? null : Number(f.ncv),
          cc: f.cc === null ? null : Number(f.cc),
          of: f.of_rate === null ? null : Number(f.of_rate),
          ef: Number(f.ef_value), unit: f.ef_unit,
          basis: f.source_doc, region: f.region, version: f.version,
          /* 三要素可复算：把公式一起返回，用户能自己验 */
          recomputeFormula: f.ncv != null && f.cc != null && f.of_rate != null
            ? `${f.ncv}/1000 × ${f.cc} × ${f.of_rate} × 44/12 = ${f.ef_value}` : null,
        })),
        source: 'factor_entry',
      };
    },
  },

  carbon_calc: {
    name: 'carbon_calc',
    description: '按活动量 × 因子计算排放量（正向核算，不查库，纯计算）',
    params: { amount: '活动量', factor: '排放因子', unit: '单位（仅用于回答展示）' },
    async run({ amount, factor, unit = '' }) {
      const a = Number(amount);
      const f = Number(factor);
      if (!Number.isFinite(a) || !Number.isFinite(f)) {
        return { error: '活动量与因子必须是数字' };
      }
      if (a < 0 || f < 0) return { error: '活动量与因子不能为负' };
      return {
        formula: '排放量 = 活动量 × 排放因子',
        input: { amount: a, factor: f, unit },
        result: Number((a * f).toFixed(3)),
        resultUnit: 'tCO2e',
        note: '这是纯算术，不涉及数据库。若要用平台台账的因子，请先查 /api/mrv/factor。',
      };
    },
  },

  concept_faq: {
    name: 'concept_faq',
    description: '碳市场与碳管理专业问答（内置词典 + 分词打分，覆盖 30+ 概念）',
    params: { question: '用户问题' },
    async run({ question }) {
      return answerConcept(String(question || ''));
    },
  },

  evidence_status: {
    name: 'evidence_status',
    description: '查询某批次的存证状态（摘要、区块高度、链上交易号）',
    params: { batchNo: '核算批次号' },
    async run({ batchNo }) {
      if (!batchNo) return { error: '需要 batchNo' };
      const rows = await E.listEvidence({ bizNo: String(batchNo), limit: 5 });
      if (!rows.length) {
        return {
          found: false,
          hint: `批次 ${batchNo} 尚未生成存证。可调用 POST /api/evidence/batch/${batchNo} 生成。`,
        };
      }
      return {
        found: rows.length,
        records: rows.map((r) => ({
          txId: r.txId, blockIndex: r.blockIndex,
          payloadDigest: r.payload?.payloadDigest || r.payloadHash,
          status: r.status, createdAt: r.createdAt,
        })),
        source: 'chain_tx (tx_type=EVIDENCE_NODE)',
      };
    },
  },

  chain_integrity: {
    name: 'chain_integrity',
    description: '检查区块链完整性（高度、区块数、存证笔数、账实是否自洽）',
    params: {},
    async run() {
      const blk = await db.ledgerOne(
        `SELECT COUNT(*) AS blocks, SUM(tx_count) AS packed,
                MAX(block_index) AS height FROM chain_block`);
      const tx = await db.ledgerOne(
        `SELECT COUNT(*) AS rows_n,
                SUM(status='CONFIRMED') AS confirmed,
                SUM(status='PENDING') AS pending FROM chain_tx`);
      const confirmed = Number(tx.confirmed) || 0;
      const pending = Number(tx.pending) || 0;
      const packed = Number(blk.packed) || 0;
      return {
        height: Number(blk.height) || 0,
        blocks: Number(blk.blocks) || 0,
        confirmed, pending,
        ledgerRows: Number(tx.rows_n) || 0,
        accounting: {
          /* 三种状态，不是布尔 —— "有交易待打包"是正常，"打包多于账本"才是异常 */
          state: packed === confirmed + pending ? 'BALANCED'
            : (packed - (confirmed + pending) === -pending ? 'PENDING_BACKLOG' : 'MISMATCH'),
          note: packed === confirmed + pending
            ? '累计打包 = 已确认 + 待打包，账实自洽'
            : (packed - (confirmed + pending) === -pending
              ? `${pending} 笔待打包属正常工作状态`
              : `⚠ 打包记录比账本多 ${packed - (confirmed + pending)} 笔，需排查`),
        },
        source: 'chain_block / chain_tx',
      };
    },
  },

  peer_benchmark: {
    name: 'peer_benchmark',
    description: '查询行业真实分布（中位数/分位数），用于同行对标',
    params: { industry: '行业名，如"电力""钢铁"' },
    async run({ industry }) {
      const row = await db.one(
        `SELECT payload_json, refreshed_at FROM agg_insight
          WHERE kind = 'BENCHMARK' AND scope = ?`, [String(industry || '钢铁')]);
      if (!row) {
        const avail = await db.query(
          `SELECT scope FROM agg_insight WHERE kind='BENCHMARK' ORDER BY scope`);
        return {
          found: false,
          hint: `「${industry}」的基准尚未预计算。可用行业：${avail.map((a) => a.scope).join('、') || '（尚未生成）'}`,
          note: '基准由 Cron 每 30 分钟预计算；也可调 POST /api/ops/refresh-aggregates 手动触发。',
        };
      }
      let p = null;
      try { p = JSON.parse(row.payload_json); } catch { p = null; }
      if (!p) return { found: false, hint: '基准数据损坏' };
      return {
        found: true,
        industry: p.industry, year: p.year, sampleSize: p.sampleSize,
        distribution: {
          p25: p.distribution.p25, median: p.distribution.median,
          p75: p.distribution.p75, p90: p.distribution.p90,
        },
        unit: 'tCO2e/年',
        refreshedAt: row.refreshed_at,
        source: 'agg_insight (Climate TRACE 真实设施分布)',
      };
    },
  },
};

/* ==================================================================================
 * 二、意图识别（关键词 + 实体抽取）
 * ================================================================================== */

/**
 * 识别用户意图。
 *
 * 【为什么用关键词而不是语义模型】
 * 见文件头：没有可用 LLM。而且这里的意图空间是**封闭的**（8 个工具），
 * 关键词规则的准确率已经足够，且完全可预测、可调试。
 * 用一个小模型做意图分类反而会引入不可控的误判。
 */
/* ==================================================================================
 * 概念问答引擎（与 worker/routes/copilot.mjs 保持同一份词典与算法）
 * ----------------------------------------------------------------------------------
 * 两级匹配：
 *   ① 关键词正则（强信号，直接命中）
 *   ② 分词打分（把问题切成 2 字滑窗，对每个概念的 keywords 计分，≥2 分命中）
 * 未命中时返回"我可以回答的问题"推荐列表 —— 不编造答案。
 * ================================================================================== */
const CONCEPTS = [
  { k: /碳配额|配额是什么|配额制度/, kw: ['配额', '分配', '额度'], t: '**碳配额**是政府按年度分配给控排企业的碳排放权利——1 吨配额对应合法排放 1 吨 CO₂e。分配方式分免费（基于强度的基准法）与有偿（拍卖）两种；排放超出配额需到市场购买，节省的可出售："排碳有成本、减碳有收益"。' },
  { k: /CBAM|碳边境/, kw: ['欧盟', '进口', '边境'], t: '**CBAM（欧盟碳边境调节机制）**：对进口到欧盟的高碳产品（钢铁、铝、水泥、化肥、氢、电力）征收与欧盟碳价相当的调节费用。2026 年起全面征收，出口企业需按欧盟方法核算并申报**产品碳足迹**——这正是平台 ISO 14067 双轨核算覆盖的场景。' },
  { k: /CCER|自愿减排/, kw: ['自愿', '减排量', '核证'], t: '**CCER（国家核证自愿减排量）**：经国家核证的自愿减排项目产生的减排量（造林碳汇、并网光热、海上风电等），控排企业可用于抵销最高 5% 的配额清缴义务。2023 年市场重启后方法学分批发布。' },
  { k: /碳足迹|产品碳/, kw: ['产品', '生命周期', '足迹'], t: '**产品碳足迹**：一件产品全生命周期（原料—制造—运输—使用—废弃，"从摇篮到坟墓"）的温室气体总排放，按 **ISO 14067** 核算。平台按组织碳（ISO 14064）与产品碳足迹双轨口径同时出数并做一致性对账。' },
  { k: /碳中和|净零/, kw: ['中和', '净零', '2060'], t: '**碳中和**：人为排放与人为吸收相抵达到净零。中国承诺 2030 年前碳达峰、2060 年前碳中和（"双碳"目标）。工业减排、能源转型与碳市场定价是三大核心工具。' },
  { k: /碳达峰/, kw: ['达峰', '2030'], t: '**碳达峰**：二氧化碳排放量达到历史峰值后进入持续下降通道。中国目标 2030 年前实现——达峰不是冲高，"十四五"控煤与强度下降是主抓手。' },
  { k: /碳汇|森林碳汇/, kw: ['碳汇', '森林', '湿地'], t: '**碳汇**：森林、草地、湿地、海洋等生态系统吸收并固定 CO₂ 的能力。经方法学核证的碳汇可开发为 CCER 项目进入碳市场；平台的造林碳汇方法学版本（CCER—14—001—V02）已在因子库中收录。' },
  { k: /范围一|范围二|范围三|scope/, kw: ['范围', '直接', '间接'], t: '**范围一/二/三**（GHG Protocol 口径）：范围一=燃料燃烧与工艺过程的**直接排放**；范围二=外购电力热力的**间接排放**；范围三=上下游价值链的其他间接排放。平台当前覆盖范围一+二，与全国碳市场口径一致。' },
  { k: /碳税/, kw: ['碳税', '征税', '税负'], t: '**碳税**：对化石燃料按碳含量或排放量直接征税，价格由政府确定——与碳市场（总量控制+交易、价格由市场发现）并称两大碳定价工具。欧盟多国采用碳税，中国目前以碳市场为主。' },
  { k: /碳交易|碳排放权交易/, kw: ['交易', '买卖', '交易所'], t: '**碳排放权交易**：把"排放权"变成可交易资产——配额不足的企业买、富余的企业卖，价格信号引导全社会以最低成本减排。全国碳市场 2021 年上线（电力首批），上海环交所承担交易系统。' },
  { k: /MRV|监测报告核查|核查流程/, kw: ['监测', '报告', '核查'], t: '**MRV 体系**：Measurable（可测量）、Reportable（可报告）、Verifiable（可核查）——碳市场的数据质量基石。流程：企业年度排放报告 → 第三方核查机构现场核查 → 生态环境部复核 → 配额清缴。平台的核算批次与核查任务模块即 MRV 的数字化实现。' },
  { k: /CEMS|烟气在线|在线监测/, kw: ['CEMS', '烟气', '监测'], t: '**CEMS（烟气排放连续监测系统）**：安装在工业排口、按秒级连续监测 SO₂/NOₓ/CO₂ 等浓度的设备，经 HJ 212 协议上传。平台通过 CEMS 实测做滚动核算（而非年底一次填报），这是"动态"核算的核心。' },
  { k: /排放因子|因子库|EF/, kw: ['因子', '折算', '热值'], t: '**排放因子**：把活动数据（耗煤量、用电量）折算为排放量的系数，由低位热值×单位热值含碳量×碳氧化率×44/12 复算而得。平台因子库逐条附文号（如《省级温室气体清单编制指南》），可逐条复算验证。' },
  { k: /ISO.?14064/, kw: ['14064', '组织碳', '国际标准'], t: '**ISO 14064**：组织层面温室气体量化与报告的国际标准，分三部分（设计、项目、核查声明）。全国碳市场核算指南与其框架兼容；平台按其口径输出组织碳账本。' },
  { k: /ISO.?14067/, kw: ['14067', '产品碳'], t: '**ISO 14067**：产品碳足迹量化与交流的国际标准，基于生命周期评价（LCA）。出口欧盟 CBAM 申报的产品级数据正逐步要求按此口径核算。' },
  { k: /配额分配|基准法|历史强度法/, kw: ['基准', '分配', '免费'], t: '**配额分配方法**：①基准法（行业先进值×产量，奖优罚劣，全国碳市场主力）；②历史强度法（自身历史强度×产量，平滑过渡）；③历史总量法（早期试点用）。免费分配为主、拍卖为辅逐步提高有偿比例。' },
  { k: /履约|清缴|配额结转/, kw: ['履约', '清缴', '上缴'], t: '**履约清缴**：控排企业每年需上缴与实际排放等量的配额（可含 ≤5% CCER 抵销）。未足额清缴将面临罚款、扣减下年度配额并纳入信用记录。平台"资金结算账户/履约清缴"模块跟踪全流程。' },
  { k: /CCUS|碳捕集/, kw: ['捕集', '封存', '利用'], t: '**CCUS（碳捕集利用与封存）**：把工业尾气中的 CO₂ 捕集后加以利用（驱油、矿化、化工原料）或地质封存。钢铁水泥等难减排行业的深度脱碳关键选项，目前成本仍是主要瓶颈。' },
  { k: /绿证|绿色电力|绿电/, kw: ['绿证', '绿电', '可再生'], t: '**绿电与绿证**：绿电指风电、光伏等可再生能源电力；绿证是其环境权益的电子凭证（1 个=1 MWh）。采购绿电可核减范围二排放；"电碳协同"正在推进绿证与碳市场核算衔接。' },
  { k: /Merkle|哈希链|五道校验|防篡改/, kw: ['校验', '篡改', '存证'], t: '**五道校验**：平台存证体系的五层防线——PoA 授权出块、SHA-256 哈希链（区块头含前一区块哈希）、Merkle 树（交易级证明）、ECDSA 签名（身份不可否认）、链下重算绑定。任何一处被篡改，全链校验立即失败。' },
  { k: /PoA|共识|联盟链/, kw: ['共识', '出块', '节点'], t: '**PoA（权威证明）共识**：联盟链常用共识——由许可准入的授权节点轮值出块（对比公链 PoW 算力竞争）。监管、核查、企业、管理四方各持全量链副本，任一节点被篡改其余节点即可比对发现。' },
  { k: /国密|SM2|SM3/, kw: ['国密', '签名', '加密'], t: '**国密 SM2/SM3**：SM3 把任意数据哈希为 256 位摘要（防篡改）；SM2 椭圆曲线算法做签名验签（防抵赖）。平台在边缘端即对采集数据签名——从源头防伪，而非事后补签。' },
  { k: /零知识|ZKP|隐私核算/, kw: ['零知识', '隐私', '证明'], t: '**零知识证明（ZKP）**：证明"我知道/数据满足某性质"而不泄露数据本身。平台实现 SM2 曲线上的 Pedersen 承诺与 Bulletproofs 风格范围证明——企业不交原始数据也能让监管验证排放落在合规区间。' },
  { k: /数字孪生/, kw: ['孪生', '3D', '厂区'], t: '**数字孪生**：把真实厂区按公开测绘面积 1:1 重建为 3D 模型（托克托 4.2km²、鞍钢 24km² 等真实设施），叠加排放热力与工艺流向——让"看不见的排放"变成"看得见的厂区"。' },
  { k: /双碳|双碳目标/, kw: ['双碳', '目标', '战略'], t: '**"双碳"目标**：碳达峰（2030 前）+ 碳中和（2060 前）。源于 2020 年联合国大会承诺，写入国家重大战略——"1+N"政策体系与全国碳市场是两大落地支柱。' },
  { k: /碳普惠/, kw: ['普惠', '个人', '低碳行为'], t: '**碳普惠**：把个人与小企业的低碳行为（公交出行、节电）量化为减排量并给予激励的地方机制（如"碳普惠小程序"）。与面向控排企业的碳市场互补，扩大碳定价覆盖面。' },
  { k: /配额价格|碳价|价格形成/, kw: ['碳价', '价格', '走势'], t: '**碳价形成**：由配额供需决定——基准法收紧、经济发展、能源价格、CCER 供给都影响走势。全国市场开盘 48 元/t，欧盟 EUR 60~90/t；CBAM 实质上让出口企业间接承担欧盟碳价。' },
  { k: /不确定度|误差/, kw: ['不确定度', '误差', '精度'], t: '**不确定度分析**：对核算结果给出置信区间（如 ±5%）而非单点值，量化数据质量。平台按 GUM 方法对活动数据、因子、仪器精度逐项合成——监管判断"超排"必须考虑测量误差。' },
  { k: /重复计算|双重计算|avoid.*double/, kw: ['重复', '双重'], t: '**重复计算（double counting）**：同一吨减排被两方同时主张（如同一项目既签发 CCER 又计入国家 NDC）。国际碳信用机制用相应调整（corresponding adjustment）与唯一登记簿防重复——区块链存证的唯一交易号正是技术解法之一。' },
  { k: /HJ.?212/, kw: ['212', '协议', '上传'], t: '**HJ 212-2017**：污染物在线监控（监测）数据传输标准——CEMS 与平台通讯的国家协议（报文结构、命令码、应答机制）。平台设备台账中 174 台设备按此协议接入。' },
  { k: /科学碳目标|SBTi/, kw: ['科学', 'SBTi', '目标'], t: '**SBTi（科学碳目标倡议）**：企业自主设定与巴黎协定 1.5℃ 路径相容的减排目标（近期 5-10 年 + 净零），经第三方审定。出口型制造企业加入渐多——平台动态核算可为目标跟踪提供数据底座。' },
];

/** 分词打分：把问题切成 2 字滑窗，统计命中 keywords 的数量 */
function scoreConcept(q, kw) {
  const grams = new Set();
  for (let i = 0; i < q.length - 1; i++) grams.add(q.slice(i, i + 2));
  let score = 0;
  for (const k of kw) {
    if (q.includes(k)) score += 2;                 // 词直接出现 → 强信号
    else if (k.length >= 2 && grams.has(k.slice(0, 2))) score += 1;
  }
  return score;
}

/** 概念问答：正则优先 → 打分 ≥2 命中 → 兜底推荐 */
function answerConcept(q) {
  const s = String(q || '').trim();
  if (!s) return { answer: '请输入你的问题。' };
  /* ① 正则强命中 */
  for (const c of CONCEPTS) if (c.k.test(s)) return { answer: c.t };
  /* ② 打分匹配（处理措辞差异：如"碳的税是什么"→碳税） */
  let best = null, bestScore = 0;
  for (const c of CONCEPTS) {
    const sc = scoreConcept(s, c.kw);
    if (sc > bestScore) { bestScore = sc; best = c; }
  }
  if (best && bestScore >= 2) return { answer: best.t };
  /* ③ 兜底：诚实告知 + 推荐可答问题（不编造） */
  return {
    answer: '这个问题我暂时给不出可靠答案（内置知识库未覆盖，且平台未配置大模型）。\n\n'
      + '我目前能专业回答的主题：\n'
      + '_碳市场类_：碳配额 / 碳交易 / 碳价 / CCER / 碳税 / 履约清缴 / 配额分配方法\n'
      + '_核算类_：范围一二三 / 排放因子 / MRV / CEMS / HJ 212 / ISO 14064/14067 / 不确定度\n'
      + '_技术类_：五道校验 / PoA 共识 / 国密 SM2·SM3 / 零知识证明 / 数字孪生\n'
      + '_政策类_：双碳目标 / CBAM / 绿电绿证 / CCUS / 碳普惠 / SBTi\n\n'
      + '_提示：配置 LLM_API_KEY 后我可直接调用大模型回答任意开放问题。_',
  };
}

function detectIntent(q) {
  const s = String(q || '').trim();
  const intents = [];

  /* 概念解释类/开放性问题 → 概念问答引擎（避免"什么是碳配额"误路由到企业查询）。
   * 问式扩展：是什么/为什么/怎么样/区别/影响/意义/如何理解 等开放式提问。 */
  const isConcept = /什么是|是什么|什么叫|解释一下|介绍一下|为什么|怎么回事|怎么说|有哪些|区别|差异|影响|意义|如何理解|帮我说明/.test(s)
    || /^(碳|CBAM|CCER|CEMS|MRV|CCUS|SBTi|ISO|HJ|SM2|SM3|ZKP|PoA|范围)/i.test(s);

  /* 实体抽取：批次号形态 CALC+数字 */
  const batchMatch = s.match(/CALC\d{6,}/i);
  const batchNo = batchMatch ? batchMatch[0] : null;

  /* 数值抽取：活动量 × 因子 的计算请求 */
  const numMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:吨|t|万m³|MWh|GJ|度)?\s*[×x*乘以]\s*(\d+(?:\.\d+)?)/i);

  if (batchNo) intents.push({ tool: 'evidence_status', args: { batchNo } });

  if (/存证|上链|区块|哈希|凭证|evidence/i.test(s)) {
    if (!batchNo) intents.push({ tool: 'chain_integrity', args: {} });
  }
  if (/完整性|账实|一致|校验|validat/i.test(s)) intents.push({ tool: 'chain_integrity', args: {} });
  if (/计算|算一下|多少吨|排放量是|帮我算/.test(s) && numMatch) {
    intents.push({ tool: 'carbon_calc', args: { amount: numMatch[1], factor: numMatch[2] } });
  }
  if (/因子|系数|EF|NCV|热值|含碳量/.test(s)) {
    /* 从问题里提关键词：优先匹配已知因子名 */
    const kw = ['原煤', '焦炭', '天然气', '柴油', '燃料油', '汽油', '液化石油气',
      '华北', '东北', '华东', '华中', '西北', '南方', '西南', '电力', '热力']
      .find((k) => s.includes(k)) || '';
    intents.push({ tool: 'factor_lookup', args: { keyword: kw } });
  }
  if (/配额|缺口|履约|超排|风险|余额/.test(s) && !isConcept) intents.push({ tool: 'enterprise_overview', args: {} });
  if (/批次|核算记录|核算单/.test(s)) intents.push({ tool: 'list_my_batches', args: {} });
  if (/同行|对标|基准|行业平均|中位数/.test(s)) {
    const ind = ['电力', '钢铁', '建材', '化工', '石化', '煤炭', '有色金属', '其他']
      .find((k) => s.includes(k)) || '钢铁';
    intents.push({ tool: 'peer_benchmark', args: { industry: ind } });
  }
  if (isConcept) intents.push({ tool: 'concept_faq', args: { question: s } });
  /* 兜底：问"我的情况"→ 企业总览 */
  if (!intents.length && /我|企业|排放|情况|多少/.test(s) && !isConcept) {
    intents.push({ tool: 'enterprise_overview', args: {} });
  }
  if (!intents.length) intents.push({ tool: 'concept_faq', args: { question: s } });

  /* 去重（同一工具只调一次，取第一个参数集） */
  const seen = new Set();
  return intents.filter((i) => (seen.has(i.tool) ? false : (seen.add(i.tool), true)));
}

/* ==================================================================================
 * 三、回答组装
 * ================================================================================== */

/** 数字格式化：大数加千分位，保留合理小数 */
function n(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const x = Number(v);
  return x.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/** 把工具结果渲染成人话 */
function renderAnswer(intent, result, ctx) {
  const { tool, args } = intent;

  if (result && result.error) {
    return `查询「${tool}」时遇到问题：${result.error}`;
  }

  switch (tool) {
    case 'enterprise_overview': {
      const d = result;
      const ent = d.enterprise;
      const lines = [`**${ent.name}**（${ent.industry} · ${ent.region} · ${ent.scale}）`];
      if (d.quota) {
        lines.push(`配额：${d.quota.year} 年度已分配 **${n(d.quota.allocated)} tCO₂e**，`
          + `已使用 ${n(d.quota.used)}，余量 ${n(d.quota.available)}`);
      } else {
        lines.push('配额：暂无分配记录');
      }
      if (d.dynamic) {
        lines.push(`动态核算：累计排放 **${n(d.dynamic.cumulativeEmission)} tCO₂e**，`
          + `期末预测 ${n(d.dynamic.predictedEoy)}`);
        const gap = d.dynamic.gap;
        if (gap > 0) {
          lines.push(`⚠ 预计缺口 **${n(gap)} tCO₂e**，风险等级 ${d.dynamic.riskLevel}。`
            + '建议：优先在交易端购入配额，或启用 CCER 抵销（上限为主体配额的 5%）。');
        } else if (gap < 0) {
          lines.push(`✔ 预计富余 ${n(-gap)} tCO₂e，可考虑在市场上出售。`);
        }
      }
      if (d.offsetTonnes > 0) lines.push(`已用碳信用抵销：${n(d.offsetTonnes)} tCO₂e`);
      lines.push(`\n_数据来源：${d.source}_`);
      return lines.join('\n');
    }

    case 'list_my_batches': {
      if (!result.count) return '目前还没有核算批次。可以在「核算作业」页发起一次核算。';
      const lines = [`最近 **${result.count}** 个核算批次：`];
      result.batches.forEach((b) => {
        lines.push(`· \`${b.batchNo}\` — ${b.year} ${b.period}，`
          + `排放 **${n(b.totalEmission)} tCO₂e**，状态 ${b.status}`);
      });
      lines.push(`\n_数据来源：${result.source}_`);
      return lines.join('\n');
    }

    case 'factor_lookup': {
      if (!result.found) return result.hint || '未找到匹配的因子。';
      const lines = [`找到 **${result.found}** 项因子：`];
      result.factors.forEach((f) => {
        lines.push(`· **${f.name}**（\`${f.code}\`）：EF = ${f.ef} ${f.unit || 'tCO₂e/单位'}`);
        if (f.recomputeFormula) {
          lines.push(`  三要素复算：\`${f.recomputeFormula}\``);
        }
        if (f.basis) lines.push(`  出处：${f.basis}${f.region ? ' · ' + f.region : ''}`);
      });
      lines.push(`\n_数据来源：${result.source}（公开可查，无需登录）_`);
      return lines.join('\n');
    }

    case 'carbon_calc': {
      return [
        `计算过程：**${n(result.input.amount, 4)} ${result.input.unit || ''} × ${n(result.input.factor, 6)}`
          + ` = ${n(result.result, 3)} tCO₂e**`,
        '',
        `_公式：${result.formula}_`,
        `_${result.note}_`,
      ].join('\n');
    }

    case 'concept_faq': {
      return result.answer || '暂未覆盖该概念，试试：碳配额 / 碳足迹 / CBAM / CCER / 五道校验。';
    }

    case 'evidence_status': {
      if (!result.found) return result.hint;
      const lines = [`批次 \`${args.batchNo}\` 有 **${result.found}** 条存证记录：`];
      result.records.forEach((r) => {
        lines.push(`· 区块 **#${r.blockIndex}** · 摘要 \`${String(r.payloadDigest).slice(0, 16)}…\``);
        lines.push(`  交易号 \`${String(r.txId).slice(0, 20)}…\` · 状态 ${r.status}`);
      });
      lines.push(`\n_可用 POST /api/evidence/verify 对这个凭证做独立复核（公开端点，无需登录）_`);
      return lines.join('\n');
    }

    case 'chain_integrity': {
      return [
        `区块链状态：高度 **${n(result.height, 0)}**，共 ${n(result.blocks, 0)} 个区块`,
        `存证：已确认 **${n(result.confirmed, 0)}** 笔，待打包 ${n(result.pending, 0)} 笔`,
        `账实核对：${result.accounting.note}`,
        '',
        `_数据来源：${result.source}_`,
        `_可调 GET /api/chain/validate 做全链哈希与 Merkle 复算（当场验证，非事后声称）_`,
      ].join('\n');
    }

    case 'peer_benchmark': {
      if (!result.found) return result.hint;
      const d = result.distribution;
      return [
        `**${result.industry}** 行业真实分布（${result.year} 年，样本 **${n(result.sampleSize, 0)}** 家设施）：`,
        `· P25 = ${n(d.p25, 0)} tCO₂e/年`,
        `· 中位数 = **${n(d.median, 0)}** tCO₂e/年`,
        `· P75 = ${n(d.p75, 0)} tCO₂e/年`,
        `· P90 = ${n(d.p90, 0)} tCO₂e/年`,
        '',
        `_数据来源：${result.source} · 刷新于 ${result.refreshedAt}_`,
        `_⚠ 这是第三方观测估算的分布，不是你所在企业的自报值；用于判断量级位置，不能替代企业核算。_`,
      ].join('\n');
    }

    default:
      return '我暂时无法处理这个问题。';
  }
}

/* ==================================================================================
 * 四、主入口
 * ================================================================================== */

/**
 * 回答一个问题。
 *
 * @param {object} p
 *   question  用户问题
 *   user      当前用户 { uid, role, orgId }
 *   context   前端上下文 { view, selectedWorkshop, selectedBatch, ... }
 * @returns {Promise<object>} { answer, intents, tools, context }
 */
async function ask(p) {
  const question = String(p.question || '').slice(0, 500);
  const user = p.user || {};
  const ctx = p.context || {};

  if (!question.trim()) {
    return { answer: '请提出一个与平台数据相关的问题，例如「我的配额还够吗」「原煤的排放因子是多少」。', intents: [], tools: [] };
  }

  /* 上下文补充：如果前端传了选中的车间/批次，把它作为默认参数 */
  let intents = detectIntent(question);

  /* 3D 场景联动：用户点选了某个车间，问题里又没明确对象，则带入选中对象 */
  if (ctx.selectedBatchNo && !intents.some((i) => i.tool === 'evidence_status')
      && /这个|该|选中|当前/.test(question)) {
    intents.push({ tool: 'evidence_status', args: { batchNo: ctx.selectedBatchNo } });
  }

  /* 无意图 → 如实说明能力边界，不编答案 */
  if (!intents.length) {
    return {
      answer: [
        '这个问题超出了我的能力范围。',
        '',
        '我是**碳链通平台的数据助手**，不是通用大模型。我能回答的是平台数据相关的问题：',
        '· 排放与配额：「我的配额还够吗」「今年缺口多少」',
        '· 核算批次：「最近的核算批次」「这个批次的存证在哪」',
        '· 排放因子：「原煤的因子是多少」「华北电网因子」',
        '· 行业对标：「钢铁行业的中位数排放」',
        '· 链上状态：「链有多高」「账实一致吗」',
        '· 计算：「12000 吨煤 × 1.9003 等于多少」',
        '',
        '_我不回答开放性的行业趋势、政策解读问题 —— 那需要能引用权威来源，而我只能保证平台内数据准确。_',
      ].join('\n'),
      intents: [], tools: [],
      boundary: true,
    };
  }

  /* 执行工具 */
  const toolResults = [];
  for (const it of intents) {
    const def = TOOLS[it.tool];
    if (!def) continue;
    const args = { ...it.args };
    /* 企业角色强制用自己 orgId，防越权 */
    if (def.name === 'enterprise_overview' || def.name === 'list_my_batches') {
      if (user.role === 'ENTERPRISE') args.entId = Number(user.orgId);
      else if (!args.entId) args.entId = ctx.entId ? Number(ctx.entId) : null;
    }
    try {
      const result = await def.run(args);
      toolResults.push({ tool: it.tool, args, result });
    } catch (e) {
      toolResults.push({ tool: it.tool, args, result: { error: e.message } });
    }
  }

  /* 组装回答 */
  const parts = toolResults.map((t) => renderAnswer(
    { tool: t.tool, args: t.args }, t.result, ctx));

  const answer = parts.join('\n\n---\n\n');

  return {
    answer,
    intents: intents.map((i) => i.tool),
    tools: toolResults.map((t) => ({
      tool: t.tool, args: t.args,
      ok: !(t.result && t.result.error),
      source: t.result && t.result.source ? t.result.source : null,
      /* 原始查询结果：给数字溯源校验用（grounding.js）。
       * 渲染后的文字经过格式化（千分位、小数位），拿它当"事实集"会漏掉
       * 未渲染的字段（如分位数明细）；这里给原始结构，校验才有完整依据。 */
      data: t.result,
    })),
    /* 上下文回显：让用户知道 AI 看到了什么 */
    contextUsed: Object.keys(ctx).length ? ctx : null,
    generatedAt: new Date().toISOString(),
    engine: {
      kind: 'rule-based with real tool calls',
      why: '不使用外部 LLM：① 无可用凭据；② 碳数据不能由语言模型编造；③ 平台承诺"每个数字可复算"，'
        + '而 LLM 输出无法复算。所有数字均来自数据库或纯算术。',
    },
  };
}

/** 可用能力清单（供前端展示快捷问题） */
function capabilities() {
  return {
    tools: Object.values(TOOLS).map((t) => ({
      name: t.name, description: t.description, params: t.params,
    })),
    sampleQuestions: [
      '我的配额还够吗？今年会不会超排？',
      '最近的核算批次有哪些？',
      '原煤的排放因子是多少？怎么复算？',
      '华北电网的区域因子是多少？',
      '12000 吨原煤 × 1.9003 等于多少吨 CO₂？',
      '链上现在多高？账实一致吗？',
      '钢铁行业的中位数排放是多少？',
      '这个批次的存证在哪个区块？',
    ],
    boundary: '只回答平台数据相关问题；不回答开放性行业趋势或政策解读。',
  };
}

module.exports = {
  TOOLS, detectIntent, ask, capabilities, renderAnswer,
};
