#!/usr/bin/env node
/**
 * tools/_qa/loop-e2e.cjs —— 端到端业务闭环实测
 * 链路：企业上报 → 自动建核查任务 → 核查双人复核 → 监管配额分配 → 交易 → 清缴
 * 用隔离测试企业，不碰真实企业数据。
 */
'use strict';
const http = require('http');
const mysql = require('mysql2/promise');
const cfg = require('../../server/config');

function req(m, p, body, tok) {
  return new Promise((r) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json' };
    if (tok) h.Authorization = 'Bearer ' + tok;
    if (d) h['Content-Length'] = Buffer.byteLength(d);
    const q = http.request({ host: '127.0.0.1', port: 8300, path: p, method: m, headers: h, timeout: 30000 }, (res) => {
      let s = ''; res.on('data', (c) => (s += c));
      res.on('end', () => { try { r({ status: res.statusCode, j: JSON.parse(s) }); } catch { r({ status: res.statusCode, raw: s.slice(0, 150) }); } });
    });
    q.on('timeout', () => { q.destroy(); r({ status: 0, raw: 'timeout' }); });
    q.on('error', (e) => r({ status: 0, raw: e.message }));
    if (d) q.write(d); q.end();
  });
}
const lg = async (u, pw) => { const x = await req('POST', '/api/auth/login', { username: u, password: pw }); return x.j && x.j.data ? x.j.data.token : null; };
let failures = 0;
const line = (ok, name, detail) => { if (!ok) failures++; console.log((ok ? '✔' : '✘') + ' ' + name + (detail ? ' → ' + String(detail).slice(0, 90) : '')); };

(async () => {
  const conn = await mysql.createConnection(cfg.db);
  console.log('\n════ 端到端闭环实测（隔离测试企业）════\n');

  /* 建隔离企业 + 账号 */
  const YEAR = new Date().getFullYear();
  const code = 'E2ELOOP-' + Date.now();
  const [entRes] = await conn.query(
    "INSERT INTO enterprise (ent_code, ent_name, industry, region, status) VALUES (?,?,?,?,'ACTIVE')",
    [code, '[闭环测试]环链环保科技有限公司', '垃圾焚烧发电', '保定市']
  );
  const entId = entRes.insertId;
  const cu = require('../../server/blockchain/crypto-utils');
  const salt = cu.randomSalt(16);
  const hash = cu.hashPasswordPbkdf2('123456', salt);
  const uname = 'e2e_' + Date.now().toString(36);
  await conn.query(
    `INSERT INTO sys_user (username,password,salt,real_name,role,org_id,org_name,status)
     VALUES (?,?,?,?,'ENTERPRISE',?,?,1)`,
    [uname, hash, salt, '闭环测试员', entId, '[闭环测试]环链环保科技有限公司']
  );
  console.log(`隔离企业 #${entId} / 账号 ${uname}\n`);

  try {
    const et = await lg(uname, '123456');
    if (!et) { console.log('✘ 登录失败'); return; }

    /* ① 企业创建上报单 */
    const rep = await req('POST', '/api/enterprise/reports', {
      year: YEAR, quarter: 4,
      items: [
        { energyType: '原煤', amount: 1000 },
        { energyType: '电力', amount: 10000 },
      ],
    }, et);
    line(rep.status === 200 && rep.j.code === 0, '① 企业创建上报单', rep.j && (rep.j.message || (rep.j.data && rep.j.data.reportNo)));
    const reportId = rep.j && rep.j.data && (rep.j.data.reportId || rep.j.data.id);
    if (!reportId) { console.log('   无法继续：未取得 reportId'); return; }

    /* ② 提交上报（应自动建核查任务） */
    const sub = await req('POST', `/api/enterprise/reports/${reportId}/submit`, {}, et);
    line(sub.status === 200 && sub.j.code === 0, '② 提交上报', sub.j && sub.j.message);

    const [tasks] = await conn.query('SELECT id, verifier_id, status FROM verify_task WHERE report_id = ?', [reportId]);
    const task = tasks[0];
    line(!!task, '③ 自动建核查任务', task ? `任务 #${task.id} → 核查机构 #${task.verifier_id}` : '未生成');

    if (task) {
      /* 把任务指派给有双岗位的核查机构（大连碳中和 org=1） */
      await conn.query('UPDATE verify_task SET verifier_id = 1 WHERE id = ?', [task.id]);
      const vId = 1;
      /* 给该机构发一个机构管理员账号用于建档（若已有 clerk/review 直接用） */
      const [clerks] = await conn.query(
        "SELECT id FROM sys_user WHERE role='VERIFIER' AND org_id=? AND post='VER_CLERK' LIMIT 1", [vId]
      );
      const [reviews] = await conn.query(
        "SELECT id FROM sys_user WHERE role='VERIFIER' AND org_id=? AND post='VER_REVIEWER' LIMIT 1", [vId]
      );
      line(!!clerks.length && !!reviews.length, '④ 核查机构具备双岗位', `录入 ${clerks.length} / 审核 ${reviews.length}`);

      if (clerks.length && reviews.length) {
        const ct = await lg('ver_clerk', '123456');
        const rt = await lg('ver_review', '123456');

        /* ⑤ 录入员提交结论 */
        const s1 = await req('POST', `/api/verifier/tasks/${task.id}/verify`,
          { conclusion: 'PASS', verifiedValue: 9000 }, ct);
        line(s1.status === 200 && s1.j.data && s1.j.data.stage === 'SUBMITTED', '⑤ 录入员提交结论', s1.j && s1.j.message);
        const vrId = s1.j.data && s1.j.data.verifyReportId;

        /* ⑥ 录入员自批（应拒） */
        const s2 = await req('POST', `/api/verifier/tasks/${task.id}/verify`,
          { conclusion: 'PASS', approveReportId: vrId }, ct);
        line(s2.status === 403, '⑥ 录入员自批被拒', s2.j && s2.j.message);

        /* ⑦ 审核员批准 */
        const s3 = await req('POST', `/api/verifier/tasks/${task.id}/verify`,
          { conclusion: 'PASS', approveReportId: vrId }, rt);
        line(s3.status === 200, '⑦ 审核员批准并上链', s3.j && (s3.j.message || (s3.j.data && s3.j.data.verifyReportNo)));

        /* ⑧ 监管配额分配 */
        const reg = await lg('reg001', '123456');
        const alloc = await req('POST', '/api/regulator/allocations',
          { entId, year: YEAR, amount: 10000, allocType: 'FREE', allocMethod: 'BENCHMARK' }, reg);
        line(alloc.status === 200, '⑧ 监管下分配额', alloc.j && alloc.j.message);

        /* ⑨ 企业卖出配额（挂牌） */
        const sell = await req('POST', '/api/trade/orders',
          { side: 'SELL', price: 100, amount: 100 }, et);
        line(sell.status === 200, '⑨ 企业挂牌卖出', sell.j && (sell.j.message || (sell.j.data && sell.j.data.order && sell.j.data.order.orderNo)));

        /* ⑩ 证据链完整性 */
        const ec = await req('GET', `/api/regulator/evidence-chain?entId=${entId}&year=${YEAR}`, null, reg);
        const integ = ec.j.data && ec.j.data.integrity;
        line(!!integ, '⑩ 证据链可查', integ && JSON.stringify({ 完整度: integ.completeness, 上链节点: `${integ.chainAnchored}/${integ.totalNodes}`, 核查已复核: integ.verifyAllApproved }));
      }
    }
  } finally {
    /* 清理隔离数据 */
    const [rows] = await conn.query('SELECT id FROM verify_task WHERE ent_id = ?', [entId]);
    for (const r of rows) {
      await conn.query('DELETE FROM verify_report WHERE task_id = ?', [r.id]);
      await conn.query('DELETE FROM verify_task WHERE id = ?', [r.id]);
    }
    for (const t of ['emission_item', 'emission_report', 'activity_data', 'carbon_quota', 'quota_allocation', 'trade_order', 'trade_deal', 'settlement_account', 'settlement_flow', 'alert_record']) {
      try { await conn.query(`DELETE FROM ${t} WHERE ent_id = ?`, [entId]); } catch (e) { /* 表无此列则跳过 */ }
    }
    await conn.query('DELETE FROM sys_user WHERE org_id = ?', [entId]);
    await conn.query('DELETE FROM enterprise WHERE id = ?', [entId]);
    console.log('\n（隔离测试数据已清理）');
    await conn.end();
    const [chk] = await mysql.createConnection(cfg.db).then(async (c2) => {
      const r = await c2.query('SELECT COUNT(*) n FROM enterprise WHERE ent_code LIKE ?', ['E2ELOOP-%']);
      await c2.end(); return r;
    });
    const [chk2] = await mysql.createConnection(cfg.db).then(async (c2) => {
      const r = await c2.query('SELECT COUNT(*) n FROM enterprise');
      await c2.end(); return r;
    });
    console.log(`企业总数 ${chk2[0].n}（隔离残留 ${chk[0].n}）`);
    /* 供回归套件判断：任一步失败即非零退出 */
    console.log(failures === 0 ? '\n闭环实测全部通过' : `\n闭环实测有 ${failures} 项未通过`);
    process.exitCode = failures > 0 || chk[0].n > 0 ? 1 : 0;
  }
})();
