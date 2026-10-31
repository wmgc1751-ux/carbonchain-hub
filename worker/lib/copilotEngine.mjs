/**
 * worker/lib/copilotEngine.mjs —— AI 顾问引擎（Worker 轻量版）
 * ==================================================================================
 * 与 server/services/carbonCopilot.js 同一套意图识别与工具结构，
 * 但直接用 Worker 的 db 句柄查 D1。
 * 额度耗尽时各工具自然抛错，由上层转成 503。
 */
import { sm3Hex } from './gm.mjs';

/* ---------- 意图识别（与 Express 版同一套规则） ---------- */
export function detectIntent(q) {
  const s = String(q || '').trim();
  const intents = [];
  const batchMatch = s.match(/CALC\d{6,}/i);
  const batchNo = batchMatch ? batchMatch[0] : null;
  if (batchNo) intents.push({ tool: 'evidence_status', args: { batchNo } });
  if (/存证|上链|区块|哈希|凭证/.test(s) && !batchNo) intents.push({ tool: 'chain_integrity', args: {} });
  if (/完整性|账实|一致|校验/.test(s)) intents.push({ tool: 'chain_integrity', args: {} });
  if (/计算|算一下|多少吨/.test(s)) {
    const m = s.match(/(\d+(?:\.\d+)?)\s*[×x*]\s*(\d+(?:\.\d+)?)/);
    if (m) intents.push({ tool: 'carbon_calc', args: { amount: m[1], factor: m[2] } });
  }
  if (/因子|系数|EF|NCV/.test(s)) {
    const kw = ['原煤','焦炭','天然气','柴油','华北','东北','华东','华中','西北','南方','西南','电力'].find(k=>s.includes(k)) || '';
    intents.push({ tool: 'factor_lookup', args: { keyword: kw } });
  }
  if (/配额|缺口|履约|风险/.test(s)) intents.push({ tool: 'enterprise_overview', args: {} });
  if (/批次|核算/.test(s)) intents.push({ tool: 'list_my_batches', args: {} });
  if (/同行|对标|中位数/.test(s)) {
    const ind = ['电力','钢铁','建材','化工'].find(k=>s.includes(k)) || '钢铁';
    intents.push({ tool: 'peer_benchmark', args: { industry: ind } });
  }
  if (!intents.length && /我|企业|排放/.test(s)) intents.push({ tool: 'enterprise_overview', args: {} });
  const seen = new Set();
  return intents.filter(i => (seen.has(i.tool) ? false : (seen.add(i.tool), true)));
}

/* ---------- 工具（简化版，够用） ---------- */
async function toolEnterpriseOverview(db, user) {
  const entId = user && user.role === 'ENTERPRISE' ? Number(user.orgId) : null;
  if (!entId) return { error: '请以企业身份登录后查询' };
  const ent = await db.one('SELECT ent_name, industry, region FROM enterprise WHERE id = ?', [entId]);
  if (!ent) return { error: '企业不存在' };
  const quota = await db.one(
    'SELECT year, total_allocated, used FROM carbon_quota WHERE ent_id = ? ORDER BY year DESC LIMIT 1', [entId]);
  const dyn = await db.one(
    'SELECT cumulative_emission, predicted_eoy, gap, risk_level FROM carbon_dynamic_account WHERE ent_id = ? ORDER BY year DESC LIMIT 1', [entId]);
  return { enterprise: { name: ent.ent_name, industry: ent.industry, region: ent.region },
    quota: quota ? { year: Number(quota.year), allocated: Number(quota.total_allocated), used: Number(quota.used) } : null,
    dynamic: dyn ? { cumulative: Number(dyn.cumulative_emission), predicted: Number(dyn.predicted_eoy),
      gap: Number(dyn.gap), risk: dyn.risk_level } : null,
    source: 'carbon_quota / carbon_dynamic_account' };
}

async function toolFactorLookup(db, args) {
  const kw = `%${args.keyword || ''}%`;
  const rows = await db.query(
    'SELECT code, name_cn, ef_value, ef_unit, source_doc, region, version FROM factor_entry WHERE code LIKE ? OR name_cn LIKE ? OR region LIKE ? ORDER BY category LIMIT 10',
    [kw, kw, kw]);
  if (!rows.length) return { found: 0, hint: '未匹配到因子' };
  return { found: rows.length, factors: rows.map(f => ({
    code: f.code, name: f.name_cn, ef: Number(f.ef_value), unit: f.ef_unit, basis: f.source_doc,
  })), source: 'factor_entry' };
}

async function toolChainIntegrity(db) {
  const blk = await db.one('SELECT COUNT(*) AS blocks, MAX(block_index) AS height, SUM(tx_count) AS packed FROM chain_block');
  const tx = await db.one("SELECT COUNT(*) AS rows_n, SUM(status='CONFIRMED') AS confirmed, SUM(status='PENDING') AS pending FROM chain_tx");
  const packed = Number(blk.packed) || 0;
  const confirmed = Number(tx.confirmed) || 0;
  const pending = Number(tx.pending) || 0;
  return { height: Number(blk.height) || 0, blocks: Number(blk.blocks) || 0,
    confirmed, pending, ledgerRows: Number(tx.rows_n) || 0,
    accounting: { state: packed === confirmed + pending ? 'BALANCED' : (packed - confirmed - pending === -pending ? 'PENDING_BACKLOG' : 'MISMATCH') },
    source: 'chain_block / chain_tx' };
}

async function toolEvidenceStatus(db, args) {
  if (!args.batchNo) return { error: '需要批次号' };
  const rows = await db.query(
    "SELECT tx_id, block_index, payload_hash, payload_json, status, created_at FROM chain_tx WHERE biz_no = ? AND tx_type = 'EVIDENCE_NODE' ORDER BY id DESC LIMIT 5",
    [String(args.batchNo)]);
  if (!rows.length) return { found: false, hint: `批次 ${args.batchNo} 尚未生成存证` };
  return { found: rows.length, records: rows.map(r => ({
    txId: r.tx_id, blockIndex: r.block_index, status: r.status, createdAt: r.created_at,
  })), source: 'chain_tx' };
}

/* ---------- 回答组装 ---------- */
function renderAnswer(tool, result, args) {
  if (result && result.error) return `查询遇到问题：${result.error}`;
  switch (tool) {
    case 'enterprise_overview': {
      const d = result;
      const lines = [`**${d.enterprise.name}**（${d.enterprise.industry} · ${d.enterprise.region}）`];
      if (d.quota) lines.push(`配额：${d.quota.year} 年度已分配 **${d.quota.allocated.toLocaleString()} tCO₂e**，已使用 ${d.quota.used.toLocaleString()}`);
      if (d.dynamic) {
        lines.push(`累计排放 **${d.dynamic.cumulative.toLocaleString()} tCO₂e**，期末预测 ${d.dynamic.predicted.toLocaleString()}`);
        if (d.dynamic.gap > 0) lines.push(`⚠ 预计缺口 **${d.dynamic.gap.toLocaleString()} tCO₂e**，风险等级 ${d.dynamic.risk}`);
        else lines.push(`✔ 预计富余 ${(-d.dynamic.gap).toLocaleString()} tCO₂e`);
      }
      lines.push(`\n_数据来源：${d.source}_`);
      return lines.join('\n');
    }
    case 'factor_lookup': {
      if (!result.found) return result.hint || '未找到因子';
      return result.factors.map(f =>
        `**${f.name}**（\`${f.code}\`）：EF = ${f.ef} ${f.unit || ''}\n  出处：${f.basis || '—'}`
      ).join('\n') + `\n\n_数据来源：${result.source}_`;
    }
    case 'carbon_calc': {
      const a = Number(args.amount), f = Number(args.factor);
      return `计算：**${a} × ${f} = ${(a * f).toFixed(3)} tCO₂e**`;
    }
    case 'chain_integrity': {
      return `区块链：高度 **${result.height}**，${result.blocks} 个区块\n`
        + `已确认 ${result.confirmed} 笔，待打包 ${result.pending} 笔\n`
        + `账实：${result.accounting.state}\n_数据来源：${result.source}_`;
    }
    case 'evidence_status': {
      if (!result.found) return result.hint;
      return result.records.map(r =>
        `区块 **#${r.blockIndex}** · 状态 ${r.status} · ${r.createdAt}`
      ).join('\n');
    }
    default: return '暂时无法处理这个问题。';
  }
}

/* ---------- 主入口 ---------- */
export async function ask({ question, user, context, db }) {
  const q = String(question || '').slice(0, 500);
  if (!q.trim()) return { answer: '请提出一个与平台数据相关的问题。', intents: [], tools: [] };
  const intents = detectIntent(q);
  if (!intents.length) {
    return { answer: '这个问题超出我的能力范围。\n\n我是碳链通平台的数据助手，能回答配额、核算、因子、链上存证等平台数据问题。',
      intents: [], tools: [], boundary: true };
  }
  const results = [];
  for (const it of intents) {
    let result;
    try {
      switch (it.tool) {
        case 'enterprise_overview': result = await toolEnterpriseOverview(db, user); break;
        case 'factor_lookup': result = await toolFactorLookup(db, it.args); break;
        case 'carbon_calc': result = { result: Number(it.args.amount) * Number(it.args.factor) }; break;
        case 'chain_integrity': result = await toolChainIntegrity(db); break;
        case 'evidence_status': result = await toolEvidenceStatus(db, it.args); break;
        default: result = { error: '工具未实现' };
      }
    } catch (e) { result = { error: e.message }; }
    results.push({ tool: it.tool, args: it.args, result });
  }
  const answer = results.map(r => renderAnswer(r.tool, r.result, r.args)).join('\n\n---\n\n');
  return { answer, intents: intents.map(i=>i.tool),
    tools: results.map(r => ({ tool: r.tool, ok: !(r.result && r.result.error) })),
    generatedAt: new Date().toISOString() };
}
