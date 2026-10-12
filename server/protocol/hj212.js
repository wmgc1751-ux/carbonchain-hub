/**
 * server/protocol/hj212.js —— HJ 212-2017《污染物在线监控（监测）系统数据传输标准》编解码核心
 * ==================================================================
 * 定位：平台「源端真实化」的协议层。零外部依赖，只做两件事：
 *   ① 把 HJ 212 报文解析成结构化对象（设备直报 → 平台）；
 *   ② 把结构化对象编码成合规 HJ 212 报文（平台下发 / 应答 → 设备）。
 *
 * 为什么必须自己实现而不用第三方库
 * ------------------------------------------------------------------
 * 现场数采仪（CEMS 网关）只认 HJ 212 报文，不接受"HTTP + JSON"。若平台
 * 只能读自己合成的数据，"面向工业场景"就只是话术。实现本模块后，
 * 任何符合标准的数据采集仪都能**直连**平台 —— 协议层不再是模拟。
 *
 * 标准依据与本项目实现的子集（须如实声明）
 * ------------------------------------------------------------------
 * 完整依据 HJ 212-2017：
 *   · 表 2 通信包结构组成    `##` + 数据段长度(4) + 数据段 + CRC(4) + `<CR><LF>`
 *   · 表 3 数据段结构组成    QN / ST / CN / PW / MN / Flag / [PNUM / PNO] / CP
 *   · 6.3.3 数据区结构       字段与值用 `=`；同项目不同分类值用 `,`；不同项目用 `;`
 *   · 附录 A CRC-16 算法     初值 0xFFFF，多项式右移形式 0xA001（高字节在前）
 *   · HJ 525-2009 编码表     污染物因子编码（a34013 烟尘 / a21026 二氧化硫 / …）
 *
 * 本项目**未实现**的部分（如实声明，避免"全兼容"式夸大）：
 *   · 拆包/组包（PNUM/PNO 多包重组）—— 仅解析字段，不重组
 *   · 加密压缩（CP 加密传输、数据压缩上报）
 *   · CN 命令集全量 —— 只实现下方 CN_CODES 列出的 10 条（覆盖采数、状态、心跳、应答）
 *   · 2025 修订版新增字段（RF/NewSK/SKCreateTime/CalibrationType/SampleType）
 *
 * ⚠ 一处必须记牢的易错点：CRC 不是 CRC-16/CCITT
 * ------------------------------------------------------------------
 * HJ 212 的生成多项式写成 `1010 0000 0000 0001`，这是**右移（reflected）形式**
 * 的 0x8005，即位反射等价于 0xA001；配合初值全 1、无末异或，
 * 参数集与 **CRC-16/MODBUS**（名录 check = 0x4B37, poly=0x8005, init=0xFFFF,
 * refin/refout=true, xorout=0x0000）**完全相同**。
 * 若误用 CCITT 的 0x1021（初值 0xFFFF），每个报文的 CRC 都会错，
 * 而错法与"设备品牌不兼容"的表现一模一样，现场极难定位。
 *
 * 注：标准正文写"与寄存器**高位字节**异或"，而业内实现普遍是异或到低位字节
 * 并右移。两者在反射 CRC 下**数学等价**，本模块两种写法都实现，
 * 并在 conformance() 中互证（见 crc16MsbFirst）。
 */
'use strict';

/* ==================================================================
 * 一、CRC-16（HJ 212-2017 附录 A）
 * ================================================================== */

/** HJ 212 CRC 生成多项式（右移形式）：1010 0000 0000 0001 = 0xA001 */
const CRC_POLY = 0xa001;
/** 同上的正常形式（左移实现用）：0x8005 */
const CRC_POLY_NORMAL = 0x8005;
/** 初值：16 位寄存器全 1 */
const CRC_INIT = 0xffff;
/** 名录校验值：CRC-16/MODBUS 对 ASCII '123456789' 的结果 */
const CRC_CHECK_123456789 = 0x4b37;

/**
 * 计算 HJ 212 CRC-16（= CRC-16/MODBUS 参数集）。
 * 实现取"异或到低位字节 + 右移"的 LSB-first 写法。
 * 仅以每个字节的 8 Bit 数据参与运算，起始位/停止位/校验位不参与。
 * @param {string|Buffer} data 待校验的数据（**数据段**，不含 `##`、长度、CRC、包尾）
 * @returns {number} 0..65535
 */
function crc16(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1');
  let crc = CRC_INIT;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x0001) crc = (crc >>> 1) ^ CRC_POLY;
      else crc >>>= 1;
    }
  }
  return crc & 0xffff;
}

/**
 * 位反转（MSB-first 等价实现需要）。
 * @param {number} value
 * @param {number} width 位宽（8 或 16）
 */
function bitReverse(value, width) {
  let out = 0;
  for (let i = 0; i < width; i++) out = (out << 1) | ((value >>> i) & 1);
  return out >>> 0;
}

/**
 * 同一算法的**独立第二实现**：MSB-first（左移 + 正常多项式 0x8005）。
 *
 * ⚠ 这里有个陷阱：反射型（refin/refout=true）CRC **不能**简单地改成
 * "异或到高位字节 + 左移"，那不是同一个算法。正确的等价写法必须
 * **逐字节位反转输入、最后再位反转输出**，否则两者结果必然不同。
 * 本函数按此实现，故与 crc16() 严格等价，却走的是完全不同的代码路径 ——
 * 用于互证"不是自己抄自己"。
 * @param {string|Buffer} data
 * @returns {number} 0..65535
 */
function crc16MsbFirst(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1');
  let crc = bitReverse(CRC_INIT, 16);
  for (let i = 0; i < buf.length; i++) {
    crc ^= (bitReverse(buf[i], 8) << 8);
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ CRC_POLY_NORMAL) & 0xffff;
      else crc = (crc << 1) & 0xffff;
    }
  }
  return bitReverse(crc, 16) & 0xffff;
}

/**
 * 计算 CRC 并格式化为 4 位十六进制大写。**高字节在前**（标准附录 A：先高字节后低字节）。
 * @param {string|Buffer} data
 * @returns {string} 如 '9E81'
 */
function crc16Hex(data) {
  const v = crc16(data);
  return ((v >> 8) & 0xff).toString(16).padStart(2, '0').toUpperCase()
    + (v & 0xff).toString(16).padStart(2, '0').toUpperCase();
}

/* ==================================================================
 * 二、常量表
 * ================================================================== */

/** 数据段字段键（顺序即编码顺序，与标准表 3 一致） */
const SEG_KEYS = ['QN', 'ST', 'CN', 'PW', 'MN', 'Flag', 'PNUM', 'PNO', 'CP'];

/**
 * 本项目实现的 CN 命令编码子集（HJ 212-2017 6.6.5 表 9）。
 * dir: 'up' 设备→平台；'down' 平台→设备；'both' 双向
 */
const CN_CODES = {
  2011: { dir: 'up', name: '上传污染物实时数据' },
  2031: { dir: 'up', name: '上传污染物分钟数据' },
  2041: { dir: 'up', name: '上传污染物小时数据' },
  2051: { dir: 'up', name: '上传污染物日数据' },
  3011: { dir: 'up', name: '上传设备运行状态数据' },
  9021: { dir: 'up', name: '数据转发登录' },
  9022: { dir: 'up', name: '链路心跳' },
  9011: { dir: 'down', name: '设置超时时间与重发次数' },
  9012: { dir: 'down', name: '设置实时采样数据上报间隔' },
  9014: { dir: 'down', name: '取回数据应答 / 上传数据应答' },
};

/**
 * 污染物因子编码（HJ 525-2009，HJ 212-2017 引用）。
 * 仅列本项目工业烟气核算实际用到的因子；unit 为缺省计量单位。
 * 「排放量」列见标准原文，本项目按浓度×流量自行折算，故只标浓度单位。
 */
const POLLUTANT_CODES = {
  a00000: { name: '废气', unit: 'm³/s' },
  a01011: { name: '烟气流速', unit: 'm/s' },
  a01012: { name: '烟气温度', unit: '℃' },
  a01013: { name: '烟气压力', unit: 'kPa' },
  a01014: { name: '烟气湿度', unit: '%' },
  a19001: { name: '氧气含量', unit: '%' },
  a21002: { name: '氮氧化物', unit: 'mg/m³' },
  a21026: { name: '二氧化硫', unit: 'mg/m³' },
  a34013: { name: '烟尘', unit: 'mg/m³' },
};

/** 因子实时数据标记 xxx-Flag（HJ 212-2017 6.3.3.2） */
const DATA_FLAGS = {
  N: '正常',
  P: '电源故障',
  F: '排放源停运',
  C: '校验',
  M: '维护',
  T: '超测上限',
  D: '故障',
  S: '设定值',
};

/**
 * 平台内部质量标记（cems_reading.quality_flag）与 HJ 212 数据标记的映射。
 * 这是"源端标记"落到"时序质量标记"的桥，是数据可信度的第一环。
 */
const FLAG_TO_QUALITY = {
  N: 'NORMAL',
  P: 'OFFLINE',
  F: 'OFFLINE',
  C: 'CALIBRATION',
  M: 'CALIBRATION',
  T: 'DRIFT',
  D: 'DRIFT',
  S: 'SUBSTITUTED',
};

/** 系统编码 ST（HJ 212-2017 6.6.1 表 5）常用值 */
const ST_CODES = {
  21: '国控污染源',
  22: '省控污染源',
  31: '市控污染源',
  32: '区县控污染源',
  51: '污水处理厂',
  91: '其他',
};

/* ==================================================================
 * 三、Flag 位域
 * ================================================================== */

/**
 * 解析 Flag 字节。
 * 位序：bit7..bit2 = V5..V0（标准版本号），bit1 = D（含包号/总包数），bit0 = A（是否应答）
 * @param {number} flag
 * @returns {{version:number, versionName:string, hasPnum:boolean, needAck:boolean, raw:number}}
 */
function parseFlag(flag) {
  const f = Number(flag) & 0xff;
  const version = (f >> 2) & 0x3f;
  const versionName = version === 0 ? 'HJ/T 212-2005'
    : version === 1 ? 'HJ 212-2017'
      : version === 2 ? 'HJ 212-2017 修订版' : `未知(${version})`;
  return {
    version,
    versionName,
    hasPnum: (f & 0x02) === 0x02,
    needAck: (f & 0x01) === 0x01,
    raw: f,
  };
}

/**
 * 构造 Flag 字节。
 * @param {object} o { version=1, hasPnum=false, needAck=true }
 */
function buildFlag(o = {}) {
  const version = Number(o.version === undefined ? 1 : o.version) & 0x3f;
  return (version << 2) | (o.hasPnum ? 0x02 : 0) | (o.needAck === false ? 0 : 0x01);
}

/* ==================================================================
 * 四、CP 数据区
 * ================================================================== */

/**
 * 构造 CP 字段（含 `&&` 包裹）。
 * 数据区结构（6.3.3.1）：字段与值用 `=`；同项目不同分类值用 `,`；不同项目用 `;`。
 *
 * 产出的形态（以 CN=2011 为例）：
 *   CP=&&DataTime=20261012120000;a34013-Rtd=12.50,a34013-Flag=N;a19001-Rtd=6.80,a19001-Flag=N&&
 *
 * @param {object} o
 *   o.dataTime   'YYYYMMDDhhmmss' 或 Date
 *   o.pollutants [{ code, Rtd, Flag, Cou, Min, Avg, Max }]  code 为 HJ 525 因子编码
 *   o.extras     { 其他顶层字段 } 如 { RtdInterval: 60 }
 * @returns {string} '&&...&&'
 */
function buildCP(o = {}) {
  const parts = [];
  if (o.pnum != null) parts.push(`PNUM=${o.pnum}`);
  if (o.pno != null) parts.push(`PNO=${o.pno}`);

  const dt = o.dataTime == null ? null
    : (o.dataTime instanceof Date ? fmtDateTime(o.dataTime) : String(o.dataTime));
  if (dt) parts.push(`DataTime=${dt}`);

  if (o.extras && typeof o.extras === 'object') {
    for (const k of Object.keys(o.extras)) parts.push(`${k}=${o.extras[k]}`);
  }

  for (const p of (o.pollutants || [])) {
    if (!p || p.code == null) continue;
    const subs = [];
    for (const f of ['Rtd', 'ZsRtd', 'Cou', 'Min', 'Avg', 'Max', 'Flag']) {
      if (p[f] !== undefined && p[f] !== null) subs.push(`${p.code}-${f}=${p[f]}`);
    }
    if (subs.length) parts.push(subs.join(','));
  }
  return `&&${parts.join(';')}&&`;
}

/**
 * 解析 CP 数据区（输入需为含 `&&` 的完整 CP 值，或裸数据区文本）。
 * @param {string} cp
 * @returns {{dataTime:string|null, pollutants:Object, extras:Object, order:string[], raw:string}}
 */
function parseCP(cp) {
  let body = String(cp == null ? '' : cp).trim();
  if (body.startsWith('&&')) body = body.slice(2);
  if (body.endsWith('&&')) body = body.slice(0, -2);

  const out = { dataTime: null, pollutants: {}, extras: {}, order: [], raw: body };
  if (!body) return out;

  /* 两层切分（HJ 212-2017 6.3.3.1）：
   *   `;` 分隔"不同项目"，`,` 分隔"同一项目的不同分类值"。
   * 必须先按 `;` 切、再按 `,` 切 —— 只切一层会把
   * `a34013-Rtd=12.5,a34013-Flag=N` 整体当成 Rtd 的值（实测踩过）。 */
  const put = (code, field, val) => {
    if (!out.pollutants[code]) {
      out.pollutants[code] = { code, name: (POLLUTANT_CODES[code] || {}).name || null };
      out.order.push(code);
    }
    out.pollutants[code][field] = val;
  };

  for (const item of body.split(';')) {
    if (!item) continue;
    for (const sub of item.split(',')) {
      const eq = sub.indexOf('=');
      if (eq < 0) continue;
      const key = sub.slice(0, eq);
      const val = sub.slice(eq + 1);

      // 因子子字段形如 a34013-Rtd / a34013-Flag
      const dash = key.indexOf('-');
      if (dash > 0 && /^[a-zA-Z]\d{5}$/.test(key.slice(0, dash))) {
        put(key.slice(0, dash), key.slice(dash + 1), val);
        continue;
      }
      if (key === 'DataTime') out.dataTime = val;
      else out.extras[key] = val;
    }
  }
  return out;
}

/* ==================================================================
 * 五、数据段
 * ================================================================== */

/** Date → 'YYYYMMDDhhmmss' */
function fmtDateTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 生成 QN 请求编码：`YYYYMMDDhhmmsszzz`，**固定 17 位**（标准表 3：QN 字段含 `QN=` 共 20 字符）。
 * 标准要求 QN 唯一标识一次命令交互，故 zzz 取毫秒；
 * 同一毫秒内需再区分时，用 seq 顶替 zzz（仍保持 3 位，不破坏字段宽度）。
 * @param {Date} [d]
 * @param {number|null} [seq] 0..999；传 null/省略则用毫秒
 * @returns {string} 17 位
 */
function fmtQN(d = new Date(), seq = null) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const zzz = (seq === null || seq === undefined)
    ? p(d.getMilliseconds(), 3)
    : p(Math.abs(Number(seq)) % 1000, 3);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${zzz}`;
}

/**
 * 由结构化字段拼出**数据段**（不含 `##`、长度、CRC、包尾）。
 * 字段顺序严格按标准表 3；PNUM/PNO 仅在 hasPnum 时输出。
 *
 * 注意：字段之间用 `;` 分隔，**末尾不加 `;`**。
 * 这一点是拿公开样例的长度字段反推出来的：样例写 0141，逐字段累加恰好 141
 * （含字段间 6 个 `;`、不含末尾 `;`）。多一个 `;` 长度就变 142，
 * 对端按长度截取时会连带吃掉 CRC 的首字符，表现为"CRC 校验失败"。
 */
function buildDataSegment(o = {}) {
  const flag = o.flag === undefined ? buildFlag({ needAck: true }) : Number(o.flag);
  const f = parseFlag(flag);
  const parts = [
    `QN=${o.qn || fmtQN()}`,
    `ST=${o.st}`,
    `CN=${o.cn}`,
    `PW=${o.pw == null ? '123456' : o.pw}`,
    `MN=${o.mn}`,
    `Flag=${flag}`,
  ];
  if (f.hasPnum) {
    parts.push(`PNUM=${o.pnum == null ? 1 : o.pnum}`);
    parts.push(`PNO=${o.pno == null ? 1 : o.pno}`);
  }
  if (o.cp !== undefined && o.cp !== null) parts.push(`CP=${o.cp}`);
  return parts.join(';');
}

/**
 * 解析数据段为结构化对象。
 * @param {string} seg
 * @returns {object} { qn, st, cn, pw, mn, flag, flagInfo, pnum, pno, cp, cpParsed, seg }
 */
function parseDataSegment(seg) {
  const s = String(seg);
  const out = {
    seg: s, qn: null, st: null, cn: null, pw: null, mn: null,
    flag: null, flagInfo: null, pnum: null, pno: null, cp: null, cpParsed: null,
  };

  /* CP 值内部含 `;`（数据区用分号分隔），故不能简单 split(';')。
   * 先整体切分，再把落在 CP= 之后的所有片段重新拼回。 */
  const idx = s.indexOf('CP=');
  const head = idx < 0 ? s : s.slice(0, idx);
  const cpRaw = idx < 0 ? null : s.slice(idx + 3);

  for (const item of head.split(';')) {
    if (!item) continue;
    const eq = item.indexOf('=');
    if (eq < 0) continue;
    const k = item.slice(0, eq); const v = item.slice(eq + 1);
    if (k === 'QN') out.qn = v;
    else if (k === 'ST') out.st = v;
    else if (k === 'CN') out.cn = v;
    else if (k === 'PW') out.pw = v;
    else if (k === 'MN') out.mn = v;
    else if (k === 'Flag') out.flag = Number(v);
    else if (k === 'PNUM') out.pnum = Number(v);
    else if (k === 'PNO') out.pno = Number(v);
  }
  if (cpRaw !== null) {
    out.cp = cpRaw;
    out.cpParsed = parseCP(cpRaw);
  }
  out.flagInfo = parseFlag(out.flag === null ? 1 : out.flag);
  out.cnName = (CN_CODES[out.cn] || {}).name || `未知命令(${out.cn})`;
  out.stName = ST_CODES[out.st] || null;
  return out;
}

/* ==================================================================
 * 六、整帧编解码
 * ================================================================== */

/**
 * 编码一整帧。
 * 结构：`##` + 数据段长度(4 位十进制) + 数据段 + CRC(4 位十六进制大写) + `<CR><LF>`
 * 长度与 CRC 均**只覆盖数据段**（这是解析错位的头号原因，务必记牢）。
 * @param {object|string} input 结构化字段对象，或已拼好的数据段字符串
 * @returns {string}
 */
function encode(input) {
  const seg = typeof input === 'string' ? input : buildDataSegment(input);
  const len = Buffer.byteLength(seg, 'latin1');
  if (len > 1024) throw new Error(`数据段超长：${len} > 1024（标准上限）`);
  return `##${String(len).padStart(4, '0')}${seg}${crc16Hex(seg)}\r\n`;
}

/**
 * 解码一整帧（须为完整、边界对齐的一帧）。
 * @param {string} frame
 * @returns {object} parseDataSegment 的结果 + { crc, crcExpect, crcOk, lenField, lenActual }
 */
function decode(frame) {
  const buf = Buffer.isBuffer(frame) ? frame.toString('latin1') : String(frame);
  const start = buf.startsWith('##') ? 2 : buf.indexOf('##') + 2;
  if (start < 2) throw new Error('未找到包头 ##');

  const lenField = buf.slice(start, start + 4);
  const len = Number.parseInt(lenField, 10);
  if (!Number.isFinite(len) || len < 0 || len > 1024) {
    throw new Error(`数据段长度字段非法：'${lenField}'`);
  }

  const seg = buf.slice(start + 4, start + 4 + len);
  const crc = buf.slice(start + 4 + len, start + 8 + len).toUpperCase();
  const parsed = parseDataSegment(seg);
  const crcExpect = crc16Hex(seg);
  return {
    ...parsed,
    lenField,
    lenActual: Buffer.byteLength(seg, 'latin1'),
    crc,
    crcExpect,
    crcOk: crc === crcExpect,
  };
}

/**
 * TCP 流式拆包器 —— HJ 212 走 TCP，必须自己处理粘包/半包。
 *
 * 为什么不能按 `\r\n` 切分：TCP 是字节流，一次 data 事件可能只有半帧、
 * 也可能含两帧；且数据段内部允许出现类似换行的字节。正确做法是维护接收
 * 缓冲，先定位 `##`，读到 4 位长度后判断"攒够一帧没有"，够则切出、余下继续。
 */
class FrameDecoder {
  /**
   * @param {object} o { maxBuffer=65536, onNoise }
   */
  constructor(o = {}) {
    this.buf = '';
    this.maxBuffer = o.maxBuffer || 65536;
    this.onNoise = o.onNoise || null;
    this.stats = { frames: 0, crcFail: 0, noise: 0, dropped: 0 };
  }

  /**
   * 喂入一段字节，返回本次能完整解析出的帧数组。
   * @param {Buffer|string} chunk
   * @returns {Array<object>} decode 结果数组（含解析失败但 CRC 可核验的帧）
   */
  push(chunk) {
    this.buf += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk);
    const frames = [];

    for (;;) {
      const p = this.buf.indexOf('##');
      if (p < 0) {
        // 无包头：整段都是噪声，保留最后 1 字符以防 '#' 被截断在边界
        if (this.buf.length > 1) {
          const noise = this.buf.slice(0, -1);
          this.stats.noise += noise.length;
          if (this.onNoise) this.onNoise(noise);
          this.buf = this.buf.slice(-1);
        }
        break;
      }
      if (p > 0) {
        const noise = this.buf.slice(0, p);
        this.stats.noise += noise.length;
        if (this.onNoise) this.onNoise(noise);
        this.buf = this.buf.slice(p);
      }
      // 此时 buf 以 '##' 开头
      if (this.buf.length < 6) break;                 // 长度字段还没到齐
      const len = Number.parseInt(this.buf.slice(2, 6), 10);
      if (!Number.isFinite(len) || len < 0 || len > 1024) {
        /* 长度字段非法 → 重新同步。
         * 只能丢 1 个字符，不能丢 2 个：噪声若以 '#' 结尾（如 "GARBAGE#"+帧），
         * indexOf('##') 会把噪声的 '#' 和帧头的第一个 '#' 误配成一个假包头，
         * 此时丢 2 位会连帧头的第二个 '#' 一起吃掉，导致该帧永久丢失。
         * 丢 1 位后 '##' 会被重新识别，实测可正确恢复。 */
        this.stats.dropped++;
        this.buf = this.buf.slice(1);
        continue;
      }
      const need = 6 + len + 4;                        // ## + 长度 + 数据段 + CRC
      if (this.buf.length < need) break;               // 半包，等后续字节
      const raw = this.buf.slice(0, need);
      this.buf = this.buf.slice(need);
      // 包尾 <CR><LF>：标准要求，容错跳过
      if (this.buf.startsWith('\r\n')) this.buf = this.buf.slice(2);
      else if (this.buf.startsWith('\n')) this.buf = this.buf.slice(1);

      try {
        const f = decode(raw);
        this.stats.frames++;
        if (!f.crcOk) this.stats.crcFail++;
        frames.push(f);
      } catch (e) {
        this.stats.dropped++;
        if (this.onNoise) this.onNoise(`解析失败：${e.message}`);
      }
    }

    if (this.buf.length > this.maxBuffer) {
      // 缓冲异常膨胀（对端一直发无包头垃圾）→ 截断自保
      this.buf = this.buf.slice(-1024);
      this.stats.dropped++;
    }
    return frames;
  }

  reset() { this.buf = ''; }
}

/* ==================================================================
 * 七、合规自检（三重锚定）
 * ==================================================================
 * 协议实现最怕"自洽但错"——自己算、自己验，错了也发现不了。故本模块的自检
 * 刻意用三种互不依赖的锚：
 *
 *   锚 ① 名录校验值：CRC-16/MODBUS 对 '123456789' 的公认 check = 0x4B37。
 *       这一条把多项式/初值/位序**三件事一起钉死**，任何一处改动都会红。
 *   锚 ② 双实现互证：crc16()（LSB-first 右移）与 crc16MsbFirst()（MSB-first 左移）
 *       是同一算法完全不同的代码路径，必须对每一个字节序列都给出相同结果。
 *   锚 ③ 长度语义：公开资料中的 HJ 212 实报样例，其长度字段等于**数据段 ASCII
 *       字符数**。样例一的 MN 在传播中被缩写为 14 位；补足标准要求的 24 位后，
 *       数据段长度恰好等于其公开长度字段 0141 —— 这独立验证了长度口径。
 *
 * 说明：样例的 CRC 值**不能**用来校验本模块，因为 MN 缩写后数据段已非原样，
 * CRC 必然变化。故此处只取其长度语义，不取其 CRC。如实标注，不做无谓的"吻合"。
 */

/** 公开资料中的 HJ 212-2017 实报样例（结构原样，MN 在传播中被缩写） */
const PUBLISHED_SAMPLES = [
  {
    note: '样例一 CN=2011 实时数据（氮氧化物）；公开长度字段 0141',
    publishedLenField: 141,
    segTemplate: 'QN=20240309134257896;ST=31;CN=2011;PW=123456;MN={MN};Flag=4;'
      + 'CP=&&DataTime=20240309134257;a21002-Rtd=5.125,a21002-Flag=N&&',
    abbreviatedMn: '88888888000001',
  },
  {
    note: '样例二 CN=2011 实时数据（总悬浮颗粒物）；公开长度字段自相矛盾（帧内 0138 / 正文 136），仅作结构参考',
    publishedLenField: null,
    segTemplate: 'QN=20230810123456789;ST=22;CN=2011;PW=123456;MN={MN};Flag=4;'
      + 'CP=&&DataTime=20230810123456;A34001-Rtd=36.5,A34001-Flag=N&&',
    abbreviatedMn: '0100000135000001',
  },
];

/**
 * 运行合规自检。
 * @returns {{pass:boolean, total:number, passed:number, details:Array<{anchor:string,pass:boolean,problems:string[]}>}}
 */
function conformance() {
  const details = [];
  const add = (anchor, problems) => details.push({ anchor, pass: problems.length === 0, problems });

  /* —— 锚 ① 名录校验值 —— */
  {
    const p = [];
    const v1 = crc16('123456789');
    if (v1 !== CRC_CHECK_123456789) {
      p.push(`crc16('123456789') = 0x${v1.toString(16).toUpperCase()}，应为 0x4B37`);
    }
    const v2 = crc16('');
    if (v2 !== 0xffff) p.push(`crc16('') = 0x${v2.toString(16).toUpperCase()}，应为 0xFFFF（初值原样保留）`);
    // 与 CCITT 区分：若误用 0x1021 初值 0xFFFF，'123456789' 会得到 0x29B1
    if (v1 === 0x29b1) p.push('检测到使用了 CCITT(0x1021) 参数集 —— HJ 212 不是 CCITT');
    add('① 名录校验值 CRC-16/MODBUS（poly=0x8005 reflected / init=0xFFFF / xorout=0）：'
      + "'123456789' → 0x4B37，空串 → 0xFFFF", p);
  }

  /* —— 锚 ② 双实现互证（对公开样例的原始与补全两种形态都跑） —— */
  {
    const p = [];
    let n = 0;
    for (const s of PUBLISHED_SAMPLES) {
      for (const mn of [s.abbreviatedMn, s.abbreviatedMn.padEnd(24, '0')]) {
        const seg = s.segTemplate.replace('{MN}', mn);
        const a = crc16(seg); const b = crc16MsbFirst(seg);
        n++;
        if (a !== b) {
          p.push(`MN=${mn} 时两种实现不一致：LSB-first 0x${a.toString(16).toUpperCase()}`
            + ` vs MSB-first 0x${b.toString(16).toUpperCase()}`);
        }
      }
    }
    add(`② 双实现互证（LSB-first 右移 与 MSB-first 左移 两条独立代码路径，共 ${n} 个序列）`, p);
  }

  /* —— 锚 ③ 长度语义 —— */
  for (const s of PUBLISHED_SAMPLES) {
    const p = [];
    if (s.publishedLenField == null) {
      add(`③ 长度语义 · ${s.note}`, p); // 无可靠公开值，仅展示结构，不判定
      continue;
    }
    const segFull = s.segTemplate.replace('{MN}', s.abbreviatedMn.padEnd(24, '0'));
    const len = Buffer.byteLength(segFull, 'latin1');
    if (len !== s.publishedLenField) {
      p.push(`MN 补足 24 位后数据段长 ${len}，公开长度字段为 ${s.publishedLenField}`);
    }
    // 顺带验证：长度口径 = 数据段字符数，不含 ## / 长度 / CRC / 包尾
    const frame = encode(segFull);
    if (frame.length !== 2 + 4 + len + 4 + 2) {
      p.push(`整帧长度 ${frame.length} ≠ 2+4+${len}+4+2，说明帧结构不符合表 2`);
    }
    add(`③ 长度语义 · ${s.note}（MN 补足 24 位后 = ${len}）`, p);
  }

  /* —— 补充：往返一致性（本模块自建帧） —— */
  {
    const p = [];
    const built = encode({
      st: '31', cn: '2011', pw: '123456', mn: '010000A8900016F000169DC0', flag: buildFlag({ needAck: true }),
      cp: buildCP({
        dataTime: new Date(2026, 9, 12, 12, 0, 0),
        pollutants: [
          { code: 'a34013', Rtd: 12.5, Flag: 'N' },
          { code: 'a21026', Rtd: 35.2, Flag: 'N' },
          { code: 'a19001', Rtd: 6.8, Flag: 'N' },
        ],
      }),
    });
    const back = decode(built);
    if (!back.crcOk) p.push(`自建帧 CRC 自校失败：${back.crc} vs ${back.crcExpect}`);
    if (back.cn !== '2011' || back.mn !== '010000A8900016F000169DC0') p.push('自建帧往返字段丢失');
    if (!back.cpParsed || back.cpParsed.pollutants.a34013.Rtd !== '12.5') p.push('自建帧 CP 因子未正确回读');
    if (back.cpParsed.dataTime !== '20261012120000') {
      p.push(`自建帧 DataTime 回读为 ${back.cpParsed && back.cpParsed.dataTime}`);
    }
    if (encode({ qn: back.qn, st: back.st, cn: back.cn, pw: back.pw, mn: back.mn, flag: back.flag, cp: back.cp }) !== built) {
      p.push('自建帧 encode(decode(x)) 不能字节级还原');
    }
    add('④ 往返一致性 · 自建三因子帧 encode → decode → encode 应字节级恒等', p);
  }

  /* —— 补充：拆包器抗粘包/半包 —— */
  {
    const p = [];
    const f1 = encode({ st: '31', cn: '2011', mn: 'A'.repeat(24), flag: 4, cp: buildCP({ dataTime: '20261012120000', pollutants: [{ code: 'a19001', Rtd: 6.8, Flag: 'N' }] }) });
    const f2 = encode({ st: '31', cn: '2011', mn: 'B'.repeat(24), flag: 4, cp: buildCP({ dataTime: '20261012120001', pollutants: [{ code: 'a19001', Rtd: 6.9, Flag: 'N' }] }) });
    const dec = new FrameDecoder();
    // 粘包 + 半包：整段一次喂入应得 2 帧
    const got = dec.push(f1 + f2);
    if (got.length !== 2) p.push(`粘包一次喂入应得 2 帧，实得 ${got.length}`);
    // 逐字节喂入也应得 2 帧
    const dec2 = new FrameDecoder();
    let n2 = 0;
    for (const ch of (f1 + f2)) n2 += dec2.push(ch).length;
    if (n2 !== 2) p.push(`逐字节喂入应得 2 帧，实得 ${n2}`);
    // 前置垃圾应被丢弃且不影响成帧
    const dec3 = new FrameDecoder();
    const g3 = dec3.push('GARBAGE#' + f1);
    if (g3.length !== 1) p.push(`前置噪声后应仍得 1 帧，实得 ${g3.length}`);
    // CRC 被改坏时应报 crcFail 而不是静默通过
    const dec4 = new FrameDecoder();
    const bad = f1.slice(0, -6) + '0000' + '\r\n';
    const g4 = dec4.push(bad);
    if (g4.length !== 1 || g4[0].crcOk) p.push('CRC 被破坏的帧未被识别为校验失败');
    add('⑤ 拆包器 · 粘包 / 逐字节半包 / 前置噪声 / CRC 破坏 四种情形', p);
  }

  const passed = details.filter((x) => x.pass).length;
  return { pass: passed === details.length, total: details.length, passed, details };
}

module.exports = {
  // CRC
  crc16, crc16MsbFirst, crc16Hex, CRC_POLY, CRC_POLY_NORMAL, CRC_INIT, CRC_CHECK_123456789,
  // 常量
  SEG_KEYS, CN_CODES, POLLUTANT_CODES, DATA_FLAGS, FLAG_TO_QUALITY, ST_CODES,
  // Flag
  parseFlag, buildFlag,
  // CP
  buildCP, parseCP,
  // 数据段 / 整帧
  buildDataSegment, parseDataSegment, encode, decode,
  // 时间
  fmtDateTime, fmtQN,
  // 流式
  FrameDecoder,
  // 自检
  PUBLISHED_SAMPLES, conformance,
};
