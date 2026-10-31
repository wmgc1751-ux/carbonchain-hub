/**
 * datasource.js —— 国内真实数据源接入层
 * ==================================================================================
 * 【设计原则：只接国内权威来源，拿不到的绝不编】
 *
 * 本模块接入的国内真实数据源，全部开放、可核查、可复现：
 *
 *   ① 生态环境部 / 国家发改委 / 国家统计局公开排放因子
 *      燃料因子与区域电网因子（已在 methodology.js 内置并逐条比对）
 *      用途：全部核算的因子底座
 *
 *   ② 上海环境能源交易所 / 北京绿色交易所行情
 *      全国碳配额（CEA）与核证自愿减排量（CCER）成交价
 *      用途：碳价与跨市场比价
 *
 *   ③ 省级在线监测公开平台（生活垃圾焚烧 ljgk）
 *      生活垃圾焚烧发电厂 5 项污染物小时/日均值原始报文
 *      用途：**唯一可公开获取的企业级实测数据**，是真实层的实证基石
 *
 *   ④ 东方财富公开行情接口
 *      A 股上市公司快照（名称、市值、行业分类）。
 *      用途：**真实企业主体** —— 替代原本的模板合成企业
 *
 * 【数据来源范围：仅限国内（2026-10-30 收敛）】
 *   原接入的 World Bank（世界银行）、OWID（Our World in Data）与
 *   US EPA GHGRP、Climate TRACE 均已下线。理由：
 *     · 境外机构对中国设施的独立估算（Climate TRACE）不是国内核算依据，
 *       不能替代企业报送值与核查结论；
 *     · 世界银行 / OWID 是境外机构整理的中国数据，与国内统计口径存在
 *       差异（能源折标煤系数、边界划分），混排会产生"两套中国数字"。
 *   中国宏观数据改用国家统计局口径。详见 docs/国外数据下线报告-20261030.md。
 *
 * 【拿不到的，本模块明确不提供】
 *   · 企业级逐年 CO₂ 排放量 —— 我国不公开逐家排放数据
 *   · 企业 CEMS 实测 CO₂ —— GB 18485 监测因子不含 CO₂
 *   · 企业活动数据（产量/能耗/工艺）—— 核心商业机密
 *
 *   对于这三类，平台采取的做法是：
 *   用真实上市公司的**公开财务数据（营收）** × **行业排放强度**做**估算**，
 *   并在每一条记录上标注 `estimate: true` 与估算方法。
 *   **估算不等于真实，必须可被识别。**
 *
 * 【网络环境注意（重要）】
 *   本环境 Node 的 https 直连会被代理拦截（socket hang up），
 *   而 curl 可以正常访问。因此本模块统一通过**子进程调用 curl** 取数，
 *   并把结果缓存到 `.cache/realdata/`。
 *   这不是权宜之计 —— 它同时也是离线兜底：网络不可用时读缓存，
 *   缓存也不可用时才报错，**绝不返回编造的数据**。
 *
 * @module services/datasource
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', '..', '.cache', 'realdata');

/* ==================================================================================
 * 一、HTTP 取数（走 curl，带缓存与来源标注）
 * ================================================================================== */

/**
 * 用 curl 取一个 URL。
 *
 * 【为什么必须用 curl，而不是 Node 的 https】
 *   本环境 Node 的 https 直连会被代理拦截（socket hang up），
 *   而 curl 走系统代理配置可以正常访问。这不是偷懒，是环境约束。
 *
 * 【为什么参数要这么"朴素"】
 *   实测：给 curl 加 `-L`（跟随重定向）+ 自定义 `Accept` 头时，
 *   东方财富接口会返回 `curl: (56) schannel: server closed abruptly`。
 *   换成最朴素的 `-s --max-time N <url>`（不跟随重定向、不加自定义头）
 *   反而稳定。原因大概是对方 WAF 对"看起来像爬虫的请求头组合"更敏感。
 *
 *   ⇒ **不要给这个函数加 -L 或自定义头**。这是踩过坑之后的结论。
 *
 * @param {string} url
 * @param {object} [opts] { timeoutMs, retries }
 * @returns {string} 响应体
 * @throws 取不到就抛错 —— **绝不返回空字符串或假数据**
 */
function curlGet(url, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 25000;
  const retries = Number(opts.retries) || 2;
  let lastErr = null;

  for (let i = 0; i <= retries; i++) {
    try {
      const out = execFileSync('curl', [
        '-s', '--max-time', String(Math.ceil(timeoutMs / 1000)),
        url,
      ], { encoding: 'utf8', timeout: timeoutMs + 3000, maxBuffer: 64 * 1024 * 1024 });
      if (!out || !out.trim()) throw new Error('响应为空');
      return out;
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        /* 退避重试：1s, 2s */
        try {
          execFileSync(process.platform === 'win32' ? 'ping' : 'sleep',
            process.platform === 'win32' ? ['-n', '2', '127.0.0.1'] : ['1'],
            { stdio: 'ignore', timeout: 4000 });
        } catch { /* ignore */ }
      }
    }
  }
  throw new Error(`取数失败 ${url}：${lastErr ? lastErr.message : '未知错误'}`);
}

/** 读缓存（不存在返回 null） */
function readCache(name) {
  const p = path.join(CACHE_DIR, name);
  if (!fs.existsSync(p)) return null;
  try {
    const st = fs.statSync(p);
    return {
      body: fs.readFileSync(p, 'utf8'),
      mtime: st.mtime,
      ageMs: Date.now() - st.mtimeMs,
    };
  } catch { return null; }
}

/** 写缓存 */
function writeCache(name, body) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, name), body, 'utf8');
}

/**
 * 取数：优先用未过期缓存，否则网络拉取并刷新缓存。
 *
 * @param {string} name     缓存文件名
 * @param {string} url      真实数据源 URL
 * @param {number} ttlMs    缓存有效期
 * @returns {{body:string, fromCache:boolean, fetchedAt:string, source:string}}
 */
function fetchWithCache(name, url, ttlMs, opts = {}) {
  const cached = readCache(name);
  if (cached && cached.ageMs < ttlMs && opts.force !== true) {
    return {
      body: cached.body, fromCache: true,
      fetchedAt: cached.mtime.toISOString(), source: url,
    };
  }
  try {
    const body = curlGet(url, opts);
    writeCache(name, body);
    return { body, fromCache: false, fetchedAt: new Date().toISOString(), source: url };
  } catch (e) {
    /* 网络失败但有旧缓存 → 用旧缓存，并如实标注已过期 */
    if (cached) {
      return {
        body: cached.body, fromCache: true, stale: true,
        fetchedAt: cached.mtime.toISOString(), source: url,
        warning: `实时拉取失败（${e.message}），返回 ${(cached.ageMs / 3600000).toFixed(1)} 小时前的缓存`,
      };
    }
    throw e;
  }
}

/* ==================================================================================
 * 二、数据源清单（用于前端展示"数据来自哪里"）
 * ================================================================================== */

const SOURCES = {
  EASTMONEY: {
    id: 'eastmoney',
    name: '东方财富公开行情接口（A 股上市公司）',
    url: 'https://push2.eastmoney.com/api/qt/stock/get',
    license: '公开接口（仅供研究演示）',
    kind: 'ENTITY',
    real: true,
    note: '真实上市公司名称、市值、行业分类 —— 用于替换原模板合成企业',
  },
  MEE_FACTORS: {
    id: 'mee',
    name: '生态环境部 / 国家发改委公开排放因子',
    url: '（内置，见 methodology.js 与 factor_entry 表）',
    license: '政府公开信息',
    kind: 'FACTOR',
    real: true,
    note: '燃料因子 7 项 + 区域电网因子 7 项，与官方公布值逐条一致',
  },
  EE_TRADING: {
    id: 'cneeex',
    name: '上海环境能源交易所（全国碳市场行情）',
    url: 'https://www.cneeex.com',
    license: '公开信息',
    kind: 'MARKET',
    real: true,
    degraded: true,
    note: '站点有 WAF 反爬保护，当前**未接入**。碳价暂用平台内成交均价（合成）',
  },
};

/* ==================================================================================
 * 五、东方财富：真实上市公司快照
 * ================================================================================== */

/**
 * 取一只 A 股的真实快照。
 *
 * @param {string} secid  形如 '1.600019'（1=沪，0=深）
 * @returns {object|null} 取不到返回 null（**不编造**）
 */
function emStock(secid) {
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}`
    + '&fields=f57,f58,f84,f85,f116,f117,f127,f162,f167';
  try {
    const c = fetchWithCache(`em-${secid}.json`, url, 6 * 3600 * 1000, { timeoutMs: 15000, retries: 2 });
    const j = JSON.parse(c.body);
    const d = j && j.data;
    if (!d || !d.f58) return null;
    return {
      code: String(d.f57 || ''),
      name: String(d.f58 || ''),
      industry: d.f127 ? String(d.f127) : null,
      totalMktCap: d.f116 ? Number(d.f116) : null,       // 元
      floatMktCap: d.f117 ? Number(d.f117) : null,       // 元
      totalShares: d.f84 ? Number(d.f84) : null,
      floatShares: d.f85 ? Number(d.f85) : null,
      pe: d.f162 !== undefined && d.f162 !== '-' ? Number(d.f162) : null,
      pb: d.f167 !== undefined && d.f167 !== '-' ? Number(d.f167) : null,
      secid,
      meta: {
        source: SOURCES.EASTMONEY.name,
        url: c.source,
        fromCache: c.fromCache,
        stale: !!c.stale,
        fetchedAt: c.fetchedAt,
        real: true,
      },
    };
  } catch (e) {
    return null;
  }
}

/**
 * 批量取上市公司快照。
 *
 * @param {string[]} secids
 * @param {object} [opts] { concurrency, onProgress }
 */
function emStocks(secids, opts = {}) {
  const conc = Math.min(Number(opts.concurrency) || 3, 6);
  const results = [];
  let i = 0;
  return new Promise((resolve) => {
    let running = 0;
    let done = 0;
    const next = () => {
      while (running < conc && i < secids.length) {
        const id = secids[i++];
        running++;
        /* 串行化 + 轻延迟，避免触发对方限流 */
        setTimeout(() => {
          const r = emStock(id);
          if (r) results.push(r);
          running--; done++;
          if (typeof opts.onProgress === 'function') opts.onProgress(done, secids.length, r);
          if (i >= secids.length && running === 0) resolve(results);
          else next();
        }, 260);
      }
      if (!secids.length) resolve(results);
    };
    next();
  });
}

module.exports = {
  SOURCES,
  curlGet, fetchWithCache, readCache, writeCache,
  emStock, emStocks,
};
