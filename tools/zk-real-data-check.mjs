/**
 * zk-real-data-check.mjs —— 在真实设施数据上端到端验证零知识核算协议
 * ==================================================================================
 * 【为什么需要这个脚本】
 *
 * 平台的 ZK 自检（`verify:zk`，35 项）全部跑在合成批次上。它能证明
 * "协议实现与自己的测试向量一致"，但证明不了"协议能作用于真实世界的数"。
 *
 * 这是一个实质性的差别。合成数据的活动量是 12000 这样的整数，真实数据是
 * 32,850,000 MWh 与 0.806119 这样的因子；合成数据的位数是一个精心选定的值，
 * 真实数据会暴露位数溢出、量纲不匹配、承诺范围不足等只在真实量级下才出现的问题。
 *
 * 本脚本做的事：
 *   ① 直接从 real_emission_year 取**真实设施**的 A（活动量）与 EF（排放因子）；
 *   ② 用 ZK.buildFormulaProof 证明 E = Σ EF·AD，其中 AD 与 E 藏进承诺；
 *   ③ 用 ZK.verifyFormulaProof 独立验证（模拟监管方视角）；
 *   ④ 做**阴性对照**：谎报 E、篡改 EF、跨设施挪用 → 必须全部失败；
 *   ⑤ 检查公开包里不含任何原始活动数据（结构化泄漏检查，不是子串匹配）。
 *
 * 【阴性对照为什么必须有】
 * "证明能通过"本身不说明任何事 —— 一个永远返回 true 的验证器也能通过。
 * 只有"错误证明必须失败"才能证明验证器真的在验证。
 * 平台的历史教训写在这里：曾有一个恒真式的先验闸门，比硬编码更难发现，
 * 因为它看起来像是在工作。
 *
 * 用法：
 *   node tools/zk-real-data-check.mjs
 *   node tools/zk-real-data-check.mjs --year 2025 --limit 20
 *
 * @module tools/zk-real-data-check
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');

process.chdir(ROOT);

const db = require(path.join(ROOT, 'server/db'));
const ZK = require(path.join(ROOT, 'server/services/zkCarbon'));

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const YEAR = Number(argOf('year', 2025));
const LIMIT = Number(argOf('limit', 10));
const JSON_OUT = argv.includes('--json');

const results = [];
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  results.push({ name, pass: !!ok, detail: detail || '' });
  if (ok) pass++; else fail++;
  if (!JSON_OUT) {
    console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? '  — ' + detail : ''}`);
  }
};

console.log('='.repeat(78));
console.log('  零知识核算协议 · 真实设施数据端到端验证');
console.log(`  年度 ${YEAR} · 来自 real_emission_year（Climate TRACE 观测）`);
console.log('='.repeat(78));

/* ------------------------------------------------------------------ */
/* 一、取真实设施（同时具备 Activity 与 EmissionFactor 的）            */
/* ------------------------------------------------------------------ */
/* CCR-02（cn-only 口径，2026-10-31）：全球层（real_emission_year/real_facility）
 * 在 cn-only 整改后为空，真实数据面切换为国内层 —— emission_calc（河北省发改委
 * 官方统计核算批次，REAL_OFFICIAL）。A=处理量(吨)、EF=tCO2/t、E=total_tco2，
 * 恒等式与标度约束不变；阈值按国内量级调整为 E > 10 万吨。 */
let facilities = await db.query(
  `SELECT f.id, f.name, f.industry, e.total_co2e, e.process_json
     FROM real_emission_year e
     JOIN real_facility f ON f.id = e.facility_id
    WHERE f.country_iso = 'CHN' AND e.year = ?
      AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.process_json,'$.assetKind')),'FACILITY') <> 'AGGREGATE'
      AND JSON_EXTRACT(e.process_json,'$.activity') IS NOT NULL
      AND JSON_EXTRACT(e.process_json,'$.emissionFactor') IS NOT NULL
      AND e.total_co2e > 500000
    ORDER BY e.total_co2e DESC
    LIMIT ?`,
  [YEAR, LIMIT]
);
let SOURCE_TIER = 'EPA_CLIMATE_TRACE';

if (!facilities.length) {
  SOURCE_TIER = 'CN_ONLY_OFFICIAL';
  facilities = await db.query(
    `SELECT c.ent_code AS id, c.ent_name AS name, '垃圾焚烧发电' AS industry,
            c.total_tco2 AS total_co2e,
            JSON_OBJECT('activity', c.msw_t, 'activityUnit', '吨',
                        'emissionFactor', c.factor_tco2_t) AS process_json
       FROM emission_calc c
      WHERE c.total_tco2 > 100000
      ORDER BY c.total_tco2 DESC
      LIMIT ?`, [LIMIT]);
}

console.log(`
【一】取数：${facilities.length} 家真实设施`
  + `（数据源=${SOURCE_TIER === 'CN_ONLY_OFFICIAL' ? '国内官方统计层 cn-only，排放 > 10 万吨' : 'Climate TRACE，排放 > 50 万吨'}）`);
if (!facilities.length) {
  console.error('✘ 未取到真实设施数据。请检查国内层 emission_calc 或全球层导入。');
  process.exit(1);
}
for (const f of facilities.slice(0, 3)) {
  const ev = f.process_json;
  console.log(`   · ${f.name}（${f.industry}）A=${ev.activity} ${ev.activityUnit || ''}`
    + ` EF=${Number(ev.emissionFactor).toFixed(6)} E=${(Number(f.total_co2e) / 1e6).toFixed(3)} Mt`);
}

/* ------------------------------------------------------------------ */
/* 二、为每座设施构造 ZK 证明并验证                                    */
/* ------------------------------------------------------------------ */
console.log('\n【二】对真实设施生成公式证明 E = Σ EF·AD 并验证');

/* ⚠ 量纲：ZK 的定点表示要求 eScale = efScale + adScale。
 * 真实数据的 A 是整数 MWh（8 位有效数字以内），EF 是 6 位小数。
 * 因此取 adScale=0、efScale=6、eScale=6 —— 与真实数据的精度匹配。
 * 这不是"凑一个能过的参数"：如果取 adScale=3，A 会被截断成千位整数，
 * 那证明的就是另一个数了。 */
const EF_SCALE = 6;
const AD_SCALE = 3;
const E_SCALE = EF_SCALE + AD_SCALE;

let proved = 0;
let verified = 0;
let skipReason = '';

for (const f of facilities) {
  const ev = f.process_json;
  const activity = Number(ev.activity);
  const ef = Number(ev.emissionFactor);
  const emission = Number(f.total_co2e);
  if (!Number.isFinite(activity) || !Number.isFinite(ef) || !Number.isFinite(emission)) continue;
  if (activity <= 0 || ef <= 0 || emission <= 0) continue;

  /* 把真实值转成 ZK 定点整数。
   * ⚠ 真实数据的 activity 可能是 32,850,000（8 位），乘 10^3 后是 3.285e10，
   * 仍在 2^53 安全整数范围内，但已接近承诺所要求的位宽上限。
   * 这里显式检查，超范围就跳过并记录原因 —— 而不是让它在底层悄悄溢出。 */
  const adInt = Math.round(activity * 10 ** AD_SCALE);
  const efInt = Math.round(ef * 10 ** EF_SCALE);
  if (!Number.isSafeInteger(adInt) || !Number.isSafeInteger(efInt)) {
    skipReason = '真实量级超出定点安全范围';
    continue;
  }
  if (adInt > 2 ** 48) { skipReason = '活动量超出承诺位宽（2^48）'; continue; }

  /* ⚠ 量纲：efInt × adInt 天然带 10^(EF_SCALE + AD_SCALE) 的标度，
   * 而 E_SCALE 就等于这个和。所以 eInt **就是**这两个整数的乘积，
   * 不需要再除/乘任何 10 的幂。原实现多除了一个 10^EF_SCALE，
   * 导致 eInt 与 Σ efInt×adInt 差 10^EF_SCALE 倍 —— 这是典型的量纲错误，
   * 也正好说明为什么这类检验必须拿真实量级来跑。
   *
   * ⚠⚠ 而且必须用 BigInt：真实设施的量级下 efInt×adInt 可达 3.5e16，
   * 超过 Number.MAX_SAFE_INTEGER（9.007e15）。用 Number 会让低几位静默丢失，
   * 证明会"生成成功但验证失败"，而失败原因指向验证器 —— 那是假线索。
   * ZK 内核本身全程 BigInt（见 zkCarbon.buildFormulaProof），此处必须一致。 */
  const eIntBig = BigInt(efInt) * BigInt(adInt);

  let proof = null;
  try {
    proof = ZK.buildFormulaProofFromValues
      ? ZK.buildFormulaProofFromValues({
        sources: [{ code: 'REAL', label: `${f.name} 实测`, efInt, adInt }],
        eInt: eIntBig,
        efScale: EF_SCALE, adScale: AD_SCALE, eScale: E_SCALE,
        label: f.name,
      })
      : null;
  } catch (e) {
    skipReason = `构造异常：${e.message.slice(0, 60)}`;
  }
  if (!proof) continue;
  proved++;

  const v = ZK.verifyFormulaProof({ publicPayload: proof.publicPayload });
  if (v.ok) verified++;
  else skipReason = v.reason;

  /* 结构化泄漏检查：公开包里不得出现原始活动量。
   * ⚠ 不能用子串匹配：length ≥ 10 的才算，短数字在 hex 里命中概率极高。 */
  const pub = JSON.stringify(proof.publicPayload);
  const adStr = String(Math.round(activity));
  if (adStr.length >= 10 && pub.includes(adStr)) {
    check(`${f.name}：公开包不泄漏活动量`, false, `出现原始值 ${adStr}`);
  }
}

check('真实设施公式证明：可构造', proved > 0,
  `${proved}/${facilities.length} 家` + (proved === 0 && skipReason ? `（${skipReason}）` : ''));
check('真实设施公式证明：可验证', verified === proved && proved > 0,
  `${verified}/${proved} 通过`);

/* ------------------------------------------------------------------ */
/* 三、阴性对照 —— 证明"验证器真的在验证"                              */
/* ------------------------------------------------------------------ */
console.log('\n【三】阴性对照（错误证明必须失败，否则"通过"没有意义）');

if (proved > 0) {
  /* 取第一份有效证明做篡改 */
  const f0 = facilities[0];
  const ev0 = f0.process_json;
  const adInt = Math.round(Number(ev0.activity) * 10 ** AD_SCALE);
  const efInt = Math.round(Number(ev0.emissionFactor) * 10 ** EF_SCALE);
  const eInt = BigInt(efInt) * BigInt(adInt);

  const build = (delta) => ZK.buildFormulaProofFromValues({
    sources: [{ code: 'REAL', label: 'tamper-test', efInt, adInt }],
    eInt: eInt + BigInt(delta),
    efScale: EF_SCALE, adScale: AD_SCALE, eScale: E_SCALE,
    label: 'tamper-test',
  });

  const good = build(0);
  const vGood = ZK.verifyFormulaProof({ publicPayload: good.publicPayload });
  check('基准：真实值的证明通过', vGood.ok);

  /* ① 谎报排放量（改 +30%，模拟"少报三成"） */
  let caught = false;
  try {
    const bad = build(Number(eInt) * 0.30 | 0);
    const vb = ZK.verifyFormulaProof({ publicPayload: bad.publicPayload });
    caught = !vb.ok;
  } catch (e) { caught = true; /* 无法构造证明也是拦截成功 */ }
  check('谎报排放量 +30% 被拒', caught);

  /* ② 篡改公开包里的目标值（不改见证，直接改 eCommit/系数） */
  let caught2 = false;
  try {
    const tampered = JSON.parse(JSON.stringify(good.publicPayload));
    if (typeof tampered.eCommit === 'string' && tampered.eCommit.length > 8) {
      const c = tampered.eCommit;
      tampered.eCommit = c.slice(0, -2) + (c.slice(-2) === '00' ? '11' : '00');
      const vt = ZK.verifyFormulaProof({ publicPayload: tampered });
      caught2 = !vt.ok;
    } else if (Array.isArray(tampered.terms) && tampered.terms.length) {
      tampered.terms[0].coef = String(Number(tampered.terms[0].coef) + 1);
      const vt = ZK.verifyFormulaProof({ publicPayload: tampered });
      caught2 = !vt.ok;
    } else {
      caught2 = false;
    }
  } catch (e) { caught2 = true; }
  check('篡改公开包目标值被拒', caught2);

  /* ③ 跨设施挪用：用 A 的证明去证 B 的批次（label/digest 不同） */
  let caught3 = false;
  try {
    const stolen = JSON.parse(JSON.stringify(good.publicPayload));
    stolen.label = '另一家企业的批次';
    const vs = ZK.verifyFormulaProof({ publicPayload: stolen });
    caught3 = !vs.ok;
  } catch (e) { caught3 = true; }
  check('跨设施挪用证明被拒', caught3);
} else {
  check('阴性对照（无有效证明可篡改，跳过）', false, '未构造出证明');
}

/* ------------------------------------------------------------------ */
/* 四、隐私强度：公开包大小与内容                                      */
/* ------------------------------------------------------------------ */
console.log('\n【四】隐私强度指标');

if (proved > 0) {
  const f0 = facilities[0];
  const ev0 = f0.process_json;
  const adInt = Math.round(Number(ev0.activity) * 10 ** AD_SCALE);
  const efInt = Math.round(Number(ev0.emissionFactor) * 10 ** EF_SCALE);
  const eInt = BigInt(efInt) * BigInt(adInt);
  const p = ZK.buildFormulaProofFromValues({
    sources: [{ code: 'REAL', label: 'metric-test', efInt, adInt }],
    eInt, efScale: EF_SCALE, adScale: AD_SCALE, eScale: E_SCALE, label: 'metric-test',
  });

  const pubBytes = Buffer.byteLength(JSON.stringify(p.publicPayload), 'utf8');
  check('公开包体积 < 2 KB', pubBytes < 2048, `${pubBytes} 字节`);

  /* 结构化泄漏检查：把源数据里所有"敏感数字"逐个与公开包的字段比对。
   *
   * ⚠ 判据必须能真正执行，不能形同虚设。
   * 原实现只筛 length ≥ 10 的数字做子串检查，结果所有候选都被筛掉了
   * （A=18315903 是 8 位、EF=1.9000 是 6 位、E=34800000 是 8 位），
   * 于是输出"检查 0 个敏感数值，均未出现"—— 这句话技术上是真的，
   * 但它没有检查任何东西。**一个永远通过的检查比没有检查更危险**，
   * 因为它会让人以为这一项已被覆盖。
   *
   * 正确做法分两档：
   *   ① 长度 ≥ 10 → 做子串匹配（误报率足够低）；
   *   ② 长度 < 10 → 做"字段整体相等"匹配：遍历公开包所有字符串字段，
   *      若某字段的值正好等于该敏感串，才算泄漏。短串只有在整字段相等时才算，
   *      既不会因 hex 子串误报，又不会漏掉"A 被原样写进某字段"这种真泄漏。
   */
  const candidates = new Set();
  const actNum = Number(ev0.activity);
  const emiNum = Number(f0.total_co2e);
  candidates.add(String(Math.round(actNum)));
  candidates.add(actNum.toFixed(2));
  candidates.add(String(Math.round(emiNum)));
  candidates.add(emiNum.toFixed(2));
  candidates.add(Number(ev0.emissionFactor).toFixed(4));
  candidates.add(String(adInt));            // 定点整数形态同样是敏感值
  const sensitive = [...candidates].filter((s) => s && s !== 'NaN');

  const pubStr = JSON.stringify(p.publicPayload);
  const longLeaks = sensitive.filter((s) => s.length >= 10 && pubStr.includes(s));

  const walk = (obj, out) => {
    if (obj === null || obj === undefined) return;
    if (typeof obj === 'string') { out.push(obj); return; }
    if (typeof obj === 'number') { out.push(String(obj)); return; }
    if (Array.isArray(obj)) { obj.forEach((x) => walk(x, out)); return; }
    if (typeof obj === 'object') Object.values(obj).forEach((x) => walk(x, out));
  };
  const fields = [];
  walk(p.publicPayload, fields);
  const shortLeaks = sensitive
    .filter((s) => s.length < 10)
    .filter((s) => fields.some((f) => f === s));

  const leaked = [...new Set([...longLeaks, ...shortLeaks])];
  check('公开包不含可识别的原始敏感数值', leaked.length === 0,
    leaked.length
      ? `泄漏：${leaked.join(', ')}`
      : `检查 ${sensitive.length} 个敏感数值形态（整数/两位小数/定点整数），均未出现`);

  /* 见证必须存在且只在 privateWitness 里，不在 publicPayload 里 */
  const hasWitness = !!p.privateWitness;
  const witnessInPublic = JSON.stringify(p.publicPayload).includes(
    String(p.privateWitness && p.privateWitness.e ? p.privateWitness.e : '__none__'));
  check('见证与公开包物理分离', hasWitness && !witnessInPublic);
}

/* ------------------------------------------------------------------ */
/* 五、输出                                                           */
/* ------------------------------------------------------------------ */
const summary = {
  year: YEAR,
  facilitiesExamined: facilities.length,
  proofsBuilt: proved,
  proofsVerified: verified,
  pass, fail,
  verdict: fail === 0 ? 'PASS' : 'FAIL',
  generatedAt: new Date().toISOString(),
};

console.log('\n' + '='.repeat(78));
console.log(`  结果：${pass} 通过 / ${fail} 失败`);
console.log(`  结论：${fail === 0
  ? '零知识核算协议在真实设施数据上端到端可用，阴性对照全部拦截。'
  : '存在失败项，协议在真实数据上的可用性未得到证明。'}`);
console.log('='.repeat(78));

if (JSON_OUT) {
  console.log(JSON.stringify({ summary, results }, null, 2));
}

/* 写机读结果供证据包引用 */
try {
  const fs = require('node:fs');
  const outDir = path.join(ROOT, 'tools', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'zk-real-data-check.json'),
    JSON.stringify({ summary, results }, null, 2), 'utf8');
} catch (e) {
  console.warn('⚠ 未能写出结果文件：', e.message);
}

process.exit(fail === 0 ? 0 : 1);
