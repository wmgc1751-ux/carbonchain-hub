/**
 * 一次性诊断：Turso 配额年度分布 + 结算账户现状
 */
import fs from 'node:fs';
import { createTurso } from '../../../../碳链通小程序/server/src/turso.js';

const env = {};
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const db = createTurso({ url: env.TURSO_URL, token: env.TURSO_AUTH_TOKEN });

const y = await db.prepare(
  'SELECT year, COUNT(*) AS n, SUM(total_allocated) AS alloc, SUM(available) AS avail FROM carbon_quota GROUP BY year ORDER BY year',
).all();
console.log('quota by year:', JSON.stringify(y.results));

const a = await db.prepare(
  "SELECT ent_id, balance, frozen FROM settlement_account WHERE currency='CNY'",
).all();
console.log('accounts:', JSON.stringify(a.results));

const e = await db.prepare(
  "SELECT status, COUNT(*) AS n FROM enterprise GROUP BY status",
).all();
console.log('enterprise status:', JSON.stringify(e.results));
