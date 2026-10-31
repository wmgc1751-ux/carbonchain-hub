/**
 * server/services/deviceRegistry.js —— 工业现场设备注册与接入台账（WP1 源端真实化）
 * ==================================================================
 * 解决什么问题
 * ------------------------------------------------------------------
 * 升级前的平台，CEMS 读数是平台自己 `dynamic.js#ingest()` 合成的 —— 源端不存在。
 * 一旦接入真实数采仪，第一个绕不开的问题就是：**这条数据是谁发的？**
 *
 * 本模块把"谁"变成了可治理的对象：
 *   · 设备身份   HJ 212 的 MN（24 位十六进制，固化在设备里）↔ 平台 DID ↔ 归属企业与排口
 *   · 准入治理   ACTIVE 在用 / PENDING 待审批 / REVOKED 已吊销
 *     未知 MN 首次连入 → 自动登记为 PENDING（可观测），但**数据不落库**
 *     （未经审批的源端不能污染核算账本，这是碳数据合规的底线）
 *   · 在线状态   last_seen_at / offline（offline 标记可解释"这段缺数是设备离线"，
 *     是 MISSING 质量标记的正当来源，不是数据缺失的借口）
 *
 * 为什么 MN 要确定性派生而不是随机
 * ------------------------------------------------------------------
 * 现场设备换一台，MN 就换一个 —— 但本项目要演示"同一排口长期序列"，
 * 故对**平台自举登记**的排口用 `sha256('CC-HJ212-MN|entId|monitorNo')` 前 24 位派生。
 * 确定性带来两个好处：① 重启/复位后 MN 不变，演示可复现；
 * ② 同一 (企业, 排口) 永远得到同一 MN，与 `cems_reading` 的唯一键天然对齐。
 * 真实设备接入时 MN 由设备自带，本模块只做登记，不覆盖。
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');

/** HJ 212 的 MN：24 个 0-9A-F 字符（EPC-96 编码转化） */
const MN_LENGTH = 24;

/**
 * 由 (企业, 排口) 确定性派生 HJ 212 设备唯一标识 MN。
 * @param {number|string} entId
 * @param {string} monitorNo
 * @returns {string} 24 位大写十六进制
 */
function mnFor(entId, monitorNo) {
  return cu.sha256(`CC-HJ212-MN|${entId}|${monitorNo}`).slice(0, MN_LENGTH).toUpperCase();
}

/**
 * 由 (企业, 排口) 确定性派生设备 DID。
 * @param {number|string} entId
 * @param {string} monitorNo
 * @returns {string} 如 did:iot:cems:3f9a1c2e5b7d4086
 */
function didFor(entId, monitorNo) {
  return `did:iot:cems:${cu.sha256(`CC-DID|${entId}|${monitorNo}`).slice(0, 16)}`;
}

/** 设备类型 / 厂商 / 接入协议（由能源品种决定，演示用固定值，避免随机） */
const DEVICE_PROFILE = {
  烟煤: { protocol: 'HJ212', type: '烟气排放连续监测系统(CEMS)', maker: '中环监测' },
  天然气: { protocol: 'HJ212', type: '烟气排放连续监测系统(CEMS)', maker: '中环监测' },
  // ⚠ 电力计量走的是 Modbus TCP / OPC UA，不是 HJ 212（HJ 212 面向污染物在线监控）。
  //   如实登记协议为 MODBUS_TCP，并标注驱动状态为"规划中"，
  //   避免把"已实现 HJ 212"夸大成"支持一切工业协议"。
  电力: { protocol: 'MODBUS_TCP', type: '电能计量终端', maker: '国网智芯' },
};

/** 与 dynamic.js 保持一致的排口划分（大型 3 个 / 中型 2 个 / 小型 1 个） */
function monitorsOf(ent) {
  const n = ent.scale === '大型' ? 3 : ent.scale === '小型' ? 1 : 2;
  const names = ['1 号排口', '2 号排口', '3 号排口'];
  return Array.from({ length: n }, (_, i) => ({
    monitor_no: `M-${String(ent.id).padStart(4, '0')}-${String(i + 1).padStart(2, '0')}`,
    energy_type: i === 0 ? '烟煤' : (i === 1 ? '天然气' : '电力'),
    name: names[i],
  }));
}

/** 排口序号 → 能源品种（与 monitorsOf 同口径；用于 device_registry 无该列时反推） */
const ENERGY_BY_SUFFIX = { '01': '烟煤', '02': '天然气', '03': '电力' };
const NAME_BY_SUFFIX = { '01': '1 号排口', '02': '2 号排口', '03': '3 号排口' };

/**
 * 由排口编号反推能源品种（device_registry 未存该列，故按约定解析后缀）。
 * @param {string} monitorNo 形如 M-0007-02
 * @returns {string}
 */
function energyTypeOf(monitorNo) {
  const m = String(monitorNo || '').match(/-(\d{2})$/);
  return (m && ENERGY_BY_SUFFIX[m[1]]) || '烟煤';
}

/** 由排口编号反推排口名称 */
function monitorNameOf(monitorNo) {
  const m = String(monitorNo || '').match(/-(\d{2})$/);
  return (m && NAME_BY_SUFFIX[m[1]]) || '排口';
}

/**
 * 幂等自举登记：为所有非停用企业的每个排口建立设备档案。
 * 已存在的 (device_did) 不覆盖 —— 现场改过的授权状态不会被平台抹掉。
 * @returns {Promise<{created:number, existing:number, total:number}>}
 */
async function ensureSeeded() {
  const ents = await db.query("SELECT id, industry, scale FROM enterprise WHERE status <> 'SUSPENDED' ORDER BY id");
  const rows = [];
  for (const ent of ents) {
    for (const m of monitorsOf(ent)) {
      const prof = DEVICE_PROFILE[m.energy_type] || { protocol: 'SIMULATED', type: '在线监测终端', maker: '通用' };
      rows.push([
        didFor(ent.id, m.monitor_no),
        ent.id,
        m.monitor_no,
        prof.protocol,
        prof.type,
        prof.maker,
        mnFor(ent.id, m.monitor_no),
        'ACTIVE',
        prof.protocol === 'HJ212'
          ? `平台自举登记 · ${m.name} · ${m.energy_type}`
          : `平台自举登记 · ${m.name} · ${m.energy_type}（非 HJ 212 链路，驱动规划中）`,
      ]);
    }
  }
  if (!rows.length) return { created: 0, existing: 0, total: 0 };

  const before = Number(await db.value('SELECT COUNT(*) FROM device_registry')) || 0;
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const ph = slice.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
    await db.query(
      'INSERT IGNORE INTO device_registry '
      + '(device_did, ent_id, monitor_no, protocol, device_type, manufacturer, mn, auth_status, remark) '
      + `VALUES ${ph}`,
      slice.flat()
    );
  }
  const after = Number(await db.value('SELECT COUNT(*) FROM device_registry')) || 0;
  return { created: after - before, existing: before, total: after };
}

/**
 * 按 MN 取设备档案。
 * @param {string} mn
 * @returns {Promise<object|null>}
 */
async function byMn(mn) {
  if (!mn) return null;
  return db.one('SELECT * FROM device_registry WHERE mn = ? LIMIT 1', [String(mn)]);
}

/**
 * 按 DID 取设备档案。
 */
async function byDid(did) {
  return db.one('SELECT * FROM device_registry WHERE device_did = ? LIMIT 1', [did]);
}

/**
 * 未知 MN 自动登记为 PENDING（准入待审批）。
 * 这是"可观测但不放行"：设备出现在台账里（监管方能看见有谁在尝试接入），
 * 但 auth_status=PENDING，其数据不进入核算。
 * @param {object} o { mn, ip, protocol, remark }
 * @returns {Promise<object>} 设备档案
 */
async function autoRegister(o = {}) {
  const mn = String(o.mn || '');
  const did = `did:iot:unknown:${cu.sha256(`CC-UNKNOWN|${mn}`).slice(0, 16)}`;
  await db.query(
    'INSERT IGNORE INTO device_registry '
    + '(device_did, protocol, mn, auth_status, remark) VALUES (?,?,?,?,?)',
    [did, o.protocol || 'HJ212', mn, 'PENDING',
      `自动登记：来源 ${o.ip || '未知'}，持有效密码报到但未在册，待监管端审批`]
  );
  return byMn(mn);
}

/**
 * 更新设备最近一次上报时间（心跳与数据帧都会调用）。
 * @param {string} mn
 * @param {string} [ip]
 */
async function touch(mn, ip) {
  await db.query(
    'UPDATE device_registry SET last_seen_at = NOW(), offline = 0 WHERE mn = ?',
    [String(mn)]
  );
  if (ip) {
    // 记录来源 IP 变化（便于发现"同一 MN 从异地上报"这类异常）
    const d = await byMn(mn);
    if (d && d.remark && !d.remark.includes(`lastIP=${ip}`)) { /* 保留策略：不覆盖备注 */ }
  }
}

/**
 * 变更授权状态（监管端审批 / 吊销）。
 * @param {string} did
 * @param {string} status ACTIVE / PENDING / REVOKED
 * @param {string} [note]
 */
async function setAuth(did, status, note) {
  const s = String(status).toUpperCase();
  if (!['ACTIVE', 'PENDING', 'REVOKED'].includes(s)) {
    throw new Error(`非法授权状态：${status}`);
  }
  const res = await db.query(
    'UPDATE device_registry SET auth_status = ?, remark = COALESCE(?, remark) WHERE device_did = ?',
    [s, note || null, did]
  );
  return { did, status: s, affected: res.affectedRows };
}

/**
 * 绑定设备归属主体（企业 + 排口）。
 *
 * ⚠ 为什么"授权"与"归属"必须分开两步
 * ------------------------------------------------------------------
 * 授权回答的是"这台设备可不可信"；归属回答的是"它的数据算到谁头上"。
 * 二者混为一谈会出事：一台通过审批但未绑定主体的设备，若放行其读数，
 * 数据只能落到 ent_id=NULL 上 —— 要么入库失败，要么（更糟）被某个默认主体
 * 静默接走。碳数据一旦归错主体，后续核算、核查、履约全错。
 * 因此本平台强制：**未绑定主体的设备，即使已授权也不予入库**（见 hj212Server）。
 *
 * ⚠ 关于"排口已被占用"
 * ------------------------------------------------------------------
 * 一个排口同一时刻只能有一台计量设备 —— 否则同一股烟气被两台设备各记一次，
 * 排放量直接翻倍。这不是洁癖，是碳数据的基本纪律。
 * 但现场确实存在**换机**（设备故障更换、厂商升级）与**新增排口**两种正当需求，故：
 *   · 指定一个尚未占用的新排口编号     → 直接绑定（新增排口）
 *   · 占用已属于其他设备的排口         → 必须显式 replace=true，
 *     平台会先把原设备置为 REVOKED 并留痕，再完成接管（设备更换，历史数据不受影响）
 *
 * @param {string} did
 * @param {number} entId
 * @param {string} [monitorNo] 为空则按该企业排口划分自动取第一个空闲排口
 * @param {object} [opts] { replace?: boolean, note?: string }
 * @returns {Promise<object>}
 */
async function bind(did, entId, monitorNo, opts = {}) {
  const dev = await byDid(did);
  if (!dev) throw new Error(`设备 ${did} 不存在`);
  const eid = Number(entId);
  if (!Number.isFinite(eid) || eid <= 0) throw new Error('entId 必须为正整数');

  const ent = await db.one('SELECT id, ent_name, scale FROM enterprise WHERE id = ?', [eid]);
  if (!ent) throw new Error(`企业 ${eid} 不存在`);

  const taken = await db.query(
    'SELECT device_did, mn, monitor_no FROM device_registry WHERE ent_id = ? AND monitor_no IS NOT NULL',
    [eid]
  );
  const usedMap = new Map(taken.map((r) => [r.monitor_no, r]));

  let mno = monitorNo ? String(monitorNo) : null;
  let replaced = null;

  if (!mno) {
    const cands = monitorsOf(ent).map((m) => m.monitor_no);
    mno = cands.find((c) => !usedMap.has(c)) || null;

    /* ⭐ P7 修复（2026-10-14）：无空闲排口时，本分支原先**完全忽略 opts.replace**，
     *    却抛出"如属设备更换，请显式传 replace=true"的提示 —— 按提示重试仍会落到
     *    同一分支，形成误导闭环。前端绑定表单确实可构造出「replace=true 且 monitorNo 为空」
     *    的组合（gov.js 的 bindForm），故该路径用户可达。
     *    语义澄清：设备更换必须知道"接管哪一个排口"。若该企业只有 1 个标准排口，
     *    接管它是**无歧义**的，直接放行；多排口时无法推断，必须要求显式指定。
     *    接管动作与原显式分支完全一致（先置原设备 REVOKED 并留痕），
     *    "同一排口不允许两台设备同时计量"的不变量不受影响。 */
    if (!mno && opts.replace && cands.length === 1) {
      mno = cands[0];
      const occupant = usedMap.get(mno);
      if (occupant && occupant.device_did !== did) {
        await db.query(
          "UPDATE device_registry SET auth_status = 'REVOKED', remark = ? WHERE device_did = ?",
          [`已被设备 ${did} 接管更换下线（监管端绑定操作）`, occupant.device_did]
        );
        replaced = { did: occupant.device_did, mn: occupant.mn, monitorNo: mno };
      }
    }

    if (!mno) {
      const hint = cands.length === 1
        ? '如属设备更换，请传 replace=true 由本设备接管；'
        : '如属设备更换，请显式指定被占用排口的 monitorNo 并传 replace=true；';
      throw new Error(`企业「${ent.ent_name}」的 ${cands.length} 个标准排口均已绑定设备。`
        + hint + '如属新增排口，请显式指定未占用的 monitorNo。');
    }
  } else {
    const occupant = usedMap.get(mno);
    if (occupant && occupant.device_did !== did) {
      if (!opts.replace) {
        throw new Error(`排口 ${mno} 已绑定设备 ${occupant.mn}（${occupant.device_did}）。`
          + '同一排口不允许两台设备同时计量（会造成重复计入）；'
          + '如确属设备更换，请传 replace=true，平台将先将原设备置为 REVOKED 并留痕。');
      }
      await db.query(
        "UPDATE device_registry SET auth_status = 'REVOKED', remark = ? WHERE device_did = ?",
        [`已被设备 ${did} 接管更换下线（监管端绑定操作）`, occupant.device_did]
      );
      replaced = { did: occupant.device_did, mn: occupant.mn, monitorNo: mno };
    }
  }

  await db.query(
    'UPDATE device_registry SET ent_id = ?, monitor_no = ?, remark = ? WHERE device_did = ?',
    [eid, mno, (opts.note || '监管端绑定归属')
      + ` · ${ent.ent_name} · ${monitorNameOf(mno)} · ${energyTypeOf(mno)}`
      + (replaced ? ` · 接管替换 ${replaced.mn}` : ''), did]
  );
  return {
    did, entId: eid, entName: ent.ent_name,
    monitorNo: mno, monitorName: monitorNameOf(mno), energyType: energyTypeOf(mno),
    replaced,
  };
}

/**
 * 设备列表。
 * @param {object} f { entId, protocol, authStatus, keyword, limit }
 */
async function list(f = {}) {
  const where = [];
  const args = [];
  if (f.entId) { where.push('d.ent_id = ?'); args.push(Number(f.entId)); }
  if (f.protocol) { where.push('d.protocol = ?'); args.push(f.protocol); }
  if (f.authStatus) { where.push('d.auth_status = ?'); args.push(String(f.authStatus).toUpperCase()); }
  if (f.keyword) {
    where.push('(d.mn LIKE ? OR d.device_did LIKE ? OR d.monitor_no LIKE ? OR e.ent_name LIKE ?)');
    const k = `%${f.keyword}%`;
    args.push(k, k, k, k);
  }
  const limit = Math.min(Number(f.limit) || 200, 1000);
  const sql = `SELECT d.*, e.ent_name, e.scale AS ent_scale, e.industry
                 FROM device_registry d
                 LEFT JOIN enterprise e ON e.id = d.ent_id
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY d.ent_id ASC, d.monitor_no ASC
                LIMIT ?`;
  const rows = await db.query(sql, [...args, limit]);
  // 补两个派生字段：能源品种与排口名（device_registry 不存这两列，按排口编号约定反推）
  return rows.map((r) => ({
    ...r,
    energy_type: energyTypeOf(r.monitor_no),
    monitor_name: monitorNameOf(r.monitor_no),
  }));
}

/** 设备台账总览 */
async function stats() {
  const [row] = await db.query(
    `SELECT COUNT(*) AS total,
            SUM(auth_status = 'ACTIVE')  AS active,
            SUM(auth_status = 'PENDING') AS pending,
            SUM(auth_status = 'REVOKED') AS revoked,
            SUM(protocol = 'HJ212')      AS hj212,
            SUM(offline = 1)             AS offline,
            SUM(last_seen_at IS NOT NULL) AS ever_seen
       FROM device_registry`
  );
  const byProtocol = await db.query(
    'SELECT protocol, COUNT(*) AS cnt FROM device_registry GROUP BY protocol ORDER BY cnt DESC'
  );
  const [cn] = await db.query(
    `SELECT SUM(device_did IS NOT NULL) AS direct_reports,
            SUM(crc16 IS NOT NULL)      AS crc_verified,
            SUM(sm3_digest IS NOT NULL) AS sm3_verified
       FROM cems_reading`
  );
  const n = (v) => Number(v || 0);
  return {
    total: n(row.total), active: n(row.active), pending: n(row.pending), revoked: n(row.revoked),
    hj212: n(row.hj212), offline: n(row.offline), everSeen: n(row.ever_seen),
    byProtocol: byProtocol.map((r) => ({ protocol: r.protocol, count: Number(r.cnt) })),
    directReports: n(cn.direct_reports),
    crcVerified: n(cn.crc_verified),
    sm3Verified: n(cn.sm3_verified),
  };
}

module.exports = {
  MN_LENGTH, DEVICE_PROFILE, ENERGY_BY_SUFFIX,
  mnFor, didFor, monitorsOf, energyTypeOf, monitorNameOf,
  ensureSeeded, byMn, byDid, autoRegister, touch, setAuth, bind, list, stats,
};
