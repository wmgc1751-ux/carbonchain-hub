const fs = require('fs');
const f = 'src/chain.js';
let raw = fs.readFileSync(f, 'utf8');
const crlf = raw.includes('\r\n');
if (crlf) raw = raw.replace(/\r\n/g, '\n');
let n = 0, miss = 0;
function rep(o, t, tag) {
  const oo = o.replace(/\r\n/g, '\n');
  if (!raw.includes(oo)) { console.log('MISS', tag); miss++; return; }
  raw = raw.replace(oo, t.replace(/\r\n/g, '\n'));
  n++;
  console.log('OK', tag);
}

/* appendBlock 块写入（转义丢失导致未替换） */
rep(
  "      `INSERT INTO cc_block (height, hash, prev_hash, merkle_root, tx_count, ts, ts_label, nonce, proposer, consensus, difficulty, size_bytes)\n       VALUES (?,?,?,?,?,?,?,?,?,'POA',0,?)`,\n    ).bind(height, hash, prevHash, root, rows.length, ts, label, nonce, proposer, sizeBytes),",
  "      `INSERT INTO chain_block (block_index, block_hash, prev_hash, merkle_root, tx_count, block_time, nonce, proposer, consensus, difficulty, size_bytes)\n       VALUES (?,?,?,?,?,?,?,?,'POA',0,?)`,\n    ).bind(height, hash, prevHash, root, rows.length, label, nonce, proposer, sizeBytes),",
  'appendBlock 块',
);
/* appendBlock 交易写入 */
rep(
  "      `INSERT INTO cc_tx (tx_id, block_height, tx_type, ent_id, ent_name, biz_no, payload, payload_hash, ts, ts_label, from_addr, to_addr)\n       VALUES (?,?,?,?,?,?,?,?,?,?,?,'did:cc:consortium')`,\n    ).bind(r.txId, height, r.type, r.entId, r.entName, r.bizNo, r.payload, r.payloadHash, r.ts, r.label, r.from)),",
  "      `INSERT INTO chain_tx (tx_id, block_index, tx_type, biz_no, payload_json, payload_hash, created_at, from_address, to_address, status, anchor_status)\n       VALUES (?,?,?,?,?,?,?,?,'CONFIRMED','PENDING')`,\n    ).bind(r.txId, height, r.type, r.bizNo, r.payload, r.payloadHash, r.label, r.from)),",
  'appendBlock 交易',
);
/* blocks 列表 */
rep(
  "      SELECT height, hash, prev_hash prevHash, merkle_root merkleRoot, tx_count txCount,\n              ts, ts_label tsLabel, nonce, proposer, size_bytes sizeBytes\n       FROM cc_block ORDER BY height DESC LIMIT ? OFFSET ?",
  "      SELECT block_index AS height, block_hash AS hash, prev_hash AS prevHash, merkle_root AS merkleRoot,\n              tx_count AS txCount, strftime('%s', block_time) AS ts, block_time AS tsLabel,\n              nonce, proposer, size_bytes AS sizeBytes\n       FROM chain_block ORDER BY block_index DESC LIMIT ? OFFSET ?",
  'blocks 列表',
);
/* txs 过滤基 */
rep(
  "    const w = ['block_height = ?'];\n    const binds = [h];",
  "    const w = ['block_index = ?'];\n    const binds = [h];",
  'txs 过滤基',
);
/* txs 分页 */
rep(
  "      FROM cc_tx ${w} ORDER BY id DESC LIMIT ? OFFSET ?`,",
  "      FROM chain_tx ${w} ORDER BY id DESC LIMIT ? OFFSET ?`,",
  'txs 分页',
);
/* txs 计数 */
rep(
  "    const total = (await db.prepare(`SELECT COUNT(*) c FROM cc_tx ${w}`).bind(...binds).first()).c;",
  "    const total = (await db.prepare(`SELECT COUNT(*) c FROM chain_tx ${w}`).bind(...binds).first()).c;",
  'txs 计数',
);
/* trust-model */
rep(
  "        `SELECT COUNT(*) blocks, COALESCE(SUM(tx_count),0) txs FROM cc_block`,",
  "        `SELECT COUNT(*) blocks, COALESCE(SUM(tx_count),0) txs FROM chain_block`,",
  'trust-model',
);

if (crlf) raw = raw.replace(/\n/g, '\r\n');
fs.writeFileSync(f, raw, 'utf8');
console.log('done', n, 'ok', miss, 'miss');
if (miss) process.exit(1);
