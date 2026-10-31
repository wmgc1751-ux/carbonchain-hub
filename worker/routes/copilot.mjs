/**
 * worker/routes/copilot.mjs —— AI 碳资产顾问（Cloudflare Workers / D1）
 * ==================================================================================
 * v2 混合引擎：
 *   规则引擎（本文件工具集，D1 真实查询）负责"取数"——保证数字准确；
 *   LLM（OpenAI 兼容协议，见 lib/llm.mjs）负责"说话"——自然语言组织 + 外部知识。
 *   LLM 未配置或调用失败时自动降级为纯规则引擎，服务永不中断。
 *
 * capabilities / status 不查 D1 —— 额度耗尽时仍可用
 * ask / stream 查 D1 —— 额度耗尽时由全局错误处理器返回 503
 *
 * @module worker/routes/copilot
 */
import { json, fail, authRequired, num } from '../lib/http.mjs';
import * as LLM from '../lib/llm.mjs';
import * as G from '../lib/grounding.mjs';

/* 数字溯源：把模型回答接上校验声明。
 * 无平台数据参与（纯概念/政策问答）时**不启用** —— 空事实集会把
 * 「GB/T 32150」「2026 年」全判成无出处，那是把"无法比较"误报成"比较失败"。 */
function withGrounding(text, toolResults, question) {
  const facts = (toolResults || [])
    .map((t) => t.result)
    .filter((r) => r && !r.error && typeof r === 'object');
  if (!facts.length) {
    return { text, grounding: { skipped: true, reason: '本次回答未引用平台数据，数字溯源不适用' } };
  }
  const g = G.verify(text, facts, { question });
  return { text: text + G.footnote(g), grounding: g };
}

/* ==================================================================================
 * 工具集（全部是 D1 真实查询）
 * ================================================================================== */
const TOOLS = {
  enterprise_overview: {
    description: '查询企业的排放、配额、缺口、风险等级',
    async run(db, { entId }) {
      if (!entId) return { error: '未指定企业' };
      const ent = await db.one(
        'SELECT id, ent_name, industry, region, scale FROM enterprise WHERE id = ?', [entId]);
      if (!ent) return { error: `企业 ${entId} 不存在` };
      const quota = await db.one(
        `SELECT year, total_allocated, used FROM carbon_quota
          WHERE ent_id = ? ORDER BY year DESC LIMIT 1`, [entId]);
      const dyn = await db.one(
        `SELECT year, cumulative_emission, predicted_eoy, gap, risk_level
           FROM carbon_dynamic_account WHERE ent_id = ? ORDER BY year DESC LIMIT 1`, [entId]);
      return {
        enterprise: { id: num(ent.id), name: ent.ent_name, industry: ent.industry,
          region: ent.region, scale: ent.scale },
        quota: quota ? { year: num(quota.year), allocated: num(quota.total_allocated),
          used: num(quota.used), available: num(quota.total_allocated) - num(quota.used) } : null,
        dynamic: dyn ? { year: num(dyn.year), cumulativeEmission: num(dyn.cumulative_emission),
          predictedEoy: num(dyn.predicted_eoy), gap: num(dyn.gap), riskLevel: dyn.risk_level } : null,
        source: 'carbon_quota / carbon_dynamic_account',
      };
    },
  },
  factor_lookup: {
    description: '查询排放因子（三要素+复算公式）',
    async run(db, { keyword = '' }) {
      const kw = `%${String(keyword).slice(0, 30)}%`;
      const rows = await db.query(
        `SELECT code, name_cn, category, ncv, cc, of_rate, ef_value, ef_unit, source_doc
           FROM factor_entry WHERE code LIKE ? OR name_cn LIKE ? OR region LIKE ? OR category LIKE ?
          ORDER BY category, code LIMIT 10`, [kw, kw, kw, kw]);
      if (!rows.length) return { found: 0, hint: '未匹配到因子' };
      return {
        found: rows.length,
        factors: rows.map((f) => ({
          code: f.code, name: f.name_cn, ef: num(f.ef_value), unit: f.ef_unit || '',
          basis: f.source_doc,
          recomputeFormula: f.ncv != null && f.cc != null && f.of_rate != null
            ? `${f.ncv}/1000 × ${f.cc} × ${f.of_rate} × 44/12 = ${f.ef_value}` : null,
        })),
        source: 'factor_entry',
      };
    },
  },
  carbon_calc: {
    description: '按活动量 × 因子计算排放量（纯算术）',
    async run(_db, { amount, factor }) {
      const a = Number(amount); const f = Number(factor);
      if (!Number.isFinite(a) || !Number.isFinite(f) || a < 0 || f < 0) return { error: '参数无效' };
      return { formula: '排放量 = 活动量 × 排放因子', input: { amount: a, factor: f },
        result: Number((a * f).toFixed(3)), resultUnit: 'tCO2e' };
    },
  },
  chain_integrity: {
    description: '检查区块链完整性',
    async run(db) {
      const blk = await db.one(
        `SELECT COUNT(*) AS blocks, SUM(tx_count) AS packed, MAX(block_index) AS height FROM chain_block`);
      const tx = await db.one(
        `SELECT COUNT(*) AS rows_n, SUM(status='CONFIRMED') AS confirmed,
                SUM(status='PENDING') AS pending FROM chain_tx`);
      const confirmed = num(tx && tx.confirmed); const pending = num(tx && tx.pending);
      const packed = num(blk && blk.packed);
      return {
        height: num(blk && blk.height), blocks: num(blk && blk.blocks),
        confirmed, pending,
        accounting: { state: packed === confirmed + pending ? 'BALANCED' : 'PENDING_BACKLOG' },
        source: 'chain_block / chain_tx',
      };
    },
  },
  peer_benchmark: {
    description: '查询行业真实分布（中位数/分位数）',
    async run(db, { industry }) {
      const row = await db.one(
        `SELECT payload_json, refreshed_at FROM agg_insight WHERE kind = 'BENCHMARK' AND scope = ?`,
        [String(industry || '钢铁')]);
      if (!row) return { found: false, hint: '该行业基准尚未预计算' };
      let p = null;
      try { p = JSON.parse(row.payload_json); } catch { return { found: false }; }
      return { found: true, industry: p.industry, year: p.year, sampleSize: p.sampleSize,
        distribution: { median: p.distribution.median, p90: p.distribution.p90 },
        source: 'agg_insight' };
    },
  },
  evidence_status: {
    description: '查询批次的存证状态',
    async run(db, { batchNo }) {
      if (!batchNo) return { error: '需要 batchNo' };
      const rows = await db.query(
        `SELECT tx_id, block_index, status FROM chain_tx
          WHERE tx_type = 'EVIDENCE_NODE' AND biz_no = ? ORDER BY id DESC LIMIT 5`, [String(batchNo)]);
      if (!rows.length) return { found: false, hint: `批次 ${batchNo} 尚无存证` };
      return { found: rows.length, records: rows.map((r) => ({ txId: r.tx_id,
        blockIndex: r.block_index === null ? null : num(r.block_index) })) };
    },
  },
  /* 概念科普：内置词典（零 LLM 也能回答"什么是碳配额"这类开放概念题） */
  concept_faq: {
    description: '碳市场与碳管理专业问答',
    async run(_db, { question }) {
      return answerConcept(String(question || ''));
    },
  },
};

/* ==================================================================================
 * 意图识别
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
  const batchMatch = s.match(/CALC\d{6,}/i);
  const batchNo = batchMatch ? batchMatch[0] : null;
  const numMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:吨|t|万m³|MWh|GJ)?\s*[×x*乘以]\s*(\d+(?:\.\d+)?)/i);
  /* 概念解释类问题（"什么是碳配额"等）→ 概念科普词典，不误路由到企业查询 */
  const isConcept = /什么是|是什么|什么叫|解释一下|介绍一下|为什么|怎么回事|怎么说|有哪些|区别|差异|影响|意义|如何理解|帮我说明/.test(s)
    || /^(碳|CBAM|CCER|CEMS|MRV|CCUS|SBTi|ISO|HJ|SM2|SM3|ZKP|PoA|范围)/i.test(s);

  if (batchNo) intents.push({ tool: 'evidence_status', args: { batchNo } });
  if (/存证|上链|区块|哈希/i.test(s) && !batchNo) intents.push({ tool: 'chain_integrity', args: {} });
  if (/完整性|账实|一致/.test(s)) intents.push({ tool: 'chain_integrity', args: {} });
  if (numMatch) intents.push({ tool: 'carbon_calc', args: { amount: numMatch[1], factor: numMatch[2] } });
  if (/因子|系数|EF|NCV/.test(s)) {
    const kw = ['原煤','焦炭','天然气','柴油','华北','东北','华东','电力','热力'].find((k) => s.includes(k)) || '';
    intents.push({ tool: 'factor_lookup', args: { keyword: kw } });
  }
  if (/配额|缺口|履约|风险/.test(s) && !isConcept) intents.push({ tool: 'enterprise_overview', args: {} });
  if (/同行|对标|中位数/.test(s)) {
    const ind = ['电力','钢铁','建材','化工'].find((k) => s.includes(k)) || '钢铁';
    intents.push({ tool: 'peer_benchmark', args: { industry: ind } });
  }
  if (isConcept) intents.push({ tool: 'concept_faq', args: { question: s } });
  if (!intents.length && /我|企业|排放|多少/.test(s) && !isConcept) intents.push({ tool: 'enterprise_overview', args: {} });
  if (!intents.length) intents.push({ tool: 'concept_faq', args: { question: s } });

  const seen = new Set();
  return intents.filter((i) => (seen.has(i.tool) ? false : (seen.add(i.tool), true)));
}

/* ==================================================================================
 * 回答组装
 * ================================================================================== */
function fmtN(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  return Number(v).toLocaleString('zh-CN', { maximumFractionDigits: d });
}

function renderAnswer(tool, result) {
  if (result && result.error) return `查询遇到问题：${result.error}`;
  switch (tool) {
    case 'enterprise_overview': {
      const d = result; if (!d.enterprise) return '未找到该企业';
      const L = [`**${d.enterprise.name}**（${d.enterprise.industry} · ${d.enterprise.region}）`];
      if (d.quota) L.push(`配额：${d.quota.year} 年已分配 **${fmtN(d.quota.allocated)} tCO₂e**，余量 ${fmtN(d.quota.available)}`);
      if (d.dynamic) {
        L.push(`累计排放 **${fmtN(d.dynamic.cumulativeEmission)} tCO₂e**，期末预测 ${fmtN(d.dynamic.predictedEoy)}`);
        if (d.dynamic.gap > 0) L.push(`⚠ 预计缺口 **${fmtN(d.dynamic.gap)}**，风险 ${d.dynamic.riskLevel}`);
      }
      L.push(`\n_来源：${d.source}_`);
      return L.join('\n');
    }
    case 'factor_lookup': {
      if (!result.found) return result.hint;
      return result.factors.map((f) => `**${f.name}**：EF = ${f.ef} ${f.unit}\n  复算 \`${f.recomputeFormula}\``).join('\n');
    }
    case 'carbon_calc':
      return `**${fmtN(result.input.amount,4)} × ${fmtN(result.input.factor,6)} = ${fmtN(result.result,3)} tCO₂e**`;
    case 'chain_integrity':
      return `链高 **${fmtN(result.height,0)}**，${fmtN(result.blocks,0)} 区块，已确认 **${fmtN(result.confirmed,0)}** 笔`;
    case 'peer_benchmark':
      if (!result.found) return result.hint;
      return `**${result.industry}**（${fmtN(result.sampleSize,0)} 家）：中位数 **${fmtN(result.distribution.median,0)}** tCO₂e/年`;
    case 'evidence_status':
      if (!result.found) return result.hint;
      return `存证在区块 **#${result.records[0].blockIndex}**`;
    case 'concept_faq':
      return result.answer || '暂未覆盖该概念，试试：碳配额 / 碳足迹 / CBAM / CCER / 五道校验。';
    default: return '暂不支持。';
  }
}

/* ==================================================================================
 * 工具执行（规则引擎取数）
 * ================================================================================== */
async function runTools(ctx, intents) {
  const results = [];
  for (const it of intents) {
    const def = TOOLS[it.tool];
    if (!def) continue;
    const args = { ...it.args };
    if (it.tool === 'enterprise_overview' && ctx.user && ctx.user.role === 'ENTERPRISE') {
      args.entId = Number(ctx.user.orgId);
    }
    try { results.push({ tool: it.tool, args, result: await def.run(ctx.db, args) }); }
    catch (e) { results.push({ tool: it.tool, args, result: { error: e.message } }); }
  }
  return results;
}

/** 把工具结果序列化为注入 LLM 的平台实时数据块 */
function toolsToContext(results) {
  if (!results.length) return '';
  return '【平台实时数据】\n' + results.map((t) =>
    `- ${t.tool}: ${JSON.stringify(t.result).slice(0, 600)}`).join('\n');
}

/* ==================================================================================
 * 路由
 * ================================================================================== */
export function attachCopilotRoutes(r) {
  /* capabilities：纯静态，不查 D1 */
  r.get('/api/copilot/capabilities', () => json({
    tools: Object.entries(TOOLS).filter(([k]) => k !== '_ask')
      .map(([k, v]) => ({ name: k, description: v.description })),
    sampleQuestions: [
      '我的配额还够吗？', '原煤的排放因子？', '链上多高？账实一致吗？',
      '钢铁行业中位数', '12000 × 1.9003 等于多少',
    ],
    boundary: '平台数据由规则引擎实时查询；行业知识由大模型回答',
  }));

  /* status：LLM 连接状态（公开，前端徽标用）
   * ⚠ 字段契约：前端读 `llm.configured / llm.model`。旧实现只返回扁平的
   *   llmEnabled/llmModel，而前端 public/js/views/copilot.js 读的是 s.llm，
   *   于是"已接入大模型"时徽标永远显示「规则引擎」—— 配了 key 也看不出来。
   *   现在同时给出嵌套 llm 与扁平旧字段，两代前端都能正确显示。 */
  r.get('/api/copilot/status', (ctx) => {
    const s = LLM.snapshot(ctx.env);
    return json({
      /* —— 新契约 —— */
      llm: {
        configured: s.configured,
        provider: s.provider,
        providerId: s.providerId,
        model: s.model,
        backend: s.backend,
        fallbacks: s.fallbacks,
        reason: s.reason,
      },
      providers: s.providers.map((p) => ({
        id: p.id, name: p.name, model: p.model, hasKey: p.hasKey, active: p.active,
      })),
      ruleEngine: true,
      dictionary: true,
      grounding: {
        enabled: true,
        policy: '正文数字逐个回查工具查询结果；无平台数据参与的回答不启用（避免误报）',
      },

      /* —— 旧契约 —— */
      llmEnabled: s.configured,
      llmModel: s.configured ? s.model : null,
      llmProvider: s.configured ? s.provider : null,
      fallback: s.configured
        ? '大模型均不可用时自动降级到概念词典 + 规则引擎'
        : (s.reason || '未配置大模型'),
      externalKnowledge: s.configured ? '已接入大模型，可回答任意开放问题' : '仅限平台数据 + 内置概念词典',
    }, null, {
      /* 状态是"此刻的事实"，不能被边缘缓存 —— 实测踩过：换了模型后
       * 状态接口继续返回上一版模型名（缓存命中），而 POST 提问已用新模型，
       * 界面上"显示 A、实际用 B"，排查时极具误导性。 */
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  });

  /* providers：支持的服务商清单（公开；不返回任何密钥） */
  r.get('/api/copilot/providers', (ctx) => {
    const s = LLM.snapshot(ctx.env);
    return json({
      protocol: 'OpenAI chat/completions 兼容',
      activeId: s.providerId,
      chain: s.chain.map((c) => c.id),
      items: s.providers.map((p) => ({
        id: p.id, name: p.name, defaultModel: p.model,
        configured: p.hasKey, active: p.active,
      })),
      configKeys: [
        'LLM_PROVIDER  指定服务商（可选，缺省自动探测）',
        'DEEPSEEK_API_KEY / ZHIPU_API_KEY / DASHSCOPE_API_KEY / MOONSHOT_API_KEY …',
        'LLM_API_KEY + LLM_BASE_URL  自定义/私有化端点',
        'AI 绑定（Workers AI）  零密钥，Pages → Settings → Functions → AI bindings 添加',
      ],
    });
  });

  /* ask：概念题词典优先 → 平台工具取数 + LLM 生成 → 失败回退规则/词典 */
  r.post('/api/copilot/ask', async (ctx) => {
    const b = await ctx.body();
    const question = String(b.question || '').slice(0, 500);
    if (!question.trim()) return json({ answer: '请提问。', intents: [] });

    const intents = detectIntent(question);
    const results = await runTools(ctx, intents);
    const ruleAnswer = results.map((t) => renderAnswer(t.tool, t.result)).join('\n\n');

    /* ① 概念题且词典命中：直接返回精确释义（零延迟、零配额、答案权威） */
    const conceptOnly = intents.length === 1 && intents[0].tool === 'concept_faq';
    if (conceptOnly && results[0] && results[0].result
      && results[0].result.answer && !results[0].result.answer.includes('暂时给不出')) {
      return json({
        answer: results[0].result.answer, engine: 'dictionary',
        intents: ['concept_faq'], tools: [{ tool: 'concept_faq', ok: true }],
      });
    }

    /* ② LLM 生成（平台数据注入上下文；词典未命中的开放题也走到这里） */
    let llmFail = null;
    if (LLM.isConfigured(ctx.env)) {
      try {
        const r = await LLM.chat(ctx.env, {
          messages: [
            { role: 'system', content: LLM.buildSystemPrompt(ctx.env) },
            { role: 'user', content: `${question}\n\n${toolsToContext(results)}` },
          ],
        });
        /* 数字溯源：正文里的数字逐个回查工具结果 */
        const { text: grounded, grounding } = withGrounding(r.text, results, question);
        return json({
          answer: grounded, engine: 'llm', model: r.model,
          provider: r.provider, backend: r.backend, grounding,
          /* 换家过程也要在成功时可见：本次由链上第几个模型作答、
           * 前几个为什么失败 —— 否则"用的是 70B 而不是 GLM"无从察觉。 */
          attempts: r.attempts || null,
          intents: intents.map((i) => i.tool),
          tools: results.map((t) => ({ tool: t.tool, ok: !(t.result && t.result.error) })),
        });
      } catch (e) {
        /* ⚠ 这里曾经是空的 catch。后果：模型名过期（Workers AI 下线
         * @cf/qwen/qwen1.5-14b-chat-awq）时，状态接口仍报"已接入"，
         * 回答却静默变成规则引擎 —— 既没有日志也没有字段能看出原因。
         * 失败必须可见：错误摘要与尝试记录一并返回。 */
        llmFail = e;
      }
    }

    /* ③ 回退：规则引擎 / 词典兜底文本（ruleAnswer 已含词典兜底） */
    return json({
      answer: ruleAnswer || '超出能力范围。我能回答：配额/因子/链/对标/计算/碳概念科普。',
      engine: intents.length ? 'rules' : 'dictionary',
      llmError: llmFail ? String(llmFail.message || llmFail).slice(0, 200) : null,
      llmAttempts: llmFail && llmFail.attempts ? llmFail.attempts : null,
      intents: intents.map((i) => i.tool),
      tools: results.map((t) => ({ tool: t.tool, ok: !(t.result && t.result.error) })),
    });
  });

  /* stream：LLM 真流式；未配置/失败回退规则引擎切片 */
  r.post('/api/copilot/stream', async (ctx) => {
    const b = await ctx.body();
    const question = String(b.question || '').slice(0, 500);
    const enc = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (ev, data) => {
          try { controller.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)); }
          catch { /* closed */ }
        };
        let closed = false;
        try {
          send('status', { phase: 'intent', message: '正在理解问题…' });
          const intents = detectIntent(question);
          if (intents.length) send('status', { phase: 'plan', intents: intents.map((i) => i.tool) });

          const results = await runTools(ctx, intents);
          const ruleAnswer = results.map((t) => renderAnswer(t.tool, t.result)).join('\n\n')
            || '超出能力范围。我能回答：配额/因子/链/对标/计算/碳概念科普。';

          /* ① 概念题词典命中：逐字流出精确释义（不走 LLM，省配额） */
          const conceptOnly = intents.length === 1 && intents[0].tool === 'concept_faq';
          const dictAnswer = conceptOnly && results[0] && results[0].result
            && results[0].result.answer && !results[0].result.answer.includes('暂时给不出')
            ? results[0].result.answer : null;

          let usedLLM = false;
          let llmText = '';
          let groundingOut = null;
          let llmFailMsg = null;
          if (dictAnswer) {
            send('status', { phase: 'answer', message: '概念词典作答' });
            for (let i = 0; i < dictAnswer.length; i += 3) {
              if (closed) break;
              send('delta', { text: dictAnswer.slice(i, i + 3) });
              await new Promise((ok) => setTimeout(ok, 12));
            }
          } else if (LLM.isConfigured(ctx.env)) {
            /* ② 大模型生成（平台数据注入；开放问题在此回答） */
            try {
              const be = LLM.backendOf(ctx.env);
              send('status', { phase: 'llm', message: '正在调用大模型…', model: be ? be.split(':')[1] : '', backend: be });
              const messages = [
                { role: 'system', content: LLM.buildSystemPrompt(ctx.env) },
                { role: 'user', content: `${question}\n\n${toolsToContext(results)}` },
              ];
              for await (const piece of LLM.chatStream(ctx.env, { messages })) {
                if (closed) break;
                llmText += piece;
                send('delta', { text: piece });
                usedLLM = true;
              }
              /* ③ 数字溯源：仅当本次有平台数据参与 */
              if (usedLLM && !closed) {
                const { text: grounded, grounding } = withGrounding(llmText, results, question);
                const extra = grounded.slice(llmText.length);
                if (extra) send('delta', { text: extra });
                groundingOut = grounding;
              }
            } catch (e) {
              /* 失败可见：把原因送到 done 事件，避免"静默降级" */
              llmFailMsg = String(e.message || e).slice(0, 200);
            }
          }

          if (closed) { controller.close(); return; }

          /* ③ LLM 未用（未配置/失败）→ 规则引擎/词典兜底切片流出 */
          if (!usedLLM && !dictAnswer) {
            send('status', { phase: 'fallback', message: '规则引擎作答' });
            for (let i = 0; i < ruleAnswer.length; i += 3) {
              if (closed) break;
              send('delta', { text: ruleAnswer.slice(i, i + 3) });
              await new Promise((ok) => setTimeout(ok, 12));
            }
          }

          send('done', {
            fullLength: usedLLM ? llmText.length : ruleAnswer.length,
            engine: usedLLM ? 'llm' : 'rules',
            backend: usedLLM ? LLM.backendOf(ctx.env) : null,
            grounding: groundingOut,
            llmError: usedLLM ? null : llmFailMsg,
            intents: intents.map((i) => i.tool),
            tools: results.map((t) => ({ tool: t.tool, ok: !(t.result && t.result.error) })),
          });
        } catch (e) {
          send('error', { message: String(e.message || e) });
        }
        controller.close();
      },
      cancel() { closed = true; },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  });
}
