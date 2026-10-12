/**
 * routes/iot.js —— 工业现场设备接入与数据质量 API（WP1 源端真实化）
 * ------------------------------------------------------------------
 * 读接口全部开放（体现"源端可审计"）；准入治理属**监管职权**，须登录 + 角色校验：
 *   · 审批 / 吊销设备          REGULATOR、ADMIN
 *   · 手动触发表账自举         ADMIN
 *
 * 端点分组
 *   运行态    /status             TCP 服务端实时状态（连接数/帧数/拒绝数/最近事件）
 *   台账      /devices           设备列表（可按企业/协议/授权状态筛选）
 *             /devices/:did/auth 变更授权状态
 *             /stats             台账总览
 *   数据质量  /pma               数据获取率（PMA）
 *             /quality           时序质量标记分布
 *             /trend             接入量时序
 *             /offline-sweep     离线看门狗巡检（OFFLINE 标记的真实生产者）
 *   协议      /factors           HJ 212 因子编码表 + **已实现子集声明**
 *             /conformance       协议合规自检结果（三重锚定）
 */
'use strict';

const express = require('express');
const H = require('../protocol/hj212');
const registry = require('../services/deviceRegistry');
const hj = require('../services/hj212Server');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');

const router = express.Router();

/* ---------------- 读：运行态 ---------------- */

/** TCP 服务端实时状态 */
router.get('/status', wrap(async (req, res) => {
  ok(res, hj.status());
}));

/** 设备台账总览 */
router.get('/stats', wrap(async (req, res) => {
  ok(res, await registry.stats());
}));

/** 设备列表 */
router.get('/devices', wrap(async (req, res) => {
  const rows = await registry.list({
    entId: req.query.entId,
    protocol: req.query.protocol,
    authStatus: req.query.authStatus,
    keyword: req.query.keyword,
    limit: req.query.limit,
  });
  ok(res, rows);
}));

/* ---------------- 读：数据质量 ---------------- */

/** 数据获取率（PMA） */
router.get('/pma', wrap(async (req, res) => {
  const r = await hj.pma({
    hours: req.query.hours,
    entId: req.query.entId,
    intervalMinutes: req.query.interval,
  });
  ok(res, r);
}));

/** 时序质量标记分布 */
router.get('/quality', wrap(async (req, res) => {
  ok(res, await hj.quality());
}));

/** 接入量时序 */
router.get('/trend', wrap(async (req, res) => {
  ok(res, await hj.ingestTrend(req.query.hours));
}));

/**
 * 离线看门狗：把"设备静默"落成 OFFLINE 占位读数。
 * 这是 OFFLINE 质量标记的**唯一真实生产者** —— 设备什么都没报时，
 * 只有平台主动巡检才能发现"数据的缺席"。
 * 存活证据只认设备直报（evidenceOnly，默认 true）：平台自举读数不能证明设备在线。
 * query: ?silentMinutes=180&cooldownMinutes=60&maxPerRun=300&evidenceOnly=1&entId=7&did=did:iot:cems:xxx
 */
router.post('/offline-sweep', authRequired, requireRole('REGULATOR', 'ADMIN'), wrap(async (req, res) => {
  const q = { ...(req.query || {}), ...(req.body || {}) };
  const r = await hj.sweepOffline({
    silentMinutes: q.silentMinutes, cooldownMinutes: q.cooldownMinutes, maxPerRun: q.maxPerRun,
    entId: q.entId, did: q.did,
    evidenceOnly: q.evidenceOnly === undefined ? undefined : !(q.evidenceOnly === false || q.evidenceOnly === '0' || q.evidenceOnly === 'false'),
  });
  if (r.marked) {
    await writeLog(req, '设备接入', '离线看门狗巡检', 'cems_reading',
      `静默超 ${r.silentMinutes} 分钟的排口 ${r.marked} 个已补记 OFFLINE（批次 ${r.batchNo}）`);
  }
  ok(res, r, r.marked
    ? `已补记 ${r.marked} 个离线排口的 OFFLINE 记录（判定阈值 ${r.silentMinutes} 分钟）`
    : `本次巡检未发现新的离线排口（阈值 ${r.silentMinutes} 分钟，冷却 ${r.cooldownMinutes} 分钟）`);
}));

/* ---------------- 读：协议能力 ---------------- */

/**
 * HJ 212 因子编码表与**已实现子集声明**。
 * 明确列出"实现了什么 / 没实现什么"，避免把部分实现说成全兼容。
 */
router.get('/factors', wrap(async (req, res) => {
  ok(res, {
    protocol: 'HJ 212-2017 污染物在线监控（监测）系统数据传输标准',
    crc: {
      algorithm: 'HJ 212-2017 附录 A',
      poly: '0x8005（右移形式 0xA001）',
      init: '0xFFFF',
      xorout: '0x0000',
      byteOrder: '高字节在前',
      equivalentCatalogueName: 'CRC-16/MODBUS（参数集相同）',
      notThis: 'CRC-16/CCITT（0x1021）—— HJ 212 不是 CCITT，误用会导致全部报文校验失败',
      checkValue: "crc16('123456789') = 0x4B37",
    },
    frame: {
      structure: '## + 数据段长度(4位十进制) + 数据段 + CRC(4位十六进制) + <CR><LF>',
      lengthCovers: '仅数据段（不含 ##、长度、CRC、包尾）',
      maxSegmentBytes: 1024,
    },
    implementedCn: H.CN_CODES,
    pollutantCodes: H.POLLUTANT_CODES,
    dataFlags: H.DATA_FLAGS,
    flagToQuality: H.FLAG_TO_QUALITY,
    stCodes: H.ST_CODES,
    notImplemented: [
      '拆包/组包（PNUM/PNO 多包重组）—— 仅解析字段，不重组',
      'CP 加密传输与数据压缩上报',
      'CN 命令集全量 —— 仅实现 implementedCn 所列 10 条',
      '2025 修订版新增字段（RF 补传标志 / NewSK / SKCreateTime / CalibrationType / SampleType）',
    ],
    note: '以上为如实声明。本平台实现的是覆盖"采数—状态—心跳—应答"闭环的标准子集，'
      + '并非 HJ 212-2017 全量命令集。',
  });
}));

/** 协议实现合规自检（三重锚定：名录校验值 / 双实现互证 / 长度语义） */
router.get('/conformance', wrap(async (req, res) => {
  ok(res, H.conformance());
}));

/* ---------------- 写：准入治理 ---------------- */

/**
 * 变更设备授权状态。
 * body: { status: 'ACTIVE' | 'PENDING' | 'REVOKED', note?: string }
 */
router.post('/devices/:did/auth', authRequired, requireRole('REGULATOR', 'ADMIN'), wrap(async (req, res) => {
  const did = decodeURIComponent(req.params.did);
  const body = req.body || {};
  const status = String(body.status || '').toUpperCase();
  if (!['ACTIVE', 'PENDING', 'REVOKED'].includes(status)) {
    return fail(res, 'status 必须是 ACTIVE / PENDING / REVOKED 之一', 400);
  }
  const dev = await registry.byDid(did);
  if (!dev) return fail(res, `设备 ${did} 不存在`, 404);

  const r = await registry.setAuth(did, status, body.note || null);
  await writeLog(req, '设备接入', '变更设备授权状态', dev.mn || did,
    `授权状态 ${dev.auth_status} → ${status}${body.note ? `；备注：${body.note}` : ''}`);
  ok(res, { ...r, mn: dev.mn, monitorNo: dev.monitor_no, previous: dev.auth_status },
    `设备 ${dev.mn || did} 授权状态已由 ${dev.auth_status} 变更为 ${status}`);
}));

/**
 * 绑定设备归属主体（企业 + 排口）。
 * body: { entId: number, monitorNo?: string, replace?: boolean, note?: string }
 *
 * 授权与归属是两步：调用本接口前设备应已 ACTIVE；
 * 未绑定主体的设备，其读数会被拒绝入库（应答码 QnRtn=7）。
 * 若目标排口已被其他设备占用，须显式 replace=true 走"设备更换"语义。
 */
router.post('/devices/:did/bind', authRequired, requireRole('REGULATOR', 'ADMIN'), wrap(async (req, res) => {
  const did = decodeURIComponent(req.params.did);
  const body = req.body || {};
  try {
    const r = await registry.bind(did, body.entId, body.monitorNo, {
      replace: !!body.replace, note: body.note,
    });
    await writeLog(req, '设备接入', '绑定设备归属主体', r.replaced ? r.replaced.mn : did,
      `绑定至 ${r.entName} · 排口 ${r.monitorNo}（${r.energyType}）`
      + (r.replaced ? `；接管替换原设备 ${r.replaced.mn}` : ''));
    ok(res, r,
      `设备已绑定至 ${r.entName} · ${r.monitorNo}（${r.energyType}），此后其上报数据方可入库`
      + (r.replaced ? `；原设备 ${r.replaced.mn} 已置为 REVOKED（设备更换留痕）` : ''));
  } catch (e) {
    fail(res, e.message, 400);
  }
}));

/**
 * 幂等触发表账自举（为所有企业排口登记设备档案）。
 */
router.post('/seed', authRequired, requireRole('ADMIN', 'REGULATOR'), wrap(async (req, res) => {
  const r = await registry.ensureSeeded();
  await writeLog(req, '设备接入', '设备台账自举', 'device_registry',
    `新增 ${r.created} 条，既有 ${r.existing} 条，合计 ${r.total} 条`);
  ok(res, r, `设备台账自举完成：新增 ${r.created} 条，合计 ${r.total} 条`
    + (r.created === 0 ? '（本次无新增，幂等）' : ''));
}));

module.exports = router;
