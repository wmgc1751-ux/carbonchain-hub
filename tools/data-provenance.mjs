#!/usr/bin/env node
/**
 * tools/data-provenance.mjs —— 数据来源分级审计
 * ==================================================================
 * 为什么必须做这件事（院审判定第 ③ 条）
 * ------------------------------------------------------------------
 * 院审原文：「'实机测试'系自举模拟，无真实企业数据」。
 *
 * 这句话如果只是"承认一下"，那它是失分项；如果把它**量化、分级、可追踪**，
 * 它就变成方法论的一部分 —— 因为绝大多数参赛作品连"自己的数据是哪一档"
 * 都说不清，而说不清的地方，恰恰是评审最容易一击致命的地方。
 *
 * 本工具把库里的每一条监测读数按**来源可验证强度**归入四级：
 *
 *   L3 现场实测   设备直报 + CRC-16 通过 + SM3 指纹非空 + 已登记 ACTIVE 设备
 *                 ⇒ 唯一可以写"实机采集"的一档
 *   L2 设备直报   有 device_did 但缺 CRC/SM3（部分校验链未闭合）
 *   L1 人工补录   source = MANUAL（人工录入，有操作人可追）
 *   L0 平台自举   device_did 为空 —— 由平台按行业基准生成，**不是任何设备发的**
 *
 * 然后再算两个评审一定会问的比值：
 *   · 设备直报覆盖率 = (L3 + L2) / 全部
 *   · 完整校验覆盖率 = 同时有 CRC 与 SM3 的比例
 *
 * ⚠ 本工具**只报告，不美化**。覆盖率是 0% 就写 0%，并给出"接上真实设备后
 *   这个数会怎么变"的说明。一个敢报 0% 的团队，比一个报 98% 但拿不出
 *   原始报文的团队可信得多。
 *
 * 用法
 *   node tools/data-provenance.mjs
 *   node tools/data-provenance.mjs --json-only
 * ==================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import os from 'node:os';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'tools', 'out');
const ARGV = process.argv.slice(2);
const JSON_ONLY = ARGV.includes('--json-only');

/* ---------- 读取 .env（不引 dotenv，保持零依赖风格） ---------- */
function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (m[1].startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

const ENV = { ...readEnv(path.join(ROOT, '.env')), ...process.env };

/* ---------- 分级定义（写进产物，评审可对账） ---------- */
const LEVELS = [
  {
    code: 'L3',
    name: '现场实测',
    rule: 'device_did 非空 且 crc16 非空 且 sm3_digest 非空',
    claim: '可作为"实机采集数据"引用',
    strong: true,
  },
  {
    code: 'L2',
    name: '设备直报（校验不完整）',
    rule: 'device_did 非空，但 crc16 或 sm3_digest 缺一',
    claim: '可称"设备上报"，不可称"已完整校验"',
    strong: false,
  },
  {
    code: 'L1',
    name: '人工补录',
    rule: "source = 'MANUAL'（且 device_did 为空）",
    claim: '可称"人工录入"，须附录入人与审批记录',
    strong: false,
  },
  {
    code: 'L0',
    name: '平台自举',
    rule: 'device_did 为空且 source 非 MANUAL',
    claim: '**不可称实测数据**；只能表述为"按行业基准生成的演示序列"',
    strong: false,
  },
];

async function main() {
  const conn = await mysql.createConnection({
    host: ENV.DB_HOST || '127.0.0.1',
    port: Number(ENV.DB_PORT || 3306),
    user: ENV.DB_USER || 'root',
    password: ENV.DB_PASSWORD || '',
    database: ENV.DB_NAME || 'carbon_chain',
  });

  const q = async (sql, params = []) => {
    const [rows] = await conn.query(sql, params);
    return rows;
  };

  /* ---------- 1. CEMS 读数分级 ---------- */
  const [cems] = await q(`
    SELECT
      COUNT(*)                                              AS total,
      SUM(device_did IS NOT NULL AND crc16 IS NOT NULL AND sm3_digest IS NOT NULL) AS l3,
      SUM(device_did IS NOT NULL AND (crc16 IS NULL OR sm3_digest IS NULL))        AS l2,
      SUM(device_did IS NULL AND source = 'MANUAL')                                AS l1,
      SUM(device_did IS NULL AND source <> 'MANUAL')                               AS l0,
      SUM(crc16 IS NOT NULL)                                                       AS has_crc,
      SUM(sm3_digest IS NOT NULL)                                                  AS has_sm3,
      SUM(batch_no IS NOT NULL)                                                    AS has_batch,
      SUM(chain_tx_id IS NOT NULL)                                                 AS has_tx
    FROM cems_reading
  `);

  const total = Number(cems.total) || 0;
  const cnt = (k) => Number(cems[k]) || 0;
  const pct = (n) => (total > 0 ? Number(((n / total) * 100).toFixed(2)) : 0);

  /* ---------- 2. 设备台账 ---------- */
  let dev = { n: 0, active: 0, has_mn: 0, has_cert: 0 };
  try {
    const [d] = await q(`
      SELECT COUNT(*) n,
             SUM(auth_status = 'ACTIVE') active,
             SUM(mn IS NOT NULL) has_mn,
             SUM(cert_fingerprint IS NOT NULL) has_cert
      FROM device_registry
    `);
    dev = {
      n: Number(d.n) || 0,
      active: Number(d.active) || 0,
      has_mn: Number(d.has_mn) || 0,
      has_cert: Number(d.has_cert) || 0,
    };
  } catch {
    /* 表不存在时保持 0，不编造 */
  }

  /* ---------- 3. 上报单与链上交易 ---------- */
  const reports = await q(`SELECT status, COUNT(*) n FROM emission_report GROUP BY status`).catch(() => []);
  /* 账本库可能在独立实例上，因此单独建连，不能用跨库限定名（同实例时才碰巧可用）。 */
  let txTypes = [];
  try {
    const led = await mysql.createConnection({
      host: ENV.LEDGER_DB_HOST || ENV.DB_HOST || '127.0.0.1',
      port: Number(ENV.LEDGER_DB_PORT || ENV.DB_PORT || 3306),
      user: ENV.LEDGER_DB_USER || ENV.DB_USER || 'root',
      password: ENV.LEDGER_DB_PASSWORD || ENV.DB_PASSWORD || '',
      database: ENV.LEDGER_DB_NAME || 'carbon_chain_ledger',
    });
    const [rows] = await led.query('SELECT tx_type, COUNT(*) n FROM chain_tx GROUP BY tx_type ORDER BY n DESC');
    txTypes = rows;
    await led.end();
  } catch (e) { txTypes = []; }

  const direct = cnt('l3') + cnt('l2');

  /* ---------- 4. 结论 ---------- */
  const verdicts = [];
  if (total === 0) {
    verdicts.push({
      level: 'BAD',
      text: '库中无监测读数，无法评估。先执行 npm run initdb 建立基准。',
    });
  } else if (direct === 0) {
    verdicts.push({
      level: 'BAD',
      text: `监测读数 ${total} 条，其中设备直报 0 条 —— 全部为平台按行业基准生成的演示序列。` +
            `当前**不可**对外称"实机采集数据"，也不可称"接入真实企业 CEMS"。`,
    });
  } else {
    verdicts.push({
      level: direct === total ? 'OK' : 'WARN',
      text: `监测读数 ${total} 条，其中设备直报 ${direct} 条（${pct(direct)}%），自举 ${cnt('l0')} 条。` +
            (direct === total ? '全部数据来自设备。' : '仍存在自举数据，引用时须按比例说明。'),
    });
  }

  if (cnt('l3') === 0 && total > 0) {
    verdicts.push({
      level: 'BAD',
      text: '通过完整校验链（CRC-16 + SM3 双校验）的读数 0 条 —— ' +
            '"逐帧国密校验"目前只能作为**能力描述**（代码与自检可证），不能作为**数据属性**（库中无一条具备）。',
    });
  }

  if (dev.n === 0) {
    verdicts.push({
      level: 'WARN',
      text: '设备台账当前 0 行。演示态下设备记录由服务启动时自举建立（initdb 后清空），' +
            '因此"132 台设备"属于**运行时数字**，引用时必须注明"服务运行态实测"，不可写成静态台账规模。',
    });
  }

  /* ---------- 5. 落盘 ---------- */
  const result = {
    generatedAt: new Date().toISOString(),
    generator: 'tools/data-provenance.mjs',
    purpose: '按"来源可验证强度"给每条监测读数分级，量化"真实数据"占比',
    env: {
      node: process.version,
      platform: `${os.type()} ${os.release()}`,
      db: `${ENV.DB_HOST || '127.0.0.1'}:${ENV.DB_PORT || 3306}/${ENV.DB_NAME || 'carbon_chain'}`,
    },
    rule: '只报告不美化：覆盖率为 0 就写 0，并说明接上真实设备后会怎么变',
    levels: LEVELS,
    cems: {
      total,
      l3: cnt('l3'),
      l2: cnt('l2'),
      l1: cnt('l1'),
      l0: cnt('l0'),
      hasCrc: cnt('has_crc'),
      hasSm3: cnt('has_sm3'),
      hasBatch: cnt('has_batch'),
      hasTx: cnt('has_tx'),
      deviceDirect: direct,
      deviceDirectPct: pct(direct),
      crcPct: pct(cnt('has_crc')),
      sm3Pct: pct(cnt('has_sm3')),
      selfBootstrapPct: pct(cnt('l0')),
    },
    deviceRegistry: dev,
    reports,
    txTypes,
    verdicts,
    /* 从当前状态到"可称实测"还差什么 —— 给用户一条明确的路 */
    roadmap: [
      {
        step: 1,
        title: '接入一台真实 CEMS 或数采仪',
        how: '设备按 HJ 212-2017 上报至平台 9100 端口（或经 CEN-100 网关转发）',
        effect: '该排口后续读数变为 L2；device_did、MN 自动落库',
        effort: '设备到位后 1 天内可通',
      },
      {
        step: 2,
        title: '补齐逐帧双校验',
        how: '设备侧启用 CRC-16 与 SM3 摘要，平台侧登记设备公钥（tools/register-device-key.mjs）',
        effect: '读数升为 L3；"逐帧国密校验"由能力描述变为数据属性',
        effort: '半天（已有工具链与真机验证记录）',
      },
      {
        step: 3,
        title: '取得企业书面授权与数据使用说明',
        how: '一页《数据使用授权书》+ 现场照片 + 设备铭牌照片',
        effect: '满足"应用证明"材料的构成要件',
        effort: '取决于企业配合，建议提前 4 周启动',
      },
      {
        step: 4,
        title: '请第三方按证据包独立复算一次',
        how: '交付 tools/out/evidence-pack-*，对方用 verify-pack.mjs + verify-offline.mjs 复核',
        effect: '形成"第三方复算记录"，是现实意义 30 分档里最硬的一条',
        effort: '对方半天，出函 1~2 周',
      },
    ],
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'data-provenance.json'), JSON.stringify(result, null, 2));

  if (JSON_ONLY) {
    console.log(JSON.stringify(result, null, 2));
    await conn.end();
    return;
  }

  /* ---------- 6. 终端输出 ---------- */
  const ICON = { OK: '✅', WARN: '🟡', BAD: '🔴' };
  console.log('');
  console.log('数据来源分级审计');
  console.log('─'.repeat(62));
  console.log(`  监测读数       ${total} 条`);
  for (const lv of LEVELS) {
    const n = cnt(lv.code.toLowerCase());
    console.log(`  ${lv.code} ${lv.name.padEnd(12, ' ')} ${String(n).padStart(7)} 条  ${String(pct(n)).padStart(6)}%`);
  }
  console.log('─'.repeat(62));
  console.log(`  设备直报覆盖   ${result.cems.deviceDirectPct}%`);
  console.log(`  含 CRC-16      ${result.cems.crcPct}%`);
  console.log(`  含 SM3 指纹    ${result.cems.sm3Pct}%`);
  console.log(`  设备台账       ${dev.n} 行（ACTIVE ${dev.active}）`);
  console.log('─'.repeat(62));
  console.log('');
  for (const v of verdicts) {
    console.log(`  ${ICON[v.level]} ${v.text}`);
    console.log('');
  }
  console.log(`  输出  tools/out/data-provenance.json`);
  console.log('');

  await conn.end();
}

main().catch((e) => {
  console.error('审计失败：', e.message);
  process.exit(1);
});
