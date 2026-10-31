/**
 * worker/routes/evidence.mjs —— 核算节点可信存证（Cloudflare Workers / D1）
 * ==================================================================================
 * /nodes   静态清单，不查 D1 —— 额度耗尽时仍可用
 * /verify  纯哈希复算，不查 D1
 * /list    查 D1（chain_tx）
 *
 * @module worker/routes/evidence
 */
import { json, fail, authRequired, num } from '../lib/http.mjs';

/* 规范化 + SHA-256（Workers 原生 crypto.subtle） */
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  const out = {};
  Object.keys(obj).sort().forEach((k) => {
    if (obj[k] === undefined) return;
    out[k] = typeof obj[k] === 'number' ? Number(obj[k].toFixed(6)) : canonicalize(obj[k]);
  });
  return out;
}

const NODE_TYPES = {
  ACTIVITY_RECORDED: '活动数据登记',
  CALC_COMPLETED: '核算批次完成',
  VERIFY_PASSED: '核查通过',
  QUOTA_ALLOCATED: '配额分配',
  SURRENDER_EXECUTED: '履约清缴',
  REPORT_SUBMITTED: '排放上报',
};

export function attachEvidenceRoutes(r) {
  /* 节点类型：静态 */
  r.get('/api/evidence/nodes', () => json(
    Object.keys(NODE_TYPES).map((k) => ({ code: k, name: NODE_TYPES[k] })),
  ));

  /* 离线复核：纯哈希，不查 D1 */
  r.post('/api/evidence/verify', async (ctx) => {
    const body = await ctx.body();
    const cred = body && (body.credential || body);
    if (!cred || !cred.evidence) return fail('需要凭证对象', 400);

    const recomputed = await sha256(JSON.stringify(canonicalize(cred.evidence)));
    const digestMatches = recomputed === cred.payloadDigest;

    /* 链上核验（可选，查 D1） */
    let chainCheck = null;
    if (cred.chain && cred.chain.txId) {
      try {
        const row = await ctx.db.one(
          `SELECT tx_id, block_index, payload_json FROM chain_tx WHERE tx_id = ?`,
          [String(cred.chain.txId)]);
        if (!row) {
          chainCheck = { found: false, reason: '链上不存在该交易号' };
        } else {
          let onChain = null;
          try { onChain = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json; }
          catch { onChain = null; }
          chainCheck = {
            found: true,
            blockIndex: row.block_index === null ? null : num(row.block_index),
            digestMatches: !!(onChain && onChain.payloadDigest === cred.payloadDigest),
          };
        }
      } catch (e) {
        /* 链上查询失败不阻断验证 —— 摘要复算仍然有效 */
        chainCheck = { found: false, reason: '链上查询暂时不可用（' + String(e.message).slice(0, 60) + '）' };
      }
    }

    const digestOk = digestMatches;
    const chainOk = !chainCheck || (chainCheck.found && chainCheck.digestMatches);
    return json({
      ok: digestOk && chainOk,
      checks: [
        { name: '载荷摘要可复算', pass: digestOk,
          detail: digestOk ? '' : `重算 ${recomputed.slice(0, 16)}… ≠ 凭证` },
        { name: '含链上锚点', pass: !!cred.chain,
          detail: cred.chain ? `区块 #${cred.chain.blockIndex}` : '未上链' },
      ],
      chainCheck,
      verdict: (digestOk && chainOk) ? 'PASS' : 'FAIL',
    });
  });

  /* 存证列表：查 D1 */
  r.get('/api/evidence/list', authRequired(async (ctx) => {
    const rows = await ctx.db.query(
      `SELECT tx_id, biz_no, block_index, payload_hash, status, created_at
         FROM chain_tx WHERE tx_type = 'EVIDENCE_NODE' ORDER BY id DESC LIMIT 50`);
    return json(rows.map((r2) => ({
      txId: r2.tx_id, bizNo: r2.biz_no,
      blockIndex: r2.block_index === null ? null : num(r2.block_index),
      payloadHash: r2.payload_hash, status: r2.status, createdAt: r2.created_at,
    })), { count: rows.length });
  }));
}
