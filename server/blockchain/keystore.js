/**
 * keystore.js —— 链上钱包私钥托管（节点本地文件）
 * ------------------------------------------------------------------
 * 设计说明（这是本平台安全模型的一部分）：
 *   · 业务库中只保存企业的【公钥】与【钱包地址】，任何人都无法凭库里的数据伪造签名；
 *   · 私钥离线托管在节点本地的 keystore.json，不进入业务数据库、不随 SQL 备份外流；
 *   · 上链时由节点代持私钥完成 ECDSA 签名，验签只需要公钥。
 * 生产环境应替换为硬件加密机(HSM)或 KMS，本作业中用本地密钥库等价实现。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cu = require('./crypto-utils');
const config = require('../config');

const FILE = config.paths.keystore;
let store = {};

function load() {
  try {
    if (fs.existsSync(FILE)) {
      store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    }
  } catch (e) {
    store = {};
  }
  return store;
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2), 'utf8');
}

const byAddr = new Map();

function reindex() {
  byAddr.clear();
  Object.values(store).forEach((w) => byAddr.set(w.address, w));
}

/**
 * 取某个主体的钱包，不存在则新建并落盘。
 * ------------------------------------------------------------------
 * 用【确定性】密钥派生：私钥由 label 摘要而来，因此
 *   · 同一 label 在任何机器、任何次重跑都得到完全相同的地址与密钥；
 *   · 数据库初始化脚本在本机 MySQL 与云端 TiDB 上跑出的存证签名逐字节一致，
 *     同一份数据在两端重算哈希 / 验签都会通过 —— 这是跨环境可复现的前提。
 * @param {string} label 形如 'ent:12' / 'verifier:3' / 'regulator:system'
 */
function walletFor(label) {
  if (!store[label]) {
    store[label] = { label, ...cu.generateWalletDeterministic(label), createdAt: new Date().toISOString() };
    save();
  }
  byAddr.set(store[label].address, store[label]);
  return store[label];
}

/** 按地址反查钱包（用于验签时取公钥） */
function byAddress(addr) {
  if (byAddr.size === 0) reindex();
  return byAddr.get(addr) || null;
}

/** 系统/监管方钱包（代表"上级主管部门"节点） */
function systemWallet() {
  return walletFor('regulator:system');
}

function all() {
  return store;
}

load();
reindex();

module.exports = { load, save, walletFor, byAddress, systemWallet, all, FILE };
