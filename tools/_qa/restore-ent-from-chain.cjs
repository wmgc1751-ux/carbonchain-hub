/**
 * 从链上存证反推重建业务行 —— 用于修复"业务行被删、链上存证仍在"的孤儿。
 * 原则：链是事实源。业务行必须由链上 payload 重建，不能凭空编造。
 */
const fs = require('fs');
const env = {};
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim();
}
const mysql = require('mysql2/promise');

const TX = 'a912b30b498686b69afea487a58b7448f4e80606a5800540be179e2cb9533e68';
const WALLET = '0xc23d61f58435ddce70ba3b1b1693995ea5153b53';

(async () => {
  const ledger = await mysql.createConnection({
    host: env.LEDGER_DB_HOST, port: +env.LEDGER_DB_PORT, user: env.LEDGER_DB_USER,
    password: env.LEDGER_DB_PASSWORD, database: env.LEDGER_DB_NAME,
  });
  const [txs] = await ledger.query('SELECT * FROM chain_tx WHERE tx_id = ?', [TX]);
  if (!txs.length) { console.log('链上存证不存在'); process.exit(1); }
  const tx = txs[0];
  const payload = JSON.parse(tx.payload_json);
  console.log('链上事实:', JSON.stringify(payload));
  await ledger.end();

  const biz = await mysql.createConnection({
    host: env.DB_HOST, port: +env.DB_PORT, user: env.DB_USER,
    password: env.DB_PASSWORD, database: env.DB_NAME,
  });

  // 1. 企业档案（entId 由链上 payload 指定）
  const [ent] = await biz.query('SELECT id FROM enterprise WHERE id = ?', [payload.entId]);
  if (!ent.length) {
    await biz.query(
      `INSERT INTO enterprise (id, ent_code, ent_name, industry, region, wallet_address, status)
       VALUES (?,?,?,?,?,?, 'ACTIVE')`,
      [payload.entId, `REG${payload.entId}`, payload.entName, '电力', '河北', WALLET]);
    console.log(`✔ 重建企业 #${payload.entId} ${payload.entName}`);
  } else { console.log('企业已存在，跳过'); }

  // 2. 业务上报行（字段取自链上 payload，chain_tx_id 回填以恢复绑定）
  const [rep] = await biz.query('SELECT id FROM emission_report WHERE report_no = ?', [payload.reportNo]);
  if (!rep.length) {
    const year = Number(String(payload.period).slice(0, 4));
    const quarter = Number(String(payload.period).slice(5));
    await biz.query(
      `INSERT INTO emission_report
        (report_no, ent_id, year, quarter, period, scope1_emission, scope2_emission, total_emission,
         intensity, data_source, status, chain_block_index, chain_tx_id, submit_time, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'SUBMITTED', ?,?, NOW(), ?)`,
      [payload.reportNo, payload.entId, year, quarter, payload.period,
        payload.scope1, payload.scope2, payload.totalEmission, payload.intensity,
        payload.dataSource, tx.block_index, TX, tx.created_at]);
    console.log(`✔ 重建上报单 ${payload.reportNo}（${payload.period}，${payload.totalEmission} t）→ 绑定 #${tx.block_index}`);
  } else { console.log('上报单已存在，跳过'); }

  // 3. 复核绑定
  const [chk] = await biz.query(
    'SELECT id, report_no, total_emission, chain_tx_id FROM emission_report WHERE report_no = ?', [payload.reportNo]);
  console.log('复核:', JSON.stringify(chk[0]));
  await biz.end();
})().catch(e => { console.error(String(e.message).slice(0, 300)); process.exit(1); });
