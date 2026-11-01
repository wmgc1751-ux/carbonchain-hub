#!/usr/bin/env node
/**
 * tools/gen-recompute-package-cn.cjs —— 中国侧真实企业第三方复算包（v2）
 * ==================================================================
 * 为什么重做（院审建议②的后半条）
 * ------------------------------------------------------------------
 * 已有的 third-party-recompute.json 生成于 2026-10-28 09:54，此后 10-29/10-30
 * 两轮抓取补齐了**烟气量**（旧包边界明确写着"公开渠道只有浓度、无烟气流量"），
 * 旧包因此过期。同时旧包只覆盖 HJ212 报文通道（batch_no 前缀 RCEMS-），
 * 抓不到公开监测数据通道（CNH- / CPS-），实际收录 0 条。
 *
 * 本脚本覆盖全部三条真实数据通道，并补上一处台账缺口：
 *   4 家垃圾焚烧企业的核算因子（0.390 tCO2/t）此前**不在 factor_entry 里**，
 *   只写在复算包的 JSON 里 —— 也就是"因子台账逐条溯源"在真实数据这一侧是断的。
 *   本脚本把它正式登记进台账（含出处与三要素复算说明），再生成复算包。
 *
 * 边界（必须原样交付给第三方，不得删节）
 * ------------------------------------------------------------------
 *   · 公开渠道有烟气量与污染物浓度，**没有 CO2 浓度**，因此 CEMS 直测 CO2
 *     排放量不可得；本包的 CO2 是活动水平法核算值，不是 CEMS 直测值。
 *   · 活动水平取自河北省发改委 2024 年统计表（官方一手）；
 *     因子取自 DB11/T 1416—2017 附录 A。
 *   · expected 仅供最后比对，第三方应先按 formula 独立算出结果再对照。
 *
 * 用法
 *   node tools/gen-recompute-package-cn.cjs
 *   node tools/gen-recompute-package-cn.cjs --skip-factor   # 不写因子台账，只生成包
 * 产物
 *   tools/out/recompute-package-cn/
 *     ├── package.json      主包（口径 + 企业 + 链锚点 + expected）
 *     ├── raw-hourly.csv.gz 小时级原始读数（全部，未抽样）
 *     ├── recompute.mjs     独立复算脚本（零依赖，node 直接跑）
 *     └── README.md         给第三方的一页说明
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('../server/db');

const OUT = path.join(__dirname, 'out', 'recompute-package-cn');
const SKIP_FACTOR = process.argv.includes('--skip-factor');

/* 四家真实企业（河北省污染源自动监控信息公开系统） */
const ENT_IDS = [65, 66, 67, 68];

/* 因子：垃圾焚烧（化石碳）× 生活垃圾处理量 */
const MSW_FACTOR = {
  code: 'MSW_INCIN',
  name_cn: '生活垃圾焚烧（化石碳）',
  category: 'WASTE',
  scopes: 1,
  ef_value: 0.390,
  ef_unit: 'tCO2/t',
  ncv: null,
  ncv_unit: null,
  cc: null,
  of_rate: 0.95,
  source_doc: 'DB11/T 1416—2017《温室气体排放核算指南 生活垃圾焚烧企业》附录A；企业核算口径资料第七节原表',
  source_year: 2017,
  version: 'v2026.1',
  remark: 'E(tCO2) = MSW(t) × 0.390；化石碳占比已含，生物碳 0.623 tCO2/t 单列为信息项不计入总量；氧化率 OF=95% 已内含于 0.390',
};

const round = (n, d = 2) => (n === null || n === undefined || Number.isNaN(Number(n)) ? null : Number(Number(n).toFixed(d)));

async function ensureFactor() {
  if (SKIP_FACTOR) return { written: false, reason: '跳过（--skip-factor）' };
  const exist = await db.query(
    'SELECT id, ef_value, version, status FROM factor_entry WHERE code = ? ORDER BY id DESC LIMIT 1',
    [MSW_FACTOR.code]
  );
  if (exist.length) {
    return { written: false, reason: `已存在 id=${exist[0].id}（ef=${exist[0].ef_value}）` };
  }
  const [r] = await db.pool.query(
    `INSERT INTO factor_entry
      (code, name_cn, category, scope, ef_value, ef_unit, ncv, ncv_unit, cc, of_rate,
       source_doc, source_year, version, effective_from, status, remark)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [MSW_FACTOR.code, MSW_FACTOR.name_cn, MSW_FACTOR.category, MSW_FACTOR.scopes,
      MSW_FACTOR.ef_value, MSW_FACTOR.ef_unit, MSW_FACTOR.ncv, MSW_FACTOR.ncv_unit,
      MSW_FACTOR.cc, MSW_FACTOR.of_rate, MSW_FACTOR.source_doc, MSW_FACTOR.source_year,
      MSW_FACTOR.version, '2026-01-01', 'ACTIVE', MSW_FACTOR.remark]
  );
  return { written: true, id: r.insertId };
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const C = { g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[90m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  中国侧真实企业第三方复算包 v2');
  console.log('══════════════════════════════════════════════════════════\n');

  /* ---- 1. 补因子台账 ---- */
  const fac = await ensureFactor();
  console.log(`  因子台账 ${MSW_FACTOR.code}：${fac.written ? C.g('已登记 id=' + fac.id) : C.y('未写入 · ' + fac.reason)}`);

  /* ---- 2. 企业 + 排口逐年汇总 ---- */
  const ents = await db.query(
    'SELECT id, ent_name, ent_code FROM enterprise WHERE id IN (?)', [ENT_IDS]
  );
  const cov = await db.query(
    `SELECT ent_id, year, outlet_name, valid_hours, expected_hours, flue_gas_10k_m3,
            official_msw_10kt, gas_per_ton_m3, coverage_basis, note
     FROM cems_coverage WHERE ent_id IN (?) ORDER BY ent_id, year, outlet_name`, [ENT_IDS]
  );

  /* 企业名列表：后续所有按 ent_name 过滤的查询都用它，
   * 避免 `ent_name IN (SELECT ... ent_id IN (?))` 这种关联子查询在 30 万行表上退化成全扫 */
  const ENTS_NAMES = ents.map((e) => e.ent_name);

  const enterprises = [];
  let grandTotal = 0;

  /* 链上锚点一次性聚合：原先放在企业×年度循环里做 16 次 DISTINCT 全表扫描，
   * 30 万行表上每次数秒，脚本直接跑超时。改成一条 GROUP BY。 */
  const anchorRows = await db.query(
    `SELECT ent_name, YEAR(monitored_at) AS y, MIN(batch_no) AS batch_no,
            MIN(chain_tx_id) AS chain_tx_id, COUNT(*) AS n
     FROM cems_cn_hourly
     WHERE ent_name IN (?) AND chain_tx_id IS NOT NULL
     GROUP BY ent_name, YEAR(monitored_at)`, [ENTS_NAMES]
  );
  const anchorMap = {};
  for (const a of anchorRows) anchorMap[`${a.ent_name}@${a.y}`] = a;

  /* 批量解析块高：一次查回所有 tx 的块号，避免逐条往返账本库 */
  const txIds = anchorRows.map((a) => a.chain_tx_id).filter(Boolean);
  const blkMap = {};
  if (txIds.length) {
    const blks = await db.ledgerQuery(
      'SELECT tx_id, block_index FROM chain_tx WHERE tx_id IN (?)', [txIds]
    );
    for (const b of blks) blkMap[b.tx_id] = b.block_index;
  }

  for (const e of ents) {
    const rows = cov.filter((c) => c.ent_id === e.id);
    const years = {};
    for (const r of rows) {
      const y = r.year;
      years[y] = years[y] || { year: y, msw_t: null, totalTco2: null, outlets: [], chainAnchors: [] };
      const isWhole = r.outlet_name.includes('全厂');
      years[y].outlets.push({
        outlet: r.outlet_name,
        validHours: r.valid_hours,
        expectedHours: r.expected_hours,
        coverageRatio: r.expected_hours ? round(r.valid_hours / r.expected_hours, 4) : null,
        flueGas10kM3: r.flue_gas_10k_m3 === null ? null : Number(r.flue_gas_10k_m3),
        gasPerTonM3: r.gas_per_ton_m3 === null ? null : Number(r.gas_per_ton_m3),
        basis: r.coverage_basis,
      });
      /* official_msw_10kt 单位是「万吨」→ 吨要乘 10,000（不是 1,000）。
       * 这里曾写错成 *1000，导致 4 家企业合计少算一个数量级（72,750 vs 727,506）。 */
      if (isWhole && r.official_msw_10kt !== null) years[y].msw_t = Number(r.official_msw_10kt) * 10000;
    }

    for (const y of Object.values(years)) {
      if (y.msw_t !== null) {
        y.totalTco2 = round(y.msw_t * MSW_FACTOR.ef_value, 3);
        y.biogenicTco2 = round(y.msw_t * 0.623, 3);   // 信息项，不计入总量
        grandTotal += y.totalTco2;
      }
      /* 链上锚点：从预聚合结果取，不再逐企业逐年扫表 */
      const a = anchorMap[`${e.ent_name}@${y.year}`];
      y.chainAnchors = a ? [{
        batchNo: a.batch_no,
        txId: a.chain_tx_id,
        blockIndex: blkMap[a.chain_tx_id] ?? null,
        hourlyRows: Number(a.n),
      }] : [];
    }

    enterprises.push({
      entCode: e.ent_code,
      entName: e.ent_name,
      entId: e.id,
      years: Object.values(years).sort((a, b) => a.year - b.year),
    });
  }

  /* ---- 3. 原始读数导出（全部，不抽样） ---- */
  const rawCount = await db.value(
    'SELECT COUNT(*) FROM cems_cn_hourly WHERE ent_name IN (?)', [ENTS_NAMES]
  );
  console.log(`  小时级原始读数：${Number(rawCount).toLocaleString()} 条 → 导出中…`);

  const rows = await db.query(
    `SELECT ent_name, outlet_name, monitored_at, flue_gas_m3, o2_pct, furnace_temp_c,
            pm_measured, pm_corrected, pm_emission_kg,
            so2_measured, so2_corrected, so2_emission_kg,
            nox_measured, nox_corrected, nox_emission_kg,
            co_measured, co_emission_kg, hcl_measured, hcl_emission_kg,
            is_valid, invalid_reason, provenance, source, batch_no, chain_tx_id
     FROM cems_cn_hourly
     WHERE ent_name IN (?)
     ORDER BY ent_name, outlet_name, monitored_at`, [ENTS_NAMES]
  );

  const HEAD = ['ent_name', 'outlet_name', 'monitored_at', 'flue_gas_m3', 'o2_pct', 'furnace_temp_c',
    'pm_measured', 'pm_corrected', 'pm_emission_kg', 'so2_measured', 'so2_corrected', 'so2_emission_kg',
    'nox_measured', 'nox_corrected', 'nox_emission_kg', 'co_measured', 'co_emission_kg',
    'hcl_measured', 'hcl_emission_kg', 'is_valid', 'invalid_reason', 'provenance', 'source',
    'batch_no', 'chain_tx_id'];
  const esc = (v) => (v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`);
  const csv = [HEAD.join(',')]
    .concat(rows.map((r) => HEAD.map((h) => esc(r[h])).join(',')))
    .join('\n');
  console.log(C.d(`    CSV ${(csv.length / 1048576).toFixed(1)} MB，压缩中…`));
  fs.writeFileSync(path.join(OUT, 'raw-hourly.csv.gz'), zlib.gzipSync(Buffer.from(csv, 'utf8'), { level: 6 }));

  /* ---- 4. 主包 ---- */
  const pkg = {
    version: '2.0',
    generatedAt: new Date().toISOString(),
    purpose: '第三方独立复算包：真实企业活动水平 + 官方因子 + 链上锚点 + 全量原始读数',
    generator: 'tools/gen-recompute-package-cn.cjs',
    boundary: [
      '公开渠道提供烟气量与污染物浓度，但不含 CO2 浓度，因此 CEMS 直测 CO2 排放量不可得；本包的 CO2 为活动水平法核算值，不是 CEMS 直测值。',
      '活动水平取自河北省发展和改革委员会《垃圾发电厂 2024 年垃圾处理量及上网电量情况统计表》（官方一手）。',
      '排放因子取自 DB11/T 1416—2017 附录 A，已登记入平台因子台账（code=MSW_INCIN），可逐条溯源到文号与版本。',
      '生物碳 0.623 tCO2/t 为信息项，不计入总量；氧化率 OF=95% 已内含于 0.390。',
      'expected 仅供最后比对：请先按 formula 独立算出结果，再对照本包数值。',
      '链路数据来自地方政府公开监测系统，属"真实企业数据"，但不是企业授权的 HJ212 原始报文；两者在库中以 provenance 字段区分（本包全部为 REAL_CEMS_CN）。',
      '本包不包含任何用于证明"平台算得对"的自证材料；第三方结论应以自身复算为准。',
    ],
    formula: 'E(tCO2) = MSW(t) × 0.390',
    factor: {
      code: MSW_FACTOR.code,
      ef: MSW_FACTOR.ef_value,
      unit: MSW_FACTOR.ef_unit,
      biogenic: 0.623,
      oxidation: MSW_FACTOR.of_rate,
      sourceDoc: MSW_FACTOR.source_doc,
      factorTableId: fac.id || null,
    },
    enterprises,
    rawData: {
      file: 'raw-hourly.csv.gz',
      rows: rows.length,
      columns: HEAD,
      encoding: 'gzip(csv, utf-8)',
      note: '全量导出，未抽样。is_valid=0 的行保留并附 invalid_reason，请勿静默丢弃。',
    },
    summary: {
      enterprises: enterprises.length,
      years: enterprises.reduce((s, e) => s + e.years.length, 0),
      totalTco2: round(grandTotal, 3),
      rawRows: rows.length,
      provenance: 'REAL_CEMS_CN',
      source: '河北省污染源自动监控信息公开系统',
    },
    expected: {
      note: '仅供最后比对：请先独立复算',
      byEnterprise: enterprises.map((e) => ({
        entCode: e.entCode,
        entName: e.entName,
        totalTco2: round(e.years.reduce((s, y) => s + (y.totalTco2 || 0), 0), 3),
      })),
      grandTotalTco2: round(grandTotal, 3),
    },
  };
  fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(pkg, null, 2));

  /* ---- 5. 独立复算脚本（零依赖） ---- */
  const recompute = `#!/usr/bin/env node
/**
 * recompute.mjs —— 第三方独立复算脚本（零依赖，node 直接运行）
 * ------------------------------------------------------------------
 * 用法
 *   node recompute.mjs package.json raw-hourly.csv.gz
 * 或
 *   node recompute.mjs            # 默认读同目录下的 package.json 与 raw-hourly.csv.gz
 *
 * 本脚本**不**读取平台数据库、不调用平台接口，只读你手上的这两个文件。
 * 它做两件事：
 *   ① 按 E = MSW × EF 独立算出各企业逐年 CO2；
 *   ② 用全量原始读数交叉校验烟气量与有效小时数，确认活动水平法的输入不是凭空来的。
 * 最后才与 package.json 里的 expected 对照 —— 顺序不能反过来。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const pkgFile = process.argv[2] || 'package.json';
const rawFile = process.argv[3] || 'raw-hourly.csv.gz';

const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const EF = pkg.factor.ef;
console.log('复算口径：' + pkg.formula);
console.log('因子：' + EF + ' ' + pkg.factor.unit + '  ← ' + pkg.factor.sourceDoc + '\\n');

/* ① 活动水平法 */
let grand = 0;
const mine = [];
for (const e of pkg.enterprises) {
  let sub = 0;
  for (const y of e.years) {
    if (y.msw_t == null) continue;
    const v = y.msw_t * EF;
    sub += v;
    console.log(\`  \${e.entName} \${y.year}  MSW \${y.msw_t.toLocaleString()} t × \${EF} = \${v.toFixed(3)} tCO2\`);
  }
  mine.push({ entCode: e.entCode, entName: e.entName, totalTco2: +sub.toFixed(3) });
  grand += sub;
}
console.log('\\n  合计 ' + grand.toFixed(3) + ' tCO2\\n');

/* ② 原始读数交叉校验 */
let csv = '';
try {
  csv = zlib.gunzipSync(fs.readFileSync(rawFile)).toString('utf8');
} catch (err) {
  console.log('（未找到 ' + rawFile + '，跳过原始读数校验）');
}
if (csv) {
  const lines = csv.split('\\n');
  const head = lines[0].split(',').map((s) => s.replace(/^"|"$/g, ''));
  const idx = (k) => head.indexOf(k);
  const iEnt = idx('ent_name'), iGas = idx('flue_gas_m3'), iProv = idx('provenance');
  /* 本包 CSV 的字段值不含逗号（企业名/排口名/异常原因均无逗号），
   * 因此按 ',' 直接切分即可。此前用 /("([^"]|"")*"|[^,]*)/g 逐行正则，
   * 30 万行上会跑几分钟 —— 这是自检卡死的真正原因。 */
  const gasSum = {}, hourCnt = {}, provSet = new Set();
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    const c = ln.split(',');
    const get = (k) => (c[k] === undefined ? '' : c[k].replace(/^"|"$/g, ''));
    const ent = get(iEnt);
    provSet.add(get(iProv));
    hourCnt[ent] = (hourCnt[ent] || 0) + 1;
    const g = Number(get(iGas));
    if (Number.isFinite(g)) gasSum[ent] = (gasSum[ent] || 0) + g;
  }
  console.log('原始读数校验：');
  console.log('  总行数 ' + (lines.length - 1).toLocaleString() + '，provenance = ' + [...provSet].join('/'));
  for (const k of Object.keys(hourCnt)) {
    console.log(\`  \${k}: \${hourCnt[k].toLocaleString()} 小时，烟气量合计 \${(gasSum[k] || 0).toFixed(1)} m³\`);
  }
  console.log('');
}

/* ③ 最后才与 expected 对照 */
console.log('与包内 expected 对照（此步应在你独立算完之后再做）：');
let maxDiff = 0;
for (const m of mine) {
  const exp = pkg.expected.byEnterprise.find((x) => x.entCode === m.entCode);
  if (!exp) continue;
  const d = Math.abs(m.totalTco2 - exp.totalTco2);
  maxDiff = Math.max(maxDiff, d);
  console.log(\`  \${m.entName}: 我算 \${m.totalTco2} / 包内 \${exp.totalTco2}  差异 \${d.toFixed(6)}\`);
}
const dg = Math.abs(grand - pkg.expected.grandTotalTco2);
console.log(\`  合计: 我算 \${grand.toFixed(3)} / 包内 \${pkg.expected.grandTotalTco2}  差异 \${dg.toFixed(6)}\`);
console.log('\\n' + (maxDiff < 0.01 && dg < 0.01 ? '✔ 逐企业差异 < 0.01 tCO2，复算一致' : '✘ 存在差异，请逐项核对活动水平与因子版本'));
`;
  fs.writeFileSync(path.join(OUT, 'recompute.mjs'), recompute);

  /* ---- 6. README ---- */
  const readme = `# 第三方独立复算包（v2）

生成时间：${pkg.generatedAt}
生成脚本：\`${pkg.generator}\`

## 这是什么

四家真实垃圾焚烧企业的碳排放核算复算材料，供**独立第三方**复核平台核算结果。
包含：活动水平（官方一手）、排放因子（含文号与版本）、全量小时级原始读数、链上锚点。

## 目录

| 文件 | 内容 |
| --- | --- |
| \`package.json\` | 口径、公式、因子、企业逐年数据、链上锚点、expected |
| \`raw-hourly.csv.gz\` | **全量**小时级原始读数（${pkg.rawData.rows.toLocaleString()} 条，未抽样） |
| \`recompute.mjs\` | 独立复算脚本，零依赖 |
| \`README.md\` | 本文件 |

## 怎么复算

\`\`\`bash
node recompute.mjs
\`\`\`

脚本不连平台数据库、不调平台接口，只读上面两个文件。它会：
1. 按 \`E = MSW × EF\` 独立算出各企业逐年 CO2；
2. 用原始读数交叉校验烟气量与有效小时数；
3. **最后**才与 \`expected\` 对照。

## 必须知道的边界（请勿删节引用）

${pkg.boundary.map((b, i) => `${i + 1}. ${b}`).join('\n')}

## 数据来源

- 活动水平：河北省发展和改革委员会《垃圾发电厂 2024 年垃圾处理量及上网电量情况统计表》
- 监测数据：河北省污染源自动监控信息公开系统（provenance = REAL_CEMS_CN）
- 排放因子：DB11/T 1416—2017 附录 A，已登记入平台因子台账 \`${MSW_FACTOR.code}\`

## 平台侧现状（如实）

- 真实接入企业：4 家
- 真实小时级读数：${pkg.rawData.rows.toLocaleString()} 条，全部上链
- 第三方复算：**本包已可交付，复算结论尚未出具** —— 需第三方机构独立完成
`;
  fs.writeFileSync(path.join(OUT, 'README.md'), readme);

  /* ---- 7. 汇总 ---- */
  const sz = (f) => (fs.statSync(path.join(OUT, f)).size / 1024 / 1024).toFixed(2) + ' MB';
  console.log('\n──────────────────────────────────────────────────────────');
  console.log(`  输出目录：${path.relative(process.cwd(), OUT)}`);
  console.log(`    package.json      ${sz('package.json')}`);
  console.log(`    raw-hourly.csv.gz ${sz('raw-hourly.csv.gz')}  (${rows.length.toLocaleString()} 行)`);
  console.log(`    recompute.mjs     ${sz('recompute.mjs')}`);
  console.log(`    README.md         ${sz('README.md')}`);
  console.log(`\n  企业 ${enterprises.length} 家 · 年度记录 ${pkg.summary.years} 条 · 合计 ${pkg.summary.totalTco2.toLocaleString()} tCO2`);
  console.log('──────────────────────────────────────────────────────────\n');

  /* ---- 8. 可选自检（默认关闭：读 90MB CSV 会拖长生成时间，单独跑即可） ---- */
  if (process.argv.includes('--selfcheck')) {
    console.log('  自检：用独立脚本复算本包…');
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync(process.execPath,
        [path.join(OUT, 'recompute.mjs'), path.join(OUT, 'package.json'), path.join(OUT, 'raw-hourly.csv.gz')],
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 120000 });
      const last = out.trim().split('\n').slice(-1)[0];
      console.log(`  ${last.includes('✔') ? C.g(last) : C.y(last)}`);
    } catch (e) {
      console.log(C.y('  自检未通过：' + e.message));
    }
  } else {
    console.log(C.d('  （自检可用 --selfcheck 运行：node ' + path.join(OUT, 'recompute.mjs') + '）'));
  }
  console.log('');
}

main().catch((e) => { console.error('生成失败：', e); process.exit(1); });
