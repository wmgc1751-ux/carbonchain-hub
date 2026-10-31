/**
 * worker/routes/noticeFeed.mjs —— 云端实时通知聚合（权威源站 → Cache API）
 * ==================================================================================
 * 【与本地版的架构差异，为什么必须不同】
 *
 *   本地（Express + MySQL）：抓取 → 入库 notice 表 → 前端查表。
 *   云端（Workers + D1）  ：D1 行读取有 500 万/天配额，且 Worker 出口网络
 *   可以直接访问源站。因此云端采用 **实时抓取 + Cache API**：
 *
 *     · 前端请求 → Cache API（20 分钟边缘缓存）→ 未命中则实时抓取源站
 *     · 全程零 D1 查询 —— 通知功能的配额成本为 0
 *     · 抓取失败返回明确错误，不编造内容
 *
 * 【源与解析器】与 server/services/noticeFeed.js 保持同一套结构认知：
 *   MEE 标题在 <a title> 属性；环交所文章路径 /c/YYYY-MM/ID.shtml；
 *   ICAP 是 Drupal 的 <h2 class="title"><a>。
 *
 * @module worker/routes/noticeFeed
 */
import { json } from '../lib/http.mjs';

/* ==================================================================================
 * 分类定义（与本地 noticeFeed.js / 前端 DICT 对齐）
 * ================================================================================== */
const CATEGORIES = {
  OFFICIAL:      { label: '官方通知', desc: '生态环境部等权威机构发布的正式通知与要闻' },
  POLICY:        { label: '政策法规', desc: '碳市场政策法规、核算指南、配额分配方案' },
  MARKET:        { label: '市场动态', desc: '全国碳市场行情、CCER、交易与清缴公告' },
  INTERNATIONAL: { label: '国际动态', desc: 'EU CBAM、ICAP、国际碳市场进展' },
};

/* ==================================================================================
 * 解析工具
 * ================================================================================== */
function cleanTitle(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    .replace(/&uuml;/gi, 'ü').replace(/&eacute;/gi, 'é')
    .replace(/\s+/g, ' ')
    .trim();
}

function dateFromPath(url) {
  const m1 = url.match(/t(\d{4})(\d{2})(\d{2})_\d+\./);
  if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
  const m2 = url.match(/\/c\/(\d{4}-\d{2}-\d{2})\//);
  if (m2) return m2[1];
  return null;
}

function parseTitleAttr(html, baseUrl) {
  const items = [];
  const re = /<a[^>]+href="([^"]+)"[^>]+title="([^"]{8,200})"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const title = cleanTitle(m[2]);
    if (title.length < 10) continue;
    const full = new URL(m[1], baseUrl).toString();
    items.push({ title, url: full, date: dateFromPath(full) });
  }
  return items;
}

function parseArticlePath(html, baseUrl) {
  const items = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{6,200}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!/\/c\/\d{4}-\d{2}-\d{2}\/\d+\.shtml/.test(m[1])) continue;
    const title = cleanTitle(m[2]);
    if (title.length < 10) continue;
    const full = new URL(m[1], baseUrl).toString();
    items.push({ title, url: full, date: dateFromPath(full) });
  }
  return items;
}

function parseHeadingLinks(html, baseUrl) {
  const items = [];
  const re = /<h[23][^>]*class="[^"]*title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]{8,300}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const title = cleanTitle(m[2]);
    if (title.length < 10) continue;
    items.push({ title, url: new URL(m[1], baseUrl).toString(), date: null });
  }
  return items;
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

/* ==================================================================================
 * 源配置
 * ================================================================================== */
const SOURCES = [
  {
    key: 'mee_news', category: 'OFFICIAL', sourceName: '生态环境部',
    url: 'https://www.mee.gov.cn/ywdt/', parser: parseTitleAttr,
    filter: /碳|排放|环境|气候|绿色|污染|生态|督察|美丽|双碳/, max: 8,
  },
  {
    key: 'mee_policy', category: 'POLICY', sourceName: '生态环境部 · 政策文件',
    url: 'https://www.mee.gov.cn/zcwj/', parser: parseTitleAttr,
    filter: /碳|排放|办法|条例|方案|通知|意见|指南|标准|目录/, max: 8,
  },
  {
    key: 'cneeex', category: 'MARKET', sourceName: '上海环境能源交易所',
    url: 'https://www.cneeex.com/xwzx/tzgg/', parser: parseArticlePath,
    filter: null, max: 8,
  },
  {
    key: 'icap', category: 'INTERNATIONAL', sourceName: 'ICAP 国际碳行动伙伴关系',
    url: 'https://icapcarbonaction.com/en/news', parser: parseHeadingLinks,
    filter: null, max: 6,
  },
];

/** 抓全部源（并发），返回视图模型。biz.mjs 的 D1 回退也复用此函数。 */
export async function fetchAllSources() {
  const items = [];
  const errors = [];

  await Promise.all(SOURCES.map(async (f) => {
    try {
      const html = await fetchPage(f.url);
      let list = f.parser(html, f.url);
      if (f.filter) list = list.filter((it) => f.filter.test(it.title));
      /* 去重 + 截断 */
      const seen = new Set();
      list = list.filter((it) => (seen.has(it.url) ? false : (seen.add(it.url), true))).slice(0, f.max);
      for (const it of list) {
        items.push({
          title: it.title.slice(0, 190),
          url: it.url,
          date: it.date,
          category: f.category,
          categoryLabel: CATEGORIES[f.category].label,
          sourceName: f.sourceName,
          sourceUrl: f.url,
          sourceKey: f.key,
        });
      }
    } catch (e) {
      errors.push({ source: f.key, error: String(e.message || e).slice(0, 100) });
    }
  }));

  items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return { items, errors };
}

/* ==================================================================================
 * 路由
 * ================================================================================== */
export function attachNoticeFeedRoutes(r) {
  /* capabilities / 分类清单（纯静态） */
  r.get('/api/notices/categories', () => json({
    categories: Object.entries(CATEGORIES).map(([key, c]) => ({ key, ...c })),
    mode: 'live',   // 云端为实时抓取模式
    ttlMinutes: 5,
  }));

  /* 实时聚合：Cache API 5 分钟 → 未命中实时抓取。
   *
   * 【双层缓存】
   *   主键 notices-live     max-age=300  —— 日常命中，5 分钟新鲜度（前端
   *                          铃铛 60s 轮询该端点做增量检测，5 分钟缓存
   *                          在"准实时"与源站友好之间取平衡）
   *   回退键 notices-stale  max-age=86400 —— 源站全失败时兜底
   * 抓取成功同时写两层；全失败时读回退键并标记 stale:true。
   * 这样源站限流（如环交所对 CF 出口的 420）时用户看到的仍是
   * 上一次成功抓取的真实消息，而不是空白或编造内容。 */
  r.get('/api/notices/live', async (ctx) => {
    const category = String(ctx.query.category || '').toUpperCase();
    const cache = caches.default;
    const mainKey = new URL(`https://cache.internal/notices-live?cat=${category || 'ALL'}`);
    const staleKey = new URL(`https://cache.internal/notices-stale?cat=${category || 'ALL'}`);

    const cached = await cache.match(mainKey);
    if (cached) {
      const data = await cached.json();
      return json({ ...data, cached: true });
    }

    const { items, errors } = await fetchAllSources();
    const filtered = category ? items.filter((i) => i.category === category) : items;

    /* 全失败：回退到 24 小时内的最后一次成功抓取 */
    if (!items.length) {
      const stale = await cache.match(staleKey);
      if (stale) {
        const data = await stale.json();
        return json({ ...data, cached: true, stale: true, latestErrors: errors });
      }
      return json({
        items: [], total: 0, errors,
        fetchedAt: new Date().toISOString(), cached: false,
      });
    }

    const payload = {
      items: filtered,
      total: filtered.length,
      errors,
      fetchedAt: new Date().toISOString(),
      cached: false,
    };

    const cacheRes = new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    ctx.waitUntil(cache.put(mainKey, cacheRes.clone()));
    ctx.waitUntil(cache.put(staleKey, new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
    })));

    return json(payload);
  });
}
