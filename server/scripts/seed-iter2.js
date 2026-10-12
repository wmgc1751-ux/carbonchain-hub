/**
 * seed-iter2.js —— 第 2 轮种子：补齐 WP5 / WP4 / WP2 的业务台账
 * ==================================================================
 * 为什么需要这个脚本
 *   `npm run initdb` 只负责第 1 轮基准（企业 / 配额 / 上报 / 实测读数 / 联盟链）。
 *   第 2 轮新增的六张表在 initdb 之后是**空的**：
 *     cbam_declaration / green_power_match / report_export /
 *     uncertainty_posterior / model_eval / key_rotation_log
 *   于是 CBAM 申报、绿电溯源、双轨报告、不确定度台账、密钥轮换台账
 *   这些页面会全部落在空态 —— 演示时看着像"没做完"。
 *
 *   本脚本在**第 1 轮基准之上**补齐这些台账，且全部调用**真实服务层**：
 *   不是往表里塞假行，而是走 `I.generateDeclaration` / `I.exportReport` /
 *   `U.recomputeAll` / `KM.requestRotation+approveRotation` 这些生产代码路径，
 *   因此种出来的数据与业务逻辑必然一致（含上链存证）。
 *
 * 用法
 *   npm run initdb && node server/scripts/seed-iter2.js
 *   （package.json 里注册为 npm run seed:iter2）
 *
 * 幂等性
 *   · 绿电匹配、CBAM 申报、双轨报告、后验区间：服务层按业务主键覆盖或先清后写
 *   · 密钥轮换：先查是否已存在 APPROVED 记录，存在则跳过
 * ==================================================================
 */
'use strict';

const db = require('../db');
const I = require('../services/international');
const U = require('../services/uncertainty');
const KM = require('../services/keymgmt');

const YEAR = 2026;
/* 上报单种子数据最新到 2026 Q2；用 Q3 会取不到能耗/产值，绿电与 CBAM 都会因缺数据失败 */
const PERIOD = `${YEAR}Q2`;

/** 选择样本企业：覆盖 CBAM 现行管辖的六个行业 + 一家不在管辖内的（造纸），
 *  后者用于演示"该行业不在 CBAM 覆盖范围"的如实提示路径。 */
const SAMPLES = [
  { entId: 2, industry: '钢铁', note: 'CBAM 现行管辖区' },
  { entId: 3, industry: '有色金属', note: 'CBAM 现行管辖区' },
  { entId: 7, industry: '建材', note: 'CBAM 现行管辖区（水泥）' },
  { entId: 4, industry: '化工', note: 'CBAM 现行管辖区（化肥）' },
  { entId: 6, industry: '石化', note: 'CBAM 现行管辖区（氢/氨路径）' },
  { entId: 17, industry: '电力', note: 'CBAM 现行管辖区（电力）' },
  { entId: 1, industry: '造纸', note: '不在 CBAM 覆盖范围 —— 用于演示如实拒绝' },
];

let ok = 0; let skip = 0; let bad = 0;
const line = (state, msg) => {
  if (state === 'ok') ok++; else if (state === 'skip') skip++; else bad++;
  console.log(`  ${state === 'ok' ? '✓' : state === 'skip' ? '△' : '✗'} ${msg}`);
};

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  第 2 轮种子：WP5 国际互认 / WP4 核算升级 / WP2 密码学生产化');
  console.log('══════════════════════════════════════════════════════════════');

  const entCount = Number((await db.one('SELECT COUNT(*) AS n FROM enterprise')).n);
  if (!entCount) {
    console.error('\n✗ 企业表为空 —— 请先执行 npm run initdb。\n');
    process.exit(1);
  }
  const dynCount = Number((await db.one('SELECT COUNT(*) AS n FROM cems_reading')).n);
  if (!dynCount) {
    console.error('\n✗ cems_reading 为空 —— 不确定度模块无数据可算，请先 npm run initdb。\n');
    process.exit(1);
  }
  console.log(`\n  基准检查：企业 ${entCount} 家 / 实测读数 ${dynCount} 条\n`);

  /* ================================================================
   * 一、WP5：小时级绿电匹配（必须先做 —— CBAM 的间接排放扣减依赖它）
   * ================================================================ */
  console.log('【一】WP5 · 小时级绿电匹配');
  for (const s of SAMPLES) {
    try {
      const r = await I.matchGreenPower(s.entId, { year: YEAR, month: 6, days: 7 });
      line('ok', `ent${String(s.entId).padStart(2)} ${s.industry.padEnd(4)} ${String(r.summary.hours).padStart(3)} 小时 · `
        + `覆盖率 ${(r.summary.coverageRatio * 100).toFixed(2)}% · 减碳 ${r.summary.savedTco2} tCO2e`);
    } catch (e) {
      line('bad', `ent${s.entId} ${s.industry} 绿电匹配失败：${e.message}`);
    }
  }

  /* ================================================================
   * 二、WP5：CBAM 申报数据包（试算 + 生成 + 上链）
   * ================================================================ */
  console.log('\n【二】WP5 · CBAM 申报数据包');
  for (const s of SAMPLES) {
    try {
      const calc = await I.productCarbon(s.entId, { period: PERIOD });
      if (!calc.cnCode) {
        line('skip', `ent${String(s.entId).padStart(2)} ${s.industry.padEnd(4)} 不在 CBAM 覆盖范围 —— ${calc.cnReason}`);
        continue;
      }
      const r = await I.generateDeclaration(s.entId, { period: PERIOD });
      line('ok', `ent${String(s.entId).padStart(2)} ${s.industry.padEnd(4)} ${r.declNo} · `
        + `${r.calc.cnGoods} 隐含碳 ${r.calc.embeddedIntensity} tCO2e/${r.calc.unit} · 区块 #${(r.chain && r.chain.blockIndex) || '—'}`);
    } catch (e) {
      line('bad', `ent${s.entId} ${s.industry} CBAM 申报失败：${e.message}`);
    }
  }

  /* ================================================================
   * 三、WP5：双轨报告导出（ISO 14064-1 组织轨 + ISO 14067 产品轨）
   * ================================================================ */
  console.log('\n【三】WP5 · 双轨报告导出');
  for (const s of SAMPLES) {
    for (const std of ['14064', '14067']) {
      try {
        const r = await I.exportReport(s.entId, std, { period: PERIOD, operator: 'seed-iter2' });
        const total = r.payload.totals.total !== undefined
          ? r.payload.totals.total : r.payload.totals.totalEmission;
        line('ok', `ent${String(s.entId).padStart(2)} ${r.std.padEnd(12)} 总量 ${total} tCO2e · 指纹 ${String(r.fileFingerprint).slice(0, 12)}…`);
      } catch (e) {
        line('bad', `ent${s.entId} ${std} 报告导出失败：${e.message}`);
      }
    }
    /* 两轨互证检查：组织总量应 ≥ 产品隐含碳总量 */
    try {
      const org = await db.one(
        `SELECT total_emission FROM report_export WHERE ent_id = ? AND std LIKE '%14064%' ORDER BY id DESC LIMIT 1`, [s.entId]);
      const prod = await db.one(
        `SELECT total_emission FROM report_export WHERE ent_id = ? AND std LIKE '%14067%' ORDER BY id DESC LIMIT 1`, [s.entId]);
      if (org && prod) {
        const a = Number(org.total_emission); const b = Number(prod.total_emission);
        line(a >= b ? 'ok' : 'bad',
          `  └ 两轨互证 ent${s.entId}：组织 ${a} ≥ 产品 ${b} → ${a >= b ? '成立' : '不成立（须复核边界/产量）'}`);
      }
    } catch (e) { /* 互证检查失败不影响种子完整性 */ }
  }

  /* ================================================================
   * 四、WP4：全平台后验区间 + 模型评估落库
   * ================================================================ */
  console.log('\n【四】WP4 · 不确定度后验区间与模型评估（全平台）');
  const t0 = Date.now();
  try {
    const r = await U.recomputeAll({});
    line('ok', `后验区间落库 ${r.saved}/${r.total} 家 · 模型评估落库 ${r.modelEvalRows} 行 · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (r.skipped.length) line('skip', `跳过 ${r.skipped.length} 家（有效观测不足）：${r.skipped.slice(0, 3).map((x) => x.entId).join(',')}…`);
    if (r.failed.length) line('bad', `失败 ${r.failed.length} 家：${r.failed.slice(0, 3).map((x) => x.entId + ':' + x.error).join(' | ')}`);
  } catch (e) {
    line('bad', `批量重算失败：${e.message}`);
  }

  /* 行业汇总抽样打印（证明新口径下覆盖度与相对半宽都落在合理区间） */
  try {
    const ind = await U.industrySummary({ limit: 60 });
    const items = ind.items.filter((x) => x.available);
    console.log(`  · 行业汇总：可评估 ${ind.available}/${ind.scanned} 家 · 平均覆盖度 ${(ind.avgCoverage * 100).toFixed(2)}%`
      + ` · 平均相对半宽 ${(ind.avgRelHalfWidth * 100).toFixed(2)}% · 超工程上限读数 ${ind.totalImplausibleRows} 条`);
    items.slice(0, 4).forEach((x) => {
      console.log(`      ${String(x.entId).padStart(2)} ${x.industry.padEnd(4)} 覆盖 ${(x.coverage * 100).toFixed(1)}%`
        + ` 相对半宽 ${(x.relHalfWidth * 100).toFixed(2)}% 日均 ${x.dailyMean.toFixed(2)} t`);
    });
  } catch (e) { line('bad', `行业汇总失败：${e.message}`); }

  /* ================================================================
   * 五、WP2：一次真实的「申请 → 双人复核 → 生效」密钥轮换
   * ================================================================ */
  console.log('\n【五】WP2 · 密钥轮换（含双人复核强制）');
  const ROT_LABEL = 'gateway:1';
  const existing = await db.one(
    `SELECT id, block_index FROM key_rotation_log WHERE key_label = ? AND approval_status = 'APPROVED' ORDER BY id DESC LIMIT 1`,
    [ROT_LABEL]
  );
  if (existing) {
    line('skip', `${ROT_LABEL} 已有 APPROVED 轮换记录 #${existing.id}（区块 #${existing.block_index || '—'}），跳过以保持幂等`);
  } else {
    try {
      /* 先演示"同一人不得既申请又复核"——服务层必须拒绝 */
      const req = await KM.requestRotation({
        keyLabel: ROT_LABEL, reason: `${YEAR} 年度例行轮换`, requestedBy: 'admin',
      });
      line('ok', `轮换申请已提交：#${req.id} · 当前第 ${req.currentGeneration} 代 · ${String(req.currentAddress).slice(0, 12)}…`);

      try {
        await KM.approveRotation(req.id, { approvedBy: 'admin', note: '自审自批（应被拒绝）' });
        line('bad', '同一人自审自批竟然通过了 —— 双人复核未生效（严重缺陷）');
      } catch (e) {
        line('ok', `同一人自审自批被服务层拒绝 → ${e.message.slice(0, 52)}…`);
      }

      const appr = await KM.approveRotation(req.id, { approvedBy: '监管员·李（复核）', note: '年度例行轮换，批准' });
      line('ok', `双人复核通过：g${appr.oldGeneration.keyId} ${String(appr.oldGeneration.address).slice(0, 12)}… → g${appr.newGeneration.keyId} ${String(appr.newGeneration.address).slice(0, 12)}…`
        + ` · 区块 #${(appr.chain && appr.chain.blockIndex) || '—'}`);

      /* 轮换安全举证：旧签名必须仍能用历史公钥验通过 */
      const demo = KM.rotationSafetyDemo(ROT_LABEL, { bizNo: 'SEED-ITER2-ROTATION', at: '2026-10-12T00:00:00.000Z' });
      line(demo.allPass ? 'ok' : 'bad', `轮换安全举证 ${demo.passed}/${demo.total} 项通过 → ${demo.conclusion.slice(0, 46)}…`);
    } catch (e) {
      line('bad', `密钥轮换失败：${e.message}`);
    }
  }

  /* ================================================================
   * 汇总
   * ================================================================ */
  const counts = {};
  for (const t of ['cbam_declaration', 'green_power_match', 'report_export', 'uncertainty_posterior', 'model_eval', 'key_rotation_log']) {
    counts[t] = Number((await db.one(`SELECT COUNT(*) AS n FROM ${t}`)).n);
  }
  const chain = await db.one('SELECT COUNT(*) AS blocks FROM chain_block');

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(`  种子结果：成功 ${ok} / 跳过 ${skip} / 失败 ${bad}`);
  console.log('  台账规模：');
  Object.keys(counts).forEach((k) => console.log(`    ${k.padEnd(24)} ${counts[k]}`));
  console.log(`    ${'block（联盟链区块）'.padEnd(22)} ${chain.blocks}`);
  console.log(bad === 0 ? '  ✅ 第 2 轮台账已就绪' : '  ❌ 存在失败项，请逐条排查');
  console.log('──────────────────────────────────────────────────────────────\n');
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n✗ 种子脚本异常终止：', (e && e.stack) || e);
  process.exit(2);
});
