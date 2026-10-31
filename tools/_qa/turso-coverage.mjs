import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
(async () => {
  const r = await fetch(env.TURSO_URL.replace('libsql://', 'https://') + '/v2/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.TURSO_AUTH_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql: "SELECT name, sql FROM sqlite_master WHERE type='table'" } }] }),
  });
  const j = await r.json();
  const item = j.results[0];
  if (item.type !== 'ok') { console.log('ERR', item.error && item.error.message); process.exit(1); }
  const schema = {};
  for (const row of item.response.result.rows) {
    const name = row[0].value, sql = row[1].value || '';
    const cols = [...sql.matchAll(/^\s{2,}(["'`]?)([\w]+)\1\s+(TEXT|INTEGER|REAL|NUMERIC|BLOB|VARCHAR|DECIMAL|DATETIME|BIGINT|BOOLEAN)/gim)].map((x) => x[2].toLowerCase());
    schema[name] = new Set(cols);
  }
  console.log('远端表结构已取：', Object.keys(schema).length, '张');
  const keyChecks = [
    ['chain_block', ['block_index', 'block_hash', 'prev_hash', 'merkle_root', 'nonce', 'proposer', 'proposer_sig', 'tx_count', 'ts', 'consensus', 'difficulty', 'size_bytes']],
    ['chain_tx', ['tx_id', 'tx_type', 'biz_no', 'block_index', 'from_address', 'to_address', 'payload_hash', 'payload_json', 'signature', 'pub_key', 'nonce', 'status', 'created_at']],
    ['chain_node', ['node_id', 'public_key', 'status', 'is_authorized', 'vote_weight']],
    ['enterprise', ['id', 'ent_name', 'wallet_address', 'pub_key', 'status', 'credit_score']],
    ['emission_report', ['id', 'report_no', 'ent_id', 'year', 'quarter', 'total_emission', 'status', 'chain_tx_id']],
    ['verify_task', ['id', 'task_no', 'report_id', 'ent_id', 'verifier_id', 'status']],
    ['carbon_quota', ['ent_id', 'year', 'total_allocated', 'available']],
    ['sys_user', ['id', 'username', 'password', 'salt', 'role', 'status', 'org_id']],
    ['notice', ['id', 'title', 'content', 'notice_type', 'publish_time']],
    ['real_facility', ['id', 'external_id', 'name', 'industry', 'latitude', 'longitude']],
    ['real_emission_year', ['facility_id', 'year', 'total_co2e', 'process_json']],
  ];
  let miss = 0;
  for (const [t, cols] of keyChecks) {
    const have = schema[t] || new Set();
    if (!have.size) { console.log('✘ 表缺失:', t); miss++; continue; }
    const missing = cols.filter((c) => !have.has(c));
    if (missing.length) { console.log('✘', t, '缺列:', missing.join(',')); miss++; }
    else console.log('✔', t, '(' + cols.length + ' 列全齐)');
  }
  console.log(miss ? '缺失 ' + miss + ' 项' : '全部关键表/列就绪');
})().catch((e) => console.log('ERR', e.message));
