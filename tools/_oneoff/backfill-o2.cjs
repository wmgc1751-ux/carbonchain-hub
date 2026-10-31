/** 用 .cache/hb-o2 回补原 4 排口的 o2_pct（唯一键定位行，不触碰其它列） */
'use strict';
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const cfg = require('../../server/config');
const SRC = path.join(__dirname, '..', '..', '.cache', 'hb-o2');
const num = (v) => { const n = Number(v); return (v === undefined || v === null || v === '-' || !Number.isFinite(n)) ? null : n; };
(async () => {
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.json'));
  const conn = await mysql.createConnection({ ...cfg.db, dateStrings: true });
  let set = 0, cleared = 0, missing = 0;
  for (const f of files) {
    const [portId, ym] = f.replace('.json', '').split('_');
    const rows = JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
    for (const r of rows) {
      if (!r.time) continue;
      const o2 = num(r['a19001-avg']);
      /* 含氧量物理区间 0–21%（标干烟气上限），超界按传感器故障置 NULL */
      const v = (o2 !== null && o2 >= -0.5 && o2 <= 21.5) ? o2 : null;
      if (o2 === null) { missing++; continue; }
      if (v === null) cleared++;
      const [res] = await conn.query(
        'UPDATE cems_cn_hourly SET o2_pct = ? WHERE monitored_at = ? AND outlet_name IN (\'1号烟气排放口\',\'废气排口1号\',\'焚烧炉烟囱\',\'焚烧炉排气筒\')',
        [v, r.time]);
      if (res.affectedRows) set++; else missing++;
    }
  }
  const [[s]] = await conn.query("SELECT COUNT(*) n, SUM(o2_pct IS NOT NULL) has_o2 FROM cems_cn_hourly");
  console.log(`更新 ${set} 行 · 源端无值 ${missing} · 超界置空 ${cleared}`);
  console.log(`库内 ${s.n} 行，含氧量非空 ${s.has_o2}`);
  await conn.end();
})().catch(e => { console.error(e.message); process.exit(1); });
