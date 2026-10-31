import fs from 'node:fs';
import { createTurso } from '../../../../碳链通小程序/server/src/turso.js';
const env = {};
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const db = createTurso({ url: env.TURSO_URL, token: env.TURSO_AUTH_TOKEN });
const byV = await db.prepare(
  'SELECT verifier_id, status, COUNT(*) AS n FROM verify_task GROUP BY verifier_id, status ORDER BY verifier_id',
).all();
console.log('task distribution:', JSON.stringify(byV.results));
const v1 = await db.prepare('SELECT id, org_code, org_name, status FROM verifier_org WHERE id <= 6').all();
console.log('verifier orgs:', JSON.stringify(v1.results));
const users = await db.prepare("SELECT id, username, role, org_id FROM sys_user WHERE role='VERIFIER' LIMIT 6").all().catch(e => ({ results: [{ err: String(e).slice(0,80) }] }));
console.log('verifier users:', JSON.stringify(users.results));
