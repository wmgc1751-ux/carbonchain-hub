#!/usr/bin/env node
/**
 * tools/verify-supplementary.cjs —— 「补充主体」落地的最终验收
 * ============================================================================
 * 逐项核对：原先空置的功能页面，现在是否有可展示的数据；
 * 且数据来源标识是否正确（真实/派生/演示三者不可混淆）。
 *
 * 任一关键项为 0 即非零退出。
 * ============================================================================
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db'));

const P = (s = '') => console.log(s);
const line = (c = '─', n = 78) => c.repeat(n);

let pass = 0;
let fail = 0;
const check = (ok, label, detail = '') => {
  if (ok) pass++; else fail++;
  P(`  ${ok ? '✔' : '✘'} ${label}${detail ? '  ' + detail : ''}`);
};

(async () => {
  P(line('═'));
  P('补充主体验收：原先空置的功能页面能否展示数据');
  P(line('═'));

  /* ---------- 一、主体 ---------- */
  P('\n【一】新增主体');
  const ents = await db.query('SELECT id, ent_name, industry, ent_code, is_real FROM enterprise ORDER BY id');
  P(`  企业总数 ${ents.length}（原 4 家真实 + 新增 ${ents.length - 4} 家）`);
  for (const e of ents.filter((x) => x.id > 68)) {
    const verified = /^\d{2}\d{6}/.test(String(e.ent_code));
    P(`    #${e.id} ${e.ent_name.slice(0, 26).padEnd(28)} ${String(e.industry).padEnd(10)} `
      + `信用代码 ${verified ? '✔ 已核验' : '⚠ 待核验'}`);
  }
  check(ents.length >= 7, '补充主体已建立', `${ents.length} 家`);

  const newUsers = await db.query(
    "SELECT username, post FROM sys_user WHERE username LIKE 'ent_sg%' OR username LIKE 'ent_hd%' OR username LIKE 'ent_zb%'"
  );
  check(newUsers.length >= 9, '岗位账号按体系建立',
    `${newUsers.length} 个：${newUsers.map((u) => u.post).join('/')}`);

  /* ---------- 二、各功能页数据 ---------- */
  P('\n【二】原先空置的功能页面');

  const cbam = await db.query('SELECT cn_code, goods_name, embedded_intensity FROM cbam_declaration');
  check(cbam.length > 0, 'CBAM 证书：申报包已生成',
    cbam.length ? `${cbam.length} 份，${cbam[0].cn_code} ${cbam[0].goods_name} 强度 ${Number(cbam[0].embedded_intensity).toFixed(2)}` : '0 份');

  const assets = await db.query('SELECT asset_type, COUNT(*) n, SUM(amount) s FROM credit_asset GROUP BY asset_type');
  check(assets.length > 0, '碳信用与抵销：资产已建立',
    assets.map((a) => `${a.asset_type}=${a.n}条/${Number(a.s).toLocaleString()}`).join(' '));

  const gec = await db.query('SELECT COUNT(*) n, SUM(energy_mwh) s FROM green_cert');
  check(Number(gec[0].n) > 0, '绿电溯源：绿证台账已建立',
    `${gec[0].n} 张 / ${Number(gec[0].s || 0).toLocaleString()} MWh`);

  const gpm = await db.query(
    'SELECT COUNT(*) n, COUNT(DISTINCT ent_id) e, AVG(coverage_ratio) c FROM green_power_match'
  );
  check(Number(gpm[0].n) > 0, '绿电溯源：小时级匹配已生成',
    `${gpm[0].n} 小时 / ${gpm[0].e} 家 / 平均覆盖 ${(Number(gpm[0].c || 0) * 100).toFixed(1)}%`);

  const act = await db.query('SELECT source_code, COUNT(*) n FROM activity_data GROUP BY source_code');
  check(act.length > 0, '活动数据台账：已生成',
    act.map((a) => `${a.source_code}=${a.n}`).join(' '));

  const cb = await db.query('SELECT COUNT(*) n FROM calc_batch');
  check(Number(cb[0].n) > 0, '核算批次：已生成', `${cb[0].n} 批`);

  const zk = await db.query('SELECT COUNT(*) n FROM zk_commitment');
  check(Number(zk[0].n) > 0, '零知识：承诺已生成', `${zk[0].n} 条`);

  const alert = await db.query('SELECT alert_type, COUNT(*) n FROM alert_record GROUP BY alert_type');
  check(alert.length > 0, '监管预警：已生成',
    alert.map((a) => `${a.alert_type}=${a.n}`).join(' '));

  /* ---------- 三、可辨识性（最关键） ---------- */
  P('\n【三】真实 / 派生 / 演示 三者可辨识');

  const src = await db.query(
    `SELECT data_source, COUNT(*) n, COUNT(DISTINCT ent_id) ents, SUM(total_emission) s
       FROM emission_report GROUP BY data_source ORDER BY n DESC`
  );
  for (const s of src) {
    const tag = s.data_source === 'DERIVED_FROM_CEMS' ? '真实派生（有血缘）'
      : s.data_source === 'DEMO_SUPPLEMENT' ? '演示（无血缘）' : '其他';
    P(`    ${String(s.data_source).padEnd(20)} ${String(s.n).padStart(3)} 张 / ${s.ents} 家 `
      + `${Number(s.s).toLocaleString().padStart(12)} t  ← ${tag}`);
  }

  const derivedWithLineage = Number(await db.value(
    `SELECT COUNT(*) FROM emission_report r WHERE r.data_source='DERIVED_FROM_CEMS'
      AND EXISTS (SELECT 1 FROM derivation_log d WHERE d.target_table='emission_report' AND d.target_id=r.id)`
  ));
  const derivedTotal = Number(await db.value(
    "SELECT COUNT(*) FROM emission_report WHERE data_source='DERIVED_FROM_CEMS'"
  ));
  check(derivedWithLineage === derivedTotal,
    '所有真实派生单均有血缘', `${derivedWithLineage}/${derivedTotal}`);

  const demoWithLineage = Number(await db.value(
    `SELECT COUNT(*) FROM emission_report r WHERE r.data_source='DEMO_SUPPLEMENT'
      AND EXISTS (SELECT 1 FROM derivation_log d WHERE d.target_table='emission_report' AND d.target_id=r.id)`
  ));
  check(demoWithLineage === 0, '演示数据无血缘（不与真实混同）', `${demoWithLineage} 条误挂`);

  const demoMarked = Number(await db.value(
    "SELECT COUNT(*) FROM emission_report WHERE data_source='DEMO_SUPPLEMENT' AND remark LIKE '%演示%'"
  ));
  const demoAll = Number(await db.value(
    "SELECT COUNT(*) FROM emission_report WHERE data_source='DEMO_SUPPLEMENT'"
  ));
  check(demoMarked === demoAll, '演示数据单据内已标注', `${demoMarked}/${demoAll}`);

  const fakeReal = Number(await db.value('SELECT COUNT(*) FROM emission_report WHERE is_real <> 0'));
  check(fakeReal === 0, '无数据冒充实测', `${fakeReal} 条违规`);

  /* ---------- 四、演示资产同样可辨识 ---------- */
  P('\n【四】演示资产可辨识');
  const demoAssets = await db.query(
    "SELECT COUNT(*) n, SUM(CASE WHEN registry='DEMO' THEN 1 ELSE 0 END) marked FROM credit_asset"
  );
  check(Number(demoAssets[0].n) === Number(demoAssets[0].marked),
    '碳资产均带 DEMO 登记簿标识', `${demoAssets[0].marked}/${demoAssets[0].n}`);

  const demoCert = await db.query(
    "SELECT COUNT(*) n, SUM(CASE WHEN cert_no LIKE 'DEMO-%' THEN 1 ELSE 0 END) marked FROM green_cert"
  );
  check(Number(demoCert[0].n) === Number(demoCert[0].marked),
    '绿证编号均带 DEMO- 前缀', `${demoCert[0].marked}/${demoCert[0].n}`);

  /* ---------- 汇总 ---------- */
  P('\n' + line('═'));
  P(`  通过 ${pass} 项，失败 ${fail} 项`);
  P(line('═'));
  await db.pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n✘', e.message); console.error(e.stack); process.exit(1); });
