/**
 * routes/chain.js —— 区块链浏览器 API
 * 区块查询 / 交易查询 / 全链校验 / 篡改演示 / 手动出块
 *
 * 说明：本模块的读接口完全开放（体现"公有链可审计"的特性）；
 * 篡改 / 还原 / 手动出块属于**破坏性写接口**，由环境变量 CHAIN_DEMO 控制，
 * **生产环境默认关闭**（安全默认），需显式 CHAIN_DEMO=true 才开放，供答辩演示或内网教学使用。
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('../services/anchor');
const anchorBatch = require('../services/anchorBatch');
const bizBinding = require('../services/bizBinding');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');

const router = express.Router();

/**
 * 链上时间的对外表示 —— 统一走 server/utils/time.js，本模块不再各写一份。
 * ---------------------------------------------------------------------
 * 背景（2026-10-29 巡检 P0）：chain_block.block_time 在库里存的是**UTC 字面量**
 * （区块哈希的输入是绝对秒数，写入时按 UTC 格式化，见 blockchain/chain.js）。
 * 早先接口把它原样透传，前端 App.fmt.dt() 按本地时区解析这个无时区标记的
 * 字符串 —— 浏览器上比真实时间早 8 小时：同一屏里区块列表 07:46、CEMS 16:16。
 *
 * 一度改成以 `UNIX_TIMESTAMP(block_time)` 为准，但那个函数**按会话时区解释**输入，
 * 而会话时区是连接级状态：链内核启动时的 `SET time_zone='+00:00'` 只作用于池里
 * 当时那一条连接，其余连接仍是 SYSTEM(+08) —— 于是同一张表在不同请求上解出
 * 相差 28800 秒的 epoch，时好时坏。最终一律按 UTC 字面量在 JS 侧解析，
 * 绕开会话时区，任何连接、任何部署都得到同一答案。
 */
const { fmtLocalTs, localFromUtcLiteral } = require('../utils/time');

const TX_TYPE_CN = {
  EMISSION_REPORT: '排放上报存证',
  VERIFY_REPORT: '核查报告存证',
  QUOTA_ALLOC: '配额分配存证',
  ENTERPRISE_REG: '企业备案存证',
  TRADE_DEAL: '履约流转成交存证',
  CREDIT_ASSET: '碳信用资产存证',
  FACTOR_VERSION: '因子版本发布存证',
  CEMS_BATCH: 'CEMS 实测批次存证',
  FILE_ANCHOR: '文件存证',
  ORACLE_FEED: '预言机数据存证',
  ANCHOR_BATCH: '批量锚点存证',
};

/**
 * 演示接口开关（安全默认：线上关闭）。
 * 原实现为 `process.env.CHAIN_DEMO !== 'false'` —— 即**线上默认开启**，
 * 意味着公网上任何人都能调用 /api/chain/tamper 去改写链上数据、调用 /repair 重挖后缀块。
 * 这些是**破坏性写接口**，绝不能默认暴露。现改为与 config.demoAccounts 一致的口径：
 *   显式 CHAIN_DEMO=true / false 优先；未设置时，只有非生产环境开放。
 */
const { isProd } = require('../config');
const DEMO = process.env.CHAIN_DEMO === 'true'
  || (process.env.CHAIN_DEMO === undefined && !isProd);
function demoOnly(req, res, next) {
  if (!DEMO) {
    return fail(res, '演示接口已在当前环境关闭（生产环境默认关闭；如需开启请显式设置 CHAIN_DEMO=true）', 403);
  }
  next();
}

/* 信任模型面板（院审意见①②③④的对外可核验出口） --------------------
 * 为什么需要这个接口：评审指出「声明与证据不对等」——平台声称
 * "链库分离 / 管理员无法篡改 / 数字有出处"，但评审现场没有任何一条
 * 能当场查询的通道。本接口把信任模型本身变成**可运行时核验的对象**：
 *
 *   ① splitDb        —— 实时查 information_schema：账本 5 表是否物理上
 *                       不在业务库（链库分离的直接证据，非文案）；
 *   ② sevenChecks    —— 七道校验逐层列出（每层回答"防的是哪种改动"）；
 *   ③ attack         —— 最近一次「同库同改」演练的判定摘要
 *                       （读 tools/out/attack-same-db.json 证据文件；
 *                        文件缺失时如实返回 null，不编造）；
 *   ④ metrics        —— 指标溯源台账的关键条目（存证笔数 / PoA 倍数 /
 *                       设备数等全部来自台账，台账缺证时为 null）；
 *   ⑤ deployMode     —— 部署形态的如实声明：云端=前后端分离部署
 *                       （静态资产与 API 分离托管），本地=同端口合并托管
 *                       （开发便利，不改变运行时契约）。
 *
 * 只读接口；除 information_schema 元数据外不触碰任何业务数据。 */
router.get('/trust-model', wrap(async (req, res) => {
  const config = require('../config');

  /* ---- ① 链库分离：两侧各查自己的 information_schema ----
   * ⚠ 必须分两次查、各走各的连接：
   *   业务池只能看见**本实例**上的 schema；账本库在另一台实例时，
   *   用业务池去查它的 schema 会静默得到 0 行，于是"账本表 0 张"被误读成
   *   "分离未完成"。上一版就踩了这个坑：隔离强度 L3 却报 separated=false。
   * 判据按 TABLE_TYPE 区分：业务库里的同名 chain_* 是 INVOKER 视图
   * （兼容层），只有 BASE TABLE 才是实体。 */
  const LEDGER_TABLES = ['chain_tx', 'chain_block', 'chain_node', 'chain_node_replica', 'chain_payload_backup'];
  const norm = (r) => ({
    schema: r.TABLE_SCHEMA ?? r.table_schema,
    name: r.TABLE_NAME ?? r.table_name,
    type: r.TABLE_TYPE ?? r.table_type,
  });
  const bizRows = await db.query(
    `SELECT table_schema, table_name, table_type FROM information_schema.tables
      WHERE table_schema = ? AND table_name IN (${LEDGER_TABLES.map(() => '?').join(',')})`,
    [config.db.database, ...LEDGER_TABLES]
  );
  let ledgerRows = [];
  let ledgerProbeError = null;
  try {
    ledgerRows = await db.ledgerQuery(
      `SELECT table_schema, table_name, table_type FROM information_schema.tables
        WHERE table_schema = ? AND table_name IN (${LEDGER_TABLES.map(() => '?').join(',')})`,
      [config.ledgerDb.database, ...LEDGER_TABLES]
    );
  } catch (e) { ledgerProbeError = e.code || e.message; }

  const bizBase = bizRows.map(norm).filter((r) => String(r.type).toUpperCase() === 'BASE TABLE').map((r) => r.name);
  const bizViews = bizRows.map(norm).filter((r) => String(r.type).toUpperCase() !== 'BASE TABLE').map((r) => r.name);
  const inLedger = ledgerRows.map(norm).filter((r) => String(r.type).toUpperCase() === 'BASE TABLE').map((r) => r.name);

  /* 分离强度分级 —— 院审意见①的正面回应。
   * 「另一个 schema」与「另一台实例」是两种强度完全不同的隔离，混为一谈就是
   * 声明与证据不对等。这里把强度算出来、写清楚，而不是笼统说"已分离"。 */
  const sep = db.separationFacts();
  const SEP_LEVELS = {
    L0: { label: '同库同表', guard: false, desc: '链上锚点与链下明文在同一张表/同一库 —— 一条 UPDATE 即可同改' },
    L1: { label: '同实例不同库', guard: false, desc: '同实例的两个 schema：DBA 同一会话执行两条 UPDATE 仍可同改；业务账号无写权限时才拦得住非 DBA' },
    L2: { label: '不同实例同账号', guard: true, desc: '两台实例、账号相同：网络层已切断同连接同改，账号被盗则两侧都能动' },
    L3: { label: '不同实例不同账号', guard: true, desc: '两台实例、两套账号：业务侧凭据在任何情况下都够不到账本库' },
  };
  const sepLevel = SEP_LEVELS[sep.level] || SEP_LEVELS.L0;

  /* 账本库连不上时应如实报告"读不到"，而不是伪装成"没有实体表"。
   * 探针错误已在上面的 information_schema 查询里捕获，这里复用同一个变量。 */
  const ledgerReachable = inLedger.length > 0 || !ledgerProbeError;

  const splitDb = {
    businessDb: config.db.database,
    ledgerDb: config.ledgerDb.database,
    /* 「分离」只按实体表位置判定；「强度」单独给，两个概念不混用 */
    separated: bizBase.length === 0 && inLedger.length > 0,
    level: sep.level,
    levelLabel: sepLevel.label,
    levelGuarded: sepLevel.guard,
    levelDesc: sepLevel.desc,
    sameInstance: sep.sameInstance,
    sameAccount: sep.sameUser,
    businessEndpoint: `${config.db.host}:${config.db.port}`,
    ledgerEndpoint: `${config.ledgerDb.host}:${config.ledgerDb.port}`,
    ledgerReachable,
    ledgerProbeError,
    ledgerBaseTablesInBusinessDb: bizBase,
    ledgerViewsInBusinessDb: bizViews,
    ledgerTablesInLedgerDb: inLedger,
    note: (bizBase.length === 0
      ? `账本实体表只在 ${config.ledgerDb.host}:${config.ledgerDb.port}/${config.ledgerDb.database}`
        + `（${inLedger.length} 张 BASE TABLE）；业务库 ${config.db.host}:${config.db.port}/${config.db.database} `
        + `中不存在任何账本对象${bizViews.length ? `（残留 ${bizViews.length} 张视图需清理）` : ''}`
      : `⚠ 业务库中仍存在账本实体表（${bizBase.join(', ')}），链库分离未完成`)
      + `　｜　隔离强度 ${sep.level}（${sepLevel.label}）：${sepLevel.desc}`,
  };

  /* ---- ② 七道校验清单 ---- */
  const sevenChecks = [
    { id: 1, name: '区块哈希重算', guards: '区块内容被改动', where: 'validateChain' },
    { id: 2, name: '共识合法性', guards: '非法节点出块 / 难度不足', where: 'validateChain' },
    { id: 3, name: 'prevHash 连续性', guards: '区块被抽换 / 断链', where: 'validateChain' },
    { id: 4, name: 'Merkle 根重算', guards: '区块内交易被增删改', where: 'validateChain' },
    { id: 5, name: '链下重算绑定', guards: '链下存证明文被改而锚点未动', where: 'validateChain' },
    { id: 6, name: '交易发起方签名', guards: 'payload_hash 被同步重算（私钥不在库中）', where: 'validateChain' },
    { id: 7, name: '业务行绑定（对账式）', guards: '业务表与链上摘要不一致', where: '/api/chain/business-binding' },
  ];

  /* ---- ③④ 证据文件读取（缺证如实报 null，绝不编数） ---- */
  const readJsonSafe = (rel) => {
    try {
      const p = path.join(config.paths.root, rel);
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
    } catch { return null; }
  };
  const attackRaw = readJsonSafe(path.join('tools', 'out', 'attack-same-db.json'));
  const attack = attackRaw ? {
    generatedAt: attackRaw.generatedAt,
    splitDb: attackRaw.splitDb,
    /* 演练时的隔离强度：与"当前"强度不一致时必须显示出来 ——
     * 拿旧环境下跑出的证据证明新环境的强度，正是评审最反感的那种错位。 */
    level: attackRaw.level || null,
    levelMatchesNow: attackRaw.level ? attackRaw.level === sep.level : null,
    summary: attackRaw.summary,
    cases: (attackRaw.cases || []).map((c) => ({
      case: c.case, expect: c.expect, verdict: c.verdict, hit: c.hit,
    })),
  } : null;

  const ledgerRaw = readJsonSafe(path.join('tools', 'out', 'metrics-ledger.json'));
  const LEDGER_KEYS = ['chain.txs', 'chain.blocks', 'consensus.ratio', 'iot.total', 'attack.hit', 'attack.mismatch', 'verify.assert.pass', 'verify.assert.total'];
  const metrics = ledgerRaw ? {
    generatedAt: ledgerRaw.generatedAt,
    totals: ledgerRaw.totals,
    key: (ledgerRaw.rows || []).filter((r) => LEDGER_KEYS.includes(r.id)).map((r) => ({
      id: r.id, claim: r.claim, value: r.value, unit: r.unit, status: r.status,
      cmd: r.cmd, capturedAt: r.capturedAt,
    })),
  } : null;

  /* ---- ⑤ 真实数据接入状态（院审意见③） ----
   * 判定口径（三者互斥，不允许含糊）：
   *   realBatches   —— batch_no 以 RCEMS- 开头的批次数（接入工具专用命名空间）
   *   realReadings  —— 上述批次的读数条数
   *   modeledReadings —— 其余全部读数（平台自举生成，不是任何设备上报的）
   * 为什么不用 source='CEMS' 来判"真实"：该字段也包含自举生成的读数，
   * 用它当真实数据口径，就是评审批评的那种混淆。 */
  let realData = null;
  try {
    const r = await db.one(
      `SELECT
         SUM(batch_no LIKE 'RCEMS-%')                             AS real_readings,
         SUM(batch_no NOT LIKE 'RCEMS-%' OR batch_no IS NULL)     AS modeled_readings,
         COUNT(DISTINCT CASE WHEN batch_no LIKE 'RCEMS-%' THEN batch_no END) AS real_batches
       FROM cems_reading`
    );
    const pkgPath = path.join(config.paths.root, 'tools', 'out', 'third-party-recompute.json');
    realData = {
      realBatches: Number(r.real_batches) || 0,
      realReadings: Number(r.real_readings) || 0,
      modeledReadings: Number(r.modeled_readings) || 0,
      recomputePackage: fs.existsSync(pkgPath),
      recomputePackageAt: fs.existsSync(pkgPath)
        ? (() => { try { return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).generatedAt; } catch { return null; } })()
        : null,
      ingestCmd: 'node tools/real-cems-ingest.mjs --file <报文> --mode=hj212|csv|json --ent-code=<信用代码>',
      recomputeCmd: 'node tools/real-cems-ingest.mjs --recompute-package',
    };
  } catch (e) {
    realData = { error: e.code || e.message };
  }

  /* ---- ⑥ 部署形态（对应院审意见④：消除"前后端分离 vs 同端口单进程"的矛盾） ----
   *
   * 矛盾的原话是：一边写"前后端分离"，一边又写"同端口单进程"。
   * 原因是这两个词在描述**不同层面**，却被并列成了同一层面的两种说法：
   *
   *   · 应用形态：本平台是**单一 Node 进程**，它同时提供 REST API 与前端静态资源。
   *     这不是"分离"，就是同进程同端口 —— 本地 `node server/app.js` 与线上一致。
   *   · 交付形态：线上把「静态文件」与「API」放到两个托管产品上
   *     （Cloudflare Pages 放静态、Workers/Render 放 API），这是**资产托管层面的分离**。
   *
   * 前端本身是运行期编译的 Vue（vendor/vue.global.prod.js + 纯 JS 视图），
   * 没有独立构建产物、没有 Node 侧渲染 —— 因此**不能**称作"前后端分离架构"。
   * 正确表述只有一句：**单一 Node 进程提供全部 API 与静态资源；
   * 线上按托管产品拆成静态与 API 两个入口，共用同一套 API 契约。**
   *
   * 这里把三个维度分开给：谁在跑（runtime）、资产怎么托管（assetHosting）、
   * 契约是否一致（contract）——让读者不可能再把它们混成一句话。 */
  const deployMode = {
    cloud: !!config.isCloud,
    runtime: {
      model: 'single-process',
      statement: '单一 Node 进程同时提供 REST API（/api/**）与前端静态资源（/）—— 本地与线上运行形态一致',
      apiBase: './api（相对路径，同源请求，无需跨域）',
      frontendBuild: '无独立构建产物：运行期编译的 Vue 3（vue.global.prod.js）+ 原生 JS 视图',
    },
    assetHosting: {
      separated: !!config.isCloud,
      statement: config.isCloud
        ? '线上托管分离：静态资产由 Cloudflare Pages 托管，API 由 Workers / Render 承载 —— 这是**托管层**的拆分，不是应用架构的拆分'
        : '本地同端口托管：Express 一个端口同时返回静态资产与 API',
    },
    contract: {
      consistent: true,
      statement: '两种托管形态共用同一套 API 契约与同一份前端代码，接口路径不随部署形态变化',
    },
    /* 一句话总结，供页面直接引用 —— 避免各处自行拼装出互相矛盾的说法 */
    oneLine: '单一 Node 进程提供全部 API 与静态资源；线上按托管产品拆成静态与 API 两个入口，'
      + '共用同一套 API 契约。**本平台不采用"前后端分离架构"这一说法。**',
  };

  ok(res, {
    generatedAt: new Date().toISOString(),
    splitDb,
    sevenChecks,
    attack,
    metrics,
    realData,
    deployMode,
    selfCheckHint: '完整演练与台账可用以下命令现场重跑：node tools/attack-same-db.mjs && node tools/metrics-ledger.mjs --strict',
  });
}));

/* 链概况 ------------------------------------------------------------ */
router.get('/stats', wrap(async (req, res) => {
  const chain = await anchorSvc.getChain();
  const stats = await chain.stats();
  /* ⚠ 链表一律走账本通道（ledger*）：账本库可以位于另一台 MySQL 实例，
   * 业务池上的同名对象只是同实例视图，跨实例时并不存在。见 db.js#separationFacts。 */
  const byBiz = await db.ledgerQuery(
    `SELECT tx_type AS type, COUNT(*) AS cnt FROM chain_tx GROUP BY tx_type ORDER BY cnt DESC`
  );
  const size = await db.ledgerOne(
    `SELECT IFNULL(SUM(size_bytes),0) AS s, IFNULL(SUM(tx_count),0) AS t FROM chain_block`
  );
  /* 原实现是 enterprise LEFT JOIN chain_tx 的跨库 JOIN —— 账本库独立成实例后
   * 该语句不可能成立。改为两段取回、应用层归并（企业表仅数十行，代价可忽略）。 */
  const ents = await db.query(
    'SELECT id, ent_name AS name, wallet_address AS address FROM enterprise'
  );
  const txPerAddr = await db.ledgerQuery(
    'SELECT from_address AS address, COUNT(*) AS cnt FROM chain_tx GROUP BY from_address'
  );
  const cntOf = new Map(txPerAddr.map((r) => [r.address, Number(r.cnt)]));
  const holders = ents
    .map((e) => ({ name: e.name, address: e.address, cnt: cntOf.get(e.address) || 0 }))
    .sort((a, b) => b.cnt - a.cnt)
    .slice(0, 10);

  ok(res, {
    ...stats,
    byBizType: byBiz.map((b) => ({ ...b, typeCn: TX_TYPE_CN[b.type] || b.type, cnt: Number(b.cnt) })),
    totalSize: Number(size.s),
    totalTxInBlocks: Number(size.t),
    topAccounts: holders,
  });
}));

/* 区块列表 ---------------------------------------------------------- */
router.get('/blocks', wrap(async (req, res) => {
  const page = await db.ledgerPaginate(
    `SELECT block_index, block_hash, prev_hash, merkle_root, nonce, difficulty, consensus,
            proposer, proposer_sig, tx_count, miner, size_bytes, mine_time,
            UNIX_TIMESTAMP(block_time) AS ts, block_time
     FROM chain_block ORDER BY block_index DESC`, [], req.query
  );
  /* 统一时区口径：block_time 落库是 UTC 字面量，按 UTC 解析后转本地展示。
   * 不用 r.ts（UNIX_TIMESTAMP）—— 会话时区不确定时它会差 8 小时。 */
  if (page && Array.isArray(page.rows)) {
    page.rows = page.rows.map((r) => ({ ...r, block_time: localFromUtcLiteral(r.block_time) || r.block_time }));
  }
  ok(res, page);
}));

/* 区块详情（含区块内交易） ------------------------------------------- */
router.get('/blocks/:index', wrap(async (req, res) => {
  /* 必须先校验高度是合法整数。
   *
   * 原实现直接把 req.params.index 交给 mysql2 绑定。传入 `/blocks/abc` 时
   * Number('abc') 是 NaN，而 mysql2 把 NaN 绑成 0 —— 于是查询命中创世区块，
   * 接口返回 200 + 一个"看起来正常"的区块。
   * 调用方以为自己查的是某个高度，实际拿到的是 #0。
   * 这类"参数非法却返回看似正常数据"的问题，比直接报错危险得多：
   * 浏览器/小程序会把 #0 当作被查询的区块展示，用户无从察觉查错了对象。
   * 因此这里显式拒绝非整数与负数，返回 400 而不是悄悄查 0。 */
  const idx = Number(req.params.index);
  if (!Number.isInteger(idx) || idx < 0) {
    return fail(res, '区块高度必须是非负整数', 400);
  }
  const b = await db.ledgerOne(
    'SELECT *, UNIX_TIMESTAMP(block_time) AS ts FROM chain_block WHERE block_index = ?', [idx]
  );
  if (!b) return fail(res, '区块不存在', 404);
  const txs = await db.ledgerQuery(
    `SELECT tx_id, tx_type, biz_no, from_address, to_address, payload_hash, payload_json,
            nonce, gas_fee, status, created_at
     FROM chain_tx WHERE block_index = ? ORDER BY id`, [idx]
  );
  const hashes = txs.map((t) => t.tx_id);
  const proof = cu.merkleProof(hashes, 0);
  /* 权威 epoch 以 block_time 的 UTC 字面量为准（写入时就是这么格式化的），
   * 不取 UNIX_TIMESTAMP —— 后者受会话时区影响，会在部分连接上差 28800 秒，
   * 进而让"现场重算哈希"与记录值不符，把好块报成坏块。 */
  const tsTrue = (() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(b.block_time || ''));
    return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000) : Number(b.ts);
  })();

  const block = {
    index: Number(b.block_index), hash: b.block_hash, prevHash: b.prev_hash,
    merkleRoot: b.merkle_root, nonce: Number(b.nonce), difficulty: Number(b.difficulty),
    consensus: b.consensus || 'POW', proposer: b.proposer || null, proposerSig: b.proposer_sig || null,
    txCount: Number(b.tx_count), miner: b.miner, sizeBytes: Number(b.size_bytes),
    mineTime: Number(b.mine_time), blockTime: fmtLocalTs(tsTrue) || b.block_time, timestamp: tsTrue,
  };
  // 现场重算：本区块记录哈希与实时重算哈希是否一致
  const recomputed = require('../blockchain/chain').Blockchain.calcHash(block);
  // PoA 出块签名现场验签（证明是本轮授权节点出的块）
  let proposerSigValid = null;
  if (block.consensus === 'POA' && block.proposerSig) {
    try {
      const node = await db.ledgerOne('SELECT public_key FROM chain_node WHERE node_id = ?', [block.proposer]);
      const pub = node && node.public_key
        ? node.public_key
        : require('../blockchain/keystore').all()[`node:${block.proposer}`]?.publicKey;
      proposerSigValid = !!(pub && cu.verify(pub, require('../blockchain/chain').Blockchain.signingPayload(block), block.proposerSig));
    } catch (e) { proposerSigValid = null; }
  }

  ok(res, {
    block,
    recomputedHash: recomputed,
    hashMatch: recomputed === block.hash,
    proposerSigValid,
    // 注意：这里的 block 是上面重塑过的驼峰对象，字段名是 merkleRoot；
    // 早前误写成 block.merkle_root（那是原始行 b 的字段名），
    // 导致恒为 undefined、rootMatches 永远是 false。改回 merkleRoot 后与 b 同源一致。
    merkle: { root: proof.root, rootMatches: proof.root === block.merkleRoot, samplePath: proof.path },
    transactions: txs.map((t) => ({
      ...t,
      txTypeCn: TX_TYPE_CN[t.tx_type] || t.tx_type,
      nonce: Number(t.nonce),
      gas_fee: Number(t.gas_fee),
      created_at: localFromUtcLiteral(t.created_at),
      payload: typeof t.payload_json === 'string' ? safeParse(t.payload_json) : t.payload_json,
    })),
  });
}));

/* 交易列表 ---------------------------------------------------------- */
router.get('/txs', wrap(async (req, res) => {
  const { type, status, keyword, blockIndex } = req.query;
  const where = ['1=1'];
  const params = [];
  if (type) { where.push('tx_type = ?'); params.push(type); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (blockIndex !== undefined && blockIndex !== '') { where.push('block_index = ?'); params.push(Number(blockIndex)); }
  if (keyword) { where.push('(tx_id LIKE ? OR biz_no LIKE ? OR from_address LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  const page = await db.ledgerPaginate(
    `SELECT id, tx_id, tx_type, biz_no, block_index, from_address, to_address, payload_hash,
            nonce, gas_fee, status, created_at, confirmed_at
     FROM chain_tx WHERE ${where.join(' AND ')} ORDER BY id DESC`, params, req.query
  );
  ok(res, {
    ...page,
    rows: page.rows.map((r) => ({
      ...r,
      txTypeCn: TX_TYPE_CN[r.tx_type] || r.tx_type, nonce: Number(r.nonce), gas_fee: Number(r.gas_fee),
      /* UTC 字面量 → 本地时区（见 utils/time.js 的说明） */
      created_at: localFromUtcLiteral(r.created_at),
      confirmed_at: localFromUtcLiteral(r.confirmed_at),
    })),
  });
}));

/* 交易详情（验签 + Merkle 证明） ------------------------------------- */
router.get('/tx/:txId', wrap(async (req, res) => {
  const tx = await db.ledgerOne('SELECT * FROM chain_tx WHERE tx_id = ?', [req.params.txId]);
  if (!tx) return fail(res, '交易不存在', 404);

  const block = tx.block_index === null ? null : await db.ledgerOne(
    'SELECT *, UNIX_TIMESTAMP(block_time) AS ts FROM chain_block WHERE block_index = ?', [tx.block_index]
  );
  let merkle = null;
  if (block) {
    const list = await db.ledgerQuery('SELECT tx_id FROM chain_tx WHERE block_index = ? ORDER BY id', [tx.block_index]);
    const idx = list.findIndex((t) => t.tx_id === tx.tx_id);
    const proof = cu.merkleProof(list.map((t) => t.tx_id), idx);
    merkle = {
      leafIndex: idx, leafHash: tx.tx_id, root: proof.root, path: proof.path,
      rootMatches: proof.root === block.merkle_root,
      verified: cu.verifyMerkleProof(tx.tx_id, proof.path, proof.root),
    };
  }
  const signatureValid = tx.signature
    ? cu.verify(tx.pub_key, cu.stableStringify({
      txId: tx.tx_id, txType: tx.tx_type, bizNo: tx.biz_no, fromAddress: tx.from_address,
      toAddress: tx.to_address, payloadHash: tx.payload_hash, nonce: Number(tx.nonce),
    }), tx.signature)
    : false;

  const payload = typeof tx.payload_json === 'string' ? safeParse(tx.payload_json) : tx.payload_json;
  const payloadIntact = cu.hashObject(payload) === tx.payload_hash;

  ok(res, {
    tx: {
      txId: tx.tx_id, txType: tx.tx_type, txTypeCn: TX_TYPE_CN[tx.tx_type] || tx.tx_type,
      bizNo: tx.biz_no, blockIndex: tx.block_index, from: tx.from_address, to: tx.to_address,
      payloadHash: tx.payload_hash, nonce: Number(tx.nonce), fee: Number(tx.gas_fee),
      status: tx.status, signature: tx.signature, pubKey: tx.pub_key,
      /* created_at 与 block_time 同为 UTC 字面量，统一转本地时区再给前端 */
      createdAt: localFromUtcLiteral(tx.created_at),
    },
    payload,
    block: block && {
      index: Number(block.block_index), hash: block.block_hash, prevHash: block.prev_hash,
      merkleRoot: block.merkle_root, nonce: Number(block.nonce), difficulty: Number(block.difficulty),
      blockTime: localFromUtcLiteral(block.block_time), miner: block.miner,
    },
    verify: { signatureValid, payloadIntact },
    merkle,
  });
}));

/* 交易池 ------------------------------------------------------------ */
router.get('/pool', wrap(async (req, res) => {
  const rows = await db.ledgerQuery(
    `SELECT tx_id, tx_type, biz_no, from_address, payload_hash, status, created_at
     FROM chain_tx WHERE status = 'PENDING' ORDER BY id DESC LIMIT 50`
  );
  const chain = await anchorSvc.getChain();
  ok(res, { count: chain.pool.length, rows: rows.map((r) => ({ ...r, created_at: localFromUtcLiteral(r.created_at) })) });
}));

/* 全链完整性校验 ----------------------------------------------------- */
router.get('/validate', wrap(async (req, res) => {
  const chain = await anchorSvc.getChain();
  /* 全链校验是重活（对每个区块做出块签名验签 + Merkle 重建，对每笔交易做链下重算绑定）。
   * 监管端与浏览器会高频轮询本接口，故走带缓存的入口：
   *   · 默认 TTL 5s，且缓存键含链数据变更版本号 —— 出块/篡改/修复会立刻使其失效；
   *   · 传 ?fresh=1 可强制穿透缓存重算（答辩现场演示防篡改时用，确保看到实时结果）。
   * 返回体新增 cached / cacheAgeMs，如实告知调用方本次是否为复用结果。 */
  const fresh = String(req.query.fresh || '') === '1';
  const r = await chain.validateChainCached({
    fromIndex: Number(req.query.fromIndex) || 0,
    ttlMs: fresh ? 0 : 5000,
  });
  ok(res, {
    ...r,
    errors: r.errors.slice(0, 50),
    errorCount: r.errors.length,
    criteria: [
      '① 逐块重算 SHA-256，比对记录的区块哈希（区块内容是否被改动）',
      '② 校验每块的共识合法性：PoA 块验「出块节点签名 + 联盟授权资格」；历史 PoW 块验难度前导零',
      '③ 校验 prevHash 是否指向上一区块（链是否连续、区块是否被抽换）',
      '④ 由链上交易表重算 Merkle 根，与区块头比对（区块内交易是否被增删改）',
      '⑤ 链下重算绑定：用链下业务明文重算 SHA-256，与链上锚定的 payload_hash 比对'
        + '（链下明细是否被改动而链上锚点未变 —— 这是"链上存证 + 链下存储"结构下唯一的链下完整性出口）',
    ],
    // 如实披露本次结果是否为缓存复用。缓存键含链数据变更版本号，
    // 因此任何写入（出块 / 篡改 / 修复）都会即时失效，不存在"链已破坏仍报 valid"的窗口。
    freshness: r.cached
      ? `复用 ${r.cacheAgeMs} ms 前的校验结果（链高与链数据版本均未变化）；如需强制重算请加 ?fresh=1`
      : '本次为实时重算（缓存窗口外，或链数据刚发生变更）',
  });
}));

/* 第六道：业务行 ↔ 链上摘要 绑定核对（对账式） -----------------------
 * 补的是五道校验覆盖不到的那一段：业务表那一行本身。
 * 第⑤道只重算 chain_tx.payload_json，证明「存证快照没被改」；
 * 本接口证明「业务表里的这一行仍等于上链时的那一份」。
 * 典型用途：监管抽查、审计取证、篡改演练的判定依据。
 * 只读接口，不做任何写入；由监管端、核查端与系统管理端使用。 */
router.get('/business-binding',
  authRequired, requireRole('REGULATOR', 'VERIFIER'), wrap(async (req, res) => {
    const r = await bizBinding.verifyBusinessBinding({
      txType: req.query.txType || undefined,
      sinceBlock: req.query.sinceBlock === undefined ? undefined : Number(req.query.sinceBlock),
      limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
    });
    ok(res, r, r.mismatch
      ? `发现 ${r.mismatch} 处业务行与链上摘要失配（业务库被改动而链上锚点未变）`
      : `已核对 ${r.checked} 笔存证，业务行与链上摘要全部一致`);
    writeLog(req, 'CHAIN_BIZ_BINDING', `核对 ${r.checked} 笔，失配 ${r.mismatch} 笔`);
  }));

/* 篡改演示 ---------------------------------------------------------- */
router.post('/tamper', demoOnly, wrap(async (req, res) => {
  const { blockIndex, field } = req.body || {};
  const chain = await anchorSvc.getChain();
  const r = await chain.tamper(Number(blockIndex), field || 'merkle_root');
  const msg = r.field === 'offchain_payload'
    ? `已篡改区块 #${r.blockIndex} 内交易的**链下明细**字段 ${r.changedKey}（链上锚点未动）；`
      + `全链校验结果：${r.validation.valid ? '链上四道校验均通过、第五道亦未告警' : `发现 ${r.validation.errors.length} 处异常（第五道「链下重算绑定」）`}`
    : `已模拟篡改区块 #${r.blockIndex} 的 ${r.field} 字段，全链校验结果：${r.validation.valid ? '未发现异常' : `发现 ${r.validation.errors.length} 处异常`}`;
  ok(res, r, msg);
}));

/* 还原链下明细篡改（配合 field=offchain_payload 的演示） ---------------- */
router.post('/repair-payload', demoOnly, wrap(async (req, res) => {
  const chain = await anchorSvc.getChain();
  const r = await chain.repairOffChainPayload((req.body || {}).blockIndex);
  ok(res, r, `已还原 ${r.restored} 笔链下明细，第五道校验结果：${r.validation ? (r.validation.valid ? '通过' : '仍有异常') : '无需校验'}`);
}));

/* 修复链（重做后缀 PoW） --------------------------------------------- */
router.post('/repair', demoOnly, wrap(async (req, res) => {
  const fromIndex = Number((req.body || {}).fromIndex) || 0;
  const chain = await anchorSvc.getChain();
  const r = await chain.repairChain(fromIndex);
  ok(res, r, `已从区块 #${fromIndex} 起重算后缀哈希并重做工作量证明，共修复 ${r.repaired.length} 个区块`);
}));

/* 手动出块 ---------------------------------------------------------- */
router.post('/mine', demoOnly, wrap(async (req, res) => {
  const chain = await anchorSvc.getChain();
  if (!chain.pool.length) return fail(res, '当前交易池为空，无可打包交易', 400);
  const block = await chain.mineBlock();
  if (req.user) await writeLog(req, '链上存证', '手动出块', `#${block.index}`, `打包 ${block.txCount} 笔交易`);
  ok(res, block, `出块成功：#${block.index}，打包 ${block.txCount} 笔交易，耗时 ${block.mineTime}ms`);
}));

/** 通用：按地址查询该主体的全部存证 */
router.get('/address/:address', wrap(async (req, res) => {
  const addr = String(req.params.address || '');
  /* 地址一律是 0x + 40 位十六进制。不校验就等于把任意字符串
     （包括 <script> 片段）原样回显给客户端，还会白白跑三次全表查询。
     校验后：非法地址 400 + 中文提示，且不进入查询。 */
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return fail(res, '钱包地址格式不合法：应为 0x 开头的 40 位十六进制', 400);
  }
  const ent = await db.one('SELECT id, ent_name, industry, region FROM enterprise WHERE wallet_address = ?', [addr]);
  const ver = await db.one('SELECT id, org_name, region FROM verifier_org WHERE wallet_address = ?', [addr]);
  const txs = await db.ledgerQuery(
    `SELECT tx_id, tx_type, biz_no, block_index, to_address, payload_hash, created_at
     FROM chain_tx WHERE from_address = ? ORDER BY id DESC LIMIT 100`, [addr]
  );
  const stats = await db.ledgerOne(
    `SELECT COUNT(*) AS cnt, IFNULL(SUM(gas_fee),0) AS fee FROM chain_tx WHERE from_address = ?`, [addr]
  );
  ok(res, {
    address: addr,
    owner: ent ? { type: 'ENTERPRISE', ...ent } : (ver ? { type: 'VERIFIER', ...ver } : null),
    txCount: Number(stats.cnt),
    totalFee: Number(stats.fee),
    txs: txs.map((t) => ({
      ...t,
      txTypeCn: TX_TYPE_CN[t.tx_type] || t.tx_type,
      created_at: localFromUtcLiteral(t.created_at),
    })),
  });
}));

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

/* ==================================================================
 * 批量锚定（WP3 链内核规模化）
 * ------------------------------------------------------------------
 * 设计要点：把时间窗内 N 笔业务存证组织为 1 棵 Merkle 树，链上只留 1 个锚点。
 * 读接口开放（可审计性），触发接口需监管/管理角色（属运营动作，非演示破坏性操作）。
 * ================================================================== */

/* 锚定统计（含状态语义说明，防止把 PENDING 误读为"未上链"） */
router.get('/anchor/stats', wrap(async (req, res) => {
  ok(res, await anchorBatch.stats());
}));

/* 批次列表 */
router.get('/anchor/batches', wrap(async (req, res) => {
  const r = await anchorBatch.listBatches({ page: req.query.page, size: req.query.size });
  ok(res, r);
}));

/* 批次详情（含全部叶） */
router.get('/anchor/batch/:batchNo', wrap(async (req, res) => {
  const b = await anchorBatch.getBatch(req.params.batchNo);
  if (!b) return fail(res, `批次 ${req.params.batchNo} 不存在`, 404);
  ok(res, b);
}));

/* 单笔存证的 Merkle 存在性证明（O(log N) 独立验证） */
router.get('/anchor/proof', wrap(async (req, res) => {
  const { batchNo, txId } = req.query;
  if (!batchNo || !txId) return fail(res, '缺少 batchNo 或 txId 参数', 400);
  const p = await anchorBatch.getProof(batchNo, txId);
  if (!p.found) return fail(res, '该存证不属于指定批次', 404);
  ok(res, p);
}));

/* 触发一次批量锚定（监管 / 管理角色） */
router.post('/anchor/run', authRequired, requireRole('REGULATOR'), wrap(async (req, res) => {
  const r = await anchorBatch.createBatch({
    limit: (req.body || {}).limit,
    actor: req.user && req.user.role === 'REGULATOR' ? 'regulator:system' : 'regulator:system',
  });
  if (!r.created) return ok(res, r, r.hint || '当前无可锚定的存证');
  await writeLog(req, '链上存证', '批量锚定',
    r.batchNo, `${r.leafCount} 笔存证 → 1 个锚点，根 ${r.merkleRoot.slice(0, 16)}…`);
  ok(res,
    r,
    `批量锚定完成：${r.leafCount} 笔存证聚合为 1 个锚点（压缩比 ${r.compressionRatio}），`
    + `锚点交易 ${r.anchorTxId.slice(0, 16)}… 落于区块 #${r.anchorBlockIndex}`);
}));

/* 内部锚定入口（小程序 → 权威链） -------------------------------------
 * 为什么需要它（2026-10-31 两端联调）：
 *   小程序后端曾自持一条 SQLite 链并用 appendBlock 出块，而链路页/存证页
 *   已经代理到本平台权威链 —— 结果是"写进 A 链、读的是 B 链"：
 *   企业在小程序上报后拿到的块号（#160/161）在权威链上是**别的交易**，
 *   平台端完全查不到这笔上报，两端口径永久分叉（违反约束③）。
 *   修法不是让小程序自己继续出块（那仍是第二条链），而是让它把存证交给
 *   权威链出块，本地只保留业务表并回写 chain_tx_id。
 *
 * 鉴权：共享密钥头 x-internal-token，比对 MINI_ANCHOR_TOKEN。
 *   未配置该变量时接口**直接 403 关闭**（安全默认：没有密钥就没有入口），
 *   避免公网任何人都能往链上写存证。
 */
const MINI_ANCHOR_TOKEN = process.env.MINI_ANCHOR_TOKEN || '';
router.post('/internal/anchor', wrap(async (req, res) => {
  if (!MINI_ANCHOR_TOKEN) {
    return fail(res, '内部锚定入口未启用（未配置 MINI_ANCHOR_TOKEN）', 403);
  }
  const provided = String(req.headers['x-internal-token'] || '');
  const a = Buffer.from(provided);
  const b = Buffer.from(MINI_ANCHOR_TOKEN);
  /* 定长比较：避免逐字节提前返回泄露前缀 */
  const same = a.length === b.length && require('crypto').timingSafeEqual(a, b);
  if (!same) return fail(res, '内部锚定凭据无效', 403);

  const { txType, bizNo, payload, fromLabel, toLabel } = req.body || {};
  if (!txType) return fail(res, '缺少 txType', 400);
  if (!bizNo) return fail(res, '缺少 bizNo', 400);

  const chain = await anchorSvc.anchor({
    txType,
    bizNo,
    payload: payload || {},
    fromLabel: fromLabel || 'regulator:system',
    toLabel,
  });
  return ok(res, {
    txId: chain.txId,
    payloadHash: chain.payloadHash,
    blockIndex: chain.blockIndex,
    blockHash: chain.blockHash,
    blockTime: chain.blockTime,
  }, `存证已写入权威链区块 #${chain.blockIndex}`);
}));

/* 内部：预警处置结果同步给小程序（2026-10-31 通知互通）
 * ------------------------------------------------------------------
 * 两端各有一张预警表（平台 alert_record / 小程序 cc_alert），编号体系
 * 完全不同（AL2600001 vs AL202600001），企业归属也不一致。做实时推送前
 * 必须先解决"哪条是同一件事"的问题，所以这里只暴露**按企业 id 查询
 * 处置状态**的只读视图：小程序侧用自己的 alert 记录发起查询，按 ent_id
 * 与时间窗口匹配，把平台侧的处置结论合并展示。
 *
 * 鉴权与 internal/anchor 相同（x-internal-token），未配置则 403 关闭。 */
router.get('/internal/alerts', wrap(async (req, res) => {
  if (!MINI_ANCHOR_TOKEN) return fail(res, '内部接口未启用（未配置 MINI_ANCHOR_TOKEN）', 403);
  const provided = String(req.headers['x-internal-token'] || '');
  const a = Buffer.from(provided);
  const b = Buffer.from(MINI_ANCHOR_TOKEN);
  if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) {
    return fail(res, '内部凭据无效', 403);
  }
  const entId = Number(req.query.entId);
  if (!Number.isInteger(entId) || entId <= 0) return fail(res, 'entId 必须为正整数', 400);
  const rows = await db.query(
    `SELECT alert_no, ent_id, alert_type, level, title, status, handler, handle_note, created_at, closed_at
       FROM alert_record WHERE ent_id = ? ORDER BY id DESC LIMIT 100`,
    [entId],
  );
  return ok(res, {
    entId,
    total: rows.length,
    rows: rows.map((r) => ({
      alertNo: r.alert_no,
      type: r.alert_type,
      level: r.level,
      title: r.title,
      status: r.status,
      handler: r.handler || null,
      note: r.handle_note || null,
      createdAt: r.created_at,
      closedAt: r.closed_at,
    })),
  });
}));

module.exports = router;
