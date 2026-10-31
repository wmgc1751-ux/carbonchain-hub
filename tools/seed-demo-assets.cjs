#!/usr/bin/env node
/**
 * tools/seed-demo-assets.cjs
 * ============================================================================
 * 为补充主体生成**演示用碳资产与绿证**，使「碳信用与抵销」「绿电溯源」可用。
 *
 * ⚠ 与 seed-demo-business.cjs 同一套可辨识性约定：
 *   · credit_asset.registry 写明 'DEMO'（真实应为 'CCER登记簿'/'中国绿证'）
 *   · asset_no / cert_no 用 DEMO- 前缀，不与真实核发编号混淆
 *   · 配合 remark/note 说明"演示资产，未在真实登记簿核发"
 *
 * 为什么不做成真实编号：
 *   CCER 项目编号（如 0012345）与绿证编号都是**登记簿唯一编号**，
 *   编一个格式正确的假编号，等于伪造登记簿记录 —— 这比编一个明显是演示的
 *   前缀编号危害大得多：前者能被当成真的去查，后者一眼可辨。
 *
 * 用法：
 *   node tools/seed-demo-assets.cjs --dry
 *   node tools/seed-demo-assets.cjs
 *   node tools/seed-demo-assets.cjs --reset
 * ============================================================================
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db'));
const cu = require(path.join(__dirname, '..', 'server', 'blockchain', 'crypto-utils'));

const DRY = process.argv.includes('--dry');
const RESET = process.argv.includes('--reset');
const R = (x, n = 2) => Number(Number(x).toFixed(n));

/* CCER 资产规格：项目类型、规模取自公开的行业量级，不指认具体项目 */
const CCER_SPEC = [
  {
    entPrefix: 'ent_zb',
    assetType: 'CCER',
    projectName: '张北风电场自愿减排项目（演示）',
    amount: 240000,          // tCO2e
    issueYear: 2024,
    validUntil: '2027-12-31',
    registry: 'DEMO',
    note: '演示资产：CCER 项目登记与核发需在国家温室气体自愿减排注册登记系统完成，'
      + '本平台无该数据源。编号前缀 DEMO- 表明未经真实核发。',
  },
  {
    entPrefix: 'ent_zb',
    assetType: 'GEC',
    projectName: '张北风电绿色电力证书（演示）',
    amount: 1000000,         // MWh（GEC 计量单位）
    issueYear: 2024,
    validUntil: '2026-12-31',
    registry: 'DEMO',
    note: '演示资产：绿证核发需经国家可再生能源信息管理中心，本平台无该数据源。',
  },
  {
    entPrefix: 'ent_zb',
    assetType: 'FOREST',
    projectName: '张北坝上林业碳汇项目（演示）',
    amount: 35000,
    issueYear: 2024,
    validUntil: '2030-12-31',
    registry: 'DEMO',
    note: '演示资产：林业碳汇项目需经备案与计量监测，本平台无该数据源。',
  },
];

(async () => {
  console.log('══════════════════════════════════════════════════════════');
  console.log(`生成演示碳资产  ${DRY ? '【试算】' : ''}`);
  console.log('══════════════════════════════════════════════════════════');

  const ent = await db.one(
    "SELECT id, ent_name FROM enterprise WHERE ent_name LIKE '%张北%' LIMIT 1"
  );
  if (!ent) { console.log('未找到张北风电主体'); await db.pool.end(); return; }
  console.log(`\n主体：#${ent.id} ${ent.ent_name}`);

  if (RESET && !DRY) {
    const n = Number(await db.value(
      "SELECT COUNT(*) FROM credit_asset WHERE ent_id=? AND registry='DEMO'", [ent.id]
    ));
    if (n > 0) {
      await db.query("DELETE FROM credit_asset WHERE ent_id=? AND registry='DEMO'", [ent.id]);
      console.log(`  ⟲ 已清除旧演示资产 ${n} 条`);
    }
  }

  console.log('\n── 碳资产 ──');
  for (const s of CCER_SPEC) {
    const exists = await db.one(
      "SELECT id FROM credit_asset WHERE ent_id=? AND project_name=? AND registry='DEMO'",
      [ent.id, s.projectName]
    );
    if (exists) { console.log(`  ${s.assetType.padEnd(6)} 已存在 #${exists.id}`); continue; }
    const assetNo = `DEMO-${s.assetType}-${s.issueYear}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
    if (DRY) { console.log(`  [dry] ${s.assetType} ${s.amount} ${s.projectName}`); continue; }

    await db.query(
      `INSERT INTO credit_asset
        (ent_id, asset_no, asset_type, project_name, amount, used_amount, issue_year,
         valid_until, registry, status, created_at)
       VALUES (?,?,?,?,?,0,?,?,?,'ACTIVE',NOW())`,
      [ent.id, assetNo, s.assetType, s.projectName, s.amount,
        s.issueYear, s.validUntil, s.registry]
    );
    console.log(`  ✔ ${s.assetType.padEnd(6)} ${String(s.amount).padStart(9).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}  ${s.projectName}`);

    /* 资产账户：asset_account 按 ent_id + asset_kind 维护余额 */
    await db.query(
      `INSERT INTO asset_account (ent_id, asset_kind, vintage, available, frozen, total_in, total_out, created_at, updated_at)
       VALUES (?,?,?,?,0,?,0,NOW(),NOW())
       ON DUPLICATE KEY UPDATE available = available + VALUES(available),
                               total_in = total_in + VALUES(total_in)`,
      [ent.id, s.assetType, s.issueYear, s.amount, s.amount]
    );
    console.log(`     ↳ 资产账户 +${s.amount} ${s.assetType}（vintage ${s.issueYear}）`);
  }

  console.log('\n── 绿证台账 ──');
  const gecExists = await db.one(
    "SELECT id FROM green_cert WHERE owner_ent_id=? AND cert_no LIKE 'DEMO-%'", [ent.id]
  );
  if (gecExists) {
    console.log(`  已存在 #${gecExists.id}`);
  } else if (!DRY) {
    for (let i = 1; i <= 3; i++) {
      const certNo = `DEMO-GEC-2024-${String(i).padStart(4, '0')}`;
      await db.query(
        `INSERT INTO green_cert
          (cert_no, cert_type, issuer, energy_source, energy_mwh, period_from, period_to,
           owner_ent_id, claim_status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,NOW())`,
        [certNo, 'GEC 绿证', '国家可再生能源信息管理中心（演示）', '风电',
          333333, `2024-0${i * 3 - 2}-01`, `2024-0${i * 3 < 10 ? '0' + i * 3 : i * 3}-28`,
          ent.id, 'UNCLAIMED']
      );
      console.log(`  ✔ ${certNo}  333,333 MWh  风电`);
    }
  } else {
    console.log('  [dry] 将新建 3 张 GEC 绿证');
  }

  console.log('\n══════════════════════════════════════════════════════════');
  if (!DRY) {
    const a = await db.query(
      "SELECT asset_type, COUNT(*) n, SUM(amount) s FROM credit_asset WHERE registry='DEMO' GROUP BY asset_type"
    );
    console.log('  演示资产汇总：');
    for (const x of a) console.log(`    ${x.asset_type.padEnd(8)} ${x.n} 条  ${R(Number(x.s), 0).toLocaleString()}`);
    const g = await db.query("SELECT COUNT(*) n, SUM(energy_mwh) s FROM green_cert WHERE cert_no LIKE 'DEMO-%'");
    console.log(`    绿证     ${g[0].n} 张  ${R(Number(g[0].s || 0), 0).toLocaleString()} MWh`);
  }
  console.log('══════════════════════════════════════════════════════════');
  await db.pool.end();
})().catch((e) => { console.error('✘', e.message); console.error(e.stack); process.exit(1); });
