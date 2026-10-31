/**
 * 验证：Turso 适配器在 LEFT JOIN 的 ON 条件里能否正确绑定参数。
 * 这是一次性探针 —— 结果决定生产代码能否在 ON 里用 ? 占位。
 */
import fs from 'node:fs';
import { createTurso } from '../../../../碳链通小程序/server/src/turso.js';

const env = {};
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const db = createTurso({ url: env.TURSO_URL, token: env.TURSO_AUTH_TOKEN });

const a = await db.prepare(
  `SELECT e.id, COALESCE(q.total_allocated, 0) AS quota
     FROM enterprise e
     LEFT JOIN carbon_quota q ON q.ent_id = e.id AND q.year = ?
    WHERE e.id <= 3 ORDER BY e.id`,
).bind(2026).all();
console.log('ON 条件参数(?)：', JSON.stringify(a.results));

const b = await db.prepare(
  `SELECT e.id, COALESCE(q.total_allocated, 0) AS quota
     FROM enterprise e
     LEFT JOIN carbon_quota q ON q.ent_id = e.id AND q.year = 2026
    WHERE e.id <= 3 ORDER BY e.id`,
).all();
console.log('ON 条件字面量：', JSON.stringify(b.results));

const c = await db.prepare(
  `SELECT e.id, COALESCE(q.total_allocated, 0) AS quota
     FROM enterprise e
     LEFT JOIN carbon_quota q ON q.ent_id = e.id
    WHERE e.id <= 3 AND q.year = ? ORDER BY e.id`,
).bind(2026).all();
console.log('WHERE 条件参数(?)：', JSON.stringify(c.results));
