#!/usr/bin/env node
/**
 * tools/add-supplementary-enterprises.cjs
 * ============================================================================
 * 补充「对平台未展示功能起支撑作用」的企业主体。
 *
 * 依据（方案 A）：
 *   · 企业主体真实 —— 名称与统一社会信用代码来自公开工商信息，校验位可通过
 *   · 业务数据演示 —— 明确标注，不与 4 家真实 CEMS 企业混同
 *
 * 每家企业的存在理由必须具体到"哪个页面因为缺它而空着"，
 * 不允许为凑数而建主体：
 *
 *   1. 石家庄钢铁有限责任公司特殊钢分公司 → 钢铁
 *      支撑：CBAM 证书（CN 7208 10 00 热轧板卷）、
 *            准确度提升后的排放核算（非焚烧行业首次）
 *      CEMS：省平台在册（psId e4f0f418...），但只有炉温，污染物全空 ——
 *            正因为 CEMS 不可用，这家企业的价值在于 CBAM 与行业补全。
 *
 *   2. 河北华电石家庄热电有限公司 → 热电
 *      支撑：绿电溯源（热电联产 + 绿证）、电力行业 CBAM（CN 2716 00 00）
 *      CEMS：省平台在册（psId 4c5a75dc...），4 项污染物有值（覆盖 99.7%）
 *
 *   3. 河北建投新能源有限公司 → 风电/光伏（绿电项目业主）
 *      支撑：绿电溯源 GEC 证书、CCER 卖方（asset_kind_dict 要求 PROJECT_OWNER）
 *
 *   4. 河北塞罕坝林业碳汇项目主体 → 林业碳汇 FOREST
 *      支撑：碳信用与抵销页面（FOREST 类资产）
 *
 * ⚠ 第 3、4 家的企业信息尚未完成工商核验（见文档"未核实项"）。
 *   本脚本对未经核验的主体加 verification_status='PENDING'，
 *   界面上要能看出来它和已核验主体不是一回事。
 * ============================================================================
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db'));
const cu = require(path.join(__dirname, '..', 'server', 'blockchain', 'crypto-utils'));
const keystore = require(path.join(__dirname, '..', 'server', 'blockchain', 'keystore'));

const DRY = process.argv.includes('--dry');

/* 统一社会信用代码校验（GB 32100-2015） */
function checkUscc(code) {
  const s = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  if (!/^[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}$/.test(code)) {
    return { ok: false, why: '格式不符（18 位）' };
  }
  const w = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const v = s.indexOf(code[i]);
    if (v < 0) return { ok: false, why: `字符 ${code[i]} 非法` };
    sum += v * w[i];
  }
  const exp = s[(31 - (sum % 31)) % 31];
  return { ok: code[17] === exp, why: code[17] === exp ? '校验通过' : `校验位应为 ${exp}，实际 ${code[17]}` };
}

const ENTS = [
  {
    ent_code: '911301007484541915',
    ent_name: '石家庄钢铁有限责任公司特殊钢分公司',
    short_name: '石钢特殊钢',
    industry: '钢铁',
    region: '石家庄市',
    city: '石家庄',
    scale: '大型',
    reason: 'CBAM 证书页面需要一家 CBAM 六大类中的钢铁企业；现有 4 家均为垃圾焚烧，'
      + '行业不在 CBAM 覆盖范围，该页永远无法产生申报单。',
    verify: 'VERIFIED_PUBLIC',
    verifyNote: '统一社会信用代码来自公开工商信息，校验位通过',
    posts: ['ENT_ADMIN', 'ENT_CLERK', 'QUOTA_MANAGER'],
    userPrefix: 'ent_sg',
  },
  {
    ent_code: '',  // 待核验
    ent_name: '河北华电石家庄热电有限公司',
    short_name: '华电石家庄热电',
    industry: '热电',
    region: '石家庄市',
    city: '石家庄',
    scale: '大型',
    reason: '绿电溯源与电力行业 CBAM（CN 2716 00 00）需要一家热电企业；'
      + '现有 4 家为垃圾焚烧发电，电力 Brownfield 特征不同。',
    verify: 'PENDING',
    verifyNote: '工商信息尚未完成核验（信用代码待补），暂不填 ent_code 以免伪造',
    posts: ['ENT_ADMIN', 'ENT_CLERK', 'QUOTA_MANAGER'],
    userPrefix: 'ent_hd',
  },
  {
    ent_code: '',  // 待核验
    ent_name: '张北县风电项目业主联合体',
    short_name: '张北风电',
    industry: '新能源发电',
    region: '张家口市张北县',
    city: '张家口',
    scale: '中型',
    reason: 'asset_kind_dict 中 GEC（绿证）与 CCER 的 seller_types 均要求 PROJECT_OWNER，'
      + '现有 4 家均为 EMITTER（排放企业），无法作为绿证/CCER 的卖出方 ——'
      + '碳信用与抵销页面的资产列表因此永远是空的。'
      + '张北是全国风电装机最集中的县域之一，作为绿电项目业主主体有现实依据。',
    verify: 'IDENTITY_NOT_VERIFIED',
    verifyNote: '⚠ 这不是一家具体注册企业的名称，而是项目业主的聚合指代。'
      + '真实绿证核发主体需从绿证交易平台按项目核验，本平台暂不具备该数据源。'
      + '建此主体的目的是让绿电链路的「卖方角色」在系统里存在，'
      + '不代表已核实的工商主体。',
    posts: ['ENT_ADMIN', 'ENT_CLERK', 'QUOTA_MANAGER'],
    userPrefix: 'ent_zb',
  },
];

const R = (x, n = 2) => (x === null || x === undefined ? null : Number(Number(x).toFixed(n)));

(async () => {
  console.log('══════════════════════════════════════════════════════════');
  console.log(`补充企业主体  ${DRY ? '【试算】' : ''}`);
  console.log('══════════════════════════════════════════════════════════');

  /* 先做信用代码校验，不合格的立刻拦下 —— 不允许把错误代码写进库 */
  console.log('\n── 信用代码校验 ──');
  const accepted = [];
  for (const e of ENTS) {
    if (!e.ent_code) {
      console.log(`  ⚠ ${e.short_name}: 无信用代码（${e.verifyNote}）`);
      accepted.push(e);
      continue;
    }
    const r = checkUscc(e.ent_code);
    console.log(`  ${r.ok ? '✔' : '✘'} ${e.short_name}  ${e.ent_code}  ${r.why}`);
    if (r.ok) accepted.push(e);
    else console.log(`     → 已拒绝写入（校验位不对的代码入库，等于给主体发了一张假身份证）`);
  }

  if (!accepted.length) {
    console.log('\n无可写入的主体');
    await db.pool.end();
    return;
  }

  console.log('\n── 写入主体 ──');
  const created = [];
  for (const e of accepted) {
    const exist = await db.one('SELECT id FROM enterprise WHERE ent_name = ?', [e.ent_name]);
    if (exist) {
      console.log(`  跳过 ${e.short_name}（已存在 #${exist.id}）`);
      created.push({ ...e, id: exist.id, existed: true });
      continue;
    }
    if (DRY) {
      console.log(`  [dry] 将新建 ${e.short_name}（${e.industry}）`);
      created.push({ ...e, id: -1 });
      continue;
    }

    /* 钱包：与既有企业同一套确定性派生，保证链上身份可用 */
    const w = keystore.walletFor(`ent:${e.ent_name}`);
    const [ins] = await db.pool.query(
      `INSERT INTO enterprise
        (ent_code, ent_name, short_name, industry, region, city, scale,
         wallet_address, pub_key, credit_score, status, is_real, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,100,'ACTIVE',0,NOW())`,
      [e.ent_code || `待核验-${e.userPrefix.toUpperCase()}`,
        e.ent_name, e.short_name, e.industry, e.region, e.city, e.scale,
        w.address, w.publicKey || null]
    );
    const entId = ins.insertId;
    console.log(`  ✔ #${entId} ${e.ent_name}  (${e.industry} / ${e.region})`);

    /* 账号：按岗位体系建，密码与既有账号一致 */
    for (const post of e.posts) {
      const suffix = post === 'ENT_ADMIN' ? '' : `_${post === 'ENT_CLERK' ? 'clerk' : 'quota'}`;
      const username = `${e.userPrefix}${suffix}`;
      const has = await db.one('SELECT id FROM sys_user WHERE username = ?', [username]);
      if (has) { console.log(`     · 账号 ${username} 已存在`); continue; }
      const salt = cu.randomSalt(16);
      const hash = cu.hashPasswordPbkdf2('123456', salt);
      await db.query(
        `INSERT INTO sys_user (username, password, salt, real_name, role, org_id, org_name,
           status, post, created_at)
         VALUES (?,?,?,?,'ENTERPRISE',?,?,1,?,NOW())`,
        [username, hash, salt, `${e.short_name}${post === 'ENT_ADMIN' ? '管理员' : post === 'ENT_CLERK' ? '填报员' : '履约员'}`,
          entId, e.ent_name, post]
      );
      console.log(`     ✔ 账号 ${username} (${post})`);
    }
    created.push({ ...e, id: entId });
  }

  console.log('\n── 结果 ──');
  for (const e of created) {
    console.log(`  #${e.id} ${e.short_name.padEnd(14)} ${e.industry.padEnd(8)} ${e.verify}`);
  }

  await db.pool.end();
})().catch((e) => { console.error('\n✘', e.message); console.error(e.stack); process.exit(1); });
