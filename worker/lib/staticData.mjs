/**
 * worker/lib/staticData.mjs —— 静态数据集读取器
 * ==================================================================================
 * D1 免费层每天 500 万行读取额度。高频读（3D 孪生候选、因子、链概要）
 * 优先走静态集（构建时导出的 JSON，约 22 KB），不消耗 D1 配额。
 * 写入和实时数据仍走 D1。
 */
'use strict';

let cache = null;
let loadedAt = 0;
const TTL_MS = 5 * 60 * 1000;

/** 加载静态数据集（带内存缓存） */
export async function loadStatic(env) {
  if (cache && Date.now() - loadedAt < TTL_MS) return cache;
  try {
    /* 从同域静态资源获取 */
    const url = new URL('/data/static-dataset.json',
      env && env.ASSETS_BASE ? env.ASSETS_BASE : 'https://carbonchain-hub.pages.dev');
    const res = await fetch(url.href, { cf: { cacheTtl: 300 } });
    if (!res.ok) throw new Error(`静态集 HTTP ${res.status}`);
    const j = await res.json();
    cache = j;
    loadedAt = Date.now();
    return j;
  } catch (e) {
    console.warn('[staticData] 降级到 D1：', e.message);
    return {};
  }
}

export async function getCandidates(env) {
  const s = await loadStatic(env);
  return Array.isArray(s.candidates) && s.candidates.length ? s.candidates : null;
}

export async function getFactors(env) {
  const s = await loadStatic(env);
  return Array.isArray(s.factors) && s.factors.length ? s.factors : null;
}

export async function getChainSummary(env) {
  const s = await loadStatic(env);
  return s.chain && s.chain.height > 0 ? s.chain : null;
}

export async function getTruthData(env) {
  const s = await loadStatic(env);
  return s.truth && s.truth.chn_fac > 0 ? s.truth : null;
}
