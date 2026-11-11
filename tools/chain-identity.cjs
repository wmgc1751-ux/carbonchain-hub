/**
 * chain-identity.cjs —— 链指纹同源判定器（2026-11-01）
 * ====================================================
 * 目的：回答"你到底有几个链"。
 *
 * 判定方法：**创世块哈希即链的身份证**。
 *   哈希链的第一块由 (index|timestamp|merkleRoot|prevHash|consensus|proposer|nonce)
 *   经 SHA-256 得到，创世块的 prevHash 全零、无输出可继承，
 *   因此两个环境若创世哈希相同，则必然是同一条链（或它的完整拷贝，逐块可验）；
 *   若不同，则是两条独立引导的链，任何高度上的块都无法相互校验。
 *
 * 输出：每个观测点的 {创世哈希, tip 高度, tip 哈希, 块数}，并给出两两同源结论。
 * 用法：node tools/chain-identity.cjs [--json]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const mysql = require('mysql2/promise');
const { createClient } = require('@libsql/client');

const ROOT = path.join(__dirname, '..');

function loadEnv() {
  const env = {};
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return env;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return env;
}

function get(url, timeout = 10000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
  });
}

/** 各观测点：返回 {label, kind, genesis, tipHeight, tipHash, count, note} */
const PROBES = [];

function addProbe(p) { PROBES.push(p); }

/* ── 1. 本地 MySQL 账本库（L3 权威，可写） ── */
addProbe({
  label: '本地 MySQL 账本库 :3307',
  kind: 'mysql-ledger',
  async run(env) {
    const c = await mysql.createConnection({
      host: '127.0.0.1',
      port: Number(env.LEDGER_DB_PORT || 3307),
      user: env.LEDGER_DB_USER || 'cc_ledger',
      password: env.LEDGER_DB_PASSWORD,
      database: env.LEDGER_DB_NAME || 'carbon_chain_ledger',
    });
    const [[g]] = await c.query('SELECT block_hash FROM chain_block ORDER BY block_index ASC LIMIT 1');
    const [[t]] = await c.query('SELECT block_index, block_hash FROM chain_block ORDER BY block_index DESC LIMIT 1');
    const [[n]] = await c.query('SELECT COUNT(*) c FROM chain_block');
    await c.end();
    return { genesis: g.block_hash, tipHeight: t.block_index, tipHash: t.block_hash, count: n.c };
  },
});

/* ── 2. 本地平台服务 :8300（读同一账本库） ── */
addProbe({
  label: '本地平台服务 :8300',
  kind: 'http',
  async run() {
    const s = await get('http://127.0.0.1:8300/api/chain/stats');
    if (s.status !== 200) return { error: `HTTP ${s.status}` };
    const d = JSON.parse(s.body).data;
    /* 注意：列表接口不认 order=asc，必须直取 index=0 的块，
     * 否则会把 tip 当成创世 —— 同源判定会因此完全失真。 */
    const b0 = await get('http://127.0.0.1:8300/api/chain/blocks/0');
    let genesis = null;
    try {
      const d0 = JSON.parse(b0.body).data;
      genesis = (d0.block && (d0.block.block_hash || d0.block.hash)) || d0.block_hash || d0.hash || null;
    } catch {}
    return { genesis, tipHeight: d.height, tipHash: d.tipHash, count: d.totalBlocks };
  },
});

/* ── 3. 公网权威链 API（小程序链路页所读） ── */
addProbe({
  label: '权威链 API api.carbonchain.dpdns.org',
  kind: 'http',
  async run() {
    const s = await get('https://api.carbonchain.dpdns.org/mini/v1/chain/stats');
    if (s.status !== 200) return { error: `HTTP ${s.status}` };
    const d = JSON.parse(s.body).data;
    const b0 = await get('https://api.carbonchain.dpdns.org/mini/v1/chain/blocks/0');
    let genesis = null;
    try { genesis = JSON.parse(b0.body).data.hash; } catch {}
    return { genesis, tipHeight: d.height, tipHash: d.tipHash, count: d.blocks };
  },
});

/* ── 4. 线上展示层 www（Pages + D1 carbonchain-platform） ── */
addProbe({
  label: '线上展示层 carbonchain-hub.pages.dev',
  kind: 'http',
  async run() {
    const s = await get('https://carbonchain-hub.pages.dev/api/chain/stats', 20000);
    if (s.status !== 200) return { error: `HTTP ${s.status}` };
    const d = JSON.parse(s.body).data;
    let genesis = null;
    try {
      const b0 = await get('https://carbonchain-hub.pages.dev/api/chain/blocks/0', 20000);
      const d0 = JSON.parse(b0.body).data;
      genesis = (d0.block && (d0.block.block_hash || d0.block.hash)) || d0.block_hash || d0.hash || null;
    } catch {}
    return { genesis, tipHeight: d.height, tipHash: d.tipHash, count: d.totalBlocks };
  },
});

/* ── 5. Turso 库（旧快照） ── */
addProbe({
  label: 'Turso carbonchain-jasonwfh',
  kind: 'libsql',
  async run(env) {
    if (!env.TURSO_URL || !env.TURSO_AUTH_TOKEN) return { error: 'no creds' };
    const c = createClient({ url: env.TURSO_URL, authToken: env.TURSO_AUTH_TOKEN });
    const g = await c.execute('SELECT block_hash FROM chain_block ORDER BY block_index ASC LIMIT 1');
    const t = await c.execute('SELECT block_index, block_hash FROM chain_block ORDER BY block_index DESC LIMIT 1');
    const n = await c.execute('SELECT COUNT(*) c FROM chain_block');
    return {
      genesis: g.rows[0] && g.rows[0].block_hash,
      tipHeight: t.rows[0] && t.rows[0].block_index,
      tipHash: t.rows[0] && t.rows[0].block_hash,
      count: n.rows[0] && n.rows[0].c,
    };
  },
});

(async () => {
  const env = loadEnv();
  const out = [];
  for (const p of PROBES) {
    let r;
    try { r = await p.run(env); } catch (e) { r = { error: e.message }; }
    out.push({ label: p.label, kind: p.kind, ...r });
  }

  /* 同源分组：按创世哈希聚类 */
  const groups = new Map();
  for (const o of out) {
    const k = o.genesis || `ERR:${o.label}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o.label);
  }

  const asJson = process.argv.includes('--json');
  if (asJson) {
    console.log(JSON.stringify({ probes: out, groups: [...groups].map(([g, l]) => ({ genesis: g, members: l })) }, null, 2));
    return;
  }

  const pad = (s, n) => String(s == null ? '—' : s).padEnd(n);
  console.log('\n═══ 链指纹同源判定 ═══\n');
  console.log(pad('观测点', 40) + pad('块数', 8) + pad('tip高度', 9) + pad('创世哈希', 20) + 'tip哈希');
  console.log('─'.repeat(112));
  for (const o of out) {
    console.log(
      pad(o.label, 40) + pad(o.error ? 'ERR' : o.count, 8) + pad(o.tipHeight, 9)
      + pad(o.genesis ? o.genesis.slice(0, 16) : (o.error || '—'), 20)
      + (o.tipHash ? o.tipHash.slice(0, 16) : '—'));
  }

  console.log('\n═══ 结论 ═══\n');
  let i = 0;
  for (const [g, members] of groups) {
    i += 1;
    const same = g.startsWith('ERR:') ? '（不可达，未判定）' : `创世 ${g.slice(0, 16)}…`;
    console.log(`链 #${i}：${same}`);
    members.forEach((m) => console.log(`   · ${m}`));
  }
  console.log(`\n共 ${groups.size} 条独立链（按创世哈希聚类）。`);
  console.log('创世哈希相同 ⇒ 同一条链（或逐块可验的完整拷贝）；不同 ⇒ 各自独立引导，跨链区块无法互验。\n');
})();
