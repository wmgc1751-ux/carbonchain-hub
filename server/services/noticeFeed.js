/**
 * noticeFeed.js —— 真实通知消息聚合服务
 * ==================================================================================
 * 【解决什么问题】
 *
 * 原来的通知（notice 表）是 initdb 种子循环填充的固定模板文案——60 条
 * 内容雷同的占位公告，对用户没有信息量。用户要求：
 *   "全部要真实消息，链接各大权威平台，通知消息要分开，
 *    要包含官方通知消息和相关消息等等进行设计"
 *
 * 【设计：四类外部消息 + 平台自建】
 *
 *   OFFICIAL  官方通知   生态环境部要闻（www.mee.gov.cn/ywdt）
 *   POLICY    政策法规   生态环境部政策文件（www.mee.gov.cn/zcwj）
 *   MARKET    市场动态   上海环交所公告（www.cneeex.com）
 *   INTERNATIONAL 国际动态  ICAP 国际碳市场新闻
 *   PLATFORM  平台公告   平台自建（保留原发布流程）
 *
 * 【抓取策略——按源站结构定制解析器】
 *   · MEE（政府站）：标题在 <a title="…"> 属性里，锚文本只有"视频"等前缀
 *   · 环交所：文章路径是 /c/YYYY-MM/ID.shtml，按路径过滤掉导航链接
 *   · ICAP（Drupal）：标题在 <h2 class="title"><a> 里
 *   每次刷新都从源站实时抓取，不是静态集；源站结构变更时该源静默失败
 *   （返回空列表并在 errors 里留痕），不用编造内容填充。
 *
 * 【入库幂等】按 title 去重；带 source_url 的记录在前端可点击跳原文。
 *
 * @module services/noticeFeed
 */
'use strict';

const db = require('../db');
const { EventEmitter } = require('events');

/**
 * 新消息事件总线。
 * persist() 写入新条目后 emit('new', rows) —— /api/notify/stream 的 SSE
 * 订阅这个事件，把新消息实时推到浏览器触发弹窗与铃铛闪烁。
 */
const noticeBus = new EventEmitter();
noticeBus.setMaxListeners(50);   // SSE 订阅者可能较多

/* ==================================================================================
 * 一、消息分类定义
 * ================================================================================== */

const CATEGORIES = {
  OFFICIAL:      { label: '官方通知', desc: '生态环境部等权威机构发布的正式通知与要闻', color: 't-ok' },
  POLICY:        { label: '政策法规', desc: '碳市场政策法规、核算指南、配额分配方案', color: 't-info' },
  MARKET:        { label: '市场动态', desc: '全国碳市场行情、CCER、交易与清缴公告', color: 't-chain' },
  INTERNATIONAL: { label: '国际动态', desc: 'EU CBAM、ICAP、国际碳市场进展', color: 't-violet' },
  PLATFORM:      { label: '平台公告', desc: '碳链通平台自身的功能更新与运维通知', color: 't-mute' },
};

/* notice_type 存储值 → 分类（数据库用 notice_type 一列承载分类语义） */
const TYPE_TO_CATEGORY = {
  OFFICIAL: 'OFFICIAL', POLICY: 'POLICY', MARKET: 'MARKET',
  INTERNATIONAL: 'INTERNATIONAL', INTL: 'INTERNATIONAL', SYSTEM: 'PLATFORM',
};

/* ==================================================================================
 * 二、解析工具
 * ================================================================================== */

/** 去重：同一 URL 或同一标题只保留一条 */
function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    const k = it.url || it.title;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 清理标题里的 HTML 实体与多余空白 */
function cleanTitle(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    .replace(/&uuml;/gi, 'ü').replace(/&eacute;/gi, 'é')
    .replace(/\s+/g, ' ')
    .trim();
}

/** HTTP GET（带 UA 与超时） */
async function fetchPage(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析器 A：<a title="…"> 属性提取 —— 适用 MEE（政府站标题放在 title 属性）。
 */
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

/**
 * 解析器 B：文章路径模式 —— 环交所文章 URL 形如 /c/2026-09-17/498261.shtml，
 * 按该模式天然过滤掉导航链接。
 */
function parseArticlePath(html, baseUrl, pathRe = /\/c\/\d{4}-\d{2}-\d{2}\/\d+\.shtml/) {
  const items = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{6,200}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!pathRe.test(m[1])) continue;
    const title = cleanTitle(m[2]);
    if (title.length < 10) continue;
    const full = new URL(m[1], baseUrl).toString();
    items.push({ title, url: full, date: dateFromPath(full) });
  }
  return items;
}

/**
 * 解析器 C：标题级链接（<h2 class="…title…"><a href>）—— 适用 Drupal 站（ICAP）。
 */
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

/** 从 URL 路径提取发布日期（MEE: t20261021_…；环交所: /c/2026-09-17/） */
function dateFromPath(url) {
  const m1 = url.match(/t(\d{4})(\d{2})(\d{2})_\d+\./);
  if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
  const m2 = url.match(/\/c\/(\d{4}-\d{2}-\d{2})\//);
  if (m2) return m2[1];
  return null;
}

/* ==================================================================================
 * 三、源配置（每个源绑定解析器）
 * ================================================================================== */

const FETCHERS = {
  /** 官方通知 · 生态环境部要闻动态 */
  mee_news: {
    category: 'OFFICIAL',
    sourceName: '生态环境部',
    sourceUrl: 'https://www.mee.gov.cn/ywdt/',
    parser: parseTitleAttr,
    filter: /碳|排放|环境|气候|绿色|污染|生态|督察|美丽|双碳/,
    max: 8,
  },
  /** 政策法规 · 生态环境部政策文件库 */
  mee_policy: {
    category: 'POLICY',
    sourceName: '生态环境部 · 政策文件',
    sourceUrl: 'https://www.mee.gov.cn/zcwj/',
    parser: parseTitleAttr,
    filter: /碳|排放|办法|条例|方案|通知|意见|指南|标准|目录/,
    max: 8,
  },
  /** 市场动态 · 上海环境能源交易所公告 */
  cneeex_notice: {
    category: 'MARKET',
    sourceName: '上海环境能源交易所',
    sourceUrl: 'https://www.cneeex.com/xwzx/tzgg/',
    parser: parseArticlePath,
    filter: null,
    max: 8,
  },
  /** 国际动态 · ICAP 国际碳行动伙伴关系新闻 */
  icap_news: {
    category: 'INTERNATIONAL',
    sourceName: 'ICAP 国际碳行动伙伴关系',
    sourceUrl: 'https://icapcarbonaction.com/en/news',
    parser: parseHeadingLinks,
    filter: null,
    max: 6,
  },
};

/* ==================================================================================
 * 四、核心操作
 * ================================================================================== */

/** 规范化一条抓取结果 */
function normalize(item, key, f) {
  return {
    title: item.title.slice(0, 190),
    url: item.url,
    date: item.date,
    category: f.category,
    categoryLabel: CATEGORIES[f.category].label,
    sourceName: f.sourceName,
    sourceUrl: f.sourceUrl,
    sourceKey: key,
  };
}

/**
 * 从所有源抓取最新消息（实时获取，不落库）。
 * 每个源独立 try/catch——一个源挂不影响其他源。
 */
async function fetchAll() {
  const items = [];
  const errors = [];

  await Promise.all(Object.entries(FETCHERS).map(async ([key, f]) => {
    try {
      const html = await fetchPage(f.sourceUrl);
      let list = f.parser(html, f.sourceUrl);
      if (f.filter) list = list.filter((it) => f.filter.test(it.title));
      list = dedupe(list).slice(0, f.max);
      items.push(...list.map((it) => normalize(it, key, f)));
    } catch (e) {
      errors.push({ source: key, error: String(e.message || e).slice(0, 100) });
    }
  }));

  items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return { items, errors, fetchedAt: new Date().toISOString() };
}

/**
 * 英文源（ICAP 等）入库标题中文化映射：演示界面语言一致性。
 * 未命中的条目保留原文 —— 宁可英文也不机器翻译凑数。
 * 英文原标题写进 content 的「原文标题」行，溯源不受影响。
 */
const ZH_TITLES = {
  'Québec updates its cap-and-trade regulation': '加拿大魁北克省更新限额与交易（CAT）法规',
  'Germany set to extend national carbon price corridor through 2027': '德国拟将国家碳定价走廊延长至 2027 年',
  "Türkiye's Carbon Market Board clarifies initial national ETS pilot design": '土耳其碳市场委员会明确国家 ETS 试点初始设计',
  'Türkiye issues implementation rules for TR-ETS pilot phase': '土耳其发布 TR-ETS 试点阶段实施细则',
  'Türkiye unveils regulation for its national emissions trading system': '土耳其公布全国碳排放交易体系法规',
  'Colombia formalizes plans for an emissions trading system with regulatory decree': '哥伦比亚以监管法令正式确立建立碳排放交易体系的规划',
};

/**
 * 将抓取到的消息写入 notice 表（幂等：优先按 source_url 去重，回退 title）。
 * 只对新条目插入；已存在的原记录不动（保留 views 计数）。
 * 注：不能只按 title 去重 —— 英文源入库标题会被中文化（ZH_TITLES），
 * 标题变了同一篇新闻就会重复插入（2026-10-31 实测：重启后同一 ICAP 故事插两行）。
 */
async function persist(items) {
  if (!Array.isArray(items) || !items.length) return { inserted: 0, skipped: 0 };

  let inserted = 0, skipped = 0;
  const freshRows = [];
  for (const item of items.slice(0, 40)) {
    const zh = ZH_TITLES[item.title];
    const storeTitle = zh || item.title;
    const existing = item.url
      ? await db.one(
        'SELECT id FROM notice WHERE source_url = ? OR title = ? OR title = ? LIMIT 1',
        [item.url, storeTitle, item.title])
      : await db.one('SELECT id FROM notice WHERE title = ? LIMIT 1', [storeTitle]);
    if (existing) { skipped++; continue; }

    const result = await db.query(
      `INSERT INTO notice (title, content, notice_type, target_role, publisher, is_top, views, publish_time,
                           source_name, source_url, fetched_at)
       VALUES (?,?,?,?,?,0,0,?,?,?,NOW())`,
      [
        storeTitle,
        `【${item.categoryLabel}】来源：${item.sourceName}\n`
          + (zh ? `原文标题：${item.title}\n` : '')
          + `原文链接：${item.url}\n\n该消息由碳链通平台从权威渠道实时聚合，点击查看原文。平台不对原文内容作修改；如原文变更以原文为准。`,
        item.category,
        'ALL',
        item.sourceName,
        item.date ? `${item.date} 00:00:00` : new Date(),
        item.sourceName || null,
        item.url || null,
      ],
    );
    inserted++;
    freshRows.push({
      id: (result && result.insertId) || null,
      title: storeTitle,
      category: item.category,
      categoryLabel: item.categoryLabel,
      sourceName: item.sourceName,
      sourceUrl: item.url,
      publishedAt: item.date ? `${item.date} 00:00:00` : new Date().toISOString(),
    });
  }

  /* 有新消息：广播给 SSE 订阅者（实时弹窗 / 铃铛闪烁） */
  if (freshRows.length) noticeBus.emit('new', freshRows);

  return { inserted, skipped };
}

/**
 * 一站式刷新：抓取 + 入库。供定时任务或手动触发。
 */
async function refresh() {
  const { items, errors, fetchedAt } = await fetchAll();
  const { inserted, skipped } = await persist(items);
  return { fetched: items.length, inserted, skipped, errors, fetchedAt };
}

/**
 * 按分类查询通知（合并真实抓取 + 平台自建）。
 */
async function listByCategory(opts = {}) {
  const cat = opts.category || null;
  const limit = Math.min(Number(opts.limit) || 20, 100);

  /* 数据库中分类语义存于 notice_type（含旧值 SYSTEM→PLATFORM、INTL→INTERNATIONAL） */
  let typeIn = null;
  if (cat) {
    typeIn = Object.keys(TYPE_TO_CATEGORY).filter((k) => TYPE_TO_CATEGORY[k] === cat);
    if (!typeIn.length) typeIn = ['__none__'];
  }

  const where = typeIn
    ? `WHERE notice_type IN (${typeIn.map(() => '?').join(',')})`
    : '';
  const params = typeIn ? [...typeIn] : [];

  const rows = await db.query(
    `SELECT id, title, content, notice_type, publisher, is_top, views, publish_time,
            source_name, source_url, fetched_at
       FROM notice ${where}
      ORDER BY is_top DESC, publish_time DESC LIMIT ${limit}`,
    params,
  );

  return rows.map(mapRow);
}

/** 数据库行 → 前端视图模型 */
function mapRow(r) {
  const cat = TYPE_TO_CATEGORY[r.notice_type] || 'PLATFORM';
  return {
    id: Number(r.id),
    title: r.title,
    content: r.content,
    noticeType: r.notice_type,
    category: cat,
    categoryLabel: (CATEGORIES[cat] || CATEGORIES.PLATFORM).label,
    isTop: !!Number(r.is_top),
    publisher: r.publisher,
    views: Number(r.views) || 0,
    publishedAt: r.publish_time,
    sourceName: r.source_name || null,
    sourceUrl: r.source_url || null,
    fetched: !!r.fetched_at || !!r.source_url,
  };
}

/**
 * 获取分类汇总（各类多少条 + 最新一条时间）。
 */
async function summary() {
  const rows = await db.query(
    `SELECT notice_type, COUNT(*) AS cnt, MAX(publish_time) AS latest
       FROM notice GROUP BY notice_type`,
  );

  const out = {};
  for (const key of Object.keys(CATEGORIES)) {
    const related = Object.keys(TYPE_TO_CATEGORY).filter((k) => TYPE_TO_CATEGORY[k] === key);
    const found = rows.filter((r) => related.includes(r.notice_type));
    out[key] = {
      label: CATEGORIES[key].label,
      desc: CATEGORIES[key].desc,
      color: CATEGORIES[key].color,
      count: found.reduce((s, r) => s + Number(r.cnt), 0),
      latest: found.length
        ? found.map((r) => String(r.latest)).sort().pop()
        : null,
    };
  }
  return out;
}

module.exports = {
  CATEGORIES, TYPE_TO_CATEGORY, FETCHERS, noticeBus,
  fetchAll, persist, refresh, listByCategory, summary, mapRow,
};
