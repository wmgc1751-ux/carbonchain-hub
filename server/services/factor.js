/**
 * factor.js —— 排放因子库与版本管理
 * ------------------------------------------------------------------
 * 对齐 GB/T 32150 等国家标准：排放因子是核算的「系数」，其版本直接影响核算结果。
 * 为保证历史核算可复现，因子采用「版本管理」：
 *   · 因子库（emission_factor）保存当前生效因子；
 *   · 版本表（factor_version）记录每一次发布，含生效日期区间；
 *   · 旧版本只读，新版本发布后旧版本自动归档（effective_to 封口）。
 *
 * 因子版本发布 → 哈希上链（txType = FACTOR_VERSION），形成「核算规则合约」的链上固化。
 *
 * @module services/factor
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('./anchor');

const FACTOR_TYPES = {
  COAL: '原煤', COKE: '焦炭', GAS: '天然气', DIESEL: '柴油',
  FUEL_OIL: '燃料油', POWER: '电力', HEAT: '热力',
};

function mapFactor(r) {
  return {
    id: Number(r.id),
    energyType: r.energy_type,
    energyCn: FACTOR_TYPES[r.energy_type] || r.energy_type,
    factor: Number(r.factor),
    unit: r.unit,
    scope: Number(r.scope),
    source: r.source,
    industry: r.industry,
    version: r.version,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    status: r.status,
    remark: r.remark,
  };
}

/** 因子库列表 */
async function listFactors(filters = {}) {
  const where = [];
  const params = [];
  if (filters.energyType) { where.push('energy_type = ?'); params.push(filters.energyType); }
  if (filters.industry) { where.push('industry = ?'); params.push(filters.industry); }
  const rows = await db.query(
    `SELECT * FROM emission_factor
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY energy_type, industry, id`, params
  );
  return rows.map(mapFactor);
}

/** 新增/更新因子（保存草稿，不立即生效） */
async function upsertFactor(p) {
  const { id, energyType, factor, unit, scope, source, industry, remark } = p;
  if (!energyType) throw new Error('能源品种不能为空');
  const f = Number(factor);
  if (!(f > 0)) throw new Error('排放因子必须大于 0');
  const sc = Number(scope) === 2 ? 2 : 1;

  if (id) {
    await db.query(
      `UPDATE emission_factor SET factor=?, unit=?, scope=?, source=?, industry=?, remark=? WHERE id=?`,
      [f, unit || 'tCO2e/单位', sc, source || null, industry || null, remark || null, Number(id)]
    );
    return db.one('SELECT * FROM emission_factor WHERE id = ?', [Number(id)]);
  }
  const [ins] = await db.pool.query(
    `INSERT INTO emission_factor (energy_type, factor, unit, scope, source, industry, remark)
     VALUES (?,?,?,?,?,?,?)`,
    [energyType, f, unit || 'tCO2e/单位', sc, source || null, industry || null, remark || null]
  );
  return db.one('SELECT * FROM emission_factor WHERE id = ?', [ins.insertId]);
}

/**
 * 发布因子版本：把当前因子库快照固化为一个新版本，
 * 旧版本 effective_to 封口，新版本生效并上链存证。
 */
async function publishVersion(p) {
  const { version, effectiveFrom, operator } = p;
  if (!version) throw new Error('版本号不能为空');
  const from = effectiveFrom ? new Date(effectiveFrom) : new Date();

  // 校验版本号唯一
  const dup = await db.one('SELECT id FROM factor_version WHERE version = ?', [version]);
  if (dup) throw new Error(`版本 ${version} 已存在`);

  // 封口旧版本
  await db.query(
    `UPDATE factor_version SET effective_to = ?, status = 'ARCHIVED' WHERE status = 'ACTIVE'`,
    [from]
  );
  await db.query(
    `UPDATE emission_factor SET effective_to = ? WHERE status = 'ACTIVE' AND effective_to IS NULL`,
    [from]
  );

  // 生成版本快照（因子库当前值）
  const factors = await db.query('SELECT * FROM emission_factor ORDER BY id');
  const snapshot = factors.map((f) => ({
    energyType: f.energy_type, factor: Number(f.factor), unit: f.unit,
    scope: Number(f.scope), source: f.source, industry: f.industry,
  }));

  const versionNo = version;
  const [ins] = await db.pool.query(
    `INSERT INTO factor_version (version, effective_from, effective_to, operator, snapshot, status)
     VALUES (?,?,NULL,?,?,'ACTIVE')`,
    [versionNo, from, operator || null, JSON.stringify(snapshot)]
  );

  // 更新因子库 version 标记
  await db.query('UPDATE emission_factor SET version = ? WHERE 1=1', [versionNo]);

  // 上链存证
  let chain = null;
  try {
    chain = await anchorSvc.anchor({
      txType: 'FACTOR_VERSION',
      bizNo: `FV-${versionNo}`,
      fromLabel: 'regulator:system',
      payload: {
        version: versionNo, effectiveFrom: from.toISOString(),
        factorCount: snapshot.length,
        snapshotHash: cu.hashObject(snapshot),
      },
    });
    await db.query('UPDATE factor_version SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
      [chain.blockIndex, chain.txId, ins.insertId]);
  } catch (e) {
    console.error('[factor] 版本上链失败：', e.message);
  }

  return {
    version: versionNo, effectiveFrom: from, factorCount: snapshot.length,
    chainBlockIndex: chain ? chain.blockIndex : null, chainTxId: chain ? chain.txId : null,
  };
}

/** 版本历史 */
async function listVersions() {
  const rows = await db.query('SELECT * FROM factor_version ORDER BY effective_from DESC, id DESC');
  return rows.map((r) => ({
    id: Number(r.id), version: r.version,
    effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
    operator: r.operator, status: r.status,
    factorCount: (JSON.parse(r.snapshot || '[]')).length,
    chainBlockIndex: r.chain_block_index, chainTxId: r.chain_tx_id,
  }));
}

module.exports = {
  FACTOR_TYPES, listFactors, upsertFactor, publishVersion, listVersions,
};
