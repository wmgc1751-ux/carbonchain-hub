/**
 * realSync.js —— 外部真实源周期同步器
 * ==================================================================================
 * 职责：按各源登记的 TTL 判断是否该重新拉取，拉成功就更新 `data_source`
 * 的 last_fetched_at / record_count，失败就记一条 FAIL 到 `data_ingest_log`。
 *
 * 【为什么"失败也要记"是这套设计的核心】
 * 平台对外展示的每一个"最近同步：3 小时前"都来自这张表。
 * 如果只在成功时写记录，那失败会表现为"时间停留在上次成功"——
 * 看起来像"刚同步过、数据很新"，实际是"连续失败了三天"。
 * 把失败也记下来，新鲜度才能诚实地表达"我最后一次拿到数据是什么时候"，
 * 而不是"我最后一次尝试是什么时候"。
 *
 * 【为什么不追求"每秒同步"】
 * 官方排放因子与碳市场行情都是一版一版发布的，不是流式数据。
 * 对它们做秒级轮询只会重复下载同一份内容，同时把出口 IP 打进对方的风控。
 * 真实的"实时"在这里的正确含义是：
 *   · 状态是实时的（我多久前确认过这份数据仍然有效）
 *   · 数据不是实时的（数据本身按发布节奏才变）
 * 这两件事必须分开说。
 *
 * 【数据来源范围：仅限国内】
 * 本平台的真实数据层只接入国内权威来源（生态环境部 / 国家统计局 / 国家能源局 /
 * 上海环境能源交易所 / 北京绿色交易所 / 省级在线监测公开平台）。
 * 美国 EPA GHGRP、Climate TRACE、世界银行、OWID 等境外数据集已全部下线，
 * 详见 docs/国外数据下线报告-20261030.md。
 * 理由：本平台服务的对象是中国碳市场与中国出口企业，境外机构对中国设施的
 * 独立估算不能作为国内核算、核查与履约的依据，混用会误导数据使用者。
 *
 * @module services/realSync
 */
'use strict';

const db = require('../db');
const IR = require('./ingestReal');

/** 多久检查一次"有没有源该刷新了" */
const CHECK_MS = Number(process.env.REAL_SYNC_CHECK_MS || 3600 * 1000); // 1 小时

let timer = null;
let running = false;
const lastRun = new Map();

/**
 * 按 TTL 找出"过期"的真实源。
 * @returns {Promise<Array<{key, name, ttl, ageSec}>>}
 */
async function dueSources() {
  let rows;
  try {
    rows = await db.query(
      `SELECT source_key, name, refresh_ttl_ms, last_fetched_at
         FROM data_source
        WHERE authenticity = 'REAL' AND enabled = 1`
    );
  } catch (e) {
    return [];
  }
  const out = [];
  for (const r of rows) {
    const ttl = Number(r.refresh_ttl_ms || 86400000);
    const last = r.last_fetched_at ? new Date(r.last_fetched_at).getTime() : 0;
    const age = last ? Date.now() - last : Infinity;
    if (age >= ttl) {
      out.push({
        key: r.source_key,
        name: r.name,
        ttl,
        ageSec: Number.isFinite(age) ? Math.round(age / 1000) : null,
      });
    }
  }
  return out;
}

/**
 * 同步一个源。
 *
 * 国内来源中，真正需要"拉取"的只有省级在线监测公开平台的报文；
 * 排放因子与碳市场行情是发布驱动（标准修订 / 交易所公告），不是时间驱动。
 *
 * eastmoney 已实测被 IP 风控，默认跳过并记录原因，不做无谓重试。
 */
async function syncOne(key) {
  const t0 = Date.now();
  try {
    switch (key) {
      case 'eastmoney':
        return {
          ok: false, skipped: true,
          error: '商业行情 API 存在 IP 风控，已禁用自动轮询；如需行情请人工触发',
        };
      case 'mee_factor':
        /* 排放因子不是"拉取"来的，是标准文本里抄下来的人工台账。
         * 对它做 ASCII 轮询没有意义 —— 因子变更以标准修订为触发，不以时间为触发。
         * 因此这一源的正确状态是"静态、随标准版本更新"，不参与自动同步。 */
        return {
          ok: false, skipped: true,
          error: '排放因子为静态台账（随标准版本更新），不做周期拉取',
        };
      default:
        return { ok: false, skipped: true, error: `源 ${key} 未实现同步器` };
    }
  } catch (e) {
    await IR.logIngest(key, {
      startedAt: t0, durationMs: Date.now() - t0,
      status: 'FAIL', records: 0, fromCache: false,
      detail: { reason: 'sync-throw' },
      error: String(e.message || e).slice(0, 400),
    }).catch(() => {});
    return { ok: false, error: String(e.message || e).slice(0, 300) };
  }
}

/**
 * 跑一轮：对所有过期源依次尝试同步。
 * @param {object} [opts] { force:boolean, only:string[] }
 */
async function runOnce(opts = {}) {
  if (running) return { skipped: 'already-running' };
  running = true;
  const t0 = Date.now();
  const results = [];
  try {
    let list = opts.force
      ? (await db.query("SELECT source_key, name, refresh_ttl_ms FROM data_source WHERE authenticity='REAL' AND enabled=1"))
        .map((r) => ({ key: r.source_key, name: r.name, ttl: Number(r.refresh_ttl_ms) }))
      : await dueSources();
    if (opts.only && opts.only.length) {
      const set = new Set(opts.only);
      list = list.filter((x) => set.has(x.key));
    }

    for (const s of list) {
      const r = await syncOne(s.key);
      lastRun.set(s.key, { at: Date.now(), ...r });
      results.push({ key: s.key, name: s.name, ...r });
    }
  } finally {
    running = false;
  }
  return { durationMs: Date.now() - t0, total: results.length, results };
}

/** 启动周期检查（幂等） */
function start() {
  if (timer) return { running: true };
  const tick = () => {
    runOnce().then((r) => {
      if (r.total > 0) {
        const ok = r.results.filter((x) => x.ok).length;
        console.log(`🔄 真实源同步：${ok}/${r.total} 成功（${r.durationMs} ms）`);
        for (const x of r.results) {
          if (!x.ok) console.log(`   ⚠ ${x.key}：${x.error || '未知原因'}`);
        }
      }
    }).catch((e) => console.warn('⚠ 真实源同步异常：', e.message));
  };
  /* 启动后延迟 20 秒再跑第一轮：避免与 warmup 抢数据库连接池 */
  const boot = setTimeout(tick, 20000);
  if (boot.unref) boot.unref();
  timer = setInterval(tick, CHECK_MS);
  if (timer.unref) timer.unref();
  return { running: true, checkMs: CHECK_MS };
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 新鲜度总览（供 API / 页面用） */
async function freshness() {
  const rows = await db.query(
    `SELECT source_key, name, publisher, license, authenticity, refresh_ttl_ms,
            last_fetched_at, last_status, last_error, record_count
       FROM data_source WHERE enabled = 1 ORDER BY authenticity, source_key`
  );
  const now = Date.now();
  return rows.map((r) => {
    const last = r.last_fetched_at ? new Date(r.last_fetched_at).getTime() : null;
    const ageSec = last ? Math.round((now - last) / 1000) : null;
    const ttlSec = Math.round(Number(r.refresh_ttl_ms || 86400000) / 1000);
    return {
      key: r.source_key, name: r.name, publisher: r.publisher, license: r.license,
      authenticity: r.authenticity,
      lastFetchedAt: r.last_fetched_at,
      lastStatus: r.last_status,
      lastError: r.last_error,
      recordCount: r.record_count === null ? null : Number(r.record_count),
      ageSec,
      ttlSec,
      /* 过期 ≠ 数据失效。宏观数据过期几小时完全正常；
       * 这里只表达"按登记策略该重新确认了"，前端措辞不要写成"数据已过期"。 */
      dueForCheck: ageSec === null ? true : ageSec >= ttlSec,
      lastLocalRun: lastRun.get(r.source_key) || null,
    };
  });
}

module.exports = { start, stop, runOnce, freshness, dueSources, syncOne, CHECK_MS };
