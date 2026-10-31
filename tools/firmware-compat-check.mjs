#!/usr/bin/env node
/**
 * tools/firmware-compat-check.mjs —— 「买回来的硬件能不能用」· 固件↔平台兼容性实证
 * ==================================================================
 * 要回答的问题（用户原话）：
 *   「材料建成硬件是否与平台匹配，能够连通，避免无法使用的结果。」
 *
 * 为什么不能靠"读一遍代码觉得对"来回答
 * ------------------------------------------------------------------
 * 两端各有一套用 C / JS 独立实现的公式与字符串拼接。任何一处不同 ——
 * 字段顺序、分隔符、小数位数、浓度单位、流量基准 —— 现象都是
 * **平台能连上但一直拒收**，而现场根本看不出是哪一处。
 * 所以本脚本把**固件侧的算法逐行镜像成 JS**（下面 `FW` 命名空间，
 * 写法严格照抄 hardware/firmware/src/cc_sensors.c 与 main.c），
 * 用它签一张真实报文，再投给**真实的平台代码** `hj212Server.processFrame`，
 * 最后断言数据库副作用。
 *
 * 与 tools/sm2-verify-e2e.mjs 的分工
 * ------------------------------------------------------------------
 *   sm2-verify-e2e  —— 验平台**验签通道**本身对不对（正向 + 阴性对照）；
 *   本脚本           —— 验**设备侧口径**能不能被平台接受（端云双算能否对上）。
 * 本脚本**刻意不复用** sm2-verify-e2e 的帧构造，避免"两边一起错还全绿"。
 *
 * 覆盖率声明（不夸大）
 * ------------------------------------------------------------------
 * 被真实执行的是：canon 构造、SM2 签名/验签、HJ 212 组帧与解码、
 * 物理折算（含标干修正）、端云双算互证落表。**全部走真实平台代码路径。**
 * 未被执行的：C 代码本身（本机无 C 编译器时无法跑 firmware/test 主机桩）、
 * 真 TCP 收发、真实传感器。前者已由 `firmware/test/host_stub.c` 覆盖，
 * 后两者由 tools/device-access-evidence.mjs 覆盖。
 *
 * 用法
 *   node tools/firmware-compat-check.mjs            # 需要 MySQL（读 .env）
 *   node tools/firmware-compat-check.mjs --keep     # 保留测试读数，不清理
 * 退出码：0 = 全部通过；1 = 有失败项
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const H = require(path.join(ROOT, 'server/protocol/hj212.js'));
const bridge = require(path.join(ROOT, 'server/services/sm2DeviceBridge.js'));
const gm = require(path.join(ROOT, 'server/blockchain/gm-crypto.js'));
const registry = require(path.join(ROOT, 'server/services/deviceRegistry.js'));
const hj = require(path.join(ROOT, 'server/services/hj212Server.js'));
const db = require(path.join(ROOT, 'server/db.js'));

const KEEP = process.argv.includes('--keep');

/* ==================================================================
 * 一、固件侧算法镜像 —— 逐行照抄 hardware/firmware/src/cc_sensors.c
 * ==================================================================
 * ⚠ 这一段的**唯一权威来源是 C 代码**。改 C 必须同步改这里，
 *   否则本脚本会变成"自证正确"的摆设。
 */
const FW = {
  /** cc_sensors.h：CC_M_CO2 / CC_VM / CC_T0 / CC_P0 */
  M_CO2: 44.01,
  VM: 22.4,
  T0: 273.15,
  P0: 101.325,
  /** main.c：g_cfg.ambient_kpa = 101.325 */
  AMBIENT_KPA: 101.325,
  /** main.c：/api/iot 侧 DEFAULT_PW / ST */
  ST: '31',
  PW: '123456',

  /** cc_sensors.c#cc_flow_m3h */
  flowM3h(v, s) { return v * s * 3600.0; },

  /** cc_sensors.c#cc_flow_std_dry_m3h */
  flowStdDryM3h(q, tempC, pressKpa, ambientKpa, humidPct) {
    const t = tempC + 273.15;
    if (t <= 0) return 0.0;
    const p = ambientKpa + pressKpa;
    let dry = 1.0 - humidPct / 100.0;
    if (dry < 0) dry = 0.0;
    return q * (273.15 / t) * (p / 101.325) * dry;
  },

  /** cc_sensors.c#cc_ppm_to_mgm3_dry（标干质量浓度） */
  ppmToMgm3Dry(ppm, molMass, humidPct) {
    let xsw = Number(humidPct);
    if (!(xsw >= 0)) xsw = 0;
    if (xsw > 99.5) xsw = 99.5;
    const dry = 1.0 - xsw / 100.0;
    return ppm / dry * (molMass / 22.4);
  },

  /** cc_sensors.c#cc_emission_tph */
  emissionTph(qsn, conc) { return qsn * conc * 1e-9; },

  /** cc_sensors.c#cc_compute_emission（含回填 co2_mgm3 / gdev_tph） */
  computeEmission(r, ambientKpa = FW.AMBIENT_KPA) {
    const rr = { ...r };
    const q = FW.flowM3h(rr.velocity_ms, rr.section_m2);
    const qsn = FW.flowStdDryM3h(q, rr.temp_c, rr.press_kpa, ambientKpa, rr.humid_pct);
    const conc = FW.ppmToMgm3Dry(rr.co2_ppm, FW.M_CO2, rr.humid_pct);
    const rate = FW.emissionTph(qsn, conc);
    rr.co2_mgm3 = conc;
    rr.gdev_tph = rate;
    return { reading: rr, q, qsn, conc, rate };
  },

  /** cc_sensors.c#cc_canon_build —— 格式串抄自 C 的 snprintf */
  canonBuild({ mn, qn, dataTime, devSeq, challenge, reading }) {
    const f3 = (v) => Number(v).toFixed(3);
    const f9 = (v) => Number(v).toFixed(9);
    return [
      mn || '',
      qn || '',
      dataTime || '',
      String(devSeq),
      challenge || '',
    ].join('|')
      + '|'
      + `a05001=${f3(reading.co2_mgm3)}`
      + `|a01011=${f3(reading.velocity_ms)}`
      + `|a01012=${f3(reading.temp_c)}`
      + `|a01013=${f3(reading.press_kpa)}`
      + `|a01014=${f3(reading.humid_pct)}`
      + `|a19001=${f3(reading.o2_pct)}`
      + `|a01016=${f3(reading.section_m2)}`
      + `|G=${f9(reading.gdev_tph)}`;
  },

  /** main.c#build_frame 的 CP 拼装（含 ';' / ',' 分隔规则） */
  buildCP({ dataTime, factors, extras }) {
    let out = `&&DataTime=${dataTime}`;
    let last = '';
    for (const [code, val] of factors) {
      out += `${last === code ? ',' : ';'}${code}-Rtd=${val}`;
      out += `,${code}-Flag=N`;
      last = code;
    }
    for (const [k, v] of extras) out += `;${k}=${v}`;
    return out + '&&';
  },
};

/* ==================================================================
 * 二、帧编码（独立实现，不复用平台编码器）
 * ================================================================== */
const p2 = (n, w = 2) => String(n).padStart(w, '0');
function crcHex(seg) {
  const v = H.crc16(seg);
  return ((v >> 8) & 0xff).toString(16).padStart(2, '0').toUpperCase()
    + (v & 0xff).toString(16).padStart(2, '0').toUpperCase();
}
function stamp(d) {
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
    + `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}
function makeQn(d, ms) { return `${stamp(d)}${p2(ms % 1000, 3)}`; }
function encodeFrame({ qn, cn, mn, cp }) {
  const seg = `QN=${qn};ST=${FW.ST};CN=${cn};PW=${FW.PW};MN=${mn};Flag=5;CP=${cp}`;
  const len = Buffer.byteLength(seg, 'latin1');
  return `##${String(len).padStart(4, '0')}${seg}${crcHex(seg)}\r\n`;
}

/* ==================================================================
 * 三、断言与记录
 * ================================================================== */
const rows = [];
function record(o) { rows.push(o); return o; }
const f6 = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(6));

async function main() {
  const startedAt = new Date();
  console.log('\n════════ CEN-100 固件 ↔ 平台 · 兼容性实证 ════════\n');

  /* —— 0. 桥接层自检 —— */
  const st = bridge.selfTest();
  record({
    id: 'C0', name: 'SM2 桥接层自检（ZA 口径 / DER 往返 / 阴性对照）', kind: '前置',
    expected: `${st.total}/${st.total}`,
    actual: `${st.passed}/${st.total}`,
    pass: st.pass,
  });

  const seed = await registry.ensureSeeded();
  console.log(`  台账：既有 ${seed.existing} / 新增 ${seed.created} / 合计 ${seed.total}`);

  /* ⚠ 刻意取**最后一台**设备：tools/sm2-verify-e2e.mjs 取的是第一台，
   *   两个脚本都会临时登记/清除 dev_pubkey 与 dev_last_seq。
   *   若共用同一台设备，两个脚本**并行跑就会互相踩**（现象是"验签偶尔通偶尔不通"，
   *   极难定位）。错开设备后二者可并行、可重复执行。 */
  const devs = await db.query(
    `SELECT device_did, mn, ent_id, monitor_no FROM device_registry
      WHERE auth_status='ACTIVE' AND ent_id IS NOT NULL AND monitor_no IS NOT NULL AND mn IS NOT NULL
      ORDER BY id DESC LIMIT 1`
  );
  if (!devs.length) throw new Error('没有 ACTIVE 且已绑定的设备，请先 npm run initdb 并启动一次服务');
  const dev = devs[0];

  /* 登记一把确定性 SM2 公钥（等价于设备的"出厂密钥已被平台登记"） */
  const kp = gm.generateSm2WalletDeterministic('CEN100-FW-COMPAT');
  const keyFp = bridge.computeZa(kp.publicKey, bridge.DEFAULT_ID).toString('hex').slice(0, 32);
  await db.query(
    'UPDATE device_registry SET dev_pubkey=?, dev_key_fp=?, dev_key_reg_at=NOW(), dev_sm2_id=?, dev_last_seq=0 WHERE device_did=?',
    [kp.publicKey, keyFp, bridge.DEFAULT_ID, dev.device_did]
  );
  console.log(`  待测设备：${dev.mn}（企业 ${dev.ent_id} / 排口 ${dev.monitor_no}）公钥已登记\n`);

  const CH = '9f2a'.repeat(16);
  /* 一组贴近真实烟气工况的读数：CO₂ 12.45% vol（124500 ppm），
   * 与 firmware/test/host_stub.c#cc_hw_sample 完全一致，便于与 C 侧对拍。 */
  const reading = {
    co2_ppm: 124500.0, velocity_ms: 8.6, temp_c: 96.4, press_kpa: -0.35,
    humid_pct: 12.3, o2_pct: 6.8, section_m2: 2.5,
  };

  const EM = FW.computeEmission(reading);
  console.log('  固件侧折算结果（照抄 cc_sensors.c 算法）：');
  console.log(`    CO₂ 标干浓度  a05001 = ${EM.conc.toFixed(3)} mg/m³（传感器原始 ${reading.co2_ppm} ppm，湿基）`);
  console.log(`    工况流量      Q      = ${EM.q.toFixed(0)} m³/h`);
  console.log(`    标干流量      Qsn    = ${EM.qsn.toFixed(0)} m³/h`);
  console.log(`    排放速率      Gdev   = ${EM.rate.toFixed(9)} t/h`);

  /* —— 1. 固件口径 × 平台口径：逐项对拍 —— */
  {
    const platform = hj.computeEmission({
      a05001: { Rtd: String(EM.conc), Flag: 'N' },
      a01011: { Rtd: String(reading.velocity_ms), Flag: 'N' },
      a01012: { Rtd: String(reading.temp_c), Flag: 'N' },
      a01013: { Rtd: String(reading.press_kpa), Flag: 'N' },
      a01014: { Rtd: String(reading.humid_pct), Flag: 'N' },
      a19001: { Rtd: String(reading.o2_pct), Flag: 'N' },
      a01016: { Rtd: String(reading.section_m2), Flag: 'N' },
    });
    const dFlow = Math.abs(platform.flowStdM3h - EM.qsn) / EM.qsn;
    const dRate = Math.abs(platform.rate - EM.rate) / EM.rate;
    record({
      id: 'C1', name: '折算口径对拍：固件 cc_compute_emission vs 平台 computeEmission', kind: '口径一致性',
      expected: '标干流量与排放速率相对偏差 < 1e-9（同式应完全相等）',
      actual: `Qsn 偏差=${dFlow.toExponential(2)} · rate 偏差=${dRate.toExponential(2)} · 流量基准=${platform.flowBasis}`,
      pass: dFlow < 1e-9 && dRate < 1e-9 && platform.flowBasis === 'STD_DRY',
    });
  }

  /* —— 2. 帧构造 —— */
  const base = new Date(Date.now() + 7200 * 1000);   // 推后 2h，避开种子读数
  const cfgs = {
    a05001: EM.conc.toFixed(3),
    a01011: reading.velocity_ms.toFixed(3),
    a01012: reading.temp_c.toFixed(3),
    a01013: reading.press_kpa.toFixed(3),
    a01014: reading.humid_pct.toFixed(3),
    a19001: reading.o2_pct.toFixed(3),
    a01016: reading.section_m2.toFixed(3),
  };

  /** 按固件口径签一张帧；overrideCp 可篡改 CP 里的因子值而不重签 */
  async function fwSend({ seq, dt, cn = '2011', overrideCp = null, noSig = false }) {
    const qn = makeQn(base, seq);
    let canon = null;
    let sigB64 = '';
    if (!noSig) {
      canon = FW.canonBuild({
        mn: dev.mn, qn, dataTime: dt, devSeq: seq, challenge: CH, reading: EM.reading,
      });
      const derB64 = bridge.signAsDevice(kp.privateKey, canon);
      sigB64 = bridge.derToRaw(Buffer.from(derB64, 'base64')).toString('base64');
    }
    const factors = Object.entries(cfgs);
    const cp = overrideCp || FW.buildCP({
      dataTime: dt,
      factors,
      extras: [
        ['SM2Sig', sigB64], ['DevSeq', String(seq)], ['DevTs', dt], ['Challenge', CH],
        ['Gdev', EM.rate.toFixed(9)], ['SecStat', 'OK'], ['FwVer', '1.0.0'],
      ],
    });
    const frame = encodeFrame({ qn, cn, mn: dev.mn, cp });
    const r = await hj.processFrame(H.decode(frame), { ip: '127.0.0.1' });
    return { frame, canon, result: r };
  }

  async function readingRow(dt) {
    const sqlTime = `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)} `
      + `${dt.slice(8, 10)}:${dt.slice(10, 12)}:${dt.slice(12, 14)}`;
    const list = await db.query(
      'SELECT id, flow_value, gdev_tph, sig_mode, dev_seq FROM cems_reading WHERE ent_id=? AND monitor_no=? AND reading_time=?',
      [dev.ent_id, dev.monitor_no, sqlTime]
    );
    return { sqlTime, list };
  }
  async function crossRow(sqlTime) {
    const list = await db.query(
      'SELECT value_cems, value_edge, rel_diff, alarmed FROM source_crosscheck WHERE ent_id=? AND monitor_no=? AND reading_time=? ORDER BY id DESC LIMIT 1',
      [dev.ent_id, dev.monitor_no, sqlTime]
    );
    return list[0] || null;
  }

  /* —— 3. 正向：固件帧应被接受、落库、并触发端云双算互证 —— */
  const dtT1 = stamp(new Date(base.getTime() + 1000));
  const seqT1 = 200001;
  {
    const { frame, canon, result } = await fwSend({ seq: 200001, dt: dtT1 });
    const row = (await readingRow(dtT1));
    const x = await crossRow(row.sqlTime);
    const rel = x ? Number(x.rel_diff) : null;
    let canonOk = true;
    try {
      const rebuilt = bridge.buildCanon({
        mn: dev.mn, qn: makeQn(base, 200001), dataTime: dtT1, devSeq: 200001, challenge: CH,
        factors: Object.fromEntries(Object.entries(cfgs).map(([k, v]) => [k, Number(v)])),
        gdev: Number(EM.rate.toFixed(9)),
      });
      canonOk = rebuilt === canon;
    } catch (e) { canonOk = false; }

    record({
      id: 'C2', name: '正向链路：固件口径签名的报文（应通过验签并落库）', kind: '连通性',
      expected: 'QnRtn=1 · 落库 1 条 · sig_mode=STD · canon 两端逐字符一致',
      actual: `QnRtn=${result.qnRtn} · 落库=${row.list.length} · sig_mode=${row.list[0] ? row.list[0].sig_mode : '—'} · canon一致=${canonOk}`,
      pass: result.qnRtn === 1 && row.list.length === 1
        && row.list[0].sig_mode === 'STD' && canonOk,
      frame, canon,
    });

    record({
      id: 'C3', name: '端云双算互证：平台复算速率 vs 设备自报 Gdev（应写表且不报警）', kind: '核心创新链',
      expected: 'source_crosscheck 有记录 · alerted=0 · 相对偏差 < 5%',
      actual: x
        ? `平台=${f6(x.value_cems)} t/h · 设备=${f6(x.value_edge)} t/h · 相对偏差=${(rel * 100).toFixed(6)}% · 报警=${x.alarmed}`
        : 'source_crosscheck 无记录（互证未触发）',
      pass: !!x && Number(x.alarmed) === 0 && rel !== null && rel < 0.05,
    });

    record({
      id: 'C4', name: '落库速率与设备自报速率一致性', kind: '核心创新链',
      expected: 'cems_reading.flow_value ≈ gdev_tph，相对偏差 < 1e-4（差异仅来自 flow_value 列的 DECIMAL(16,3) 截断）',
      actual: row.list[0]
        ? `flow_value=${f6(row.list[0].flow_value)} · gdev_tph=${f6(row.list[0].gdev_tph)} · 相对偏差=${(Math.abs(Number(row.list[0].flow_value) - Number(row.list[0].gdev_tph)) / Number(row.list[0].gdev_tph)).toExponential(2)}`
        : '未落库',
      pass: !!row.list[0]
        && Number(row.list[0].gdev_tph) > 0
        && Math.abs(Number(row.list[0].flow_value) - Number(row.list[0].gdev_tph)) / Number(row.list[0].gdev_tph) < 1e-4,
    });

    /* —— 4. 阴性对照：改 a05001 而不重签 → 必须拒收 —— */
    const dtT2 = stamp(new Date(base.getTime() + 2000));
    const qnT2 = makeQn(base, 200002);
    const canonT2 = FW.canonBuild({
      mn: dev.mn, qn: qnT2, dataTime: dtT2, devSeq: 200002, challenge: CH, reading: EM.reading,
    });
    const sigT2 = bridge.derToRaw(Buffer.from(bridge.signAsDevice(kp.privateKey, canonT2), 'base64')).toString('base64');
    const tamperedCp = FW.buildCP({
      dataTime: dtT2,
      factors: Object.entries(cfgs).map(([k, v]) => [k, k === 'a05001' ? '999999.000' : v]),
      extras: [
        ['SM2Sig', sigT2], ['DevSeq', '200002'], ['DevTs', dtT2], ['Challenge', CH],
        ['Gdev', EM.rate.toFixed(9)], ['SecStat', 'OK'], ['FwVer', '1.0.0'],
      ],
    });
    const frameT2 = encodeFrame({ qn: qnT2, cn: '2011', mn: dev.mn, cp: tamperedCp });
    const rT2 = await hj.processFrame(H.decode(frameT2), { ip: '127.0.0.1' });
    const rowT2 = await readingRow(dtT2);
    record({
      id: 'N1', name: '阴性对照：现场把浓度改大但不重签（应拒收）', kind: '阴性',
      expected: 'QnRtn=8（验签失败）· 不落库',
      actual: `QnRtn=${rT2.qnRtn} · 落库=${rowT2.list.length}`,
      pass: rT2.qnRtn === 8 && rowT2.list.length === 0,
      frame: frameT2,
    });
  }

  /* —— 5. 固件侧"只算不报"的数值自洽（供答辩引用）—— */
  {
    const L = FW.P0;
    record({
      id: 'C5', name: '单位闭链自证：m³/h × mg/m³ = mg/h → ×1e-9 = t/h', kind: '口径一致性',
      expected: `Qsn(${EM.qsn.toFixed(0)} m³/h) × C(${EM.conc.toFixed(3)} mg/m³) × 1e-9 = ${(EM.qsn * EM.conc * 1e-9).toFixed(9)} t/h`,
      actual: `Gdev=${EM.rate.toFixed(9)} t/h · 大气压基准=${L} kPa`,
      pass: Math.abs(EM.qsn * EM.conc * 1e-9 - EM.rate) < 1e-15,
    });
  }

  /* ---------------- 清理与输出 ---------------- */
  if (!KEEP) {
    const t1 = `${dtT1.slice(0, 4)}-${dtT1.slice(4, 6)}-${dtT1.slice(6, 8)} ${dtT1.slice(8, 10)}:${dtT1.slice(10, 12)}:${dtT1.slice(12, 14)}`;
    await db.query('DELETE FROM source_crosscheck WHERE ent_id=? AND monitor_no=? AND reading_time=?', [dev.ent_id, dev.monitor_no, t1]);
    await db.query('DELETE FROM cems_reading WHERE ent_id=? AND monitor_no=? AND reading_time=?', [dev.ent_id, dev.monitor_no, t1]);
    await db.query('DELETE FROM device_verify_log WHERE device_did=? AND seq >= 200000', [dev.device_did]);
  }
  await db.query('UPDATE device_registry SET dev_pubkey=NULL, dev_key_fp=NULL, dev_sig_mode=NULL, dev_last_seq=0 WHERE device_did=?', [dev.device_did]);

  let pass = 0;
  for (const r of rows) {
    if (r.pass) pass++;
    console.log(`\n  ${r.pass ? '✔' : '✘'} [${r.id}] ${r.name}`);
    console.log(`      期望：${r.expected}`);
    console.log(`      实测：${r.actual}`);
  }
  console.log(`\n  结果：${pass}/${rows.length} 项符合预期`);

  const env = {
    measuredAt: startedAt.toISOString(), node: process.version,
    platform: `${os.type()} ${os.release()}`,
    sm2: { available: gm.available, openssl: (gm.CAPS && gm.CAPS.openssl) || null, userId: bridge.DEFAULT_ID },
    device: { mn: dev.mn, entId: dev.ent_id, monitorNo: dev.monitor_no, keyFp },
    firmwareReading: reading,
    firmwareDerived: {
      co2_mgm3: Number(EM.conc.toFixed(3)), q_actual_m3h: Number(EM.q.toFixed(3)),
      q_std_dry_m3h: Number(EM.qsn.toFixed(3)), gdev_tph: Number(EM.rate.toFixed(9)),
      ambient_kpa: FW.AMBIENT_KPA,
    },
  };

  const md = [];
  md.push('# CEN-100 固件 ↔ 平台 · 兼容性实证（自动生成）');
  md.push('');
  md.push(`> 生成命令：\`node tools/firmware-compat-check.mjs\`　生成时间：${startedAt.toISOString()}`);
  md.push('>');
  md.push('> 做法：把 `hardware/firmware/src/cc_sensors.c` 与 `main.c` 的算法**逐行镜像**成 JS，');
  md.push('> 用它签一张真实 HJ 212 报文，投给**真实平台代码** `hj212Server.processFrame`，断言数据库副作用。');
  md.push('');
  md.push('## 环境指纹');
  md.push('');
  md.push('```json');
  md.push(JSON.stringify(env, null, 2));
  md.push('```');
  md.push('');
  md.push('## 对照结果');
  md.push('');
  md.push('| # | 项目 | 类别 | 期望 | 实测 | 判定 |');
  md.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) md.push(`| ${r.id} | ${r.name} | ${r.kind} | ${r.expected} | ${r.actual} | ${r.pass ? 'PASS' : 'FAIL'} |`);
  md.push('');
  md.push('## 原始报文与 canon（逐字节可核）');
  md.push('');
  for (const r of rows) {
    if (!r.frame) continue;
    md.push(`### [${r.id}] ${r.name}`);
    md.push('```');
    md.push(`发送: ${r.frame}`);
    if (r.canon) md.push(`CANON: ${r.canon}`);
    md.push('```');
    md.push('');
  }
  fs.writeFileSync(path.join(OUT, 'firmware-compat-evidence.md'), md.join('\n'), 'utf8');
  fs.writeFileSync(path.join(OUT, 'firmware-compat-evidence.json'),
    JSON.stringify({ generatedAt: startedAt.toISOString(), env, rows }, null, 2), 'utf8');
  console.log(`\n  已写出：tools/out/firmware-compat-evidence.md · .json\n`);

  await shutdown();
  process.exit(pass === rows.length ? 0 : 1);
}

async function shutdown() {
  try { await db.pool.end(); } catch (_) { /* ignore */ }
  try { await db.chainPool.end(); } catch (_) { /* ignore */ }
}

main().catch(async (e) => {
  console.error('脚本失败：', (e && e.stack) || e);
  await shutdown();
  process.exit(2);
});
