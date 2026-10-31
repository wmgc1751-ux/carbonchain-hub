/**
 * server/services/deviceVerify.js —— 设备签名验签中间件（CEN-100 配套）
 * ==================================================================
 * 安装：`cp hardware/platform-patch/02-deviceVerify.js server/services/deviceVerify.js`
 *
 * 它在 platform-patch/01-schema.sql 之后、hj212Server.js 的 ④ 与 ⑤ 之间
 * 插入一道校验，把平台现有的信任链从「写入后不可篡改」推进到
 * 「离开探头那一刻起就不可抵赖」。
 *
 * 兼容性（重要）
 * ------------------------------------------------------------------
 * 对**无签名字段**的设备保持现有行为：照常落库，仅标记 UNSIGNED。
 * 存量自举设备、第三方数采仪完全不受影响。
 * 新能力是增强，不是替换 —— 这是能放心上生产的前提。
 */
'use strict';

const db = require('../db');
const bridge = require('./sm2DeviceBridge');

/** 应答码：8/9 为本项目自定义（**非 HJ 212-2017 标准码**，如实声明） */
const QNRTN = {
  OK: 1, FAIL: 2, BAD_FRAME: 3, BAD_PW: 4,
  NOT_AUTH: 5, CRC_ERR: 6, NO_OWNER: 7,
  SIG_FAIL: 8,   /* 验签失败：数据可能被篡改，或设备身份与公钥不匹配 */
  REPLAY: 9,     /* 序号回退/重复：疑似重放 */
};

/** 计数器（进程内；重启清零，明细以 device_verify_log 为准） */
const stats = {
  passStd: 0, passNoZa: 0, sigFail: 0, replay: 0, seqGap: 0, unsigned: 0, total: 0,
};

function bump(k) { stats[k] = (stats[k] || 0) + 1; stats.total++; }

/**
 * 从 CP 扩展字段里取出设备签名相关信息。
 * @returns {{sigRaw:string|null, seq:number|null, challenge:string|null,
 *            gdev:number|null, secStat:string|null}}
 */
function extractSigFields(cpParsed) {
  const ex = (cpParsed && cpParsed.extras) || {};
  const seqRaw = ex.DevSeq;
  return {
    sigRaw:    ex.SM2Sig || null,
    seq:       seqRaw === undefined || seqRaw === '' ? null : Number(seqRaw),
    challenge: ex.Challenge || null,
    gdev:      ex.Gdev === undefined || ex.Gdev === '' ? null : Number(ex.Gdev),
    secStat:   ex.SecStat || null,
    devTs:     ex.DevTs || null,
    fwVer:     ex.FwVer || null,
  };
}

/**
 * 由报文重建规范化读数串（必须与设备端 cc_canon_build 逐字符一致）。
 * 因子取 CP 中的 Rtd 值；缺失时补 0，交由后续"缺数"逻辑处理 ——
 * **绝不在此处插值或猜测**。
 */
function canonFromFrame(f, sig) {
  const p = (f.cpParsed && f.cpParsed.pollutants) || {};
  const rtd = (code) => {
    const v = p[code] && p[code].Rtd;
    return v === undefined || v === null || v === '' ? 0 : Number(v);
  };
  return bridge.buildCanon({
    mn: f.mn,
    qn: f.qn,
    dataTime: (f.cpParsed && f.cpParsed.dataTime) || '',
    devSeq: sig.seq == null ? 0 : sig.seq,
    challenge: sig.challenge || '',
    factors: {
      a05001: rtd('a05001'), a01011: rtd('a01011'), a01012: rtd('a01012'),
      a01013: rtd('a01013'), a01014: rtd('a01014'), a19001: rtd('a19001'),
      a01016: rtd('a01016'),
    },
    gdev: sig.gdev == null ? 0 : sig.gdev,
  });
}

async function logEvent(mn, did, seq, outcome, mode, cn, ip, detail) {
  try {
    await db.query(
      'INSERT INTO device_verify_log (mn, device_did, seq, outcome, mode, cn, ip, detail) VALUES (?,?,?,?,?,?,?,?)',
      [mn, did || null, seq || null, outcome, mode || null, cn || null, ip || null,
        detail ? String(detail).slice(0, 512) : null]
    );
  } catch (e) { /* 日志失败不应阻断主流程 */ }
}

/**
 * 验签入口。
 *
 * @param {object} f          hj212 decode 出来的帧
 * @param {object} dev        device_registry 行（须含 dev_pubkey / dev_last_seq / dev_sm2_id）
 * @param {object} ctx        { ip }
 * @returns {Promise<{ok:boolean, qnRtn:number|null, mode:string, sig:object, canon:string|null}>}
 *          qnRtn 为 null 表示"无需验签"（设备未登记公钥），按 UNSIGNED 放行。
 */
async function verifyFrame(f, dev, ctx = {}) {
  const sig = extractSigFields(f.cpParsed);

  /* ① 设备未登记公钥 → 无法验签，按 UNSIGNED 放行（不阻断存量设备） */
  if (!dev || !dev.dev_pubkey) {
    bump('unsigned');
    await logEvent(f.mn, dev && dev.device_did, sig.seq, 'UNSIGNED', null, f.cn, ctx.ip,
      '设备未登记 SM2 公钥，按未签名处理');
    return { ok: true, qnRtn: null, mode: 'UNSIGNED', sig, canon: null };
  }

  /* ② 有公钥却没带签名 → 记为 UNSIGNED，但**记事件**，便于发现"设备被降级" */
  if (!sig.sigRaw) {
    bump('unsigned');
    await logEvent(f.mn, dev.device_did, sig.seq, 'UNSIGNED', null, f.cn, ctx.ip,
      '设备已登记公钥但报文无签名字段');
    return { ok: true, qnRtn: null, mode: 'UNSIGNED', sig, canon: null };
  }

  /* ③ 序号防重放：必须严格单调递增 */
  const last = Number(dev.dev_last_seq || 0);
  if (sig.seq != null) {
    if (sig.seq <= last) {
      bump('replay');
      await logEvent(f.mn, dev.device_did, sig.seq, 'REPLAY', null, f.cn, ctx.ip,
        `序号回退：收到 ${sig.seq}，已确认最大 ${last}`);
      return { ok: false, qnRtn: QNRTN.REPLAY, mode: null, sig, canon: null };
    }
    if (last > 0 && sig.seq > last + 1) {
      /* 跳跃：不拒收（可能是断网补报），但必须留痕 */
      bump('seqGap');
      await logEvent(f.mn, dev.device_did, sig.seq, 'SEQ_GAP', null, f.cn, ctx.ip,
        `序号跳跃：由 ${last} 跳到 ${sig.seq}，缺口 ${sig.seq - last - 1} 条`);
    }
  }

  /* ④ 验签 */
  const canon = canonFromFrame(f, sig);
  const res = bridge.verifyDevice(dev.dev_pubkey, canon, sig.sigRaw,
    { id: dev.dev_sm2_id || bridge.DEFAULT_ID });

  if (!res.ok) {
    bump('sigFail');
    await logEvent(f.mn, dev.device_did, sig.seq, 'SIG_FAIL', null, f.cn, ctx.ip,
      `验签失败：${res.reason || 'SIG_MISMATCH'}；CANON=${canon}`);
    return { ok: false, qnRtn: QNRTN.SIG_FAIL, mode: null, sig, canon };
  }

  /* ⑤ 通过：推进序号 */
  if (res.mode === 'STD') bump('passStd'); else bump('passNoZa');
  await db.query(
    'UPDATE device_registry SET dev_last_seq = ?, dev_sig_mode = ? WHERE device_did = ?',
    [sig.seq == null ? last : sig.seq, res.mode, dev.device_did]
  );
  await logEvent(f.mn, dev.device_did, sig.seq,
    res.mode === 'STD' ? 'PASS_STD' : 'PASS_NO_ZA', res.mode, f.cn, ctx.ip,
    res.mode === 'NO_ZA' ? '设备签名不符合 GM/T 0003.2（不含 ZA），应限期整改' : null);

  return { ok: true, qnRtn: null, mode: res.mode, sig, canon };
}

/**
 * 端云双算互证：比对现役 CEMS 数采仪值与 CEN-100 独立采样值。
 *
 * @param {object} o { entId, monitorNo, readingTime, valueCems, valueEdge, thresholdPct }
 * @returns {Promise<{relDiff:number|null, alarmed:boolean, reason?:string}>}
 */
async function crossCheck(o = {}) {
  const a = Number(o.valueCems);
  const b = Number(o.valueEdge);
  const thr = Number(o.thresholdPct == null ? 5 : o.thresholdPct) / 100;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
    return { relDiff: null, alarmed: false, reason: 'INSUFFICIENT_DATA' };
  }
  const relDiff = Math.abs(a - b) / Math.abs(b);
  const alarmed = relDiff > thr;
  try {
    await db.query(
      'INSERT INTO source_crosscheck '
      + '(ent_id, monitor_no, reading_time, value_cems, value_edge, rel_diff, threshold_pct, alarmed) '
      + 'VALUES (?,?,?,?,?,?,?,?)',
      [o.entId, o.monitorNo, o.readingTime, a, b,
        Number(relDiff.toFixed(6)), Number(o.thresholdPct == null ? 5 : o.thresholdPct), alarmed ? 1 : 0]
    );
  } catch (e) { /* 记录失败不阻断 */ }
  return { relDiff, alarmed };
}

module.exports = {
  QNRTN, stats,
  extractSigFields, canonFromFrame, verifyFrame, crossCheck, logEvent,
};
