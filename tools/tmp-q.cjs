const db = require('../server/db');
(async () => {
  const rows = await db.query(
    `SELECT dev_seq, flow_value, quality_flag, created_at FROM cems_reading WHERE device_did LIKE '%d6782a54%' ORDER BY id DESC LIMIT 6`);
  for (const r of rows) console.log(`seq ${r.dev_seq} | ${r.flow_value} | ${r.quality_flag} | ${r.created_at}`);
  const q = await db.query(
    `SELECT quality_flag, COUNT(*) n FROM cems_reading WHERE device_did LIKE '%d6782a54%' GROUP BY quality_flag`);
  console.log('质量标记分布:', q.map((r) => `${r.quality_flag} ${r.n}`).join(' / '));
  const d = await db.query(
    `SELECT did, dev_last_seq, last_seen_at, dev_key_fp FROM device_registry WHERE did LIKE '%d6782a54%'`);
  console.log(JSON.stringify(d[0]));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
