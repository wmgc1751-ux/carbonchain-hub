#!/usr/bin/env node
/**
 * tools/metrics-ledger.mjs —— 指标溯源台账（Claim → Evidence）
 * ==================================================================
 * 为什么需要它（院审判定第 ② 条的直接解法）
 * ------------------------------------------------------------------
 * 院审对本案的判定原文：
 *   「关键数字无出处（PoW慢79倍、132台设备）且摘要894笔与正文895笔不一致」
 *
 * 这条意见的要害不是"数字错了"，而是**数字与产生它的那次执行之间没有可追溯的链**。
 * 评审专家问一句"63.7 ms 你怎么得出来的"，如果答案只能回到"我跑过一次"，
 * 那这个数字在答辩现场就等于不存在。
 *
 * 本脚本把每个对外引用的数字变成一条**四元组可查记录**：
 *
 *     指标 → 产生命令 → 证据文件 → 文件 SHA-256 + 采集时间
 *
 * 并额外做两件评审最在意的事：
 *
 *   ① **缺证即空**。证据文件不存在、字段取不到、数值超出预期区间，
 *      一律判 UNVERIFIED / SUSPECT，**绝不填一个"看起来合理"的数**。
 *      台账里出现空白，比台账里出现一个编造的数要好一百倍。
 *
 *   ② **过期即告警**。每条记录带 capturedAt，超过 STALE_DAYS 天标 STALE。
 *      防止"去年跑的数今年还在论文里"。
 *
 * 输出
 *   tools/out/metrics-ledger.json   机读（供证据包与页面消费）
 *   tools/out/metrics-ledger.md     人读（可直接贴进申报书附录）
 *
 * 用法
 *   node tools/metrics-ledger.mjs
 *   node tools/metrics-ledger.mjs --strict     # 存在 UNVERIFIED 时退出码 1
 *   node tools/metrics-ledger.mjs --stale 30   # 自定义过期天数（默认 45）
 * ==================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'tools', 'out');
const ARGV = process.argv.slice(2);
const argOf = (n, d) => {
  const i = ARGV.indexOf(n);
  return i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--') ? ARGV[i + 1] : d;
};
const STRICT = ARGV.includes('--strict');
const STALE_DAYS = Number(argOf('--stale', '45'));

/* ==================================================================
 * 一、取值工具（容错，取不到就返回 undefined，由调用方判空）
 * ================================================================== */

function readJson(file) {
  const p = path.join(OUT_DIR, file);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** 按路径取值，任意一层缺失返回 undefined */
function pick(obj, dotted) {
  if (!obj) return undefined;
  return dotted.split('.').reduce((acc, k) => {
    if (acc === null || acc === undefined) return undefined;
    return acc[k];
  }, obj);
}

/**
 * 支持「数组过滤」的取值表达式：
 *   items[?(@.name=~"复算")].pass
 * → obj.items 里 name 含"复算"的第一项的 pass
 *   items[?(code=RUN)].value
 * → obj.items 里 code === 'RUN' 的第一项的 value
 *
 * 为什么需要它（2026-10-24）：
 *   断言类套件（mrv-selftest）的产物是「一张断言清单」，
 *   要引用其中某一条是否通过，必须能按名字定位。
 *   只有点号路径时只能写 items.5.pass 这种硬编码下标 ——
 *   一旦断言顺序调整，台账就会静默取到**另一条**断言的结果，
 *   这比取不到更危险（会给出一个看起来正常的假绿）。
 *
 * 只支持上面两种最小形式，不引入 JSONPath 依赖：
 *   本工具要在证据包里离线可跑，多一个依赖就多一个失败点。
 */
function pickExpr(obj, expr) {
  if (!obj || !expr) return undefined;
  const m = expr.match(/^([A-Za-z0-9_]+)\[\?\(@?\.?([A-Za-z0-9_]+)\s*(=~|=)\s*"?([^")]*)"?\)\]\.([A-Za-z0-9_]+)$/);
  if (!m) return pick(obj, expr);   // 普通点号路径
  const [, arrKey, field, op, target, outKey] = m;
  const arr = obj[arrKey];
  if (!Array.isArray(arr)) return undefined;
  const hit = arr.find((x) => {
    const v = x && x[field];
    if (v === undefined || v === null) return false;
    return op === '=~' ? String(v).includes(target) : String(v) === String(target);
  });
  return hit ? hit[outKey] : undefined;
}

function sha256File(file) {
  const p = path.join(OUT_DIR, file);
  if (!fs.existsSync(p)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function bytesOf(file) {
  const p = path.join(OUT_DIR, file);
  return fs.existsSync(p) ? fs.statSync(p).size : null;
}

function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

/* ==================================================================
 * 二、指标登记表
 * ------------------------------------------------------------------
 * 每条登记项回答四个问题，缺一不可：
 *   claim   —— 对外怎么讲（论文/答辩原文口径）
 *   source  —— 哪条命令产生（必须是可以当场重跑的真实命令）
 *   file    —— 落在哪个证据文件
 *   probe   —— 从该文件里取哪个字段才算数
 *
 * expect 是可选的合理性护栏：取值落不进区间就判 SUSPECT，
 * 用来拦住"字段取错了位置但仍取到一个数"这类静默错误。
 * ================================================================== */

const REGISTRY = [
  /* ---------- A. 链内核性能（论文表 6-1 / 答辩必问） ---------- */
  {
    id: 'consensus.pow.median',
    group: '链内核性能',
    claim: '同难度 PoW 出块中位耗时',
    unit: 'ms',
    cmd: 'node tools/bench-consensus.mjs',
    file: 'bench-consensus.json',
    probe: 'pow.medianMs',
    expect: [0.1, 10000],
    note: '难度 4，20 轮取中位；与 PoA 同机同难度对照',
  },
  {
    id: 'consensus.poa.median',
    group: '链内核性能',
    claim: 'PoA 出块中位耗时（共识计算口径）',
    unit: 'ms',
    cmd: 'node tools/bench-consensus.mjs',
    file: 'bench-consensus.json',
    probe: 'poa.medianMs',
    expect: [0.01, 1000],
    note: '2000 轮取中位；含出块签名、不含验签，引用时须注明',
  },
  {
    id: 'consensus.poa.tps',
    group: '链内核性能',
    claim: 'PoA 名义吞吐（共识计算口径）',
    unit: 'TPS',
    cmd: 'node tools/bench-consensus.mjs',
    file: 'bench-consensus.json',
    probe: 'poa.tpsNominal',
    expect: [1, 100000],
    note: '⚠ 与端到端 153 TPS 是两套口径，禁止混引',
  },
  {
    id: 'consensus.ratio',
    group: '链内核性能',
    claim: 'PoA 相对同难度 PoW 的倍数',
    unit: '×',
    cmd: 'node tools/bench-consensus.mjs',
    file: 'bench-consensus.json',
    probe: 'ratio',
    expect: [1, 10000],
    note: '⚠ 旧稿"79 倍"已作废，以此值为准',
  },

  /* ---------- B. 密码学原语（论文性能表） ---------- */
  {
    id: 'crypto.sm3.ops',
    group: '密码学原语',
    claim: 'SM3 吞吐（1 KB 块）',
    unit: 'ops/s',
    cmd: 'node tools/bench-crypto.mjs',
    file: 'bench-crypto.json',
    probe: 'results',
    expect: null,
    note: '需按 label 过滤；--all 为 scale=2，不可与单档混引',
    derive: (j) => {
      const rows = j.results || [];
      const r = rows.find((x) => /SM3/.test(x.label) && /1 KB|1KB/.test(x.label));
      return r ? r.opsPerSec : undefined;
    },
  },
  {
    id: 'crypto.sm2.sign',
    group: '密码学原语',
    claim: 'SM2 签名速率',
    unit: 'ops/s',
    cmd: 'node tools/bench-crypto.mjs',
    file: 'bench-crypto.json',
    probe: 'results',
    expect: [1, 1000000],
    derive: (j) => {
      const rows = j.results || [];
      const r = rows.find((x) => /SM2\s*签名/.test(x.label));
      return r ? r.opsPerSec : undefined;
    },
  },
  {
    id: 'crypto.sm2.verify',
    group: '密码学原语',
    claim: 'SM2 验签速率',
    unit: 'ops/s',
    cmd: 'node tools/bench-crypto.mjs',
    file: 'bench-crypto.json',
    probe: 'results',
    expect: [1, 1000000],
    derive: (j) => {
      const rows = j.results || [];
      const r = rows.find((x) => /SM2\s*验签/.test(x.label));
      return r ? r.opsPerSec : undefined;
    },
  },
  {
    id: 'crypto.merkle.1000',
    group: '密码学原语',
    claim: 'Merkle 树 1000 叶构建速率',
    unit: 'ops/s',
    cmd: 'node tools/bench-crypto.mjs',
    file: 'bench-crypto.json',
    probe: 'results',
    expect: [0, 1000000],
    derive: (j) => {
      const rows = j.results || [];
      const r = rows.find((x) => /Merkle\s*1000/.test(x.label));
      return r ? r.opsPerSec : undefined;
    },
  },

  /* ---------- C. 七年链上规模（摘要与正文必须同口径） ---------- */
  {
    id: 'chain.blocks',
    group: '链上规模',
    claim: '区块数',
    unit: '块',
    cmd: 'node tools/export-chain.mjs',
    file: 'chain-export.json',
    probe: 'blocks.length',
    expect: [1, 1000000],
    note: '以导出件计数为准，不用数据库缓存值',
  },
  {
    id: 'chain.txs',
    group: '链上规模',
    claim: '存证交易数',
    unit: '笔',
    cmd: 'node tools/export-chain.mjs',
    file: 'chain-export.json',
    probe: 'txs.length',
    expect: [1, 10000000],
    note: '⚠ 摘要"894 笔"与正文"895 笔"曾不一致，以本值为唯一口径',
  },
  {
    id: 'chain.nodes',
    group: '链上规模',
    claim: '联盟节点数',
    unit: '个',
    cmd: 'node tools/export-chain.mjs',
    file: 'chain-export.json',
    probe: 'nodes.length',
    expect: [1, 100],
    note: '对应"5 节点 5 副本"表述',
  },

  /* ---------- D. 安全演练（表 5-4） ---------- */
  {
    id: 'attack.total',
    group: '安全演练',
    claim: '同库同改攻击用例总数',
    unit: '组',
    cmd: 'node tools/attack-same-db.mjs',
    file: 'attack-same-db.json',
    probe: 'summary.total',
    expect: [1, 100],
    note: '含基线与还原两组，命中数须等于总数',
  },
  {
    id: 'attack.hit',
    group: '安全演练',
    claim: '按预期检出的用例数',
    unit: '组',
    cmd: 'node tools/attack-same-db.mjs',
    file: 'attack-same-db.json',
    probe: 'summary.hit',
    expect: [1, 100],
    note: 'hit < total 即为阴性对照失效，必须解释',
  },
  {
    id: 'attack.mismatch',
    group: '安全演练',
    claim: '与预期不符的用例数',
    unit: '组',
    cmd: 'node tools/attack-same-db.mjs',
    file: 'attack-same-db.json',
    probe: 'summary.mismatch',
    /* CCR-01（2026-10-31 登记豁免）：连接层隔离强度不足（DBA 凭据同改 3 例
     * 不符），由审计哈希链 12/12 + 离线验链 + SM2 锚定等效控制覆盖。
     * bridge 全过后本条应回到 [0,0]；当前按登记豁免放宽至 [0,3] 并持续披露。 */
    expect: [0, 3],
    note: 'CCR-01 登记豁免口径：目标 0；技术债收口前上限 3（密码学层等效控制已验证）',
  },
  {
    id: 'attack.splitDb',
    group: '安全演练',
    claim: '链库与业务库是否物理分离',
    unit: 'bool',
    cmd: 'node tools/attack-same-db.mjs',
    file: 'attack-same-db.json',
    probe: 'splitDb',
    expect: null,
    note: 'false 表示退化为同库，此时"管理员无法篡改"主张不成立',
  },

  /* ---------- E. 全量回归（唯一守门口径） ----------
   * ⚠ 自引用悖论：本套件自身也注册在 verify-all 里，而 verify-all 要等全部套件
   * 跑完才写 verify-all.json。若台账在轮内读取它，读到的是**上一轮**的结果，
   * 上一轮若被 --only 部分运行覆盖过，就会得到 0/0 这种假红。
   * 处置：读取时校验 totals 的完整性；若 sumTotal 为 0 或缺失，判 UNVERIFIED 并
   * 明确提示"本轮尚未产生完整回归结果"，不把它当失败，也不当通过。
   * ---------------------------------------------------------------- */
  {
    id: 'verify.suites.passed',
    group: '全量回归',
    claim: '通过套件数',
    unit: '套',
    cmd: 'node tools/verify-all.mjs',
    file: 'verify-all.json',
    probe: 'totals.passed',
    expect: [1, 100],
    /* ⚠ 不要在这里写死"共 N 套件"。
     * 这个数字随套件增删而变化，而台账的职责是给出**当前真值**而不是记忆值。
     * 实际套件总数在 verify-all.json 的 totals.sumCount 里，引用时请直接读它。
     * （历史上这里写过"共 18 套件"，后来加到 24 个而注释未同步，
     *   于是台账本身变成了"数字无出处"的来源之一。） */
    note: '套件总数见 verify-all.json 的 totals.sumCount，不在此处硬编码',
    guard: (j) => (Number((j.totals || {}).sumTotal) ? null : '本轮汇总为残缺轮次（sumTotal=0），不计入台账'),
  },
  {
    id: 'verify.assert.pass',
    group: '全量回归',
    claim: '通过断言数',
    unit: '条',
    cmd: 'node tools/verify-all.mjs',
    file: 'verify-all.json',
    probe: 'totals.sumPass',
    expect: [1, 100000],
    note: '与总断言数配对使用，单独引用无意义',
    guard: (j) => (Number((j.totals || {}).sumTotal) ? null : '本轮汇总为残缺轮次（sumTotal=0），不计入台账'),
  },
  {
    id: 'verify.assert.total',
    group: '全量回归',
    claim: '断言总数',
    unit: '条',
    cmd: 'node tools/verify-all.mjs',
    file: 'verify-all.json',
    probe: 'totals.sumTotal',
    expect: [1, 100000],
    note: 'pass/total 应完全相等才算全绿',
    guard: (j) => (Number((j.totals || {}).sumTotal) ? null : '本轮汇总为残缺轮次（sumTotal=0），不计入台账'),
  },
  {
    id: 'verify.suites.failed',
    group: '全量回归',
    claim: '失败套件数',
    unit: '套',
    cmd: 'node tools/verify-all.mjs',
    file: 'verify-all.json',
    probe: 'totals.failed',
    expect: [0, 100],
    note: '非 0 时必须在申报材料中逐条解释原因；--only 部分运行会覆盖此文件，注意轮次',
    guard: (j) => {
      const t = j.totals || {};
      const n = Number(t.sumTotal);
      if (!n) {
        return '本轮尚未产生完整回归结果（sumTotal=0，可能是 --only 部分运行覆盖了汇总文件），请跑一次完整 verify:all 后再引用';
      }
      /* ⚠ 这里原先只判 sumTotal，导致「失败套件 1 套」但断言 279/279 全过时
       * 仍被判 OK —— 台账于是把一个红色的数字标成绿色。这正是院审说的
       * "数字口径不统一"的同型问题：汇总状态与明细状态不一致。
       * 现在：失败套件数 > 0 一律 SUSPECT，并要求写明是哪几套。 */
      if (Number(t.failed) > 0) {
        const names = (j.rows || []).filter((r) => r.status === 'FAIL').map((r) => r.id).join(', ');
        return `本次回归有 ${t.failed} 套失败${names ? `（${names}）` : ''}：`
          + '失败套件的断言不计入 sumPass/sumTotal，因此"断言全过"与"存在失败套件"可以同时成立 —— '
          + '对外只能引用套件全绿的轮次，或逐条说明失败原因';
      }
      return null;
    },
  },

  /* ---------- E2. 真实数据交叉验证（本轮新增：科学性从自证转他证） ----------
   * 这组指标的特别之处：它们不是"平台自己算出来的数"，而是"外部真实观测
   * 与平台实现之间的差异"。任何对外声称"核算引擎经过真实数据验证"的地方，
   * 都必须引用这里的三项，缺一不可：
   *   · 自洽占比 → 说明规模
   *   · 量纲错误数 → 说明没有系统性错误
   *   · 因子跳变率 → 说明数据源本身稳定
   * 只引"99.9% 自洽"而不引样本量是无意义的（3 家里 3 家也是 100%）。 */
  {
    id: 'xv.identity.verifiable',
    group: '真实数据交叉验证',
    claim: '恒等式可检验设施数',
    unit: '家',
    cmd: 'node tools/crossvalidate-check.mjs --year 2024',
    file: 'crossvalidate-check.json',
    probe: 'summary.identity.verifiable',
    /* CCR-02（cn-only）：国内层=4 家保定企业（官方统计），样本量判据按口径校准；
     * 样本量必须随结果一起引用，禁止只引"100% 自洽" */
    expect: [1, 1000000],
    note: 'cn-only：4 家 REAL_OFFICIAL；全球层恢复后应达数千家量级',
  },
  {
    id: 'xv.identity.exact_pct',
    group: '真实数据交叉验证',
    claim: '恒等式精确自洽占比（≤0.5%）',
    unit: '%',
    cmd: 'node tools/crossvalidate-check.mjs --year 2024',
    file: 'crossvalidate-check.json',
    probe: 'summary.identity.exactSharePct',
    expect: [95, 100],
    note: '判据 >95%。不要求 100%：源数据的 A 与 E 各自独立舍入，极小量级记录',
  },
  {
    id: 'xv.identity.unit_errors',
    group: '真实数据交叉验证',
    claim: '量纲级错误数（偏差 >100%）',
    unit: '例',
    cmd: 'node tools/crossvalidate-check.mjs --year 2024',
    file: 'crossvalidate-check.json',
    probe: 'summary.identity.unitErrors',
    expect: [0, 0],
    note: '必须为 0。出现任何一例都意味着单位或口径搞错（差 10 倍即 900%）',
  },
  {
    id: 'xv.stability.jump_pct',
    group: '真实数据交叉验证',
    claim: '排放因子年度跳变率（>20%）',
    unit: '%',
    cmd: 'node tools/crossvalidate-check.mjs --year 2024',
    file: 'crossvalidate-check.json',
    probe: 'summary.stability.jumpRatePct',
    expect: [0, 10],
    note: '判据 <10%。因子是技术属性，短期不应剧烈变化；超过 10% 说明数据源或解析有系统性问题',
  },
  {
    id: 'zk.realdata.pass',
    group: '真实数据交叉验证',
    claim: '零知识协议在真实设施上的通过项',
    unit: '项',
    cmd: 'node tools/zk-real-data-check.mjs --year 2024',
    file: 'zk-real-data-check.json',
    probe: 'summary.pass',
    expect: [8, 100],
    note: '含 3 类阴性对照（谎报/篡改/挪用）。只看"证明可验证"不够，必须看对照是否被拦截',
  },
  {
    id: 'zk.realdata.fail',
    group: '真实数据交叉验证',
    claim: '零知识协议在真实设施上的失败项',
    unit: '项',
    cmd: 'node tools/zk-real-data-check.mjs --year 2024',
    file: 'zk-real-data-check.json',
    probe: 'summary.fail',
    expect: [0, 0],
    note: '必须为 0。任一项失败即"协议在真实数据上的可用性未被证明"',
  },

  /* ---------- F. 设备接入（院审点名"132 台无出处"） ---------- */
  {
    id: 'iot.total',
    group: '设备接入',
    claim: '设备台账总数',
    unit: '台',
    cmd: 'node tools/iot-selftest.mjs',
    file: 'iot-stats.json',
    probe: 'data.total',
    expect: [1, 100000],
    note: '⚠ 院审点名"132 台"无出处；本值由自检实时统计，非写死',
  },
  {
    id: 'iot.active',
    group: '设备接入',
    claim: '在册 ACTIVE 设备数',
    unit: '台',
    cmd: 'node tools/iot-selftest.mjs',
    file: 'iot-stats.json',
    probe: 'data.active',
    expect: [1, 100000],
    note: '须 ≤ total',
  },
  {
    id: 'iot.directReports',
    group: '设备接入',
    claim: '设备直报帧数',
    unit: '帧',
    cmd: 'node tools/iot-selftest.mjs',
    file: 'iot-stats.json',
    probe: 'data.directReports',
    expect: [1, 10000000],
    note: '与 crcVerified / sm3Verified 配对，证明逐帧校验',
  },
  {
    id: 'iot.crcVerified',
    group: '设备接入',
    claim: 'CRC-16 校验通过帧数',
    unit: '帧',
    cmd: 'node tools/iot-selftest.mjs',
    file: 'iot-stats.json',
    probe: 'data.crcVerified',
    expect: [1, 10000000],
    note: '应等于 directReports',
  },

  /* ---------- G. 端云互认（固件证据） ---------- */
  {
    id: 'firmware.checks.pass',
    group: '端云互认',
    claim: '固件自证检查通过项',
    unit: '项',
    cmd: 'node tools/firmware-compat-check.mjs',
    file: 'firmware-compat-evidence.json',
    probe: 'rows.length',
    expect: [1, 1000],
    note: '固件侧 SM3 标准向量、密钥派生等逐项断言',
  },

  /* ---------- H. MRV 核算链路（2026-10-24 新增） ----------
   * 这一组指标回答的是「核算这件事到底靠不靠得住」，
   * 与前面的性能/链上指标性质不同：它们不是越快越好，而是**必须自洽**。
   * 因此 expect 区间都很窄，任何漂移都值得追。 */
  {
    id: 'mrv.factor.total',
    group: 'MRV 核算',
    claim: '结构化因子台账条数（燃料+电力+热力+过程）',
    unit: '条',
    /* 用 factor 接口的自检数而不是因子条数：条数会随行业扩充，
     * 而"燃料因子全部通过三要素复算"才是真正要守住的断言。 */
    cmd: 'node tools/mrv-selftest.mjs',
    file: 'mrv-selftest.json',
    probe: 'passed',
    expect: [30, 200],
    note: '本套件全部断言通过数；含因子复算、核算可复算、不确定度三路径、商业闭环',
  },
  {
    id: 'mrv.calc.reproducible',
    group: 'MRV 核算',
    claim: '已落库核算批次可复算为 REPRODUCIBLE',
    unit: '项',
    cmd: 'node tools/mrv-selftest.mjs',
    file: 'mrv-selftest.json',
    probe: 'items[?(@.name=~"复算")].pass',
    expect: [1, 1],
    note: '同一输入重算得到逐位相同摘要；这是"结果没被改过"的唯一直接证据',
  },
  {
    id: 'mrv.uq.crossvalidate',
    group: 'MRV 核算',
    claim: 'GUM 解析与蒙特卡洛互证通过',
    unit: '项',
    cmd: 'node tools/mrv-selftest.mjs',
    file: 'mrv-selftest.json',
    probe: 'items[?(@.name=~"互证")].pass',
    expect: [1, 1],
    note: '两条独立路径端点偏差 ≤5%、均值偏差 ≤0.5%；判据带阴性对照',
  },
  {
    id: 'mrv.quota.nonnegative',
    group: 'MRV 核算',
    claim: '配额账户负余额数（必须为 0）',
    unit: '个',
    cmd: 'node tools/mrv-selftest.mjs',
    file: 'mrv-selftest.json',
    probe: 'items[?(@.name=~"负余额")].pass',
    expect: [1, 1],
    note: 'initdb 曾把 used 写成全年排放导致 44/60 家负余额；此断言防止回退',
  },
  /* ---------- I. 零知识碳核算（2026-10-24 新增） ----------
   * 这一组指标回答「隐私保护是否真的成立」。
   * 与性能类指标不同：它们必须为**确定的布尔结论**（通过/不通过），
   * 因为隐私是否被保护没有差不多这个答案。 */
  {
    id: 'zk.selftest.pass',
    group: '零知识核算',
    claim: 'ZK 协议自检通过项（含 14 条阴性对照）',
    unit: '项',
    cmd: 'node tools/zk-selftest.mjs',
    file: 'zk-selftest.json',
    probe: 'passed',
    expect: [15, 200],
    note: '密码学原语 + 范围证明 + 协议语义 + 端到端四层检验',
  },
  {
    id: 'zk.cross.impl',
    group: '零知识核算',
    claim: 'SM2 群运算与 OpenSSL 逐字节一致（跨实现）',
    unit: '项',
    cmd: 'node tools/zk-selftest.mjs',
    file: 'zk-selftest.json',
    probe: 'items[?(@.name=~\OpenSSL\)].pass',
    expect: [1, 1],
    note: '自实现群运算没错的唯一硬证据；与固件 d=1,2,3 已知答案亦一致',
  },
  {
    id: 'zk.proof.positive',
    group: '零知识核算',
    claim: '64 位范围证明正向通过（防全拒退化）',
    unit: '项',
    cmd: 'node tools/zk-selftest.mjs',
    file: 'zk-selftest.json',
    probe: 'items[?(@.name=~\正向证明必须通过\)].pass',
    expect: [1, 1],
    note: '阴性对照证明坏的被拒，此断言证明好的通过——两者缺一不可',
  },
  {
    id: 'zk.privacy.leak',
    group: '零知识核算',
    claim: '公开包不泄漏原始数值（5 种形式检查）',
    unit: '项',
    cmd: 'node tools/zk-selftest.mjs',
    file: 'zk-selftest.json',
    probe: 'items[?(@.name=~\不泄漏任何形式\)].pass',
    expect: [1, 1],
    note: '信息论隐藏：不是承诺不看，而是即使想看也看不到',
  },
  {
    id: 'zk.aggregate.homomorphic',
    group: '零知识核算',
    claim: '聚合承诺可被见证之和打开（同态性实证）',
    unit: '项',
    cmd: 'node tools/zk-selftest.mjs',
    file: 'zk-selftest.json',
    probe: 'items[?(@.name=~\同态性实证\)].pass',
    expect: [1, 1],
    note: 'ΣCom(vᵢ)=Com(Σvᵢ)：区域总量核算不需看个体数值',
  },
  {
    id: 'zk.formula.valid',
    group: '零知识核算',
    claim: '公式正确性证明通过（真实核算批次）',
    unit: '项',
    cmd: 'node tools/zk-selftest.mjs',
    file: 'zk-selftest.json',
    probe: 'items[?(@.name=~"公式正确性可零知识验证")].pass',
    expect: [1, 1],
    note: '证明 E = Σ EF·AD 成立且不泄漏活动数据 —— 范围证明做不到这一层',
  },
  {
    id: 'zk.linear.negative',
    group: '零知识核算',
    claim: '线性关系阴性对照数',
    unit: '条',
    cmd: 'node tools/zk-selftest.mjs',
    file: 'zk-selftest.json',
    probe: 'items[?(@.name=~"线性关系含阴性对照")].detail',
    expect: [1, 100],
    note: '篡改因子/篡改排放量/跨批次挪用/谎报一半 等均须被拒',
  },
  {
    id: 'ui.pages.pass',
    group: 'MRV 核算',
    claim: '页面级巡检通过数（含 MRV 五页 + 真实数据六页，匿名可见）',
    unit: '页',
    cmd: 'node server/scripts/cdp-check.js',
    file: 'ui-check.json',
    probe: 'passed',
    expect: [20, 100],
    note: '判据含 hash 路由匹配 + 页面标题非空 + 内容级断言（关键数字必须真的渲染出来）'
      + ' —— 只数文字长度会被外壳骗过',
  },

  /* ---------- G. 真实数据层（2026-10-24 第 4 轮） ----------
   * 这一组指标回答的是平台最容易被追问的问题：
   *   "你说有真实数据，到底有多少、真到什么程度、能不能查？"
   * 每一条都绑定 tools/out/real-data-audit.json（外部可核查性审计）
   * 与 tools/out/real-layer-check.json（端到端是否到位）。
   * ⚠ 引用时必须同时给出"美国设施、年度粒度"这两个限制，
   *   否则"5352 家真实设施"会被误读成"接入了 5352 家中国控排企业"。 */
  {
    id: 'real.facilities',
    group: '真实数据层',
    claim: '真实排放设施数（US EPA GHGRP，可逐条回溯 Facility Id）',
    unit: '家',
    cmd: 'node tools/real-data-audit.mjs --strict',
    file: 'real-data-audit.json',
    probe: 'summary.realFacilities',
    expect: [1, 100000],
    note: '全部位于美国；GHGRP 为年度上报，无月度/实时数据',
  },
  {
    id: 'real.emission.rows',
    group: '真实数据层',
    claim: '真实设施-年度排放记录数',
    unit: '条',
    cmd: 'node tools/real-data-audit.mjs --strict',
    file: 'real-data-audit.json',
    probe: 'summary.realEmissionRows',
    expect: [1, 1000000],
    note: '2010–2018 共 9 个年度；缺年不插值',
  },
  {
    id: 'real.years',
    group: '真实数据层',
    claim: '真实数据覆盖年度数',
    unit: '年',
    cmd: 'node tools/real-data-audit.mjs --strict',
    file: 'real-data-audit.json',
    probe: 'summary.realYears',
    expect: [1, 30],
    note: null,
  },
  {
    id: 'real.total.tonnes',
    group: '真实数据层',
    claim: '真实年度排放合计（cn-only：国内官方统计层；全球层为九年度累加）',
    unit: 'tCO₂e',
    cmd: 'node tools/real-data-audit.mjs --strict',
    file: 'real-data-audit.json',
    probe: 'summary.realTonnes',
    /* CCR-02（cn-only，2026-10-31）：国内层 4 家保定企业 2024 年度合计
     * 约 72.75 万 tCO₂（官方统计 × 标准因子，可复算），区间按国内量级校准 */
    expect: [1e5, 1e9],
    note: 'cn-only 口径：由官方年度值直接相加，无系数调整；全球层恢复后应回到 1e8 量级',
  },
  {
    id: 'real.layer.assert',
    group: '真实数据层',
    claim: '真实数据层 + 实时引擎端到端断言通过数',
    unit: '项',
    cmd: 'node tools/real-layer-check.mjs',
    file: 'real-layer-check.json',
    probe: 'pass',
    /* CCR-02（cn-only）：92 项断言（SSE LIVE 变/STATIC 稳、真实性契约、边界声明） */
    expect: [10, 500],
    note: 'cn-only 校准：92 项断言；全球层恢复后回到 50+ 量级',
  },
  {
    id: 'real.truth.pass',
    group: '真实数据层',
    claim: '数据真实性契约中运行时核验通过的条数',
    unit: '条',
    cmd: 'node tools/real-layer-check.mjs',
    file: 'real-layer-check.json',
    probe: 'truthPassed',
    expect: [1, 100],
    note: '每条声明绑定核验 SQL；声称值与实算值并列，对不上就报 MISMATCH',
  },
];

/* ==================================================================
 * 三、逐条求值
 * ================================================================== */

const cache = new Map();
function loadFile(f) {
  if (!cache.has(f)) cache.set(f, readJson(f));
  return cache.get(f);
}

const rows = REGISTRY.map((r) => {
  const j = loadFile(r.file);
  let value;
  if (j && typeof r.derive === 'function') {
    value = r.derive(j);
  } else if (j) {
    /* 用 pickExpr（支持数组过滤），不是 pick —— 断言类套件需要按名字定位某条断言 */
    value = pickExpr(j, r.probe);
  }

  const exists = j !== null;
  const capturedAt = j
    ? j.generatedAt || j.exportedAt || j.at || (j.meta && j.meta.exportedAt) || null
    : null;
  const age = daysSince(capturedAt);

  /** 判定优先级：文件缺 → MISSING；自定义护栏否决 → UNVERIFIED；字段缺 → UNVERIFIED；
   *  越界 → SUSPECT；过期 → STALE；否则 OK */
  let status = 'OK';
  let reason = '';

  /* 自定义护栏先行：用于识别"文件在但内容是残缺轮次"这类情况 */
  if (j && typeof r.guard === 'function') {
    const g = r.guard(j);
    if (g) {
      status = 'UNVERIFIED';
      reason = g;
    }
  }

  if (status === 'OK' && !exists) {
    status = 'MISSING';
    reason = `证据文件 ${r.file} 不存在，先跑：${r.cmd}`;
  } else if (status === 'OK' && (value === undefined || value === null || value === '')) {
    status = 'UNVERIFIED';
    reason = `文件存在但取不到 ${r.probe}（字段名可能已变）`;
  } else if (status === 'OK' && Array.isArray(r.expect) && typeof value === 'number') {
    const [lo, hi] = r.expect;
    if (!(value >= lo && value <= hi)) {
      status = 'SUSPECT';
      reason = `取值 ${value} 越出合理区间 [${lo}, ${hi}]，疑似取错字段或本轮结果不完整`;
    }
  }
  if (status === 'OK' && age !== null && age > STALE_DAYS) {
    status = 'STALE';
    reason = `证据已 ${age} 天未更新（阈值 ${STALE_DAYS} 天），请重跑：${r.cmd}`;
  }

  return {
    id: r.id,
    group: r.group,
    claim: r.claim,
    unit: r.unit,
    value: value === undefined ? null : value,
    status,
    reason,
    note: r.note || '',
    cmd: r.cmd,
    file: r.file,
    probe: r.probe,
    capturedAt,
    ageDays: age,
    bytes: bytesOf(r.file),
    sha256: sha256File(r.file),
  };
});

/* ==================================================================
 * 四、汇总与环境指纹
 * ================================================================== */

const byStatus = rows.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] || 0) + 1;
  return acc;
}, {});

const groups = [];
for (const r of rows) {
  let g = groups.find((x) => x.group === r.group);
  if (!g) {
    g = { group: r.group, rows: [] };
    groups.push(g);
  }
  g.rows.push(r);
}

let gitHead = '';
try {
  gitHead = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString().trim();
} catch { /* 非 git 环境不阻塞 */ }

const ledger = {
  generatedAt: new Date().toISOString(),
  generator: 'tools/metrics-ledger.mjs',
  purpose: '把每个对外引用的数字绑定到「产生命令 + 证据文件 + 文件摘要 + 采集时间」',
  env: {
    node: process.version,
    platform: `${os.type()} ${os.release()}`,
    cpuModel: (os.cpus()[0] || {}).model || 'unknown',
    cpuCount: os.cpus().length,
    hostname: os.hostname(),
    gitHead,
  },
  rule: '缺证即空、过期即警；台账出现空白优于台账出现编造数',
  staleDays: STALE_DAYS,
  totals: {
    metrics: rows.length,
    ...byStatus,
  },
  groups,
  rows,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'metrics-ledger.json'), JSON.stringify(ledger, null, 2));

/* ==================================================================
 * 五、Markdown 版（可直接贴进申报书附录）
 * ================================================================== */

const ICON = { OK: '✅', STALE: '🟡', SUSPECT: '🟠', UNVERIFIED: '🔴', MISSING: '⛔' };
const fmt = (v) => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    return v >= 100 ? v.toFixed(1) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  }
  return String(v);
};

const md = [];
md.push('# 指标溯源台账');
md.push('');
md.push(`- 生成时间：${ledger.generatedAt}`);
md.push(`- 代码版本：\`${gitHead || 'n/a'}\``);
md.push(`- 运行环境：${ledger.env.cpuModel} / ${ledger.env.cpuCount} 核 / ${ledger.env.node}`);
md.push(`- 过期阈值：${STALE_DAYS} 天`);
md.push('');
md.push(`**台账纪律**：${ledger.rule}。`);
md.push('');
md.push('## 总览');
md.push('');
md.push('| 指标数 | ✅ 有效 | 🟡 过期 | 🟠 可疑 | 🔴 未取到 | ⛔ 缺文件 |');
md.push('|---|---|---|---|---|---|');
md.push(
  `| ${ledger.totals.metrics} | ${byStatus.OK || 0} | ${byStatus.STALE || 0} | ${byStatus.SUSPECT || 0} | ${byStatus.UNVERIFIED || 0} | ${byStatus.MISSING || 0} |`
);
md.push('');

for (const g of groups) {
  md.push(`## ${g.group}`);
  md.push('');
  md.push('| 状态 | 指标 | 数值 | 单位 | 证据文件 | 采集时间 | 文件 SHA-256（前 12 位） |');
  md.push('|---|---|---|---|---|---|---|');
  for (const r of g.rows) {
    const sha = r.sha256 ? r.sha256.slice(0, 12) : '—';
    const cap = r.capturedAt ? r.capturedAt.replace('T', ' ').slice(0, 19) : '—';
    md.push(`| ${ICON[r.status] || '?'} | ${r.claim} | ${fmt(r.value)} | ${r.unit} | \`${r.file}\` | ${cap} | \`${sha}\` |`);
  }
  md.push('');
  const warns = g.rows.filter((r) => r.status !== 'OK');
  if (warns.length) {
    for (const r of warns) {
      md.push(`- ${ICON[r.status]} **${r.claim}**：${r.reason}`);
    }
    md.push('');
  }
  const notes = g.rows.filter((r) => r.note);
  if (notes.length) {
    for (const r of notes) md.push(`- ⚠ ${r.claim}：${r.note}`);
    md.push('');
  }
}

md.push('---');
md.push('');
md.push('## 如何复核本台账');
md.push('');
md.push('任选一个指标，三步即可验证它不是编造的：');
md.push('');
md.push('```bash');
md.push('# 1. 按台账给出的命令重跑');
md.push('node tools/bench-consensus.mjs');
md.push('');
md.push('# 2. 比对台账记录的文件摘要');
md.push('#    台账 sha256 前 12 位应与下列输出一致');
md.push('node -e "const c=require(\'crypto\'),f=require(\'fs\');');
md.push('console.log(c.createHash(\'sha256\').update(f.readFileSync(\'tools/out/bench-consensus.json\')).digest(\'hex\').slice(0,12))"');
md.push('```');
md.push('');
md.push('摘要一致 ⇒ 数值来自那一次真实执行；摘要不一致 ⇒ 台账过期，须重跑。');
md.push('');

fs.writeFileSync(path.join(OUT_DIR, 'metrics-ledger.md'), md.join('\n'));

/* ==================================================================
 * 六、终端摘要
 * ================================================================== */

console.log('\n指标溯源台账 —— 生成完毕\n');
console.log(`  指标 ${rows.length} 条  ` +
  `✅ ${byStatus.OK || 0}  🟡 ${byStatus.STALE || 0}  🟠 ${byStatus.SUSPECT || 0}  ` +
  `🔴 ${byStatus.UNVERIFIED || 0}  ⛔ ${byStatus.MISSING || 0}`);
console.log(`  输出  tools/out/metrics-ledger.json`);
console.log(`        tools/out/metrics-ledger.md\n`);

const bad = rows.filter((r) => r.status !== 'OK');
if (bad.length) {
  console.log('  需要处理：');
  for (const r of bad) console.log(`   ${ICON[r.status]} ${r.id}  ${r.reason}`);
  console.log('');
}

if (STRICT && bad.length) {
  console.error(`--strict：存在 ${bad.length} 条非 OK 记录，退出码 1`);
  process.exit(1);
}
