/**
 * init-db.js —— 一键初始化数据库
 * ------------------------------------------------------------------
 * 执行内容：
 *   1. 建库建表（读取 db/01_schema.sql）
 *   2. 生成 16 张表的仿真业务数据（每张表均 ≥ 50 行）
 *   3. 为每个企业 / 核查机构生成 secp256k1 链上钱包（私钥落本地 keystore）
 *   4. 真实构建区块链：把历史业务动作打包、签名、做 PoW 出块
 *
 * 用法： npm run initdb
 */
'use strict';

const fs = require('fs');
const mysql = require('mysql2/promise');
const config = require('../config');
const cu = require('../blockchain/crypto-utils');
const keystore = require('../blockchain/keystore');
const { Blockchain } = require('../blockchain/chain');
const P = require('./seed-pools');

const rng = new P.Rng(20260917);
const NOW = new Date('2026-09-17T20:00:00');

/* 能源折标准煤系数（用于计算综合能耗 tce） */
const TCE = { 原煤: 0.7143, 焦炭: 0.9714, 天然气: 12.143, 柴油: 1.4571, 燃料油: 1.4286, 电力: 0.3025, 热力: 0.03412 };

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/**
 * 按 ';' 切分 SQL 文件并逐条执行
 * @param {object} conn 连接
 * @param {string} file 结构文件
 * @param {boolean} managed 是否为"云托管库"模式：
 *   免费云 MySQL（TiDB Cloud Serverless / PlanetScale 等）通常**不允许**用户
 *   执行 CREATE DATABASE / DROP DATABASE，且库名由平台分配。此模式下跳过建库删库语句，
 *   并改写到 config.db.database 指定的库。
 */
async function runSchema(conn, file, managed = false) {
  let sql = fs.readFileSync(file, 'utf8');
  sql = sql.replace(/^\s*--.*$/gm, '');          // 去掉行注释

  const dbName = config.db.database || 'carbon_chain';
  if (managed) {
    // 去掉库级语句（无权限且无必要——库由平台创建）
    sql = sql
      .replace(/DROP\s+DATABASE[^;]*;/gi, '')
      .replace(/CREATE\s+DATABASE[^;]*;/gi, '')
      .replace(/USE\s+`?[\w$]+`?\s*;/gi, '');

    /* 云托管模式下没有 DROP DATABASE 兜底，若上一次执行中断（或重复执行），
     * 残留的表会让 CREATE TABLE 直接撞 ER_TABLE_EXISTS_ERROR。
     * 这里先按【逆序】DROP 掉结构文件里出现的所有表，保证可重复执行。
     * 逆序是为了让有外键依赖的表先被删除。 */
    const created = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([\w$]+)`?/gi)]
      .map((m) => m[1]);
    if (created.length) {
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const t of created.reverse()) {
        await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
      }
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
      console.log(`   ↺ 已清理 ${created.length} 张可能残留的表（保证可重复执行）`);
    }
  } else {
    sql = sql.replace(/USE\s+`?carbon_chain`?\s*;/gi, `USE \`${dbName}\`;`);
  }

  const stmts = sql.split(';').map((s) => s.trim()).filter((s) => s.length > 2);
  for (const s of stmts) await conn.query(s);
  return stmts.length;
}

/** 批量插入 */
async function insertBatch(conn, table, cols, rows, chunk = 250) {
  if (!rows.length) return 0;
  let n = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const ph = slice.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
    await conn.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${ph}`, slice.flat());
    n += slice.length;
  }
  return n;
}

const pad = (n, w) => String(n).padStart(w, '0');
const round = (v, d = 2) => Number(Number(v).toFixed(d));
const fmtDate = (d) => new Date(d);

/** 统一社会信用代码 */
function entCode(region, rng) {
  const chars = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  let mid = '';
  for (let i = 0; i < 9; i++) mid += chars[rng.i(0, chars.length - 1)];
  return '91' + (P.REGION_CODE[region] || '110100') + mid + rng.i(0, 9);
}

/** 报告期 → 提交日期 */
function submitDate(y, q, rng) {
  let m = q * 3 + 1;
  let yy = y;
  if (m > 12) { m -= 12; yy += 1; }
  return new Date(yy, m - 1, rng.i(3, 22), rng.i(9, 18), rng.i(0, 59), rng.i(0, 59));
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const t0 = Date.now();
  console.log('▶ 碳链通 CarbonChain Hub —— 数据库初始化');
  console.log('─'.repeat(64));

  /* ============ 1. 建库建表 ============ */
  /* DB_MANAGED=true 表示库由云平台预先创建、当前账号无建库权限（免费云 MySQL 常见） */
  const managed = ['true', '1', 'yes'].includes(String(process.env.DB_MANAGED || '').toLowerCase());

  const admin = await mysql.createConnection({
    ...config.db,
    database: managed ? config.db.database : undefined,
    multipleStatements: true, charset: 'utf8mb4',
  });
  const nStmt = await runSchema(admin, config.paths.schema, managed);
  console.log(
    managed
      ? `✔ 已在云托管库 ${config.db.database} 中重建数据表，执行 DDL 语句 ${nStmt} 条`
      : `✔ 数据库 ${config.db.database} 已重建，执行 DDL 语句 ${nStmt} 条`
  );
  await admin.end();

  const conn = await mysql.createConnection({ ...config.db, multipleStatements: false });

  /* ============ 2. 企业名录 ============ */
  const combos = [];
  for (const r of P.REGIONS) for (const c of r.cities) for (const ind of P.INDUSTRIES) combos.push({ region: r.p, city: c, industry: ind });
  const picked = rng.sample(combos, 60);

  const enterprises = [];
  const entRows = [];
  picked.forEach((c, i) => {
    const id = i + 1;
    const scale = rng.pickW(['大型', '中型', '小型'], [0.45, 0.4, 0.15]);
    const scaleK = scale === '大型' ? 1 : scale === '中型' ? 0.45 : 0.18;
    const cfg = P.INDUSTRY_SCALE[c.industry];
    const name = rng.pick(P.NAME_TPL[c.industry]).replace('{c}', c.city);
    const wallet = keystore.walletFor(`ent:${id}`);
    const legal = P.personName(rng);
    const e = {
      id,
      ent_code: entCode(c.region, rng),
      ent_name: name,
      short_name: name.replace(/(集团|股份|有限责任|有限公司)+$/g, '').replace(/(集团|股份|有限责任|有限公司)/g, ''),
      industry: c.industry,
      region: c.region,
      city: c.city,
      scale,
      legal_person: legal,
      contact_phone: '1' + rng.pick(['3', '5', '7', '8', '9']) + String(rng.i(100000000, 999999999)),
      reg_capital: round(rng.d(4000, 260000, 2)),
      annual_output: round(rng.d(cfg.out[0], cfg.out[1], 2) * scaleK),
      headcount: rng.i(120, 9000),
      wallet,
      credit_score: rng.i(70, 100),
      status: rng.pickW(['ACTIVE', 'WATCH', 'SUSPENDED'], [0.88, 0.09, 0.03]),
      created_at: new Date(rng.i(2019, 2024), rng.i(0, 11), rng.i(1, 28)),
    };
    enterprises.push(e);
    entRows.push([
      e.id, e.ent_code, e.ent_name, e.short_name, e.industry, e.region, e.city, e.scale,
      e.legal_person, e.contact_phone, e.reg_capital, e.annual_output, e.headcount,
      e.wallet.address, e.wallet.publicKey, e.credit_score, e.status, fmtDate(e.created_at),
    ]);
  });
  await insertBatch(conn, 'enterprise',
    ['id', 'ent_code', 'ent_name', 'short_name', 'industry', 'region', 'city', 'scale',
      'legal_person', 'contact_phone', 'reg_capital', 'annual_output', 'headcount',
      'wallet_address', 'pub_key', 'credit_score', 'status', 'created_at'], entRows);
  console.log(`✔ enterprise            控排企业       ${entRows.length} 行`);

  /* ============ 3. 核查机构 ============ */
  const vOrgCombos = rng.sample(combos.map((c) => ({ region: c.region, city: c.city })).filter((v, i, a) => a.findIndex((x) => x.city === v.city) === i), 50);
  const verifiers = [];
  const verRows = [];
  vOrgCombos.forEach((c, i) => {
    const id = i + 1;
    const wallet = keystore.walletFor(`verifier:${id}`);
    const v = {
      id,
      org_code: 'HG' + pad(1000 + i, 6),
      org_name: rng.pick(P.VERIFIER_TPL).replace('{c}', c.city),
      region: c.region,
      city: c.city,
      license_no: 'CNCA-C' + rng.i(1000, 9999) + '-' + rng.i(100000, 999999),
      director: P.personName(rng),
      contact_phone: '1' + rng.pick(['3', '5', '8']) + String(rng.i(100000000, 999999999)),
      staff_count: rng.i(8, 76),
      level: rng.pickW(['A', 'B', 'C'], [0.22, 0.5, 0.28]),
      done_tasks: rng.i(18, 420),
      pass_rate: round(rng.d(84, 99.6, 2)),
      rating: round(rng.d(3.6, 5.0, 1), 1),
      wallet,
      status: rng.pickW(['ACTIVE', 'WATCH'], [0.94, 0.06]),
      created_at: new Date(rng.i(2018, 2024), rng.i(0, 11), rng.i(1, 28)),
    };
    verifiers.push(v);
    verRows.push([
      v.id, v.org_code, v.org_name, v.region, v.license_no, v.director, v.contact_phone,
      v.staff_count, v.level, v.done_tasks, v.pass_rate, v.rating, v.wallet.address, v.wallet.publicKey, v.status, fmtDate(v.created_at),
    ]);
  });
  await insertBatch(conn, 'verifier_org',
    ['id', 'org_code', 'org_name', 'region', 'license_no', 'director', 'contact_phone',
      'staff_count', 'level', 'done_tasks', 'pass_rate', 'rating', 'wallet_address', 'pub_key', 'status', 'created_at'], verRows);
  console.log(`✔ verifier_org          核查机构       ${verRows.length} 行`);

  /* ============ 4. 用户账号（四端） ============ */
  const userRows = [];
  const users = [];
  function addUser(u) {
    const salt = cu.randomSalt(8);
    const password = cu.hashPassword(u.password, salt);
    const row = {
      id: users.length + 1,
      ...u,
      salt,
      hash: password,
    };
    users.push(row);
    userRows.push([
      row.id, row.username, row.hash, row.salt, row.real_name, row.role,
      row.org_id || null, row.org_name || null, row.phone || null, row.email || null,
      row.status === undefined ? 1 : row.status, row.last_login || null, row.created_at || NOW,
    ]);
    return row;
  }

  addUser({
    username: 'admin', password: 'admin123', real_name: '系统管理员', role: 'ADMIN',
    phone: '13800000001', email: 'admin@carbonchain.gov.cn',
    created_at: new Date(2024, 0, 5),
  });
  const REG_NAMES = ['周振国', '吴晓宁', '郑海涛'];
  REG_NAMES.forEach((n, i) => addUser({
    username: 'reg00' + (i + 1), password: '123456', real_name: n, role: 'REGULATOR',
    org_name: '省级生态环境厅应对气候变化处', phone: '1380000000' + (i + 2),
    email: `reg00${i + 1}@carbonchain.gov.cn`, created_at: new Date(2024, 1, 10 + i),
  }));
  enterprises.forEach((e, i) => addUser({
    username: 'ent' + pad(i + 1, 3), password: '123456',
    real_name: e.legal_person, role: 'ENTERPRISE', org_id: e.id, org_name: e.ent_name,
    phone: e.contact_phone, email: `ent${pad(i + 1, 3)}@${e.short_name ? 'corp' : 'corp'}.cn`,
    last_login: new Date(NOW.getTime() - rng.i(1, 72) * 3600 * 1000),
    created_at: e.created_at,
  }));
  verifiers.forEach((v, i) => addUser({
    username: 'ver' + pad(i + 1, 3), password: '123456',
    real_name: v.director, role: 'VERIFIER', org_id: v.id, org_name: v.org_name,
    phone: v.contact_phone, email: `ver${pad(i + 1, 3)}@verify.cn`,
    last_login: new Date(NOW.getTime() - rng.i(1, 96) * 3600 * 1000),
    created_at: v.created_at,
  }));
  await insertBatch(conn, 'sys_user',
    ['id', 'username', 'password', 'salt', 'real_name', 'role', 'org_id', 'org_name',
      'phone', 'email', 'status', 'last_login', 'created_at'], userRows);
  console.log(`✔ sys_user              用户账号       ${userRows.length} 行`);

  /* ============ 5. 碳排放上报单 + 明细 ============ */
  const PERIODS = [];
  for (const y of [2025]) for (const q of [1, 2, 3, 4]) PERIODS.push({ y, q });
  for (const y of [2026]) for (const q of [1, 2]) PERIODS.push({ y, q });

  const reports = [];
  const reportRows = [];
  const itemRows = [];
  let reportId = 0;
  let itemId = 0;

  enterprises.forEach((e) => {
    const cfg = P.INDUSTRY_SCALE[e.industry];
    const scaleK = e.scale === '大型' ? 1 : e.scale === '中型' ? 0.45 : 0.18;
    const annualBase = ((cfg.emi[0] + cfg.emi[1]) / 2) * scaleK;
    const annualOut = e.annual_output;

    PERIODS.forEach(({ y, q }) => {
      reportId++;
      const ageFactor = y === 2026 ? rng.d(0.93, 0.99, 3) : rng.d(1.0, 1.06, 3);
      const total = round((annualBase / 4) * ageFactor * rng.d(0.9, 1.1, 3));
      const output = round((annualOut / 4) * rng.d(0.88, 1.12, 3));

      // 能源结构 → 明细行
      const pool = P.INDUSTRY_ENERGY[e.industry];
      const picked2 = rng.sample(pool, rng.i(Math.min(3, pool.length), pool.length));
      const shares = picked2.map(() => rng.d(0.6, 1.4, 3));
      const shareSum = shares.reduce((a, b) => a + b, 0);
      let s1 = 0, s2 = 0, energy = 0;
      const items = [];
      picked2.forEach((tname, k) => {
        const meta = P.ENERGY_TYPES.find((x) => x.name === tname);
        const co2 = round((total * shares[k]) / shareSum, 3);
        const amount = round(co2 / meta.factor, 3);
        if (meta.scope === 1) s1 += co2; else s2 += co2;
        energy += amount * (TCE[tname] || 0.7);
        items.push([
          ++itemId, reportId, e.id, tname, meta.scope, amount, meta.unit, meta.factor, co2,
          meta.scope === 1 ? '排放因子法' : '购入量法', NOW,
        ]);
      });

      // 状态按报告期新鲜度分布
      let status;
      if (y === 2025) status = rng.pickW(['VERIFIED', 'REJECTED'], [0.93, 0.07]);
      else if (q === 1) status = rng.pickW(['VERIFIED', 'VERIFYING', 'SUBMITTED'], [0.6, 0.26, 0.14]);
      else status = rng.pickW(['SUBMITTED', 'VERIFYING', 'DRAFT'], [0.45, 0.33, 0.22]);

      const submitT = status === 'DRAFT' ? null : submitDate(y, q, rng);
      const verifier = status === 'DRAFT' ? null : rng.pick(verifiers);
      const verifyT = (status === 'VERIFIED' || status === 'REJECTED')
        ? new Date(submitT.getTime() + rng.i(8, 26) * 86400000)
        : null;

      const r = {
        id: reportId, report_no: `ER${y}${pad(q, 2)}${pad(e.id, 4)}`, ent_id: e.id,
        year: y, quarter: q, period: `${y}Q${q}`,
        scope1: round(s1), scope2: round(s2), total: round(s1 + s2),
        energy: round(energy), output, intensity: round((s1 + s2) / output, 4),
        yoy: y === 2026 ? round(rng.d(-9, 5.5, 2)) : round(rng.d(-7, 8, 2)),
        source: rng.pick(['在线监测', '物料衡算', '排放因子法']),
        status, verifier_id: verifier ? verifier.id : null,
        submit_time: submitT, verify_time: verifyT,
        ent: e, verifier,
        items,
      };
      reports.push(r);
      reportRows.push([
        r.id, r.report_no, r.ent_id, r.year, r.quarter, r.period, r.scope1, r.scope2, r.total,
        r.energy, r.output, r.intensity, r.yoy, r.source, r.status, r.verifier_id,
        r.submit_time ? fmtDate(r.submit_time) : null,
        r.verify_time ? fmtDate(r.verify_time) : null,
        null, null, r.status === 'DRAFT' ? null : `emission-${r.report_no}.pdf`,
        r.status === 'REJECTED' ? '核查发现计量器具未按期检定，数据不予采信' : null,
        fmtDate(r.submit_time || new Date(r.year, r.quarter * 3 - 1, 20)),
      ]);
      itemRows.push(...items);
    });
  });

  await insertBatch(conn, 'emission_report',
    ['id', 'report_no', 'ent_id', 'year', 'quarter', 'period', 'scope1_emission', 'scope2_emission',
      'total_emission', 'energy_consumption', 'output_value', 'intensity', 'yoy_rate', 'data_source',
      'status', 'verifier_id', 'submit_time', 'verify_time', 'chain_block_index', 'chain_tx_id',
      'attachment', 'remark', 'created_at'], reportRows);
  console.log(`✔ emission_report       排放上报单     ${reportRows.length} 行`);

  await insertBatch(conn, 'emission_item',
    ['id', 'report_id', 'ent_id', 'energy_type', 'scope', 'amount', 'unit', 'factor', 'co2',
      'calc_method', 'created_at'], itemRows);
  console.log(`✔ emission_item         排放明细行     ${itemRows.length} 行`);

  /* ============ 6. 核查任务 + 核查报告 ============ */
  const tasks = [];
  const taskRows = [];
  const vReports = [];
  const vReportRows = [];
  let taskId = 0, vReportId = 0;

  reports.forEach((r) => {
    if (r.status === 'DRAFT') return;
    taskId++;
    const statusMap = { VERIFIED: 'DONE', REJECTED: 'REJECTED', VERIFYING: 'PROCESSING', SUBMITTED: 'PENDING' };
    const t = {
      id: taskId,
      task_no: `VT${r.period.replace('Q', '')}${pad(r.ent_id, 4)}`,
      report_id: r.id, ent_id: r.ent_id, verifier_id: r.verifier_id,
      verifier_user: 'ver' + pad(r.verifier_id, 3),
      task_type: rng.pickW(['ROUTINE', 'RECHECK', 'RANDOM'], [0.75, 0.15, 0.1]),
      priority: rng.pickW(['HIGH', 'NORMAL', 'LOW'], [0.18, 0.7, 0.12]),
      status: statusMap[r.status],
      assign_time: r.submit_time || NOW,
      deadline: new Date((r.submit_time || NOW).getTime() + 30 * 86400000),
      finish_time: r.verify_time,
      reject_reason: r.status === 'REJECTED' ? '计量器具检定证书缺失，排放数据缺乏支撑材料' : null,
      report: r,
    };
    tasks.push(t);
    taskRows.push([
      t.id, t.task_no, t.report_id, t.ent_id, t.verifier_id, t.verifier_user, t.task_type,
      t.priority, t.status, fmtDate(t.assign_time), fmtDate(t.deadline),
      t.finish_time ? fmtDate(t.finish_time) : null, t.reject_reason, fmtDate(t.assign_time),
    ]);

    if (r.status === 'VERIFIED' || r.status === 'REJECTED') {
      vReportId++;
      const verified = r.status === 'REJECTED'
        ? round(r.total * rng.d(0.9, 0.97, 3))
        : round(r.total * rng.d(0.985, 1.03, 3));
      const dev = round(((verified - r.total) / r.total) * 100, 2);
      const vr = {
        id: vReportId,
        report_no: `VR${r.period.replace('Q', '')}${pad(r.ent_id, 4)}`,
        task_id: t.id, emission_report_id: r.id, ent_id: r.ent_id, verifier_id: r.verifier_id,
        declared: r.total, verified, deviation: dev,
        conclusion: r.status === 'REJECTED' ? 'FAIL' : rng.pickW(['PASS', 'CONDITIONAL'], [0.86, 0.14]),
        opinion: r.status === 'REJECTED'
          ? '企业未能提供完整的能源采购凭证与计量检定记录，本次核查结论为不通过，需重新上报。'
          : '经核对能源采购台账、生产报表与在线监测数据，排放量核算边界清晰，数据来源可追溯，核查结果予以认可。',
        auditor: r.verifier ? r.verifier.director : P.personName(rng),
        seal: null,
        issue_time: r.verify_time,
        report: r,
      };
      vr.seal = cu.sha256(`${vr.report_no}|${vr.verified}|${vr.auditor}|${vr.conclusion}|${r.verifier_id}`);
      vReports.push(vr);
      vReportRows.push([
        vr.id, vr.report_no, vr.task_id, vr.emission_report_id, vr.ent_id, vr.verifier_id,
        vr.declared, vr.verified, vr.deviation, vr.conclusion, vr.opinion, vr.auditor,
        vr.seal, null, null, fmtDate(vr.issue_time), fmtDate(vr.issue_time),
      ]);
    }
  });

  await insertBatch(conn, 'verify_task',
    ['id', 'task_no', 'report_id', 'ent_id', 'verifier_id', 'verifier_user', 'task_type',
      'priority', 'status', 'assign_time', 'deadline', 'finish_time', 'reject_reason', 'created_at'], taskRows);
  console.log(`✔ verify_task           核查任务       ${taskRows.length} 行`);

  await insertBatch(conn, 'verify_report',
    ['id', 'report_no', 'task_id', 'emission_report_id', 'ent_id', 'verifier_id', 'declared_value',
      'verified_value', 'deviation_rate', 'conclusion', 'opinion', 'auditor', 'seal_hash',
      'chain_block_index', 'chain_tx_id', 'issue_time', 'created_at'], vReportRows);
  console.log(`✔ verify_report         核查报告       ${vReportRows.length} 行`);

  /* ============ 7. 交易挂单 + 成交 ============ */
  const orders = [];
  const orderRows = [];
  const deals = [];
  const dealRows = [];
  let orderId = 0, dealId = 0;
  const year2026Start = new Date('2026-01-05T09:30:00').getTime();
  const span = NOW.getTime() - year2026Start;

  // 7.1 先造成交，每笔成交配套一条买入委托 + 一条卖出委托
  for (let i = 0; i < 90; i++) {
    dealId++;
    const seller = rng.pick(enterprises);
    let buyer = rng.pick(enterprises);
    let guard = 0;
    while (buyer.id === seller.id && guard++ < 20) buyer = rng.pick(enterprises);
    const price = round(Math.min(Math.max(rng.gauss(config.biz.quotaPrice, 6.2), 48), 96), 1);
    const amount = rng.i(200, 16000);
    const total = round(price * amount, 2);
    const t = year2026Start + Math.floor((i / 90) * span) + rng.i(0, span / 120) - rng.i(0, span / 120);
    const dealTime = new Date(t);

    orderId++; const sellOrderId = orderId;
    orderId++; const buyOrderId = orderId;
    const oT = new Date(dealTime.getTime() - rng.i(1, 240) * 60000);

    orders.push({
      id: sellOrderId, order_no: `OD${pad(sellOrderId, 6)}`, ent_id: seller.id, side: 'SELL',
      price: round(price + rng.d(-0.6, 0.8, 2), 2), amount, filled: amount, status: 'FILLED',
      created_at: oT,
    });
    orders.push({
      id: buyOrderId, order_no: `OD${pad(buyOrderId, 6)}`, ent_id: buyer.id, side: 'BUY',
      price: round(price + rng.d(-0.8, 0.6, 2), 2), amount, filled: amount, status: 'FILLED',
      created_at: oT,
    });
    deals.push({
      id: dealId, deal_no: `DL${pad(dealId, 6)}`, buy_order_id: buyOrderId, sell_order_id: sellOrderId,
      buyer_ent_id: buyer.id, seller_ent_id: seller.id, price, amount, total,
      fee: round(total * 0.0006, 2), deal_time: dealTime, status: 'SETTLED',
      buyer, seller,
    });
  }

  // 7.2 再补一批未成交/部分成交委托，形成真实的订单簿形态
  for (let i = 0; i < 90; i++) {
    orderId++;
    const e = rng.pick(enterprises);
    const side = rng.pickW(['SELL', 'BUY'], [0.55, 0.45]);
    const amount = rng.i(200, 18000);
    const st = rng.pickW(['OPEN', 'PARTIAL', 'CANCELLED'], [0.58, 0.26, 0.16]);
    orders.push({
      id: orderId, order_no: `OD${pad(orderId, 6)}`, ent_id: e.id, side,
      price: round(Math.min(Math.max(rng.gauss(config.biz.quotaPrice, 7), 45), 98), 1),
      amount,
      filled: st === 'PARTIAL' ? rng.i(1, amount - 1) : 0,
      status: st,
      created_at: new Date(NOW.getTime() - rng.i(1, 260) * 86400000 + rng.i(0, 8) * 3600000),
    });
  }

  for (const o of orders) {
    orderRows.push([o.id, o.order_no, o.ent_id, o.side, o.price, o.amount, o.filled, o.status, fmtDate(o.created_at), fmtDate(o.created_at)]);
  }
  for (const d of deals) {
    dealRows.push([d.id, d.deal_no, d.buy_order_id, d.sell_order_id, d.buyer_ent_id, d.seller_ent_id,
      d.price, d.amount, d.total, d.fee, fmtDate(d.deal_time), null, null, d.status]);
  }

  await insertBatch(conn, 'trade_order',
    ['id', 'order_no', 'ent_id', 'side', 'price', 'amount', 'filled_amount', 'status', 'created_at', 'updated_at'], orderRows);
  console.log(`✔ trade_order           交易挂单       ${orderRows.length} 行`);

  await insertBatch(conn, 'trade_deal',
    ['id', 'deal_no', 'buy_order_id', 'sell_order_id', 'buyer_ent_id', 'seller_ent_id', 'price',
      'amount', 'total_amount', 'fee', 'deal_time', 'chain_block_index', 'chain_tx_id', 'status'], dealRows);
  console.log(`✔ trade_deal            成交记录       ${dealRows.length} 行`);

  /* ============ 8. 配额账户 + 配额分配 ============ */
  // 先按企业×年度汇总排放量、买入、卖出
  const agg = new Map(); // `${entId}-${year}` -> {...}
  const key = (e, y) => `${e}-${y}`;
  for (const r of reports) {
    const k = key(r.ent_id, r.year);
    if (!agg.has(k)) agg.set(k, { ent: r.ent_id, year: r.year, emission: 0, output: 0 });
    const a = agg.get(k);
    a.emission += r.total;
    a.output += r.output;
  }
  for (const d of deals) {
    const y = d.deal_time.getFullYear();
    for (const [id, role] of [[d.buyer_ent_id, 'bought'], [d.seller_ent_id, 'sold']]) {
      const k = key(id, y);
      if (!agg.has(k)) agg.set(k, { ent: id, year: y, emission: 0, output: 0 });
      const a = agg.get(k);
      a[role] = (a[role] || 0) + d.amount;
    }
  }
  const frozenMap = new Map();
  for (const o of orders) {
    if (o.status === 'OPEN' && o.side === 'SELL') {
      frozenMap.set(o.ent_id, (frozenMap.get(o.ent_id) || 0) + o.amount);
    }
  }

  const quotaRows = [];
  const allocRows = [];
  const allocations = [];
  let allocId = 0;
  const years = [2025, 2026];
  let quotaId = 0;
  years.forEach((y) => {
    enterprises.forEach((e) => {
      quotaId++;
      const a = agg.get(key(e.id, y)) || { emission: 0, output: 0 };
      const emission = a.emission || 1;
      // 配额总量 = 实际排放 × (0.9 ~ 1.04)，制造部分企业配额缺口
      const allocated = round(emission * rng.d(0.9, 1.04, 4));
      const bought = round(a.bought || 0);
      const sold = round(a.sold || 0);
      const frozen = y === 2026 ? round(frozenMap.get(e.id) || 0) : 0;
      const used = round(emission);
      const available = round(allocated + bought - sold - used - frozen);
      quotaRows.push([quotaId, e.id, y, allocated, available, frozen, used, bought, sold, NOW]);

      allocId++;
      const method = rng.pickW(['历史强度法', '行业基准线法', '历史总量法'], [0.5, 0.35, 0.15]);
      const al = {
        id: allocId, alloc_no: `QA${y}${pad(e.id, 4)}`, ent_id: e.id, year: y,
        amount: allocated, type: 'FREE', method,
        baseline: method === '行业基准线法' ? round(rng.d(0.5, 2.6, 4), 4) : null,
        operator: rng.pick(REG_NAMES),
        created_at: new Date(y - 1, 11, rng.i(10, 28), rng.i(9, 17)),
        ent: e,
      };
      allocations.push(al);
      allocRows.push([al.id, al.alloc_no, al.ent_id, al.year, al.amount, al.type, al.method,
        al.baseline, al.operator, null, null, fmtDate(al.created_at)]);

      // 约 18% 的企业需要额外有偿购买配额
      if (rng.chance(0.18)) {
        allocId++;
        const auction = {
          id: allocId, alloc_no: `QA${y}A${pad(e.id, 3)}`, ent_id: e.id, year: y,
          amount: round(emission * rng.d(0.01, 0.05, 4)), type: 'AUCTION', method: '基准价竞拍',
          baseline: null, operator: rng.pick(REG_NAMES),
          created_at: new Date(y, rng.i(0, 5), rng.i(1, 28), rng.i(9, 15)),
          ent: e,
        };
        allocations.push(auction);
        allocRows.push([auction.id, auction.alloc_no, auction.ent_id, auction.year, auction.amount,
          auction.type, auction.method, auction.baseline, auction.operator, null, null, fmtDate(auction.created_at)]);
      }
    });
  });
  await insertBatch(conn, 'carbon_quota',
    ['id', 'ent_id', 'year', 'total_allocated', 'available', 'frozen', 'used', 'bought', 'sold', 'updated_at'], quotaRows);
  console.log(`✔ carbon_quota          配额账户       ${quotaRows.length} 行`);

  await insertBatch(conn, 'quota_allocation',
    ['id', 'alloc_no', 'ent_id', 'year', 'quota_amount', 'alloc_type', 'alloc_method',
      'baseline_intensity', 'operator', 'chain_block_index', 'chain_tx_id', 'created_at'], allocRows);
  console.log(`✔ quota_allocation      配额分配       ${allocRows.length} 行`);

  /* ============ 9. 预警记录 ============ */
  const alertRows = [];
  let alertId = 0;
  const alertTypes = Object.keys(P.ALERT_TEMPLATES);
  for (let i = 0; i < 72; i++) {
    alertId++;
    const type = rng.pickW(alertTypes, [0.26, 0.3, 0.16, 0.16, 0.12]);
    const tpl = P.ALERT_TEMPLATES[type];
    const e = rng.pick(enterprises);
    const st = rng.pickW(['OPEN', 'HANDLING', 'CLOSED'], [0.32, 0.24, 0.44]);
    const created = new Date(NOW.getTime() - rng.i(1, 300) * 86400000 - rng.i(0, 20) * 3600000);
    const contentMap = {
      OVER_QUOTA: `${e.ent_name}在配额年度内的排放量已接近或超出免费分配额度，建议提前通过市场购买配额以完成履约。`,
      DATA_ABNORMAL: `${e.ent_name}上报的综合能耗与折算排放量匹配度偏低，环比波动超出阈值，需补充说明能源计量台账。`,
      MISSING_REPORT: `${e.ent_name}未在规定期限内提交季度碳排放数据，请督促其限期补报。`,
      PRICE_ANOMALY: `市场出现偏离近30日均价 15% 以上的报价，涉及${e.ent_name}，已触发价格异动监控。`,
      CHAIN_RISK: `${e.ent_name}的链上存证交易在节点校验中出现异常，建议人工复核存证内容。`,
    };
    alertRows.push([
      alertId, `AL26${pad(alertId, 5)}`, e.id, type,
      rng.pickW(['HIGH', 'MEDIUM', 'LOW'], [0.24, 0.5, 0.26]),
      tpl.titles.map((s) => s.replace('{n}', '2026')).slice(0, 1)[0],
      contentMap[type], tpl.metric, st,
      st === 'CLOSED' ? rng.pick(REG_NAMES) : null,
      st === 'CLOSED' ? '已核实并下发整改通知，企业已补充材料完成闭环。' : null,
      fmtDate(created), st === 'CLOSED' ? fmtDate(new Date(created.getTime() + rng.i(1, 20) * 86400000)) : null,
    ]);
  }
  await insertBatch(conn, 'alert_record',
    ['id', 'alert_no', 'ent_id', 'alert_type', 'level', 'title', 'content', 'metric', 'status',
      'handler', 'handle_note', 'created_at', 'closed_at'], alertRows);
  console.log(`✔ alert_record          监管预警       ${alertRows.length} 行`);

  /* ============ 10. 操作日志 ============ */
  const logRows = [];
  const modules = ['碳排上报', '核查作业', '配额管理', '交易撮合', '链上存证', '用户管理', '预警处置'];
  const actions = ['提交数据', '撤回上报', '受理任务', '出具核查报告', '分配配额', '创建挂单', '撤销挂单', '查询链上存证', '导出报表', '处理预警'];
  for (let i = 0; i < 220; i++) {
    const u = rng.pick(users);
    logRows.push([
      i + 1, u.id, u.username, u.role, rng.pick(modules), rng.pick(actions),
      rng.chance(0.5) ? rng.pick(enterprises).ent_name : rng.pick(verifiers).org_name,
      '页面操作完成', `10.12.${rng.i(0, 30)}.${rng.i(2, 250)}`,
      rng.pickW(['SUCCESS', 'FAIL'], [0.94, 0.06]),
      new Date(NOW.getTime() - rng.i(0, 45) * 86400000 - rng.i(0, 23) * 3600000),
    ]);
  }
  await insertBatch(conn, 'audit_log',
    ['id', 'user_id', 'username', 'role', 'module', 'action', 'target', 'detail', 'ip', 'result', 'created_at'], logRows);
  console.log(`✔ audit_log             操作日志       ${logRows.length} 行`);

  /* ============ 11. 通知公告 ============ */
  const noticeRows = [];
  for (let i = 0; i < 60; i++) {
    const t = i < P.NOTICE_TITLES.length ? P.NOTICE_TITLES[i] : P.NOTICE_TITLES[i % P.NOTICE_TITLES.length] + `（${Math.floor(i / P.NOTICE_TITLES.length) + 1}）`;
    const body = `各有关单位：\n\n${t}。请结合自身实际情况，于规定时间内通过本平台完成相关工作，逾期未完成的将按照相关规定处理。\n\n如有疑问请联系平台运维值班电话。`;
    noticeRows.push([
      i + 1, t, body,
      rng.pickW(['POLICY', 'MARKET', 'SYSTEM'], [0.45, 0.35, 0.2]),
      rng.pickW(['ALL', 'ENTERPRISE', 'VERIFIER', 'REGULATOR'], [0.5, 0.25, 0.15, 0.1]),
      rng.pick(REG_NAMES.concat(['系统运维组'])),
      i < 4 ? 1 : (rng.chance(0.12) ? 1 : 0),
      rng.i(60, 4800),
      new Date(NOW.getTime() - rng.i(1, 400) * 86400000),
    ]);
  }
  await insertBatch(conn, 'notice',
    ['id', 'title', 'content', 'notice_type', 'target_role', 'publisher', 'is_top', 'views', 'publish_time'], noticeRows);
  console.log(`✔ notice                通知公告       ${noticeRows.length} 行`);

  /* ============ 12. 构建区块链（真实 PoW 出块） ============ */
  console.log('─'.repeat(64));
  console.log('⛓  开始构建区块链（ECDSA 签名 + SHA-256 + PoW 出块）…');
  const chain = new Blockchain(conn, { ...config.chain, autoMine: false });
  await chain.init();

  const systemWallet = keystore.systemWallet();
  const txPlan = []; // {txType, bizNo, from, to, payload, privateKey, publicKey, at, link}

  // 12.1 企业备案
  enterprises.forEach((e) => {
    const w = keystore.walletFor(`ent:${e.id}`);
    txPlan.push({
      txType: 'ENTERPRISE_REG', bizNo: e.ent_code,
      from: systemWallet.address, to: w.address,
      payload: { entCode: e.ent_code, entName: e.ent_name, industry: e.industry, region: e.region, wallet: w.address },
      privateKey: systemWallet.privateKey, publicKey: systemWallet.publicKey,
      at: e.created_at,
    });
  });

  // 12.2 排放上报（已提交的）
  reports.forEach((r) => {
    if (r.status === 'DRAFT') return;
    const w = keystore.walletFor(`ent:${r.ent_id}`);
    txPlan.push({
      txType: 'EMISSION_REPORT', bizNo: r.report_no,
      from: w.address, to: systemWallet.address,
      payload: {
        reportNo: r.report_no, entId: r.ent_id, entName: r.ent.ent_name, period: r.period,
        scope1: r.scope1, scope2: r.scope2, totalEmission: r.total, intensity: r.intensity,
        dataSource: r.source,
      },
      privateKey: w.privateKey, publicKey: w.publicKey,
      at: r.submit_time,
      link: { table: 'emission_report', id: r.id },
    });
  });

  // 12.3 核查报告
  vReports.forEach((v) => {
    const w = keystore.walletFor(`verifier:${v.verifier_id}`);
    txPlan.push({
      txType: 'VERIFY_REPORT', bizNo: v.report_no,
      from: w.address, to: systemWallet.address,
      payload: {
        verifyReportNo: v.report_no, emissionReportNo: v.report.report_no, entId: v.ent_id,
        verifierId: v.verifier_id, declared: v.declared, verified: v.verified,
        deviationRate: v.deviation, conclusion: v.conclusion, sealHash: v.seal,
      },
      privateKey: w.privateKey, publicKey: w.publicKey,
      at: v.issue_time,
      link: { table: 'verify_report', id: v.id },
    });
  });

  // 12.4 配额分配
  allocations.forEach((a) => {
    txPlan.push({
      txType: 'QUOTA_ALLOC', bizNo: a.alloc_no,
      from: systemWallet.address, to: keystore.walletFor(`ent:${a.ent_id}`).address,
      payload: {
        allocNo: a.alloc_no, entId: a.ent_id, year: a.year, quotaAmount: a.amount,
        allocType: a.type, allocMethod: a.method,
      },
      privateKey: systemWallet.privateKey, publicKey: systemWallet.publicKey,
      at: a.created_at,
      link: { table: 'quota_allocation', id: a.id },
    });
  });

  // 12.5 交易成交
  deals.forEach((d) => {
    const w = keystore.walletFor(`ent:${d.seller_ent_id}`);
    txPlan.push({
      txType: 'TRADE_DEAL', bizNo: d.deal_no,
      from: w.address, to: keystore.walletFor(`ent:${d.buyer_ent_id}`).address,
      payload: {
        dealNo: d.deal_no, buyerEntId: d.buyer_ent_id, sellerEntId: d.seller_ent_id,
        price: d.price, amount: d.amount, totalAmount: d.total, fee: d.fee,
      },
      privateKey: w.privateKey, publicKey: w.publicKey,
      at: d.deal_time,
      link: { table: 'trade_deal', id: d.id },
    });
  });

  // 按时间升序出块
  txPlan.sort((a, b) => new Date(a.at) - new Date(b.at));
  console.log(`   待上链存证交易 ${txPlan.length} 笔，开始打包…`);

  const links = []; // {table, id, blockIndex, txId}
  let i = 0;
  let blockCount = 0;
  while (i < txPlan.length) {
    const size = rng.i(4, 8);
    const batchPlan = txPlan.slice(i, i + size);
    i += size;
    blockCount++;
    const batchTxs = batchPlan.map((p) => chain.buildTx({
      txType: p.txType, bizNo: p.bizNo, fromAddress: p.from, toAddress: p.to,
      payload: p.payload, privateKey: p.privateKey, publicKey: p.publicKey,
      fee: round(rng.d(0.001, 0.02, 4), 4),
    }));
    // 落库 PENDING（批量提交，跨地域灌数时显著减少网络往返）
    await chain.persistTxBatch(batchTxs);
    // 时间戳一律取整到秒，且严格递增，保证链上时间线单调
    const prevSec = chain.blocks.length ? chain.blocks[chain.blocks.length - 1].timestamp : 0;
    const wantSec = Math.floor(new Date(batchPlan[batchPlan.length - 1].at).getTime() / 1000);
    const secs = Math.max(wantSec, prevSec + 1);
    const blk = await chain.mineBlock({ txs: batchTxs, timestamp: secs * 1000 });
    batchTxs.forEach((tx, k) => {
      if (batchPlan[k].link) {
        links.push({ ...batchPlan[k].link, blockIndex: blk.index, txId: tx.txId });
      }
    });
    if (blockCount % 20 === 0) process.stdout.write(`   已出块 ${blockCount} …\r`);
  }
  console.log(`\n✔ chain_block           区块           ${chain.blocks.length} 行`);
  const [[txCnt]] = await conn.query('SELECT COUNT(*) AS c FROM chain_tx');
  console.log(`✔ chain_tx              链上存证交易   ${txCnt.c} 行`);

  /* ============ 13. 回写业务表的链上指针 ============ */
  const grouped = {};
  for (const l of links) (grouped[l.table] = grouped[l.table] || []).push(l);
  for (const [table, list] of Object.entries(grouped)) {
    const vals = list.map((x) => [x.blockIndex, x.txId, x.id]);
    const ph = vals.map(() => '(?,?,?)').join(',');
    await conn.query(
      `UPDATE ${table} t JOIN (SELECT ? AS bi, ? AS tid, ? AS id ${vals.slice(1).map(() => 'UNION ALL SELECT ?,?,?').join(' ')}) v
       ON t.id = v.id SET t.chain_block_index = v.bi, t.chain_tx_id = v.tid`,
      vals.flat()
    ).catch(async () => {
      // 兼容模式：逐条更新
      for (const [bi, tid, id] of vals) {
        await conn.query(`UPDATE ${table} SET chain_block_index=?, chain_tx_id=? WHERE id=?`, [bi, tid, id]);
      }
    });
    console.log(`   ↺ 回写 ${table} 链上指针 ${list.length} 条`);
  }

  /* ============ 14. 全链校验 ============ */
  const v = await chain.validateChain();
  console.log('─'.repeat(64));
  console.log(v.valid ? '✔ 全链完整性校验通过（哈希链 / PoW / Merkle 根 全部一致）' : `✘ 校验发现 ${v.errors.length} 处异常`);
  const st = await chain.stats();
  console.log(`   链高度=${st.height}  总区块=${st.totalBlocks}  链上交易=${st.confirmed}  难度=${st.difficulty}  平均出块=${st.avgMineTime}ms`);
  console.log(`   链尾区块哈希: ${st.tipHash}`);

  await conn.end();
  console.log('─'.repeat(64));
  console.log(`✅ 初始化完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  console.log('   演示账号: admin/admin123(管理员) · ent001/123456(企业端) · ver001/123456(核查机构端) · reg001/123456(监管端)');
}

main().catch((e) => {
  console.error('✘ 初始化失败:', e);
  process.exit(1);
});
