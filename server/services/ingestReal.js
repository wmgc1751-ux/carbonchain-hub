/**
 * ingest-real.js —— 国内真实数据落库器
 * ==================================================================================
 * 把从国内权威来源取到的数据写入数据库，并**在每一行上打上来源标记**。
 *
 * 【三层真实性分级，这是本模块的核心】
 *
 *   REAL      国内官方公开发布的真实数据
 *             · 生态环境部 / 国家统计局 / 国家发改委 排放因子
 *             · 省级在线监测公开平台（ljgk）污染物原始报文
 *             · 上海环境能源交易所 / 北京绿色交易所 成交行情
 *             → 这些数据的每一行都能溯源到原始文件或公告
 *
 *   ESTIMATE  基于真实公开数据的推算
 *             · 例如"用真实营收 × 行业强度估算排放量"
 *             → 有真实输入，但输出是算出来的，必须标注
 *
 *   SYNTHETIC 算法生成的合成数据
 *             · 平台内 60 家演示企业、模拟 CEMS 读数、活动数据
 *             → 仅用于功能演示，界面上必须可识别
 *
 * 【为什么必须分三层而不是"只留真实"】
 * 因为"全部真实"在企业级数据上物理不可行（我国不公开逐家排放），
 * 而平台又必须有企业级数据才能运行（核算、ZK、配额、交易都在企业维度）。
 * 所以正确做法是：真实数据能到哪一层就用到哪一层，
 * 到不了的层用合成数据补，但**必须让使用者一眼看出哪行是真的**。
 *
 * 把合成数据伪装成真实数据，比"没有真实数据"严重得多 ——
 * 前者是欺骗，后者只是能力边界。
 *
 * 【数据来源范围：仅限国内（2026-10-30 收敛）】
 * EPA GHGRP、Climate TRACE、World Bank、OWID 四个境外源已全部下线，
 * 采集代码与库内数据一并移除。详见 docs/国外数据下线报告-20261030.md。
 *
 * @module services/ingestReal
 */
'use strict';

const db = require('../db');

/* ==================================================================================
 * 一、数据源登记
 * ================================================================================== */

/** 数据源登记清单（幂等 upsert） */
const SOURCE_REGISTRY = [
  {
    key: 'mee_factor',
    name: '生态环境部 / 国家发改委公开排放因子',
    publisher: '生态环境部、国家统计局、国家发改委',
    url: '（内置因子表，见 factor_entry）',
    license: '政府公开信息',
    authenticity: 'REAL',
    scope: 'FACTOR',
    ttl: 365 * 24 * 3600 * 1000,
    note: '燃料因子 7 项（发电行业核算指南表1）+ 区域电网因子 7 项（2022年电力CO2排放因子），'
      + '与官方公布值逐条比对一致。',
  },
  {
    key: 'eastmoney',
    name: '东方财富公开行情接口',
    publisher: '东方财富',
    url: 'https://push2.eastmoney.com',
    license: '公开接口（仅供研究演示）',
    /* ⚠ 该源标 DEGRADED 而不是 REAL：代码存在但**从未成功落库过**，
     * 因为东方财富接口对服务器出口 IP 有风控（实测返回空/断连）。
     * 标 REAL 会让 /api/real/sources 看起来像'有 7 个真实源'，
     * 而其中一个永远拿不到数据 —— 这是把'计划接入'当成'已接入'。 */
    authenticity: 'DEGRADED',
    scope: 'ENTITY',
    ttl: 6 * 3600 * 1000,
    note: 'A 股上市公司快照（名称/市值/行业）。⚠ 实测被出口 IP 风控，从未成功落库，当前不可用。',
  },
  {
    key: 'synthetic_demo',
    name: '平台合成演示数据',
    publisher: '碳链通平台',
    url: '（server/scripts/seed-*.js）',
    license: '平台自有',
    authenticity: 'SYNTHETIC',
    scope: 'ENTITY',
    ttl: 0,
    note: '按行业工程定额生成，用于在缺少真实数据时保持功能可用。**不可对外声称真实。**',
  },
];

/** 登记所有数据源，返回 key → id 映射 */
async function registerSources() {
  const map = {};
  for (const s of SOURCE_REGISTRY) {
    await db.query(
      `INSERT INTO data_source
        (source_key, name, publisher, url, license, authenticity, scope, refresh_ttl_ms, note, enabled)
       VALUES (?,?,?,?,?,?,?,?,?,1)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name), publisher = VALUES(publisher), url = VALUES(url),
         license = VALUES(license), authenticity = VALUES(authenticity),
         scope = VALUES(scope), refresh_ttl_ms = VALUES(refresh_ttl_ms),
         note = VALUES(note)`,
      [s.key, s.name, s.publisher, s.url, s.license, s.authenticity, s.scope, s.ttl, s.note]
    );
    const row = await db.one('SELECT id FROM data_source WHERE source_key = ?', [s.key]);
    map[s.key] = Number(row.id);
  }
  return map;
}

/** 写采集留痕 */
async function logIngest(sourceKey, r) {
  try {
    await db.query(
      `INSERT INTO data_ingest_log
        (source_key, started_at, finished_at, duration_ms, status, records, from_cache, error, detail_json)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [sourceKey, new Date(r.startedAt), new Date(), r.durationMs,
        r.status, r.records === undefined ? null : r.records,
        r.fromCache ? 1 : 0, r.error || null,
        r.detail ? JSON.stringify(r.detail) : null]
    );
    /* 同步更新登记表的最近状态 */
    await db.query(
      `UPDATE data_source SET last_fetched_at = NOW(), last_status = ?, last_error = ?, record_count = ?
        WHERE source_key = ?`,
      [r.status, r.error || null, r.records === undefined ? null : r.records, sourceKey]
    );
  } catch (e) {
    console.error(`[ingest] 写留痕失败（${sourceKey}）：`, e.message);
  }
}

/* ==================================================================================
 * 二、统计
 * ================================================================================== */

/** 平台数据真实性总览 */
async function authenticityReport() {
  const q = async (sql, p) => db.query(sql, p || []);
  const one = async (sql, p) => db.value(sql, p || []);

  const ents = await q(
    `SELECT is_real, COUNT(*) n FROM enterprise GROUP BY is_real`
  );
  const realEnt = Number((ents.find((x) => Number(x.is_real) === 1) || {}).n || 0);
  const synthEnt = Number((ents.find((x) => Number(x.is_real) === 0) || {}).n || 0);

  const reps = await q(
    `SELECT is_real, COUNT(*) n, SUM(total_emission) s FROM emission_report GROUP BY is_real`
  );
  const realRep = reps.find((x) => Number(x.is_real) === 1) || { n: 0, s: 0 };
  const synthRep = reps.find((x) => Number(x.is_real) === 0) || { n: 0, s: 0 };

  const macro = Number(await one('SELECT COUNT(*) FROM macro_indicator') || 0);
  const macroCountries = await q(
    'SELECT country_iso, COUNT(*) n, COUNT(DISTINCT indicator) ind, MIN(year) y0, MAX(year) y1 '
    + 'FROM macro_indicator GROUP BY country_iso'
  );

  const cemsReal = Number(await one(
    "SELECT COUNT(*) FROM cems_reading WHERE source NOT IN ('CEMS','WATCHDOG')"
  ) || 0);
  const cemsTotal = Number(await one('SELECT COUNT(*) FROM cems_reading') || 0);

  const sources = await q(
    `SELECT source_key, name, publisher, authenticity, scope, license,
            last_status, last_fetched_at, record_count, note
       FROM data_source ORDER BY authenticity, source_key`
  );

  return {
    enterprises: { real: realEnt, synthetic: synthEnt, total: realEnt + synthEnt },
    emissions: {
      realReports: Number(realRep.n), realTonnes: Number(realRep.s || 0),
      syntheticReports: Number(synthRep.n), syntheticTonnes: Number(synthRep.s || 0),
    },
    macro: {
      rows: macro,
      countries: macroCountries.map((c) => ({
        iso: c.country_iso, rows: Number(c.n), indicators: Number(c.ind),
        yearFrom: Number(c.y0), yearTo: Number(c.y1),
      })),
    },
    devices: { realReadings: cemsReal, totalReadings: cemsTotal },
    sources: sources.map((s) => ({
      key: s.source_key, name: s.name, publisher: s.publisher,
      authenticity: s.authenticity, scope: s.scope, license: s.license,
      lastStatus: s.last_status, lastFetchedAt: s.last_fetched_at,
      recordCount: s.record_count === null ? null : Number(s.record_count),
      note: s.note,
    })),
  };
}

module.exports = {
  SOURCE_REGISTRY,
  registerSources, logIngest,
  authenticityReport,
};
