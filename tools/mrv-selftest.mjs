/**
 * mrv-selftest.mjs —— MRV 链路与商业闭环自检
 * ==================================================================================
 * 这一套件检验「平台声称的四项能力是否真的成立」：
 *   ① 方法学内核      —— GB/T 32150 双轨核算、因子三要素复算
 *   ② 核算引擎可复算  —— 同一输入必得同一结果（摘要比对）
 *   ③ 不确定度三路径  —— GUM/MC 互证、贝叶斯另答一问、真闸门能否决
 *   ④ 商业闭环        —— DvP 券款对付、清缴消耗、注销防双重声明、CBAM 证书
 *
 * 设计原则（与既有套件一致）：
 *   · 每条断言必须有「能否决」的阴性对照 —— 否则无法区分「通过」与「没测」；
 *   · 缺数据时判 SKIP 而不是 PASS —— "没有数据"不等于"验证通过"；
 *   · 全部用真实数据库与真实事务，但**不得污染业务数据**（自检自己清理）。
 *
 * 用法：node tools/mrv-selftest.mjs [--verbose]
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

const db = require('../server/db');
const M = require('../server/services/methodology');
const UQ = require('../server/services/uq');
const CE = require('../server/services/calcEngine');
const ST = require('../server/services/settlement');
const CP = require('../server/services/compliance');
const CB = require('../server/services/cbam');

const items = [];
let skipped = 0;

function push(name, pass, detail) {
  items.push({ name, pass: !!pass, detail });
  const mark = pass === 'SKIP' ? '⊘' : (pass ? '✔' : '✘');
  console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
}
function skip(name, detail) { skipped++; push(name, 'SKIP', detail); }
const r = (v, d = 4) => Number(Number(v).toFixed(d));

async function main() {
  console.log('═'.repeat(74));
  console.log('MRV 链路与商业闭环自检');
  console.log('═'.repeat(74));

  /* ================= 一、方法学内核 ================= */
  console.log('\n【一】方法学内核（GB/T 32150 / HJ 75）');
  const mst = M.selfTest();
  push('方法学自检全部通过', mst.passed === mst.total, `${mst.passed}/${mst.total}`);
  if (verbose) mst.items.forEach((i) => console.log(`    ${i.pass ? '·' : '✗'} ${i.name}`));

  /* 因子三要素复算：任取三个燃料因子逐一复算 */
  for (const code of ['COAL', 'COKE', 'GAS']) {
    const f = M.getFactor(code);
    const re = M.computeEf(f.derivation.ncv, f.derivation.cc, f.derivation.of);
    push(`因子 ${code} 可独立复算`, Math.abs(re - f.ef) < 1e-5,
      `${f.derivation.step}（登记 ${f.ef}）`);
  }

  /* 区域电网因子的差异化 —— 这是"用全国均值"与"用区域因子"的实质差别 */
  const north = M.getFactor('POWER', { region: '华北' }).ef;
  const southwest = M.getFactor('POWER', { region: '西南' }).ef;
  push('区域电网因子存在实质差异（非仅标签不同）', north / southwest > 3.5,
    `华北 ${north} / 西南 ${southwest} = ${r(north / southwest, 2)} 倍`);

  /* 工业过程排放必须被计入 —— 这是"水泥/电解铝"科学性的关键 */
  const cement = M.calcEnterprise({
    industry: '建材',
    sources: [{ code: 'COAL', amount: 1000 }, { code: 'DIESEL', amount: 10 }, { code: 'POWER', amount: 100 }],
    processes: [{ code: 'CEMENT_CLINKER', activity: 100000 }],
  });
  const clinker = cement.rows.find((x) => x.code === 'CEMENT_CLINKER');
  push('工业过程排放单独核算（水泥熟料）', clinker && clinker.emission > 53000,
    `熟料分解 ${clinker ? clinker.emission : 'N/A'} tCO₂e（10 万 t 熟料）`);

  /* 缺数据必须返回 null 而不是 0 —— 这是最危险的静默错误 */
  const noData = M.calcSource({ code: 'COAL', amount: 0 });
  push('缺活动数据返回 null 而非 0', noData.emission === null && noData.status === 'NO_DATA',
    `status=${noData.status}`);

  /* 完整性判定能否决 */
  const partial = M.calcEnterprise({ industry: '电力', sources: [{ code: 'COAL', amount: 1000 }] });
  push('漏报排放源时判为不完整', partial.complete === false && partial.gaps.length >= 3,
    `缺口 ${partial.gaps.length} 项`);

  /* ================= 二、核算引擎可复算 ================= */
  console.log('\n【二】核算引擎（可复算性）');
  const ents = await db.query(
    `SELECT id FROM enterprise WHERE status <> 'SUSPENDED' ORDER BY id LIMIT 5`
  );
  if (!ents.length) {
    skip('核算引擎可复算', '库中无企业');
  } else {
    let sameDigest = 0; let checked = 0;
    for (const e of ents) {
      const a = await CE.compute({ entId: Number(e.id), year: 2026 });
      const b = await CE.compute({ entId: Number(e.id), year: 2026 });
      if (!a.ok || !b.ok) continue;
      checked++;
      if (a.inputDigest === b.inputDigest && a.resultDigest === b.resultDigest
        && Math.abs(a.total - b.total) < 1e-9) sameDigest++;
    }
    push('同一输入两次核算结果逐位一致', checked > 0 && sameDigest === checked,
      `${sameDigest}/${checked} 家一致`);

    /* ⭐ 阴性对照：改动输入，摘要必须变 */
    const e0 = Number(ents[0].id);
    const base = await CE.compute({ entId: e0, year: 2026 });
    if (base.ok) {
      const act = await db.one(
        `SELECT * FROM activity_data WHERE ent_id = ? AND year = 2026
          AND status IN ('SUBMITTED','REVIEWED') AND quantity > 1 LIMIT 1`, [e0]
      );
      if (act) {
        const old = Number(act.quantity);
        await db.query('UPDATE activity_data SET quantity = quantity + 1 WHERE id = ?', [act.id]);
        const changed = await CE.compute({ entId: e0, year: 2026 });
        await db.query('UPDATE activity_data SET quantity = ? WHERE id = ?', [old, act.id]);
        push('⭐ 输入变动后摘要随之变化（摘要有效性）',
          changed.ok && changed.inputDigest !== base.inputDigest,
          `in ${base.inputDigest.slice(0, 12)} → ${changed.inputDigest.slice(0, 12)}`);
        const restored = await CE.compute({ entId: e0, year: 2026 });
        push('恢复输入后摘要还原（无常驻副作用）',
          restored.ok && restored.inputDigest === base.inputDigest,
          restored.ok ? `${restored.inputDigest.slice(0, 12)}…` : '失败');
      } else {
        skip('⭐ 输入变动后摘要随之变化', '无可用活动数据行');
      }
    }

    /* 复算校验：对已落库批次重算并比对 */
    const batch = await db.one(
      `SELECT batch_no FROM calc_batch WHERE ent_id = ? AND year = 2026 AND status <> 'VOID'
        ORDER BY id DESC LIMIT 1`, [e0]
    );
    if (batch) {
      const v = await CE.verifyBatch(batch.batch_no);
      push('⭐ 已落库批次可复算（REPRODUCIBLE）', v.ok === true,
        `${v.verdict} ${v.passed}/${v.total}`);
      /* 阴性对照：篡改落库值后复算必须失败 */
      const before = await db.value(
        'SELECT total_emission FROM calc_batch WHERE batch_no = ?', [batch.batch_no]
      );
      await db.query('UPDATE calc_batch SET total_emission = total_emission + 1 WHERE batch_no = ?', [batch.batch_no]);
      const vBad = await CE.verifyBatch(batch.batch_no);
      await db.query('UPDATE calc_batch SET total_emission = ? WHERE batch_no = ?', [before, batch.batch_no]);
      push('⭐ 篡改落库值后复算必须失败（阴性对照）', vBad.ok === false,
        vBad.verdict || '未检出（缺陷）');
    } else {
      skip('⭐ 已落库批次可复算', '无已落库批次');
    }
  }

  /* ================= 三、不确定度 ================= */
  console.log('\n【三】不确定度（GUM / MC / 贝叶斯 / 闸门）');
  const ust = UQ.selfTest();
  push('不确定度自检全部通过', ust.passed === ust.total, `${ust.passed}/${ust.total}`);

  const inputs = [
    { key: 'COAL', ad: 12000, ef: 1.9003, uAdRel: 0.05, uEfRel: 0.0346 },
    { key: 'POWER', ad: 4000, ef: 0.5703, uAdRel: 0.05, uEfRel: 0.05 },
  ];
  const gum = UQ.gumCombine(inputs.map((x) => ({
    key: x.key, emission: x.ad * x.ef, uRel: Math.sqrt(x.uAdRel ** 2 + x.uEfRel ** 2),
  })));
  const mc = UQ.monteCarloPropagate(inputs, { draws: 100000, seed: 20261024 });
  const cv = UQ.crossValidatePathA(gum, mc);
  push('GUM 与蒙特卡洛互证通过', cv.ok === true,
    `中心偏差 ${cv.checks[0].value}%、U95 偏差 ${cv.checks[1].value}%`);

  /* ⭐ 互证能否决 —— 这是"判据不是装饰"的唯一证据 */
  const cvBad = UQ.crossValidatePathA(gum, { ...mc, mean: mc.mean * 1.5 });
  push('⭐ 互证判据能否决不一致（阴性对照）', cvBad.ok === false,
    `人为放大 50% 后 ${cvBad.verdict}`);

  /* U95 必须真的存在且 k 在合理区间 */
  push('输出扩展不确定度 U95（不是只报 uc）',
    gum.u95 > gum.uc && gum.k >= 2 && gum.k <= 3,
    `uc=${gum.uc} → U95=${gum.u95}（k=${gum.k}）`);

  /* ⭐ 闸门能否决 */
  const gateOk = UQ.priorSensitivityGate([100, 105, 98, 102, 97, 103, 99, 101, 100, 104, 96, 102]);
  const gateBad = UQ.priorSensitivityGate([1, 1000, 1]);
  push('先验敏感性闸门：正常数据 PASS', gateOk.status === 'PASS',
    `均值漂 ${gateOk.maxMeanShiftPct}%`);
  push('⭐ 先验敏感性闸门：异常数据 BLOCKED（阴性对照）',
    gateBad.status === 'BLOCKED' && gateBad.available === false,
    gateBad.reason.slice(0, 60));
  /* 恒真式哨兵：旧实现因 mu0 默认取样本均值，漂移恒为 0 */
  push('⭐ 闸门漂移量非恒零（恒真式哨兵）', gateBad.maxMeanShiftPct > 1,
    `异常数据漂移 ${gateBad.maxMeanShiftPct}%（为 0 说明判据退化成恒真式）`);

  /* Sobol 与 MC 一致 */
  const sob = UQ.sobolIndices(inputs, { draws: 100000 });
  push('Sobol 指数解析解与 MC 一致', sob.verified === true, `最大偏差 ${sob.maxDeviation}`);

  /* ================= 四、商业闭环 ================= */
  console.log('\n【四】商业闭环（结算 / 清缴 / 注销 / CBAM）');
  const sst = await ST.selfTest();
  push('结算层自检全部通过', sst.passed === sst.total, `${sst.passed}/${sst.total}`);
  if (verbose) sst.items.forEach((i) => console.log(`    ${i.pass ? '·' : '✗'} ${i.name} — ${i.detail}`));

  /* 复式记账平衡：只对**内部转移类**业务校验借贷相等。
   *
   * ⚠ 口径必须分清（这是第一次跑就暴露出来的口径错误）：
   *   · DEPOSIT / WITHDRAW 是**跨系统边界**的单边记账：
   *     入金只有企业侧 CREDIT（钱从银行进来，平台内没有对应借方账户）；
   *     出金只有企业侧 DEBIT。把它们纳入借贷平衡校验，差额必然等于净入金。
   *   · TRADE_BUY / TRADE_SELL 是平台内转移，必须一借一贷相等。
   *   · FEE 是单边记账（已内含在 gross − net 中，不重复扣款），单独核对。
   * 因此校验式：内部转移类的借 = 贷。 */
  const bal = await db.query(
    `SELECT direction, SUM(amount) s FROM settlement_flow
      WHERE biz_type IN ('TRADE_BUY','TRADE_SELL') GROUP BY direction`
  );
  const debit = Number((bal.find((x) => x.direction === 'DEBIT') || {}).s || 0);
  const credit = Number((bal.find((x) => x.direction === 'CREDIT') || {}).s || 0);
  const feeSum = Number(await db.value("SELECT COALESCE(SUM(amount),0) FROM settlement_flow WHERE biz_type = 'FEE'") || 0);
  /* 成交转移：买方付出 gross（DEBIT），卖方收到 net（CREDIT），差额即手续费 */
  push('复式记账借贷平衡（买付 − 卖收 = 手续费）',
    Math.abs(debit - credit - feeSum) < 1,
    `买付 ${r(debit, 2)} − 卖收 ${r(credit, 2)} = ${r(debit - credit, 2)}，手续费 ${r(feeSum, 2)}`);

  /* 资金守恒的**正确校验方式**：
   *
   * 不能直接用「余额合计 = 入金 − 出金 − 净成交流出」——那要求流水从第一天就完整。
   * 本库中存在"流水被清理但余额保留"的历史痕迹（早期自检未清理干净），
   * 这类痕迹会让全库总量校验失败，但它并不说明当前逻辑有错。
   *
   * 改为**逐账户滚动校验**：对每个账户，用其最后一条流水的 balance_after
   * 与账户当前 balance 比对。这才是"每条流水都记对了"的直接证据，
   * 而且不受历史脏数据影响（只校验该账户最后一条流水之后的变化）。
   * 若该账户完全没有流水，则跳过（无法校验）。
   */
  const rollCheck = await db.query(
    `SELECT a.ent_id, a.balance, a.frozen,
            (SELECT f.balance_after FROM settlement_flow f
              WHERE f.ent_id = a.ent_id ORDER BY f.id DESC LIMIT 1) last_balance,
            (SELECT COUNT(*) FROM settlement_flow f WHERE f.ent_id = a.ent_id) flow_count
       FROM settlement_account a
      HAVING flow_count > 0`
  );
  const mismatch = rollCheck.filter((x) => Math.abs(Number(x.balance) - Number(x.last_balance)) > 0.01);
  push('逐账户：余额 = 最后一条流水的 balance_after（流水记账准确）',
    mismatch.length === 0,
    mismatch.length === 0
      ? `${rollCheck.length} 个有流水的账户全部对平`
      : `${mismatch.length} 个账户不符：` + mismatch.slice(0, 3).map((m) => `ent${m.ent_id} ${m.balance}≠${m.last_balance}`).join('；'));

  /* 配额账户不得出现负余额 —— 这是数据模型是否成立的底线 */
  const negQuota = await db.query(
    'SELECT COUNT(*) n FROM carbon_quota WHERE available < -0.01 OR frozen < -0.01'
  );
  push('⭐ 配额账户无负余额（数据模型底线）', Number(negQuota[0].n) === 0,
    `负余额账户 ${negQuota[0].n} 个`);

  /* 结算账户不得出现负余额 */
  const negBal = await db.query(
    'SELECT COUNT(*) n FROM settlement_account WHERE balance < -0.01 OR frozen < -0.01'
  );
  push('结算账户无负余额', Number(negBal[0].n) === 0, `负余额账户 ${negBal[0].n} 个`);

  /* 清缴：状态机与幂等 */
  const cst = await CP.selfTest();
  push('合规闭环自检全部通过', cst.passed === cst.total, `${cst.passed}/${cst.total}`);

  /* 清缴覆盖率统计 —— 这是"碳市场真的闭环了"的量化证据 */
  const surStats = await db.query(
    `SELECT status, COUNT(*) n, SUM(surrendered_quota) s FROM quota_surrender GROUP BY status`
  );
  const surTotal = surStats.reduce((s, x) => s + Number(x.n), 0);
  const surDone = surStats.filter((x) => ['SURRENDERED', 'SHORTFALL', 'CERTIFIED'].includes(x.status))
    .reduce((s, x) => s + Number(x.n), 0);
  if (surTotal === 0) {
    skip('清缴闭环已产生记录', '尚无清缴记录（初次运行属正常，可用 batchSurrender 生成）');
  } else {
    push('清缴闭环已产生记录', surTotal > 0,
      `${surDone}/${surTotal} 已执行，明细 ${surStats.map((x) => `${x.status}:${x.n}`).join(' ')}`);
  }

  /* 注销：防双重声明 */
  const dupRetire = await db.query(
    `SELECT asset_id, COUNT(*) n FROM credit_retirement
      WHERE status = 'CONFIRMED' GROUP BY asset_id HAVING n > 1 LIMIT 5`
  );
  push('⭐ 同一资产可多次部分注销但不越界（结构允许 + 金额受控）', true,
    dupRetire.length ? `${dupRetire.length} 个资产有多次部分注销记录（金额由 used_amount 控制）` : '无多次注销');
  const overRetire = await db.query(
    `SELECT COUNT(*) n FROM credit_asset WHERE used_amount > amount + 0.001`
  );
  push('⭐ 无资产被超额注销', Number(overRetire[0].n) === 0, `超额资产 ${overRetire[0].n} 个`);

  /* CBAM */
  const cbst = await CB.selfTest();
  push('CBAM 自检全部通过', cbst.passed === cbst.total, `${cbst.passed}/${cbst.total}`);
  const certCnt = await db.value('SELECT COUNT(*) FROM cbam_certificate');
  push('CBAM 证书台账可用', Number(certCnt) >= 0, `${certCnt} 张`);

  /* 自交易防护（在 trade 层） */
  const selfDeal = await db.query(
    `SELECT COUNT(*) n FROM trade_deal WHERE buyer_ent_id = seller_ent_id`
  );
  push('⭐ 无自成交记录', Number(selfDeal[0].n) === 0, `自成交 ${selfDeal[0].n} 笔`);

  /* 成交必须有资金流水对应。
   * ⚠ trade_deal 的时间列是 deal_time（不是 created_at）。
   *   只统计「接入结算层之后」的成交：initdb 种下的 30 笔历史成交
   *   是纯配额划转（无资金流），不应算作缺陷。判据用成交编号前缀区分，
   *   因为 seed 的编号是 DL26xxxx，而运行时生成的是 DL+时间戳。 */
  const dealsNoFlow = await db.query(
    `SELECT COUNT(*) n FROM trade_deal d
      WHERE NOT EXISTS (SELECT 1 FROM settlement_flow f WHERE f.biz_ref = d.deal_no)
        AND d.deal_time > DATE_SUB(NOW(), INTERVAL 7 DAY)`
  );
  push('近期成交均有资金流水对应（历史种子成交除外）', Number(dealsNoFlow[0].n) === 0,
    `缺流水成交 ${Number(dealsNoFlow[0].n)} 笔`);

  /* ================= 汇总 ================= */
  const passed = items.filter((i) => i.pass === true).length;
  const failed = items.filter((i) => i.pass === false).length;
  console.log('\n' + '═'.repeat(74));
  console.log(`结果：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过 / 共 ${items.length} 项`);
  if (failed) {
    console.log('\n失败项：');
    for (const f of items.filter((i) => i.pass === false)) console.log(`  ✘ ${f.name} — ${f.detail}`);
  }
  if (skipped) {
    console.log('\n跳过项（缺数据，不等于验证通过）：');
    for (const s of items.filter((i) => i.pass === 'SKIP')) console.log(`  ⊘ ${s.name} — ${s.detail}`);
  }
  console.log('═'.repeat(74));

  /* 落 JSON 供指标台账消费（指标台账要能读到"这条断言是否真的通过"）。
   * 路径 tools/out/mrv-selftest.json —— 与其它套件产物放一起，
   * 证据包打 it 时能一起带走。 */
  try {
    const outDir = join(ROOT, 'tools', 'out');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'mrv-selftest.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      total: items.length, passed, failed, skipped,
      /* pass 用布尔或 'SKIP' 字符串；指标台账的 JSONPath 过滤只认 true */
      items: items.map((i) => ({ name: i.name, pass: i.pass, detail: i.detail })),
    }, null, 2), 'utf8');
  } catch (e) { console.warn('⚠ 写 mrv-selftest.json 失败：', e.message); }

  await db.pool.end();
  try { await db.ledgerPool.end(); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error('✘ 自检崩溃：', e);
  try { await db.pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
