/**
 * routes/plant3d.js —— 焚烧厂区 3D 测绘模型 API
 * ==================================================================================
 * 【与 /twin 的区别（这点必须讲清楚，否则会被当成"又编了一套"）】
 *   /twin       —— 已下线。几何是"行业工程量级派生的示意方块"，却挂在真实排放量下。
 *   /plant3d    —— 本路由。几何逐栋从卫星影像量出来（services/plantGeometry.js
 *                  里每栋都带 note，写明量的是影像是哪一栋、多少米），
 *                  排放量绑 cems_cn_hourly 的实测值。
 *
 * 【返回体的来源标注】
 *   geometry.source  = SATELLITE_MEASURED  （轮廓逐栋量测；高度取工程常见值）
 *   geometry.heightBasis = typical         （正射影像读不出高度，不谎称实测）
 *   emission.source  = CEMS_HOURLY         （省污染源自动监控平台公开数据）
 * 两者分开标，不合并成一句"全部真实"。
 *
 * 【排放量如何分摊到构筑物】
 *   主厂房与烟囱承担绝大部分排放（焚烧烟气全部经烟囱排出），
 *   其余辅房按固定小微比例。分摊比例是**建模假设**，不是实测，
 *   因此在返回体的 apportion 字段里明确写出比例来源。
 *
 * @module routes/plant3d
 */
'use strict';

const express = require('express');
const db = require('../db');
const { authRequired, ok, fail, wrap } = require('../middleware/auth');
const geo = require('../services/plantGeometry');

const router = express.Router();

/** 构筑物分摊权重 —— 全部为建模假设，非实测 */
const WEIGHTS = {
  /* 焚烧线本体与烟囱是排放出口 */
  'main-hall': 0.34,
  'stack': 0.30,
  'stack-1': 0.16,
  'stack-2': 0.14,
  /* 输料/填埋环节有少量无组织排放 */
  'tunnel': 0.02,
  'landfill': 0.02,
  'platform': 0.02,
  /* 其余辅房：仅作场景构成，权重给极小值 */
  default: 0.01,
};

/**
 * GET /plants —— 四家可建模厂区清单（含坐标、场区尺寸、构筑物数量）
 */
router.get('/plants', wrap(async (req, res) => {
  ok(res, geo.list());
}));

/**
 * GET /plant/:code —— 单厂区完整几何 + 实测排放
 * :code 取 ent_zjbd / ent_yfkw / ent_yxyf / ent_zjyls
 */
/** 组装单厂区 payload（/plant/:code 与 /mine 共用，避免两份分摊逻辑漂移） */
async function buildPlantPayload(key) {
  const p = geo.PLANTS[key];
  const structures = geo.structuresFor(key);

  /* 真实排放：按企业名精确匹配（恒能保定在 CEMS 表里是全厂一行） */
  const rows = await db.query(
    `SELECT COUNT(*) hours,
            SUM(flue_gas_m3) gasM3,
            SUM(so2_emission_kg) so2Kg,
            SUM(nox_emission_kg) noxKg,
            SUM(pm_emission_kg) pmKg,
            SUM(co_emission_kg) coKg,
            SUM(hcl_emission_kg) hclKg,
            MIN(monitored_at) t0,
            MAX(monitored_at) t1
       FROM cems_cn_hourly
      WHERE ent_name = ? AND is_valid = 1`,
    [p.nameZh]
  );
  const e = (rows && rows[0]) || null;

  /* 把实测排放按权重分摊到构筑物（权重和为 1，缺省项归入 default） */
  let wsum = 0;
  const ws = structures.map((s) => {
    const w = WEIGHTS[s.id] != null ? WEIGHTS[s.id] : WEIGHTS.default;
    wsum += w; return w;
  });
  const totalNOx = e ? Number(e.noxKg || 0) : 0;
  const totalSO2 = e ? Number(e.so2Kg || 0) : 0;
  structures.forEach((s, i) => {
    const r = wsum > 0 ? ws[i] / wsum : 0;
    s.emission = Math.round(totalNOx * r);
    s.sharePct = +(r * 100).toFixed(1);
  });

  return {
    facility: {
      entId: p.entId, code: p.code, name: p.nameZh, short: p.short,
      address: p.address, lat: p.lat, lon: p.lon,
      layout: p.layout,
    },
    plant: {
      nameZh: p.nameZh,
      sceneExtent: p.extent,
      cluster: p.cluster,
      structures,
    },
    years: e ? [{ year: e.t1 ? new Date(e.t1).getFullYear() : null, emission: totalNOx }] : [],
    geometry: {
      source: 'SATELLITE_MEASURED',
      sourceDetail: '高德卫星瓦片 z18，主体建筑轮廓逐栋量测；场区边界按围墙量测',
      heightBasis: 'typical',
      heightNote: '正射影像读不出建筑高度，高度取该类构筑物常见工程值，不作实测声称',
      measuredAt: '2026-10-31',
      pixelScale: 'z18 北纬 38.83° 处 0.4655 m/px（瓦片原生）',
    },
    emission: e ? {
      source: 'CEMS_HOURLY',
      sourceDetail: '河北省污染源自动监控信息公开系统公开数据，逐小时报文',
      hours: Number(e.hours || 0),
      from: e.t0, to: e.t1,
      noxKg: totalNOx,
      so2Kg: totalSO2,
      pmKg: Number(e.pmKg || 0),
      coKg: Number(e.coKg || 0),
      hclKg: Number(e.hclKg || 0),
      gasM3: Number(e.gasM3 || 0),
    } : null,
    apportion: {
      basis: 'MODEL_ASSUMPTION',
      note: '排放按构筑物功能权重分摊（主厂房+烟囱承担主体，辅房极小值），权重为建模假设，非实测',
      weights: WEIGHTS,
    },
  };
}

router.get('/plant/:code', wrap(async (req, res) => {
  const code = String(req.params.code || '').toLowerCase();
  /* 允许直接用数字 id 查 */
  let key = null;
  const all = geo.PLANTS;
  for (const k of Object.keys(all)) {
    if (k.toLowerCase() === code || String(all[k].entId) === code
      || all[k].code === code) { key = k; break; }
  }
  if (!key) return fail(res, '未知厂区编码：' + code, 404);
  ok(res, await buildPlantPayload(key));
}));

/**
 * GET /mine —— 当前登录企业自己的厂区模型
 *
 * 企业账号（ent_zjbd 等）登录后，/twin 页取这个接口拿到**本企业**的实测
 * 厂区，而不是让每个企业都能翻看别家的模型。企业 id 65~68 与
 * services/plantGeometry.js 的 entId 一一对应；对不上就明确 404，
 * 不回退到"随便给一个"。
 */
router.get('/mine', authRequired, wrap(async (req, res) => {
  if (req.user.role !== 'ENTERPRISE') {
    return fail(res, '厂区模型归属企业账号 —— 请用企业账号（ent_zjbd 等）登录查看', 403);
  }
  const key = Object.keys(geo.PLANTS)
    .find((k) => geo.PLANTS[k].entId === Number(req.user.orgId));
  if (!key) return fail(res, '当前企业暂无实测厂区模型（模型覆盖保定四家焚烧企业）', 404);
  ok(res, await buildPlantPayload(key));
}));

/**
 * GET /compare —— 四家并置对比（场区尺度 / 构筑物数 / 实测排放强度）
 */
router.get('/compare', wrap(async (req, res) => {
  const codes = Object.keys(geo.PLANTS);
  const rows = await db.query(
    `SELECT ent_name, COUNT(*) hours, SUM(nox_emission_kg) nox, SUM(flue_gas_m3) gas
       FROM cems_cn_hourly WHERE is_valid = 1 GROUP BY ent_name`
  );
  const byName = new Map(rows.map((r) => [r.ent_name, r]));
  ok(res, codes.map((k) => {
    const p = geo.PLANTS[k];
    const e = byName.get(p.nameZh);
    return {
      code: p.code, entId: p.entId, name: p.short, nameZh: p.nameZh,
      areaM2: p.extent.w * p.extent.d,
      extent: p.extent, structureCount: p.structures.length,
      noxKg: e ? Number(e.nox || 0) : 0,
      hours: e ? Number(e.hours || 0) : 0,
    };
  }));
}));

module.exports = router;
