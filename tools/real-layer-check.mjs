/**
 * real-layer-check.mjs —— 真实数据层 + 实时引擎端到端验收
 * ==================================================================================
 * 【为什么必须是一个进程内完成"启动→测→关"】
 * 沙箱会回收脱离 shell 的后台进程（`nohup ... &` 随 shell 结束即死）。
 * 因此不能"先起服务再另开一条命令去测" —— 测的时候服务已经没了。
 * 只能在同一个 Node 进程里 require app（触发 listen）、跑完断言、再退出。
 *
 * 【断言策略：不只看 HTTP 200】
 * 每个端点都断言**内容层面**的性质：
 *   · 数值自洽（如 byIndustry 之和 == 总量）
 *   · 声称的条数与库里实际一致
 *   · 分页边界不越界、不重复
 *   · SSE 真的每秒来帧，且帧里的 LIVE 指标在变
 *   · /truth 的每条声明都 pass（有失败就整体失败）
 */
'use strict';

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8311;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const fails = [];

function ck(name, cond, note = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}${note ? ' — ' + note : ''}`); }
  else { fail++; fails.push(name + (note ? ' — ' + note : '')); console.log(`  ✘ ${name}${note ? ' — ' + note : ''}`); }
}

async function get(p) {
  const r = await fetch(BASE + p, { headers: { 'Cache-Control': 'no-store' } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { status: r.status, json, text };
}

/* ==================================================================================
 * 启动子进程（独立进程，便于结束后 kill）
 * ================================================================================== */

function startServer() {
  const child = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_PORT: String(PORT),
      INSTANCE_LOCK: '0',             // 测试探针子实例：豁免单实例互斥（已关闭全部定时写库）
      CEMS_INTERVAL_MS: '86400000',   // 关掉采数调度，避免验收期间改库
      HJ212_AUTOSTART: '0',
      JWT_SECRET: process.env.JWT_SECRET || 'real-layer-check-only',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => {
    const s = d.toString();
    if (/实时引擎|已启动|ready|listen/i.test(s)) process.stdout.write('    ' + s);
  });
  child.stderr.on('data', (d) => process.stdout.write('    [err] ' + d.toString()));
  return child;
}

async function waitUp(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/* ==================================================================================
 * 主体
 * ================================================================================== */

const child = startServer();
let exitCode = 0;

try {
  const up = await waitUp();
  if (!up) throw new Error('服务未能在 60 秒内就绪');
  console.log('\n服务已就绪，开始验收');
  console.log('─'.repeat(70));

  /* ---------- 0. 口径探测（CCR-02：cn-only 显式口径，2026-10-31）----------
   * 数据层两态：全球层（EPA + CN）与 cn-only（国内真实层：河北省公开 CEMS +
   * 官方统计）。两态的结构不变量不同（CN 层 4 家设施、无坐标字段、CO₂ 为
   * 活动水平法 DERIVED），断言按口径显式分支 —— 不静默放宽任何判据。 */
  const pre = await get('/api/real/overview');
  const CN_ONLY = !!(pre.json.data && pre.json.data.layerNote
    && String(pre.json.data.layerNote).includes('国内'));
  console.log(`  数据层口径：${CN_ONLY ? 'cn-only（国内真实层，CCR-02）' : '全球层（EPA + CN）'}`);
  console.log('─'.repeat(70));

  /* ---------- 1. 总览 ---------- */
  console.log('\n【1】真实数据总览 /api/real/overview');
  {
    const r = await get('/api/real/overview');
    ck('HTTP 200', r.status === 200);
    const d = r.json && r.json.data;
    ck('返回 data', !!d);

    /* ⚠⚠ 这些断言原本把数字写死（5352 / 38501 / 9 个年度 / 6 个行业）。
     *
     * 它们在当时是对的，但数据一旦增长（本轮接入 5 万家中国设施）就全部变红，
     * 而**数据本身没有任何问题**。这类"判据跟不上数据"的红灯最危险：
     * 它会让人形成"这个套件本来就是红的"的印象，从而在真正出问题时视而不见。
     *
     * 修法：断言"结构关系"而不是"具体数字"。
     *   · 设施数 > 0 且坐标齐全率 = 100%   → 检验的是"导入是否带坐标"
     *   · 年度记录 > 设施数                → 检验的是"是否真的多年度"
     *   · 分行业之和 == 该年度总量         → 检验的是"聚合口径是否一致"
     * 这些关系在任何数据规模下都必须成立，所以它们才是真正的判据。 */
    ck('设施数 > 0', d.facilities > 0, `${d.facilities} 家`);
    if (CN_ONLY) {
      ck('CN 设施数 = 4（保定四家，REAL_OFFICIAL）', d.facilities === 4, `${d.facilities} 家`);
      ck('CN 行业聚合 = 1（垃圾焚烧发电）', d.industries === 1, `实际 ${d.industries}`);
      ck('CN 主体齐全（byState 与设施数一致）', (d.byState || []).length === d.facilities,
        `${(d.byState || []).length}/${d.facilities}`);
      ck('CN 分行业聚合与总量同源（mt ≈ totalTonnes/1e6）',
        d.byIndustry.length === 1 && Math.abs(d.byIndustry[0].mt - d.totalTonnes / 1e6) < 0.001,
        `${d.byIndustry[0].mt} vs ${d.totalTonnes / 1e6}`);
      ck('CN 数据源 ≥ 3（河北省公开系统/省发改委/宏观序列）', d.sources.length >= 3,
        `实际 ${d.sources.length}`);
    } else {
      ck('年度记录 > 设施数（确实多年度）', d.emissionRows > d.facilities,
        `${d.emissionRows} 行 / ${d.facilities} 家`);
      ck('年度跨度 ≥ 2', d.years >= 2, `${d.yearFrom}–${d.yearTo}（${d.years} 个年度）`);
      ck('坐标齐全', d.withCoordinates === d.facilities, `${d.withCoordinates}/${d.facilities}`);
      ck('行业数 ≥ 5', d.industries >= 5, `实际 ${d.industries}`);
    }
    ck('有国家分层统计', Array.isArray(d.byCountry) && d.byCountry.length >= 1,
      (d.byCountry || []).map((c) => `${c.iso}:${c.facilities}`).join(' '));

    /* 关键自洽断言：分行业之和 ≈ **同一有效年度**的总量。
     * ⚠ 这里必须用 effectiveYear 对应的总量，不能用 trend 的最后一个年度 ——
     * 后者可能是进行中年度（只统计到当前时点），两者本来就不该相等。
     * 原断言用的正是 trend 末项，于是"2025 的分行业之和 vs 2026 的年初至今总量"
     * 必然对不上，而失败信息看起来像"聚合口径错了"。 */
    const effYear = d.effectiveYear || d.latestYear;
    const sumMt = d.byIndustry.reduce((a, b) => a + b.mt, 0);
    const tr = await get('/api/real/trend');
    const effPoint = (tr.json.data.series || []).find((s) => s.year === effYear);
    if (!CN_ONLY) {
      ck('分行业之和 == 该有效年度总量（±1 Mt 舍入）',
        !!effPoint && Math.abs(sumMt - effPoint.totalMt) < 1,
        `${sumMt.toFixed(2)} vs ${effPoint ? effPoint.totalMt : '缺少该年度'}（年度 ${effYear}）`);
      ck('数据源 ≥ 6 个', d.sources.length >= 6, `实际 ${d.sources.length}`);
    }
  }

  /* ---------- 2. 设施台账 ---------- */
  console.log('\n【2】真实设施台账 /api/real/facilities');
  {
    const r = await get('/api/real/facilities?page=1&size=5');
    ck('HTTP 200', r.status === 200);
    /* CN 版返回 {data:[...], meta, boundary} 包裹结构；EPA 版返回裸数组 */
    const d = CN_ONLY ? (r.json.data.data || []) : r.json.data;
    const cnMeta = CN_ONLY ? (r.json.data.meta || {}) : (r.json.meta || {});
    if (CN_ONLY) {
      ck('CN 返回 min(设施数,5) 条', d.length === Math.min(4, 5), `实际 ${d.length}`);
      ck('CN 每行 facilityId = 18 位统一社会信用代码',
        d.every((x) => String(x.facilityId || '').length === 18),
        d.map((x) => x.facilityId).join(',').slice(0, 60));
      ck('CN 每行 authenticity=DERIVED（CO₂ 为活动水平法，见 boundary 声明）',
        d.every((x) => x.authenticity === 'DERIVED'));
      ck('CN 响应带边界声明（不把核算值冒充实测）',
        !!r.json.data.boundary && !!r.json.data.boundary.whatThisIs,
        r.json.data.boundary ? r.json.data.boundary.whatThisIs.slice(0, 40) + '…' : '缺失');
      ck('CN 每行实测小时数 > 0（CEMS 公开数据在位）',
        d.every((x) => Number(x.measuredHours) > 0),
        d.map((x) => x.measuredHours).join(','));
      ck('CN meta.total > 0 且与分页一致', cnMeta.total > 0 && cnMeta.total >= d.length,
        `实际 total=${cnMeta.total}`);
      ck('每行都有源设施号', d.every((x) => x.facilityId != null && String(x.facilityId).length > 0));
      ck('按排放降序', d.length >= 2 && d[0].totalCO2e >= d[1].totalCO2e);
    } else {
      ck('返回 5 条', d.length === 5, `实际 ${d.length}`);
      ck('每行都有真实坐标', d.every((x) => typeof x.lat === 'number' && typeof x.lon === 'number'));
      ck('每行 authenticity=REAL', d.every((x) => x.authenticity === 'REAL'));
      ck('meta.total > 0 且与分页一致', r.json.meta.total > 0 && r.json.meta.total >= d.length,
        `实际 total=${r.json.meta.total}`);
      ck('每行都有源设施号', d.every((x) => x.facilityId != null && String(x.facilityId).length > 0));
      ck('按排放降序', d[0].totalCO2e >= d[1].totalCO2e);
    }
    ck('按排放降序', d[0].totalCO2e >= d[1].totalCO2e);

    /* 分页不重叠（CN 层为全量小清单，无分页语义 —— page2 同集属预期） */
    const r2 = await get('/api/real/facilities?page=2&size=5');
    const ids1 = new Set(d.map((x) => x.id));
    const page2 = CN_ONLY ? (r2.json.data.data || []) : r2.json.data;
    if (CN_ONLY) {
      ck('CN 全量返回（page2 与 page1 同集，无分页语义）',
        page2.length === d.length && page2.every((x) => ids1.has(x.id)),
        `page1=${d.length} page2=${page2.length}`);
    } else {
      const ids2 = page2.map((x) => x.id);
      ck('第 1、2 页无重叠', ids2.every((id) => !ids1.has(id)));
    }

    /* 行业筛选真的生效 */
    if (CN_ONLY) {
      const r3c = await get('/api/real/facilities?industry=' + encodeURIComponent('垃圾焚烧发电') + '&size=3');
      ck('CN 行业筛选生效', (r3c.json.data.data || []).every((x) => x.industry === '垃圾焚烧发电'));
      const r4c = await get('/api/real/facilities?industry=' + encodeURIComponent('不存在的行业'));
      ck('CN 非法行业返回空集（不静默放行）', r4c.status === 200 && (r4c.json.data.data || []).length === 0,
        `status=${r4c.status} rows=${(r4c.json.data.data || []).length}`);
      const r5c = await get('/api/real/facilities?order=ASC&size=3');
      const ascRows = r5c.json.data.data || [];
      ck('CN ASC 排序生效', ascRows.length >= 2
        && ascRows[0].totalCO2e <= ascRows[ascRows.length - 1].totalCO2e);
    } else {
      const r3 = await get('/api/real/facilities?industry=电力&size=3');
      ck('行业筛选生效', r3.json.data.every((x) => x.industry === '电力'));
      /* 非法行业要被拒，而不是静默返回全部 */
      const r4 = await get('/api/real/facilities?industry=' + encodeURIComponent('不存在的行业'));
      ck('非法行业被拒绝（非静默放行）', r4.status === 400, `status=${r4.status}`);
    }

    /* 排序反向（已按口径在上方分支断言） */
  }

  /* ---------- 3. 单设施明细 ---------- */
  console.log('\n【3】设施明细 /api/real/facilities/:id');
  {
    /* ⚠ 取一家**同时有活动量与排放因子**的设施（中国电力类通常齐备）。
     * 原实现取"排放最大的一家"，而美国 EPA 设施有 process_json 的工艺分解、
     * 中国设施有 activity/emissionFactor —— 两种结构的字段完全不同。
     * 用 `?country=CHN&industry=电力` 明确取后一种，断言才有意义。 */
    const list = CN_ONLY
      ? await get('/api/real/facilities?size=1')
      : await get('/api/real/facilities?country=CHN&industry=' + encodeURIComponent('电力') + '&size=1');
    const id = (CN_ONLY ? (list.json.data.data || []) : list.json.data)[0].id;
    const r = await get(`/api/real/facilities/${id}`);
    ck('HTTP 200', r.status === 200);
    const d = r.json.data;
    ck('含年度序列', Array.isArray(d.series) && d.series.length >= 1, `${d.series.length} 年`);
    if (CN_ONLY) {
      ck('CN 明细标注设施号（统一社会信用代码）', String(d.facilityId || '').length === 18,
        d.facilityId);
      ck('CN 带方法学声明（E=A×EF 可当场复算）',
        !!d.methodology && /E\s*=\s*处理量|活动水平/.test(d.methodology),
        (d.methodology || '').slice(0, 44) + '…');
      ck('CN 带小时实测证据（CEMS 公开层）',
        !!d.real && Number(d.real.hours) > 0, `hours=${d.real && d.real.hours}`);
      ck('CN 首年同比为 null（不伪造）', d.series[0].yoy === null);
      ck('CN 不存在的设施返回 404',
        (await get('/api/real/facilities/99999999')).status === 404);
    } else {
      ck('国家标注为中国', d.country === 'CHN', `实际 ${d.country}`);
      ck('带数据性质说明（不是裸数据）', !!(d.countryNote && d.countryNote.nature),
        d.countryNote ? d.countryNote.nature.slice(0, 40) + '…' : '缺失');
      /* 观测证据字段：有活动量与因子才能做恒等式检验 */
      const last = d.series[d.series.length - 1];
      ck('观测证据含活动量', last.activity != null, `activity=${last.activity}`);
      ck('观测证据含排放因子', last.emissionFactor != null, `EF=${last.emissionFactor}`);
      ck('观测证据含置信度评级', last.confidence != null,
        last.confidence ? (last.confidence.total_co2e_100yrgwp || '有') : '缺失');
      /* 恒等式：E ≈ 活动量 × 因子（容差 0.5%，与 crossValidate 的分档一致） */
      const recomputed = last.activity != null && last.emissionFactor != null
        ? last.activity * last.emissionFactor : null;
      ck('E ≈ 活动量 × 排放因子（±0.5%）',
        recomputed != null && last.totalCO2e > 0
          ? Math.abs(recomputed - last.totalCO2e) / last.totalCO2e < 0.005
          : false,
        recomputed == null ? '缺活动量或因子' : `${recomputed.toFixed(0)} vs ${last.totalCO2e}`);
      /* 同比：首年必须为 null（没有前一年可比） */
      ck('首年同比为 null（不伪造）', d.series[0].yoy === null);
      const r2 = await get('/api/real/facilities/99999999');
      ck('不存在的设施返回 404', r2.status === 404);
    }
    if (!CN_ONLY) {
      ck('带行业排名', !!d.rank && d.rank.rank >= 1,
        d.rank ? `行业第 ${d.rank.rank} / ${d.rank.total}` : '缺失');
    }
  }

  /* ---------- 4. 行业基准 ---------- */
  console.log('\n【4】行业基准 /api/real/benchmarks');
  {
    const r = await get('/api/real/benchmarks');
    ck('HTTP 200', r.status === 200);
    const d = r.json.data;
    /* 行业数随数据源变化（美国 6 类 + 中国 9 类），断言"至少 6 类"而不是"等于 6"。 */
    if (CN_ONLY) {
      /* CN 基准按企业出 4 行（小时排放速率分布，REAL） */
      ck('CN 基准行数 = 4（按企业，小时实测分布）', d.length === 4, `实际 ${d.length}`);
      ck('CN 每行分位数结构齐全', d.every((x) => x.medianMt != null && x.p90Mt != null));
      ck('CN 全部行 P90 ≥ 中位数（右偏或对称，不反向）',
        d.every((x) => x.p90Mt >= x.medianMt));
      ck('CN 全部行均值 > 0', d.every((x) => x.meanMt > 0));
    } else {
      ck('行业数 ≥ 6', d.length >= 6, `实际 ${d.length}`);
      ck('电力是最大行业', d[0].industry === '电力', `${d[0].industry} ${d[0].totalMt} Mt`);
      /* 均值 > 中位数 > 0：真实排放分布是右偏的 */
      const elec = d.find((x) => x.industry === '电力');
      ck('电力：均值 > 中位数（右偏分布符合真实）',
        elec.meanMt > elec.medianMt,
        `均值 ${elec.meanMt} / 中位数 ${elec.medianMt}`);
      ck('电力：P90 > 中位数', elec.p90Mt > elec.medianMt, `${elec.p90Mt} vs ${elec.medianMt}`);
      ck('电力：Top10 份额在 (0,1]', elec.top10Share > 0 && elec.top10Share <= 1, `${elec.top10Share}`);
    }
  }

  /* ---------- 5. 年度趋势 ---------- */
  console.log('\n【5】年度趋势 /api/real/trend');
  {
    const r = await get('/api/real/trend');
    const d = r.json.data;
    ck('年度点数 ≥ 2', d.series.length >= 2, `实际 ${d.series.length}`);
    ck('跨度 ≥ 2 年', d.span && d.span.years >= 2,
      d.span ? `${d.span.from}–${d.span.to}（${d.span.years} 年）` : '无');
    ck('首年同比为 null', d.series[0].yoy === null);
    if (CN_ONLY) {
      /* CN 层含进行中年度（2026 小时数据仍在累积），期间变化可为 null —— 不伪造 */
      ck('CN 期间变化为 null 或对象（不伪造）',
        d.change === null || (d.change && typeof d.change === 'object'),
        d.change ? `${(d.change.pct * 100).toFixed(2)}%` : 'null（含进行中年度）');
    } else {
      ck('有期间变化', d.change !== null, d.change ? `${(d.change.pct * 100).toFixed(2)}%` : '无');
      ck('趋势序列声明了聚合资产排除口径', !!d.scope && d.scope.excludesAggregateAssets === true);
    }
    /* ⚠ 原断言把方向写死（"2010→2018 为下降"）。那是**美国 EPA** 数据的特征，
     * 一旦混入中国数据（多年度、且在进行中年度仍在累积），方向就不再是判据。
     * 真正该断言的是**没有荒谬值**，方向属于数据事实、不属于质量判据。 */
    const yoys = d.series.filter((x) => x.yoy !== null);
    ck('无荒谬同比（|yoy| < 3）', yoys.every((x) => Math.abs(x.yoy) < 3),
      `极端值 ${yoys.filter((x) => Math.abs(x.yoy) >= 3).length} 个 / ${yoys.length}`);
    /* 进行中年度必须被显式标注 —— 这是避免"排放骤降"误读的唯一机制 */
    const partials = (d.completeness || []).filter((c) => c.isPartial);
    ck('进行中年度已被标注（不冒充完整年度）',
      partials.length === 0 || partials.every((c) => !!c.note),
      partials.map((c) => c.year).join(',') || '无进行中年度');
    /* 口径一致性：trend 必须声明排除了聚合资产（与 overview 同口径）；
     * CN 层无聚合资产概念，无该字段（显式跳过，不静默） */
    if (!CN_ONLY) {
      ck('趋势序列声明了聚合资产排除口径', !!d.scope && d.scope.excludesAggregateAssets === true);
    }
  }

  /* ---------- 6. 宏观序列 ---------- */
  console.log('\n【6】宏观真实序列 /api/real/macro');
  {
    const r = await get('/api/real/macro?country=CHN');
    ck('HTTP 200', r.status === 200);
    const d = r.json.data;
    ck('有指标', d.indicators.length >= 1, `${d.indicators.length} 个指标`);
    ck('每个指标有来源标注', d.indicators.every((x) => x.source && x.source.publisher));
    const pts = d.indicators[0].points;
    ck('点数 > 0', pts.length > 0);
    /* 关键：缺数据年份必须是 null 而不是 0 */
    const vals = pts.map((p) => p.value);
    ck('缺失值用 null 不用 0', vals.every((v) => v === null || v > 0),
      `null 数 ${vals.filter((v) => v === null).length}`);
  }

  /* ---------- 7. 数据源 ---------- */
  console.log('\n【7】数据源登记 /api/real/sources');
  {
    const r = await get('/api/real/sources');
    const d = r.json.data;
    if (!CN_ONLY) ck('≥ 6 个源', d.length >= 6);
    else ck('CN ≥ 3 个源', d.length >= 3, `实际 ${d.length}`);
    ck('每个源有 license', d.every((x) => !!x.license));
    ck('每个源有真实性等级',
      /* DEGRADED = 代码存在但从未成功取到数据（如被 IP 风控的商业接口）。
       * 把它单列出来是必要的：标成 REAL 会让"有 7 个真实源"这个说法
       * 虚假地包含一个永远拿不到数据的源。 */
      d.every((x) => ['REAL', 'DERIVED', 'MODELED', 'ESTIMATE', 'SYNTHETIC', 'DEGRADED'].includes(x.authenticity)),
      [...new Set(d.map((x) => x.authenticity))].join('/'));
    ck('每个源有新鲜度字段', d.every((x) => x.ageSec === null || typeof x.ageSec === 'number'));
    /* 至少有一个中国真实设施源（本轮接入的核心） */
    if (CN_ONLY) {
      /* cn-only 口径：全球源（Climate TRACE/EPA）不在数据层，断言国内源在列 */
      const cnSrc = d.find((x) => /cems|河北|hb/i.test(`${x.key}${x.name || ''}`));
      ck('CN 已登记国内真实源（河北省公开 CEMS 系）', !!cnSrc,
        cnSrc ? `${cnSrc.key} · 真实性 ${cnSrc.authenticity}` : '未登记');
      ck('CN 至少一个 REAL/DERIVED 源', d.some((x) => ['REAL', 'DERIVED'].includes(x.authenticity)),
        [...new Set(d.map((x) => x.authenticity))].join('/'));
    } else {
      const ct = d.find((x) => x.key === 'climate_trace');
      ck('已登记 Climate TRACE（中国设施级真实源）', !!ct,
        ct ? `真实性 ${ct.authenticity} · ${ct.recordCount == null ? '?' : Number(ct.recordCount).toLocaleString()} 条` : '未登记');
      const epa = d.find((x) => x.key === 'epa_ghgrp');
      ck('EPA 源已同步过', epa && epa.ageSec !== null, epa ? `${Math.round(epa.ageSec / 60)} 分钟前` : '');
    }
  }

  /* ---------- 8. 真实性契约 —— 最关键 ---------- */
  console.log('\n【8】真实性契约 /api/real/truth');
  {
    const r = await get('/api/real/truth');
    ck('HTTP 200', r.status === 200);
    const d = r.json.data;
    if (CN_ONLY) ck('CN 声明条数 ≥ 8', d.declarations.length >= 8, `实际 ${d.declarations.length}`);
    else ck('声明条数 ≥ 10', d.declarations.length >= 10, `实际 ${d.declarations.length}`);
    ck('全部核验通过', d.summary.failed === 0,
      `通过 ${d.summary.passed}/${d.summary.verified}`);
    /* 记下这两个数供台账引用 —— 它们来自**本次请求的实算结果**，
     * 不是脚本里写死的常量。 */
    globalThis.__truthPassed = d.summary.passed;
    globalThis.__truthVerified = d.summary.verified;
    ck('三层都有声明', d.summary.byLayer.REAL > 0 && d.summary.byLayer.DERIVED > 0
      && d.summary.byLayer.MODELED > 0, JSON.stringify(d.summary.byLayer));
    /* 反向检查：确认真的是"算出来的"而不是读死的字符串。
     *
     * ⚠ 原来断言的是 `c.actual === 38501`（EPA 的旧记录数）。数据一增长就红。
     * 真正的判据是"actual 与 expected 一致且都是数字" —— 那才排除了
     * "把字符串直接返回"的可能性，而不依赖某个具体数值。 */
    const c = d.declarations.find((x) => x.key === 'real_emission_rows')
      || d.declarations.find((x) => x.key === 'cn_emission_calc');
    ck('声明带运行时实算值', !!c && typeof c.actual === 'number' && c.actual > 0,
      c ? `${c.key}: actual=${c.actual}` : '未找到');
    ck('中国真实设施声明存在（cn_emission_calc 逐设施-年度）',
      d.declarations.some((x) => x.key === 'cn_facility_count' || x.key === 'cn_emission_calc'),
      d.declarations.filter((x) => x.key.startsWith('cn_')).map((x) => x.key).join(','));
    ck('每条 REAL 声明都有 basis', d.declarations.filter((x) => x.layer === 'REAL')
      .every((x) => !!x.basis));
    if (d.summary.failed > 0) {
      d.declarations.filter((x) => x.pass === false).forEach((x) => {
        console.log(`      ✘ ${x.subject}: expected=${x.expected} actual=${x.actual}`);
      });
    }
  }

  /* ---------- 9. 实时快照 ---------- */
  console.log('\n【9】实时快照 /api/real/live');
  let liveFirst = null;
  {
    const r = await get('/api/real/live');
    ck('HTTP 200', r.status === 200);
    const d = r.json.data;
    /* 实时引擎刚启动时还没有第一帧（tickCount=0、metrics=[]）。直接断言会让
     * 整套检查以 TypeError 中断（2026-10-28 实测：verify:all 里该套件自己拉起的
     * 实例尚未完成首帧，脚本在 ir.value 处崩溃，连带指标台账报"1 套失败"）。
     * 这里先等首帧，最多 8 秒。 */
    for (let i = 0; i < 16; i++) {
      const cur = await get('/api/real/live');
      const cd = (cur.json && cur.json.data) || {};
      if ((cd.metrics || []).length && cd.tickCount > 0) {
        d.metrics = cd.metrics; d.tickCount = cd.tickCount;
        break;
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    const metrics = d.metrics || [];
    ck('9 项指标', metrics.length === 9, `实际 ${metrics.length}`);
    ck('引擎已累计 tick', d.tickCount > 0, `${d.tickCount} 次`);
    ck('tickMs = 1000', d.tickMs === 1000);
    ck('所有指标有 provenance', metrics.every((m) => !!m.provenance));
    ck('所有指标有 cadence', metrics.every((m) => !!m.cadence));
    const rf = metrics.find((m) => m.key === 'real.facilities');
    /* 断言"有值且与 API 的 facilities 一致"，而不是写死 5352。
     * 一致性检查比数值检查更强：它同时排除了"实时引擎没读到数据"和
     * "两处口径不一致"两种缺陷。CN 层实时引擎无 facilities 静态指标
     * （CEMS 速率/当日排放等 9 项），显式跳过并核对 CN 指标在位。 */
    if (CN_ONLY) {
      const today = metrics.find((m) => m.key === 'cems.todayEmission');
      ck('CN 实时指标在位（cems.todayEmission）', !!today, today ? `cadence=${today.cadence}` : '缺失');
      ck('CN 指标 cadence 枚举合法（LIVE/POLL/STATIC，无伪造周期）',
        metrics.every((m) => ['LIVE', 'POLL', 'STATIC'].includes(m.cadence)),
        [...new Set(metrics.map((m) => m.cadence))].join('/'));
    } else {
      const ov = await get('/api/real/overview');
      const ovFac = (ov.json.data || {}).facilities;
      ck('real.facilities 与 overview 口径一致', rf && ovFac != null && rf.value === ovFac,
        `live=${rf ? rf.value : '?'} overview=${ovFac}`);
      ck('real.facilities 标记为 STATIC（不伪造每秒变化）', rf && rf.cadence === 'STATIC');
    }
    const ir = metrics.find((m) => m.key === 'cems.instantRate');
    ck('cems.instantRate 标记 MODELED', ir && ir.provenance === 'MODELED');
    /* 断言表达式里的 `${ir.value}` 会在 ir 为 undefined 时抛 TypeError，
     * 把"断言失败"变成"整套中断"——用可选链兜底，让失败如实计为一条 ✘。 */
    ck('瞬时速率 > 0', ir && ir.value > 0, `${ir?.value ?? 'n/a'} tCO₂e/s`);
    const bpm = metrics.find((m) => m.key === 'chain.blocksPerMin');
    ck('出块速率无除零爆炸（< 1000）', bpm && Math.abs(bpm.value) < 1000, `${bpm?.value ?? 'n/a'} 块/分`);
    const mp = metrics.find((m) => m.key === 'market.price');
    ck('成交均价已取到（非静默归零）', mp && mp.value > 0, `${mp?.value ?? 'n/a'} 元/t`);
    liveFirst = d;
  }

  /* ---------- 10. SSE 真的在推 ---------- */
  console.log('\n【10】SSE 实时流 /api/real/stream');
  {
    const ctrl = new AbortController();
    const resp = await fetch(BASE + '/api/real/stream', { signal: ctrl.signal });
    ck('HTTP 200', resp.status === 200);
    ck('Content-Type 为 event-stream',
      (resp.headers.get('content-type') || '').includes('text/event-stream'));

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const events = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 4500) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /event: (\w+)/.exec(chunk);
        const dm = /data: (.+)/.exec(chunk);
        if (ev && dm) events.push({ event: ev[1], data: JSON.parse(dm[1]) });
      }
      if (events.filter((e) => e.event === 'tick').length >= 3) break;
    }
    ctrl.abort();

    const snap = events.filter((e) => e.event === 'snapshot');
    const ticks = events.filter((e) => e.event === 'tick');
    ck('收到初始 snapshot', snap.length === 1);
    ck('4.5 秒内收到 ≥3 个 tick', ticks.length >= 3, `实际 ${ticks.length}`);

    if (ticks.length >= 2) {
      /* 关键：LIVE 指标必须在帧间变化 —— 否则"实时"是假的。
       *
       * ⚠ 判据必须允许"多个 LIVE 指标中至少一个在变"，而不是只看某一个。
       * 原实现只比 `cems.instantRate` 的首末帧。它失败过一次：
       * 两次采样恰好落在负荷曲线的同一平缓段，值经 toFixed(4) 后完全相同
       * （0.159716 → 0.159716），于是判"实时是假的"。
       * 但实际 tickCount 在推进、其余指标在变 —— 是判据太窄，不是功能坏了。
       *
       * 现在的判据：在全部 cadence=LIVE 的指标里，只要有一个首末帧不同即通过；
       * 并把"哪些变了"打出来，便于人工确认。 */
      const liveKeys = (ticks[0].data.metrics || [])
        .filter((m) => m.cadence === 'LIVE')
        .map((m) => m.key);
      const getV = (t, k) => (t.data.metrics.find((m) => m.key === k) || {}).value;
      const last = ticks[ticks.length - 1];
      const changed = liveKeys.filter((k) => getV(ticks[0], k) !== getV(last, k));
      ck('LIVE 指标帧间有变化', changed.length > 0,
        `变化的指标 ${changed.length}/${liveKeys.length}：${changed.slice(0, 3).join(', ') || '无'}`);

      /* tickCount 必须推进 —— 这是"引擎在跑"最直接的证据，
       * 且不受浮点精度影响 */
      /* 字段名是 tick（不是 tickCount）—— 以实际 payload 为准 */
      ck('tick 计数帧间推进',
        Number(last.data.tick) > Number(ticks[0].data.tick),
        `${ticks[0].data.tick} → ${last.data.tick}`);

      /* STATIC 指标帧间不得变化 —— 否则是在给年频数据加抖动 */
      const s1 = getV(ticks[0], 'real.facilities');
      const s2 = getV(last, 'real.facilities');
      ck('STATIC 指标帧间稳定（无伪造抖动）', s1 === s2, `${s1} → ${s2}`);
    }
  }

  /* ---------- 11. 引擎自检 ---------- */
  console.log('\n【11】引擎自检 /api/real/live/selfcheck');
  {
    const r = await get('/api/real/live/selfcheck');
    const d = r.json.data;
    d.checks.forEach((c) => ck(`自检：${c.name}`, c.pass, c.note));
  }

  /* ---------- 12. 既有端点未被破坏 ---------- */
  console.log('\n【12】既有端点回归（真实层不得影响业务层）');
  {
    const h = await get('/api/health');
    ck('/api/health 200（无需登录）', h.status === 200);
    const p = await get('/api/public/dashboard');
    ck('/api/public/dashboard 可访问', p.status === 200, `status=${p.status}`);
    const e = await get('/api/enterprise/list');
    ck('业务端点仍需鉴权（401）', e.status === 401, `status=${e.status}`);
    /* 未知 /api 路径返回 401 而非 404：这是**故意**的 ——
     * 404 会让攻击者枚举出哪些端点存在。统一 401 不泄露端点表。 */
    const x = await get('/api/definitely-not-a-real-endpoint-xyz');
    ck('未知 /api 路径不泄露端点存在性（401）', x.status === 401, `status=${x.status}`);
    /* 真实层必须保持公开可读 —— 这是"可被第三方核验"的前提 */
    const openPaths = ['/api/real/overview', '/api/real/truth', '/api/real/live', '/api/real/sources'];
    for (const p2 of openPaths) {
      const r = await get(p2);
      ck(`${p2} 无鉴权可读`, r.status === 200, `status=${r.status}`);
    }
  }
} catch (e) {
  console.error('\n✘ 验收异常：', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 4).join('\n'));
  fail++;
  fails.push('异常中断：' + e.message);
  exitCode = 1;
} finally {
  try { child.kill('SIGTERM'); } catch (e) {}
  await new Promise((r) => setTimeout(r, 800));
  try { child.kill('SIGKILL'); } catch (e) {}
}

console.log('\n' + '═'.repeat(70));
console.log(`  验收结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} 项断言`);
if (fails.length) {
  console.log('  失败项：');
  fails.forEach((f) => console.log('    · ' + f));
  exitCode = 1;
}
console.log('═'.repeat(70));

/* ---------- 落盘 ----------
 * 指标台账要能引用本轮的通过数与契约核验通过数。
 * 这两个数**只能从本次真实执行里取**：写死就会在回归失败时仍显示"87 通过"，
 * 那正是台账最忌讳的"数字与产生它的执行脱钩"。 */
try {
  const fs = await import('node:fs');
  const outDir = path.join(ROOT, 'tools', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'real-layer-check.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    pass, fail, total: pass + fail,
    truthPassed: globalThis.__truthPassed ?? null,
    truthVerified: globalThis.__truthVerified ?? null,
    failedItems: fails,
  }, null, 2), 'utf8');
  console.log('  已写出：tools/out/real-layer-check.json');
} catch (e) { console.log('  ⚠ 写 real-layer-check.json 失败：', e.message); }

process.exit(exitCode);
