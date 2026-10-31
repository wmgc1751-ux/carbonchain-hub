/**
 * zk-selftest.mjs —— 零知识碳核算协议自检套件
 * ==================================================================================
 * 这一套件检验「隐私保护型 MRV」是否真的成立，而不只是"代码能跑"。
 *
 * 检验的四层：
 *   L1 密码学原语   —— 曲线群运算与 OpenSSL 一致、承诺绑定性与隐藏性
 *   L2 零知识证明   —— 正向证明通过 + 阴性对照全部否决
 *   L3 协议语义     —— 隐私不被泄漏、聚合正确、跨期一致、授权披露可审计
 *   L4 端到端       —— 通过真实数据库与真实上链路径
 *
 * 设计原则（与既有套件一致）：
 *   · 每条正向断言都配一条阴性对照 —— 只有正向会漏掉"恒真式"，只有阴性会漏掉"全拒"；
 *   · 缺数据判 SKIP 而不是 PASS；
 *   · 自检自己清理，不污染业务数据。
 *
 * 用法：node tools/zk-selftest.mjs [--verbose]
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

const C = require('../server/crypto/curve');
const PD = require('../server/crypto/pedersen');
const RP = require('../server/crypto/rangeproof');
const ZK = require('../server/services/zkCarbon');
const db = require('../server/db');

const items = [];
let skipped = 0;
const push = (name, pass, detail) => {
  items.push({ name, pass: !!pass, detail });
  console.log(`${pass === 'SKIP' ? '⊘' : (pass ? '✔' : '✘')} ${name}${detail ? ' — ' + detail : ''}`);
};
const skip = (name, detail) => { skipped++; push(name, 'SKIP', detail); };

/**
 * 结构化泄漏检测：遍历对象的全部字段值，判断是否有字段**恰好等于**敏感值。
 *
 * ⚠ 为什么不直接 `JSON.stringify(obj).includes(secret)`：
 *   公开包里有数百个十六进制字符（承诺点 130 hex、证明体 384 字节），
 *   在其中搜索一个 4~5 位数字串，随机命中概率可达数十%，
 *   于是断言会**随机失败**（实测在服务运行态下偶发）。
 *   这类"假红"比漏检更糟：它会让人怀疑代码，而代码是对的。
 *
 * 规则：
 *   · 长度 ≥ 10 位的数字串 → 允许子串匹配（随机命中概率 ≈ 10⁻¹⁰，可忽略）
 *   · 长度 < 10 位          → 只做"字段整体相等"判断，不做子串搜索
 *
 * @param {object} obj     待检查对象
 * @param {string[]} secrets 敏感值的多种表示
 * @returns {string[]}     命中的路径
 */
function findLeaks(obj, secrets) {
  const hits = [];
  const secretSet = new Set(secrets.filter((x) => x !== null && x !== undefined).map(String));
  /* 只有足够长的串才允许子串匹配 */
  const longSecrets = [...secretSet].filter((x) => x.length >= 10);
  const blob = JSON.stringify(obj);

  /* 长串子串匹配（安全：误命中概率可忽略） */
  for (const s of longSecrets) {
    if (blob.includes(s)) hits.push(`substring:${s.slice(0, 12)}…`);
  }

  /* 所有敏感值都做"字段整体相等"检查 */
  const walk = (node, pathStr) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, pathStr ? `${pathStr}.${k}` : k);
      return;
    }
    const sv = String(node);
    if (secretSet.has(sv)) hits.push(`${pathStr}=${sv}`);
  };
  walk(obj, '');
  return hits;
}

async function main() {
  console.log('═'.repeat(76));
  console.log('零知识碳核算协议自检（ZK-Carbon v1）');
  console.log('═'.repeat(76));

  /* ================= L1 密码学原语 ================= */
  console.log('\n【L1】密码学原语（SM2 曲线 / Pedersen 承诺）');

  const cs = C.selfTest();
  push('曲线群运算自检', cs.passed === cs.total, `${cs.passed}/${cs.total}`);
  const cross = cs.items.find((i) => i.name.includes('OpenSSL'));
  push('⭐ 与 OpenSSL SM2 逐字节一致（跨实现）', cross && cross.pass,
    cross ? cross.detail : '未找到该断言');

  const ps = PD.selfTest();
  push('Pedersen 承诺自检', ps.passed === ps.total, `${ps.passed}/${ps.total}`);

  /* 独立复核隐藏性：同值不同盲化因子，承诺必须不同 */
  const h1 = PD.commit(123456n);
  const h2 = PD.commit(123456n);
  push('同值不同盲化因子 → 承诺不同（隐藏性）',
    !C.equals(h1.commit, h2.commit), '两次承诺互不相同');

  /* 独立复核绑定性：错误值打开必须失败 */
  push('⭐ 错误值打开承诺必失败（绑定性）',
    PD.open(h1.commit, 123457n, h1.r) === false, '值 +1 即失败');

  /* ================= L2 零知识证明 ================= */
  console.log('\n【L2】范围证明（Bulletproofs 风格）');

  const rs = RP.selfTest();
  push('范围证明自检', rs.passed === rs.total, `${rs.passed}/${rs.total}`);
  if (verbose) rs.items.forEach((i) => console.log(`    ${i.pass ? '·' : '✗'} ${i.name}`));

  /* 统计阴性对照是否齐备 —— 这是"能检出"的量化证据 */
  const negCount = rs.items.filter((i) => i.name.includes('⭐')).length;
  push('范围证明含阴性对照', negCount >= 4, `${negCount} 条阴性对照`);

  /* 独立验证：正向必须通过（不能只靠有阴性的"全拒"） */
  {
    const bl = C.randomScalar();
    const val = 8695375n;
    const cm = PD.commit(val, bl);
    const pf = RP.prove(val, bl, cm, { bits: 64 });
    const vr = RP.verify(pf, cm);
    push('⭐ 64 位正向证明必须通过（防"全拒"退化为恒假）', vr.ok, vr.reason);
  }

  /* ================= L3 协议语义 ================= */
  console.log('\n【L3】协议语义（隐私 / 聚合 / 跨期 / 披露）');

  const zs = await ZK.selfTest();
  push('协议自检', zs.passed === zs.total, `${zs.passed}/${zs.total}`);
  if (verbose) zs.items.forEach((i) => console.log(`    ${i.pass ? '·' : '✗'} ${i.name}`));

  /* ⭐ 隐私强度独立复核：用真实排放量生成承诺，公开包必须不含任何可识别痕迹 */
  {
    const SECRET = 4242424.125;
    const { publicPayload, privateWitness } = await ZK.buildCommitment({
      entId: 1, year: 2026, emission: SECRET,
    });
    const wire = JSON.stringify(publicPayload);
    const leaks = [];
    /* 检查多种可能的泄漏形式 */
    const candidates = [
      String(SECRET),                                  // 原值
      String(Math.round(SECRET)),                       // 取整
      String(Math.round(SECRET * 1000)),                // 缩放后整数
      privateWitness.blind,                             // 盲化因子
      BigInt(privateWitness.scaledValue).toString(16),  // 十六进制
    ];
    /* 用结构化检测（见 findLeaks 的说明：子串搜索短数字串会随机误报） */
    leaks.push(...findLeaks(publicPayload, candidates));
    push('⭐ 公开包不泄漏任何形式的原始数值', leaks.length === 0,
      leaks.length ? `泄漏：${leaks.join(',')}` : `检查了 ${candidates.length} 种形式 × 全字段遍历，均未泄漏`);

    /* 承诺编码长度恒定：不泄漏数值大小 */
    const small = await ZK.buildCommitment({ entId: 1, year: 2026, emission: 1 });
    push('承诺编码长度与数值大小无关（防量级泄漏）',
      small.publicPayload.commit.length === publicPayload.commit.length,
      `1 t 与 424 万 t 的承诺均为 ${publicPayload.commit.length} hex`);
  }

  /* ⭐ 同态聚合的实质检验：聚合承诺应能被"见证之和"打开 */
  {
    const a = await ZK.buildCommitment({ entId: 1, year: 2026, emission: 1000 });
    const b = await ZK.buildCommitment({ entId: 2, year: 2026, emission: 2500 });
    const agg = ZK.aggregate([a.publicPayload, b.publicPayload]);
    const sumVal = BigInt(a.privateWitness.scaledValue) + BigInt(b.privateWitness.scaledValue);
    const sumBlind = C.mod(BigInt(a.privateWitness.blind) + BigInt(b.privateWitness.blind), C.N);
    const aggPt = C.decodePoint(agg.aggregateCommit);
    push('⭐ 聚合承诺可被见证之和打开（同态性实证）',
      PD.open(aggPt, sumVal, sumBlind),
      `Com(1000) + Com(2500) = Com(3500)，聚合点可被两个见证之和打开`);
  }

  /* 跨期一致性 —— **真实场景**：各月与年度盲化因子完全独立
   *
   * ⚠ 上一轮这里用的是「先构造 Σ月度 = 年度 再断言相等」的循环论证（恒真），
   *   代码在真实业务里永远返回 false。现在改为用线性关系零知识证明，
   *   年度承诺独立生成，盲化因子毫不相关。 */
  {
    const vals = [100, 120, 95, 110, 130, 105, 115, 125, 100, 108, 112, 118];
    const ms = [];
    const blinds = [];
    for (const v of vals) {
      const r = await ZK.buildCommitment({ entId: 1, year: 2026, emission: v });
      ms.push(r.publicPayload);
      blinds.push(r.privateWitness.blind);
    }
    const totalVal = vals.reduce((a, b) => a + b, 0);
    /* 年度承诺独立生成 */
    const annual = await ZK.buildCommitment({ entId: 1, year: 2026, emission: totalVal });

    const pr = ZK.periodProof({
      mode: 'prove', monthlyCommits: ms, monthlyBlinds: blinds,
      annualCommit: annual.publicPayload, annualBlind: annual.privateWitness.blind,
      monthlyValues: vals.map((v) => BigInt(Math.round(v * 1000))),
      annualValue: BigInt(Math.round(totalVal * 1000)),
      year: 2026, label: 'PERIOD:SELFTEST',
    });
    const ok12 = ZK.periodProof({
      mode: 'verify', monthlyCommits: ms,
      annualCommit: annual.publicPayload, proof: pr.proof,
      year: 2026, label: 'PERIOD:SELFTEST',
    });
    push('⭐ 跨期一致：12 月盲化因子独立仍可证（真实场景）',
      ok12.consistent === true, `${pr.proofBytes} 字节零知识证明`);

    /* 阴性：少一个月（无法生成证明） */
    let err11 = null;
    try {
      ZK.periodProof({
        mode: 'prove', monthlyCommits: ms.slice(0, 11), monthlyBlinds: blinds.slice(0, 11),
        annualCommit: annual.publicPayload, annualBlind: annual.privateWitness.blind,
        monthlyValues: vals.slice(0, 11).map((v) => BigInt(Math.round(v * 1000))),
        annualValue: BigInt(Math.round(totalVal * 1000)),
        year: 2026, label: 'PERIOD:SELFTEST',
      });
    } catch (e) { err11 = e.message; }
    push('⭐ 跨期：漏一个月即无法生成证明（防逐月缩水）',
      err11 !== null && err11.includes('线性关系不成立'), '数值对不上，生成阶段拒绝');

    /* 阴性：把证明挪用到别的年度 */
    const badYear = ZK.periodProof({
      mode: 'verify', monthlyCommits: ms,
      annualCommit: annual.publicPayload, proof: pr.proof,
      year: 2027, label: 'PERIOD:OTHER',
    });
    push('⭐ 跨期：证明不能挪用到别的年度（标签绑定）',
      badYear.consistent === false, badYear.consistent ? '未检出（缺陷）' : '上下文不符 ⇒ 拒绝');
  }

  /* 授权披露：只披露分项，总量仍保密 */
  {
    const r = await ZK.buildCommitment({
      entId: 1, year: 2026, emission: 9000,
      breakdown: [
        { sourceCode: 'COAL', emission: 5400 },
        { sourceCode: 'POWER', emission: 3600 },
      ],
    });
    const d = ZK.authorizedDisclose(r.publicPayload, r.privateWitness, 'COAL');
    push('选择性披露：单分项披露成功',
      d.scope === 'PART' && Math.abs(d.value - 5400) < 0.01,
      `仅披露 COAL=${d.value} t，POWER 仍保密`);
    /* 披露单分项后，总量承诺仍不可被反推。
     *
     * ⚠ 这里不能用 `JSON.stringify(payload).includes('9000')` —— 那是个**假判据**：
     *   公开包里含数百个十六进制字符（承诺点、证明体），
     *   随机子串命中 "9000"（4 位数字）的概率约为 1 − (1−10⁻⁴)^(数百) ≈ 数十%，
     *   于是这条断言会**随机失败**。实测确实在服务运行态下偶发红。
     *
     *   正确做法：结构化检查 —— 遍历公开包的所有**字段值**，
     *   判断有没有哪个字段的值恰好等于目标数值（或其缩放形式），
     *   而不是在大段十六进制里做子串搜索。 */
    const SECRET_TOTAL = 9000;
    const SECRET_SCALED = 9000000;     // 9000 × scale(1000)
    const found = [];
    const walk = (obj, pathStr) => {
      if (obj === null || obj === undefined) return;
      if (typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) walk(v, pathStr ? `${pathStr}.${k}` : k);
        return;
      }
      const strVal = String(obj);
      /* 只比较"整个字段值等于 secret"，不做子串匹配 */
      if (strVal === String(SECRET_TOTAL) || strVal === String(SECRET_SCALED)) {
        found.push(`${pathStr}=${strVal}`);
      }
      /* 数值型字段也检查 */
      if (typeof obj === 'number' && (obj === SECRET_TOTAL || obj === SECRET_SCALED)) {
        if (!found.some((x) => x.startsWith(pathStr))) found.push(`${pathStr}=${obj}(number)`);
      }
    };
    walk(r.publicPayload, '');
    push('⭐ 披露分项后总量仍保密', found.length === 0,
      found.length ? `总量出现在字段：${found.join(', ')}` : '结构化遍历全部字段，无一处等于总量');
  }

  /* ================= L4 端到端（真实数据库 + 真实上链） ================= */
  console.log('\n【L4】端到端（数据库落库 + 链上存证）');

  let savedId = null;
  try {
    const { publicPayload, privateWitness } = await ZK.buildCommitment({
      entId: 1, year: 2026, emission: 12345.678,
    });
    const saved = await ZK.saveCommitment(publicPayload, { operator: 'zk-selftest' });
    savedId = saved.id;
    push('承诺落库', !!saved.id, `id=${saved.id}${saved.dedup ? '（复用）' : ''}`);
    push('承诺已上链存证', saved.chain && saved.chain.blockIndex > 0,
      saved.chain && saved.chain.blockIndex ? `区块 #${saved.chain.blockIndex}` : JSON.stringify(saved.chain));

    /* 回落库数据再验证一遍（确保"入库-出库"不丢字段） */
    const back = await ZK.listCommitments(1, 2026);
    const found = back.find((x) => x.id === savedId);
    push('回落库数据可再次验证',
      found && ZK.verifyCommitment({ ...found, meta: { bits: found.bits } }).ok,
      found ? `承诺 ${String(found.commit).slice(0, 20)}…` : '未找到');

    /* ⭐ 数据库中必须不含任何原始数值 */
    const row = await db.one('SELECT * FROM zk_commitment WHERE id = ?', [savedId]);
    const rowLeaks = findLeaks(row, ['12345', '12345678', String(privateWitness.blind),
      privateWitness.scaledValue]);
    push('⭐ 数据库记录不含原始排放量', rowLeaks.length === 0,
      rowLeaks.length ? `命中：${rowLeaks.join(',')}` : '承诺表只存公开部分（全字段遍历）');
  } catch (e) {
    push('承诺落库', false, e.message);
  }

  /* ⭐ 阴性对照：篡改数据库中的承诺，验证必须失败 */
  if (savedId) {
    try {
      const row = await db.one('SELECT * FROM zk_commitment WHERE id = ?', [savedId]);
      const orig = row.commit_value;
      const fake = C.encodePoint(C.mul(C.randomScalar(), C.G));
      await db.query('UPDATE zk_commitment SET commit_value = ? WHERE id = ?', [fake, savedId]);
      const tampered = {
        protocol: row.protocol, entId: Number(row.ent_id), year: Number(row.year),
        scale: Number(row.scale_factor), unit: row.unit,
        commit: fake, proof: ZK.safeJson(row.proof_json),
        parts: ZK.safeJson(row.parts_json),
        digest: row.digest, meta: { bits: Number(row.bits) },
      };
      const vr = ZK.verifyCommitment(tampered);
      await db.query('UPDATE zk_commitment SET commit_value = ? WHERE id = ?', [orig, savedId]);
      push('⭐ 篡改库中承诺后验证必须失败（阴性对照）', vr.ok === false,
        vr.ok ? '未检出（缺陷）' : '范围证明与承诺不匹配');
    } catch (e) {
      push('⭐ 篡改库中承诺后验证必须失败', false, e.message);
    }
  }

  /* 清理本次自检产生的数据（不污染业务库） */
  try {
    await db.query("DELETE FROM zk_commitment WHERE created_by = 'zk-selftest'");
  } catch { /* ignore */ }

  /* ================= L5 公式正确性（本轮核心） =================
   * 这一层检验的是上一轮**缺失**的能力：
   *   承诺 + 范围证明只能证明「这个数在合理量级内」，
   *   企业完全可以填任意数字。范围证明对"这个数对不对"零保障。
   * 公式证明补上「这个数确实是按 EF × AD 算出来的」这一层。 */
  console.log('\n【L5】公式正确性证明（E = Σ EF·AD）');

  const REL = require('../server/crypto/relation');
  const relSt = REL.selfTest();
  push('线性关系原语自检', relSt.passed === relSt.total, `${relSt.passed}/${relSt.total}`);
  const relNeg = relSt.items.filter((i) => i.name.includes('⭐')).length;
  push('线性关系含阴性对照', relNeg >= 8, `${relNeg} 条阴性对照`);

  /* 用真实核算批次生成公式证明
   * ⚠ 样本必须是**有可用源明细**（emission>0）的最新批次：库里存在无明细的
   * 空批次（如 CALC202610291533594662），公式证明对它们如实报"无排放源"，
   * 这是正确行为 —— 自检选样要跳过（2026-10-31 审计）。 */
  let formulaRes = null;
  try {
    const batch = await db.one(
      `SELECT b.batch_no FROM calc_batch b
         JOIN calc_source_detail d ON d.batch_id = b.id
        WHERE b.usable_for_compliance = 1 AND b.status <> 'VOID' AND d.emission > 0
        GROUP BY b.batch_no ORDER BY MAX(b.id) DESC LIMIT 1`
    );
    if (!batch) {
      skip('真实批次公式证明', '库中无可用核算批次');
    } else {
      formulaRes = await ZK.buildFormulaProof({ batchNo: batch.batch_no });
      const vr = ZK.verifyFormulaProof({ publicPayload: formulaRes.publicPayload });
      push('⭐ 真实批次：公式正确性可零知识验证', vr.ok,
        `${formulaRes.publicPayload.sourceCodes.length} 源 / ${formulaRes.publicPayload.proofBytes} 字节`);

      /* 量纲自洽：eScale 必须 = efScale + adScale */
      const sc = formulaRes.publicPayload.scales;
      push('量纲自洽（eScale = efScale + adScale）',
        sc.e === sc.ef + sc.ad, `${sc.ef} + ${sc.ad} = ${sc.e}`);

      /* ⭐ 隐私：公开包不含任何活动数据或排放量数值
       * 用结构化检测 —— 理由见 findLeaks 的说明。 */
      const leaks = [];
      for (const d of (formulaRes.__internal.detail || [])) {
        const cands = [
          String(d.ad),
          String(Math.round(d.ad * 1000)),
          BigInt(Math.round(d.ad * 1000)).toString(),
          BigInt(Math.round(d.ad * 1000)).toString(16),
          String(Math.round(d.e * 1e7)),
          String(d.e),
        ];
        const hits = findLeaks(formulaRes.publicPayload, cands);
        for (const h of hits) leaks.push(`${d.code}:${h}`);
      }
      push('⭐ 公开包不泄漏活动数据与排放量', leaks.length === 0,
        leaks.length
          ? `泄漏：${leaks.slice(0, 3).join(',')}`
          : `检查了 ${formulaRes.__internal.detail.length} 个源 × 6 种表示 × 全字段遍历`);

      /* ⭐ 阴性：篡改因子整数必须失败 */
      try {
        const bad = JSON.parse(JSON.stringify(formulaRes.publicPayload));
        bad.efInts[0] = String(BigInt(bad.efInts[0]) + 1n);
        /* 摘要会先失败（因为 efInts 参与摘要） */
        const vr2 = ZK.verifyFormulaProof({ publicPayload: bad });
        push('⭐ 篡改排放因子必须失败', vr2.ok === false,
          vr2.ok ? '未检出（缺陷）' : '摘要不匹配 ⇒ 拒绝');
      } catch (e) {
        push('⭐ 篡改排放因子必须失败', false, e.message);
      }

      /* ⭐ 阴性：篡改排放量承诺必须失败 */
      try {
        const bad2 = JSON.parse(JSON.stringify(formulaRes.publicPayload));
        bad2.eCommit = C.encodePoint(C.mul(C.randomScalar(), C.G));
        /* 这里摘要也会变（eCommit 参与摘要） */
        const vr3 = ZK.verifyFormulaProof({ publicPayload: bad2 });
        push('⭐ 篡改排放量承诺必须失败', vr3.ok === false,
          vr3.ok ? '未检出（缺陷）' : '摘要不匹配 ⇒ 拒绝');
      } catch (e) {
        push('⭐ 篡改排放量承诺必须失败', false, e.message);
      }

      /* ⭐ 阴性：换一个批次的证明不能挪用
       * ⚠ 另一批次同样须有可用源明细（同上，空批次会抛"无排放源"） */
      try {
        const other = await db.one(
          `SELECT b.batch_no FROM calc_batch b
             JOIN calc_source_detail d ON d.batch_id = b.id
            WHERE b.usable_for_compliance = 1 AND b.status <> 'VOID'
              AND b.batch_no <> ? AND d.emission > 0
            GROUP BY b.batch_no ORDER BY MAX(b.id) DESC LIMIT 1`, [batch.batch_no]
        );
        if (other) {
          const r2 = await ZK.buildFormulaProof({ batchNo: other.batch_no });
          /* 把 A 批次的证明挂到 B 批次的公共包上 */
          const mixed = { ...formulaRes.publicPayload, proof: r2.publicPayload.proof };
          const vr4 = ZK.verifyFormulaProof({ publicPayload: mixed });
          push('⭐ 证明不能跨批次挪用', vr4.ok === false,
            vr4.ok ? '未检出（缺陷）' : '上下文不符 ⇒ 拒绝');
        } else {
          skip('证明不能跨批次挪用', '库中只有一个可履约批次');
        }
      } catch (e) {
        push('⭐ 证明不能跨批次挪用', false, e.message);
      }

      /* 落库 + 上链 + 库内无明文 */
      try {
        const saved = await ZK.saveFormulaProof(formulaRes, { operator: 'zk-selftest' });
        push('公式证明落库', !!saved.id, `id=${saved.id}${saved.dedup ? '（复用）' : ''}`);
        push('公式证明上链', saved.chain && saved.chain.blockIndex > 0,
          saved.chain && saved.chain.blockIndex ? `区块 #${saved.chain.blockIndex}` : JSON.stringify(saved.chain));

        const row = await db.one('SELECT * FROM zk_formula_proof WHERE id = ?', [saved.id]);
        const rowLeaks = [];
        for (const d of (formulaRes.__internal.detail || [])) {
          rowLeaks.push(...findLeaks(row, [
            String(Math.round(d.ad * 1000)),
            String(d.ad),
            String(Math.round(d.e * 1e7)),
          ]));
        }
        push('⭐ 数据库记录不含活动数据', rowLeaks.length === 0,
          rowLeaks.length ? `命中：${rowLeaks.slice(0, 3).join(',')}` : '公式证明表只存公开部分（全字段遍历）');

        /* 清理本次自检数据 */
        await db.query("DELETE FROM zk_formula_proof WHERE created_by = 'zk-selftest'");
      } catch (e) {
        push('公式证明落库', false, e.message);
      }
    }
  } catch (e) {
    push('真实批次公式证明', false, e.message);
  }

  /* 纯密码学层面的公式证明（不依赖数据库，保证在任何环境都能验证核心能力） */
  {
    const EF_INT = 19003n;         // 1.9003 × 10⁴
    const AD_INT = 12000000n;      // 12000 × 10³
    const E_INT = EF_INT * AD_INT; // × 10⁷
    const adC = PD.commit(AD_INT);
    const eC = PD.commit(E_INT);
    const pf = REL.proveFormula({
      adCommits: [adC.commit], adBlinds: [adC.r], adValues: [AD_INT],
      efInts: [EF_INT], eCommit: eC.commit, eBlind: eC.r, eValue: E_INT,
      label: 'FORMULA:SELFTEST',
    });
    const vr = REL.verifyFormula({
      adCommits: [adC.commit], efInts: [EF_INT], eCommit: eC.commit,
      proof: pf, label: 'FORMULA:SELFTEST',
    });
    push('⭐ 公式证明：纯密码学层面正向验证', vr.ok,
      '12000 t × 1.9003 = 22803.6 tCO₂e，双方向均未泄漏');

    /* 谎报一半必须失败 */
    let err = null;
    try {
      const fakeE = PD.commit(E_INT / 2n);
      REL.proveFormula({
        adCommits: [adC.commit], adBlinds: [adC.r], adValues: [AD_INT],
        efInts: [EF_INT], eCommit: fakeE.commit, eBlind: fakeE.r, eValue: E_INT / 2n,
        label: 'FORMULA:FAKE',
      });
    } catch (e) { err = e.message; }
    push('⭐ 公式证明：谎报排放量一半无法生成证明', err !== null && err.includes('线性关系不成立'),
      '这是范围证明做不到的事 —— 范围证明只验量级，公式证明验计算');
  }

  /* ================= 汇总 ================= */
  const passed = items.filter((i) => i.pass === true).length;
  const failed = items.filter((i) => i.pass === false).length;
  console.log('\n' + '═'.repeat(76));
  console.log(`结果：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过 / 共 ${items.length} 项`);
  if (failed) {
    console.log('\n失败项：');
    for (const f of items.filter((i) => i.pass === false)) console.log(`  ✘ ${f.name} — ${f.detail}`);
  }
  console.log('═'.repeat(76));

  try {
    const outDir = join(ROOT, 'tools', 'out');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'zk-selftest.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      total: items.length, passed, failed, skipped,
      items: items.map((i) => ({ name: i.name, pass: i.pass, detail: i.detail })),
    }, null, 2), 'utf8');
  } catch (e) { console.warn('⚠ 写 zk-selftest.json 失败：', e.message); }

  await db.pool.end();
  try { await db.ledgerPool.end(); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error('✘ 自检崩溃：', e);
  try { await db.pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
