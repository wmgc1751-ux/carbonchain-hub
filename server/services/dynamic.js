/**
 * dynamic.js —— 碳资产动态核算引擎
 * ------------------------------------------------------------------
 * 这是"动态核算"的落地实现，替代原先"按季度人工填报"的静态核算：
 *
 *   1. 实时采数   模拟工业排口 CEMS 在线监测设备按小时推送排放读数
 *                 （烟气流量折算为 tCO2e/h），取代人工季度填报。
 *   2. 滚动核算   基于实测读数**持续滚动**计算：年度累计排放、当前排放速率、
 *                 按速率外推的期末排放量。
 *   3. 动态配额   把滚动核算结果与配额账户比对，实时算出**配额缺口**，
 *                 并按缺口大小动态给出履约风险等级。
 *   4. 动态预警   缺口/风险越过阈值时，自动产生监管预警（写入 alert_record）。
 *
 * 核算口径与静态上报保持一致（Scope1/2 折算为 tCO2e），因此两条路径可互相印证。
 *
 * @module services/dynamic
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const config = require('../config');

/** 行业日均排放强度基准（tCO2e/天，中型企业）：用于生成可复现的模拟实测数据 */
const INDUSTRY_BASE = {
  电力: 1800, 钢铁: 1600, 建材: 900, 化工: 1100,
  有色金属: 1000, 造纸: 500, 石化: 1400,
};
const SCALE_RATIO = { 大型: 1.6, 中型: 1.0, 小型: 0.55 };

/** 采样步长（小时）：CEMS 每 STEP 小时推一次读数 */
const STEP_HOURS = 4;

/** 年度小时数（与不确定度模块的 DAYS_PER_YEAR = 365 同源，禁止各自硬编码） */
const HOURS_PER_YEAR = 365 * 24;

/**
 * ⭐ 年度排放估计的**唯一口径**（全平台只此一处，两条写入路径 + 不确定度模块共用）。
 *
 *     annual = 基准速率(base/24) × 8760 + 实测偏差修正
 *
 * 语义：**未实测时段按配额基准模型填充，实测覆盖时段按实测值**；
 * 偏差是**绝对量**，不随覆盖度放大。
 *
 * 为什么必须收敛到一个函数（2026-10-14，WP4 口径分叉根治）
 * ------------------------------------------------------------------
 * 此前同一份读数在两侧被套上不同的外推放大系数：
 *   · `dynamic#recompute`：`cum / 已过天数 × 365`   → 偏差被放大 8760/hours ≈ 1.27 倍；
 *   · `uncertainty#posterior`：`实测日均 × 365`      → 偏差被放大 8760/coveredHours ≈ 12 倍
 *     （31 天窗口 / 365 天）。
 * 两条公式各自自洽，但**平台对外只能有一个口径**。实测证据（ent2）：
 * 两侧年化值相差 16.11%，跨过 15% 的一致性断言阈值，且该差值随窗口内
 * 实测偏离基准的幅度线性放大 —— 数据越"偏离",分叉越大。
 * 收敛到本函数后，任何一侧的后续改动都必须经过这里，分叉在结构上不可能再发生。
 *
 * @param {number} baseRate 基准排放速率 tCO2e/h（= dailyBaseFor/24）
 * @param {number} correction 实测偏差修正 tCO2e（见 observedCorrection，绝对量）
 */
function annualFrom(baseRate, correction) {
  return baseRate * HOURS_PER_YEAR + (Number(correction) || 0);
}

/** 某企业的日均排放基准（确定性：同企业每次运行结果一致，便于复现） */
function dailyBase(ent) {
  const base = INDUSTRY_BASE[ent.industry] || 800;
  const ratio = SCALE_RATIO[ent.scale] || 1.0;
  const h = parseInt(cu.sha256('dyn-baseline|' + ent.id).slice(0, 6), 16) % 200; // 0..199
  return Math.round((base + h) * ratio);
}

/**
 * 日均排放基准（与企业配额规模锚定）：
 * 以该企业当年配额作为"应排放量"参照，乘一个确定性偏置（-20% ~ +20%），
 * 使多数企业期末排放落在配额附近、少数企业超排触发预警 —— 贴近真实碳市场分布。
 */
function dailyBaseFor(ent, allocated) {
  const annual = allocated > 0
    ? allocated
    : (INDUSTRY_BASE[ent.industry] || 800) * 365 * (SCALE_RATIO[ent.scale] || 1);
  const h = (parseInt(cu.sha256('dyn-bias|' + ent.id).slice(0, 4), 16) % 401) - 200; // -200..200
  return Math.max(1, (annual / 365) * (1 + h / 1000));
}

/** 该企业排口配置（规模越大排口越多） */
function monitorsOf(ent) {
  const n = ent.scale === '大型' ? 3 : ent.scale === '小型' ? 1 : 2;
  const names = ['1 号排口', '2 号排口', '3 号排口'];
  return Array.from({ length: n }, (_, i) => ({
    monitor_no: `M-${String(ent.id).padStart(4, '0')}-${String(i + 1).padStart(2, '0')}`,
    energy_type: i === 0 ? '烟煤' : (i === 1 ? '天然气' : '电力'),
    name: names[i],
  }));
}

/**
 * 排口排放分担比：3 个排口按 5:3:2 分配，2 个排口按 5:3 归一化，1 个排口独占。
 *
 * ⚠ 归一化到 1 是硬要求。早先版本对 1/2 排口的企业直接沿用 5:3:2 的前几项
 * （合计只有 0.5 / 0.8），于是"排口读数之和"系统性小于企业实际排放量：
 *   1 排口企业偏小 50%，2 排口企业偏小 20%。
 * 这类口径缺陷在 `carbon_dynamic_account` 上**不会暴露** —— 那里的年度累计由
 * 年初基数 `base × passedDays` 主导，7 天窗口的欠计被完全掩盖。
 * 只有当审计方真去积分原始读数时才会显现，而那正是 WP4 唯一要做的事。
 */
function sharesOf(n) {
  const base = [0.5, 0.3, 0.2].slice(0, n);
  const sum = base.reduce((a, b) => a + b, 0);
  return base.map((x) => x / sum);
}

/** 当前核算年度 / 周期（与本年度配额账户口径一致，年度滚动） */
function currentPeriod(d = new Date()) {
  const q = Math.floor(d.getMonth() / 3) + 1;
  return { year: d.getFullYear(), quarter: q, period: `${d.getFullYear()} 年度` };
}

/**
 * 生成 CEMS 实测读数（幂等：已存在的 (ent, monitor, time) 不重复插入）。
 * @param {object} opts { days 回溯天数, now 基准时间 }
 */
async function ingest(opts = {}) {
  /* ⭐ 天数解析（2026-10-14 修复：本平台历史上最严重的完整性缺陷）
     ------------------------------------------------------------------
     `opts.days === 0` 是**合法取值** —— 调度器（startScheduler 的 tick）正是用它
     表示"只采当前一个步长"。但早先写成 `opts.days || 7`，0 是 falsy，于是
       ① 每次 tick 都被当成"重建 7 天窗口"；
       ② 窗口锚点是 `now - 7d`，随 now 分钟级漂移，`fmt()` 只截到分钟，
          于是每分钟整批时间戳平移 1 分钟，`INSERT IGNORE` 一条也挡不住。
     实测后果：每 60s 净增约 4,620 行（60 家 × 3 排口 × 42 点/天×... ），
     折合约 **665 万行/天**；我在本轮验证中观测到 9 分钟涨 4.5 万行即为该缺陷。
     用 `=== undefined` 判断，并显式 Number()，0 才会被如实执行。 */
  const rawDays = (opts.days === undefined || opts.days === null) ? 7 : Number(opts.days);
  const days = Number.isFinite(rawDays) && rawDays >= 0 ? rawDays : 7;
  const now = opts.now ? new Date(opts.now) : new Date();
  const ents = await db.query("SELECT id, industry, scale FROM enterprise WHERE status <> 'SUSPENDED'");
  const batchNo = cu.bizNo('CEMS');
  const rows = [];

  const STEP_MS = STEP_HOURS * 3600 * 1000;
  const points = Math.floor((days * 24) / STEP_HOURS);
  /* ⭐ 窗口锚点的确定性（第二条：重建幂等）
     重建型调用（days > 0）把窗口末尾**对齐到 4h 步长网格**：同一网格内重复调用
     得到完全相同的时间戳，`INSERT IGNORE` 真正生效（实测净增 0 行）。
     不对齐时窗口随 now 漂移，一次 `ingest({days:30})` 就能净增 18,216 行（≈0.76 个窗口）。
     实时单点（days === 0）保留分钟粒度，让准实时数据真正向前推进；
     同一分钟内的重复调用仍由时间戳去重。 */
  const endMs = days > 0
    ? Math.floor(now.getTime() / STEP_MS) * STEP_MS
    : now.getTime();
  const { year: quotaYear } = currentPeriod(now);
  for (const ent of ents) {
    const allocated = Number(await db.value(
      'SELECT total_allocated FROM carbon_quota WHERE ent_id = ? AND year = ?', [ent.id, quotaYear]
    ) || 0);
    const base = dailyBaseFor(ent, allocated);
    /* ⚠ 口径（与 cems_reading.flow_value 的列注释一致）：写入的是**瞬时排放速率 tCO2e/h**，
       不是"每个采样步长的排放量"。两个理由：
         ① 列注释写的就是 tCO2e/h，而 HJ 212 设备直报路径（hj212Server）走的是
            「流速 × 截面积 × 3600 × 浓度 × 1e-9」的物理折算，产出的是真速率。
            同列两种单位会让任何积分/对账都失去意义。
         ② 只有速率才能被任意间隔积分：平台存在 4h（自举）与 1min（设备直报）两种
            采样密度，写"每步排放量"就无法跨密度比较。
       企业级日均排放 = base ⇒ 每小时的速率基准 = base / 24。 */
    const perHour = base / 24;
    const mons = monitorsOf(ent);
    const monShares = sharesOf(mons.length);
    /* cum 的锚点：窗口起点时刻的「年度累计」。
       公式 = 基准速率 × 自年初小时数 + 该时点之前的**实测偏差修正**。
       ⚠ 不能简单写成 `base × passedDays` —— 那等于把全年的实测偏差统统抹掉，
       cum 会退化成"配额基线的复读机"，`recompute` 的"动态核算"也就名不副实。
       实测偏差修正由 observedCorrection() 给出（与设备直报路径共用同一实现）。 */
    const jan1 = new Date(now.getFullYear(), 0, 1).getTime();
    const windowStartMs = endMs - points * STEP_MS;
    const windowStart = new Date(windowStartMs);
    let cum = perHour * ((windowStartMs - jan1) / 3600000)
      + await observedCorrection(ent.id, windowStart);

    for (let p = 0; p <= points; p++) {
      const t = new Date(windowStartMs + p * STEP_MS);
      /* 一个采样步长内所有排口共用一个企业级 cum：
         先算完整步长再落 cum，避免"同一步长内不同排口拿到不同累计值"。
         （该一致性对审计仍重要 —— 积分器按 (排口, 时刻) 逐点比对，
          同刻不同值会让 Δt 归属产生歧义。） */
      let stepFlow = 0;
      const stepRows = [];
      for (let mi = 0; mi < mons.length; mi++) {
        const m = mons[mi];
        const share = monShares[mi];
        const jitter = 0.92 + ((parseInt(cu.sha256(`${m.monitor_no}|${t.toISOString()}`).slice(0, 4), 16) % 160) / 1000);
        const flow = Number((perHour * share * jitter).toFixed(3));   // tCO2e/h

        /* ── 数据质量扰动（确定性派生，不是随机噪声）──────────────────
           为什么自举数据也要有"脏数据"：
             真实 CEMS 不可能 100% 完美 —— 校准窗口、探头漂移、断线停机都会留痕。
             若自举数据清一色 NORMAL，则"数据质量治理"这一层在看板上只剩一种颜色，
             等于没做。质量标记必须被真实产生、并且**真正影响核算**（见 recompute），
             否则它只是装饰。
           实现：按 (企业, 排口, 时刻) 的 SHA-256 确定性派生质量标记，比例贴近行业实测：
             MISSING      1.2%  该时段无有效上报
             CALIBRATION  0.8%  校准/维护窗口
             OFFLINE      0.3%  停机/断线
             DRIFT        0.9%  测到了但读数存疑（flow 值明显偏离工况）
           同一份种子在任意机器、任意次运行都得到同一结果（可复现）。
           关键口径：质量标记决定该步长用**实测值**还是**基准值**推进 cum ——
           NORMAL 用实测速率，其余（缺数/校准/停机/漂移）按该排口基准速率。
           于是 cum 的含义是"实测覆盖段按实测、未覆盖段按基准估计的年度累计"，
           而不是"所有报数的累加"，也不是"仪器坏了就停止排放"。
           （2026-10-14 修正：早先这些步长贡献 0，与 observedCorrection 的
             "未覆盖时段基准填补"口径不一致，两条实现系统性相差约 0.2%。） */
        const roll = parseInt(
          cu.sha256(`cems-quality|${ent.id}|${m.monitor_no}|${t.toISOString()}`).slice(0, 6), 16
        ) % 1000;
        let quality = 'NORMAL';
        let flowValue = flow;
        let o2 = Number((3.5 + (flow % 2)).toFixed(2));
        let temp = Number((120 + (flow % 40)).toFixed(2));
        if (roll < 12) { quality = 'MISSING'; flowValue = 0; o2 = null; temp = null; }
        else if (roll < 20) { quality = 'CALIBRATION'; flowValue = 0; o2 = null; temp = null; }
        else if (roll < 23) { quality = 'OFFLINE'; flowValue = 0; o2 = null; temp = null; }
        else if (roll < 32) { quality = 'DRIFT'; flowValue = Number((flow * 1.35).toFixed(3)); }

        /* cum 的单位是 tCO2e（年度累计排放量），flowValue 的单位是 tCO2e/h，
           因此每个采样步长推进的是 flowValue × STEP_HOURS，而不是 flowValue 本身。

           ⭐ 「未被有效测量覆盖的步长怎么推进」必须与 observedCorrection 完全一致
           （2026-10-14，来源 ① 的最后一处隐性分叉）：
             observedCorrection 把 缺数/校准/停机/漂移 视作**未被测量覆盖**，
             按"未实测时段用基准模型填补"的口径以基准速率推进；
             早先这里却让这些步长贡献 0，等于宣称"仪器坏了工厂就停止排放"，
             两条实现因此系统性相差 baseRate × 覆盖损失（实测约 0.2%）。
           现在的规则统一为：NORMAL → 按实测速率推进；其余 → 按该排口的基准速率推进。
           注意质量标记**仍然真正影响核算**（它决定用实测值还是基准值），
           被排除的量继续由 excluded_points 如实披露，不是静默忽略。 */
        if (quality === 'NORMAL') stepFlow += flowValue;
        else stepFlow += perHour * share;   // 未覆盖步长：按该排口基准速率推进

        stepRows.push([
          ent.id, m.monitor_no, m.energy_type, fmt(t), flowValue, 0,
          o2, temp,
          quality === 'NORMAL' ? 'NORMAL' : 'ABNORMAL', quality, batchNo,
        ]);
      }
      /* 末点（p === points）没有后继读数，其所代表的时段无从确定 → 不推进，
         与 WP4 积分口径的"末点不外推"一致。 */
      if (p < points) cum += stepFlow * STEP_HOURS;
      const cumNow = Number(cum.toFixed(3));
      for (const r of stepRows) { r[5] = cumNow; rows.push(r); }
    }
  }

  // 批量插入（每 500 行一条 INSERT，跨地域/大数据量下显著快于逐行）
  // 幂等：同一 (enterprise, monitor, reading_time) 已存在则跳过，避免重复采数造成累计值漂移。
  const COLS = 'ent_id, monitor_no, energy_type, reading_time, flow_value, cum_value, o2_content, temperature, source, status, quality_flag, batch_no';
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const ph = slice.map(() => "(?,?,?,?,?,?,?,?,'CEMS',?,?,?)").join(',');
    const res = await db.query(`INSERT IGNORE INTO cems_reading (${COLS}) VALUES ${ph}`, slice.flat());
    inserted += (res && res.affectedRows != null) ? res.affectedRows : slice.length;
  }
  return { batchNo, inserted, enterprises: ents.length, days, points: points + 1 };
}

function fmt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

/* ==================================================================
 * 实测偏差修正（WP4：统一两条写入路径的 cum 口径）
 * ================================================================== */

/** 名义采样周期上限（分钟）——超过它的空白不予外推，与 WP4 的积分口径一致 */
const NOMINAL_CAP_MIN = STEP_HOURS * 60;
/** 修正量的缓存粒度：5 分钟。修正量是"实测相对基准的偏离"，本身就缓慢变化，
 *  而 H 帧级调用（hj212Server 每收一帧算一次 cum）若不做缓存会把全年窗口
 *  反复聚合一遍。缓存键含 5 分钟时间桶，因此**历史锚点**（如重建窗口起点）
 *  与**当前时刻**各占一个桶，不会互相污染。 */
const CORR_TTL_MS = 300000;
const corrCache = new Map();

/** 清空修正量缓存（复位 / 配额外变更后调用） */
function resetCorrCache() { corrCache.clear(); }

/**
 * 观测窗口内的「实测偏差修正量」(tCO2e)。
 *
 *   correction = ∫实测速率 dt − 基准速率 × 被测量覆盖的时长
 *
 * 语义：实测排放相对**配额基准**的超出（正）或不足（负）部分。
 * 只统计真正被测量覆盖的时长，因此不会因为采样稀疏而被误判成"排放偏低"。
 *
 * 为什么需要它：平台的读数窗口只有 30 天（自举）或更短，1 月 1 日到窗口起点
 * 这一段没有任何实测数据。假装它是 0，年度累计会凭空少掉 11 个月；
 * 用"基准速率"填补、再把窗口内实测相对基准的偏差修正进去，是唯一既不失真、
 * 也不虚构数据的形式。于是：
 *
 *     cum(t) = 基准速率(base/24) × 自年初小时数 + correction
 *
 * 该形式与 `ingest()` 的 `cum = base × passedDays + Σ(flow × STEP_HOURS)` 在
 * 覆盖率 100% 时**恒等**，因此两条写入路径（平台自举 / HJ 212 设备直报）
 * 产出同一尺度、可混用的 cum。
 */
async function observedCorrection(entId, upto = new Date()) {
  const key = `${entId}:${Math.floor(upto.getTime() / CORR_TTL_MS)}`;
  const hit = corrCache.get(key);
  if (hit && Date.now() - hit.at < CORR_TTL_MS) return hit.value;

  const ctx = await db.one('SELECT id, industry, scale FROM enterprise WHERE id = ?', [entId]);
  if (!ctx) return 0;
  const year = upto.getFullYear();
  const allocated = Number(await db.value(
    'SELECT total_allocated FROM carbon_quota WHERE ent_id = ? AND year = ?', [entId, year]
  ) || 0);
  const baseRate = dailyBaseFor(ctx, allocated) / 24;   // tCO2e/h

  const rows = await db.query(
    `SELECT monitor_no, reading_time, flow_value FROM cems_reading
      WHERE ent_id = ? AND reading_time >= ? AND reading_time < ?
        AND quality_flag = 'NORMAL' AND status = 'NORMAL'
        AND flow_value > 0 AND source <> 'WATCHDOG'
      ORDER BY monitor_no, reading_time`,
    [entId, `${year}-01-01 00:00:00`, fmt(upto)]
  );

  /* 步进积分：Δt = min(相邻间隔, 名义上限)；末点不外推（与 WP4 同一口径） */
  let integrated = 0;
  const coveredByMon = new Map();
  const emittedByMon = new Map();
  let prevMon = null;
  let prevT = null;
  let prevRate = 0;
  for (const r of rows) {
    const t = new Date(r.reading_time).getTime();
    if (r.monitor_no === prevMon) {
      const dtMin = Math.min((t - prevT) / 60000, NOMINAL_CAP_MIN);
      if (dtMin > 0) {
        const e = prevRate * (dtMin / 60);
        integrated += e;
        coveredByMon.set(r.monitor_no, (coveredByMon.get(r.monitor_no) || 0) + dtMin / 60);
        emittedByMon.set(r.monitor_no, (emittedByMon.get(r.monitor_no) || 0) + e);
      }
    }
    prevMon = r.monitor_no; prevT = t; prevRate = Number(r.flow_value);
  }

  /* ⭐ 企业级"被测量覆盖时长"= 各排口覆盖时长按**该排口实测排放量**加权平均
     ------------------------------------------------------------------
     推导（不是拍脑袋的加权）：
       设排口 m 占企业排放的份额为 shareₘ（Σ shareₘ = 1）。
       基准应排放量 = Σₘ baseRate·shareₘ·coveredₘ = baseRate · Σₘ shareₘ·coveredₘ
       因此"企业级覆盖时长" = Σₘ shareₘ · coveredₘ —— **份额加权**，不是算术平均。
       份额不可知，用该排口的实测排放量作代理（流量 ∝ 份额，商在同一窗口内抵消）。
     三种取法的后果（实测）：
       · 直接求和   → 基准量重复计 N 倍，cum 系统性偏低（ent2 偏低 12,225 t，已修）；
       · 算术平均   → 被"只在窗口里出现过几分钟"的排口拖垮。ent7 有 16 个排口
                     （3 个平台自举 + 13 个历史设备/测试排口各几条读数），
                     平均后覆盖时长从 ~700h 掉到 ~131h，基准减项缩水 82%，
                     correction 虚高 +5,682，库值/推导漂移 8.05%；
       · 排放量加权 → 权重集中在真正在测的排口上，ent7 恢复到 -0.2% 量级。
     排口完全同质（覆盖时长相同）时本式退化为算术平均，故与既有口径向后兼容。 */
  const emittedTotal = [...emittedByMon.values()].reduce((a, b) => a + b, 0);
  const coveredHours = emittedTotal > 0
    ? [...emittedByMon.entries()].reduce((a, [mon, e]) => a + (coveredByMon.get(mon) || 0) * e, 0) / emittedTotal
    : 0;

  const value = Number((integrated - baseRate * coveredHours).toFixed(3));
  if (corrCache.size > 600) corrCache.clear();   // 时间桶无界增长，做个上限兜底
  corrCache.set(key, { at: Date.now(), value, coveredHours: Number(coveredHours.toFixed(2)) });
  return value;
}

/**
 * ⭐ 任意时刻的**权威年度累计排放**（tCO2e）—— 全平台唯一实现。
 *
 *     cum(t) = 基准速率(dailyBaseFor/24) × 自年初小时数 + 实测偏差修正(t)
 *
 * 两条写入路径（平台自举 `ingest` / HJ 212 设备直报 `hj212Server`）与
 * 动态核算账（`recompute`）现在**都只调用本函数**：
 *   · 设备直报此前自带一份同名实现（`hj212Server#annualCum`），属重复口径；
 *   · `recompute` 此前直接采信库里的 `cum_value` 列 —— 而那一列由两个生产者写入，
 *     "最新一条被谁占住就听谁的"，是来源 ①（跨路径尺度混写）的结构性根源。
 * 收敛到本函数后，核算账不再依赖"哪个生产者写得晚"，而只依赖**原始读数本身**。
 *
 * @param {number} entId
 * @param {Date|string} at 目标时刻
 * @param {object} [pre] 可选的预取上下文 { base } —— 避免重复查配额
 */
async function annualCumAt(entId, at, pre = {}) {
  const t = at instanceof Date ? at : new Date(at);
  const ent = await db.one('SELECT id, industry, scale FROM enterprise WHERE id = ?', [entId]);
  if (!ent) return 0;
  const year = t.getFullYear();
  const base = pre.base !== undefined
    ? Number(pre.base)
    : dailyBaseFor(ent, Number(await db.value(
      'SELECT total_allocated FROM carbon_quota WHERE ent_id = ? AND year = ?', [entId, year]
    ) || 0));
  const jan1 = new Date(year, 0, 1).getTime();
  const hours = Math.max(0, (t.getTime() - jan1) / 3600000);
  const corr = await observedCorrection(entId, t);
  return Number((base / 24 * hours + corr).toFixed(3));
}

/**
 * 滚动核算：由 CEMS 实测读数持续计算某企业（或全部企业）的动态核算账户。
 * @param {number|null} entId 为空则核算全部企业
 * @returns {Promise<object[]>} 核算结果
 */
async function recompute(entId = null) {
  const { year, period } = currentPeriod();
  const ents = entId
    ? await db.query('SELECT id, industry, scale FROM enterprise WHERE id = ?', [entId])
    : await db.query("SELECT id, industry, scale FROM enterprise WHERE status <> 'SUSPENDED'");

  const results = [];
  for (const ent of ents) {
    /* 1) 最后读数时刻（多排口：取各排口最新时刻中的最晚者）+ 库值对照。
       ⭐ 质量门控（WP1）：只采信 quality_flag='NORMAL' 的读数。
       若把缺数/校准/停机/漂移期间的值一并采信，质量标记就只是装饰；
       这里让质量标记**真正决定哪些数据进入核算**，并用 excluded_points 如实披露被排除的量。

       ⭐ 多排口 × 多路径的取值史（2026-10-14，两步修复，末尾是定稿）
       cems_reading 是「多排口 × 多时刻」明细表，cum_value 曾是**企业级年度累计的冗余副本**，
       而该列由两个生产者写入（平台自举 / HJ 212 设备直报）。历史上踩过两坑：
         · 旧实现「全表最新一条」：会被**任意一个排口 / 任意一个生产者**的最新时刻占住，
           该行若写入滞后就取到偏小值（实测 ent2：取到 203,308，低估 18.71%）；
         · 「各排口求和」**错误**：会把同一企业累计重复计 N 次（实测 ent7 14 排口，高估 1151%）。
       中间态修复为「各排口最新值取最大值」——有效，但仍是**取值技巧**：只要某个生产者
       落后一版代码，列里就混着两种尺度，正确性依赖"谁写的值恰好更大"。
       定稿：核算账**不再从本列取值**，改为由原始读数按唯一口径重新推导（见下方第 3 步）；
       本列降级为**对照披露**（storedCum / cumDriftPct），漂移超 2% 即可被审计定位。
       这一步才是来源 ①（跨路径 cum 尺度混写）的根治：不依赖写入顺序、不依赖谁写得大。 */
    const latestPerStack = (qualityOnly) => `
      SELECT t.cum_value, t.reading_time, t.source FROM (
        SELECT cum_value, reading_time, source,
               ROW_NUMBER() OVER (PARTITION BY monitor_no ORDER BY reading_time DESC, id DESC) AS rn
          FROM cems_reading
         WHERE ent_id = ?${qualityOnly ? " AND quality_flag = 'NORMAL'" : ''}
      ) t WHERE t.rn = 1`;
    let stacks = await db.query(latestPerStack(true), [ent.id]);
    const qualityGated = !stacks.length;   // true = 该企业无 NORMAL 读数，已退化为任意读数
    if (qualityGated) stacks = await db.query(latestPerStack(false), [ent.id]);
    /* ⭐ 库里的 cum_value 只作为**对照披露**，不再作为核算账的取值来源（2026-10-14，来源 ① 根治）。
       cum_value 列由两个生产者写入（平台自举 `ingest` / 设备直报 `hj212Server`），
       只要其中一方落后一版代码或被别的时点占住，"最新一条被谁占住就听谁的"。
       现在核算账改由 `annualCumAt()` 从**原始读数**重新推导（见下方第 3 步），
       库值仅用于交叉校验：漂移 > 2% 时在结果里给出 cumDriftPct，供审计定位。
       ⚠ WATCHDOG 行是"看门狗占位写入"，其 cum 按设计就**沿用该排口最后已知值**，
         不代表当刻的推导结果，故不参与对照（否则每个离线排口都会报一次假漂移）。 */
    const comparable = stacks.filter((r) => r.source !== 'WATCHDOG');
    const storedCum = comparable.length
      ? Math.max(...comparable.map((r) => Number(r.cum_value) || 0))
      : 0;
    /* 时间口径用的「最后读数时刻」= 各排口最新时刻中的最晚者 */
    const latest = stacks.length
      ? stacks.reduce((a, b) => (new Date(a.reading_time) >= new Date(b.reading_time) ? a : b))
      : null;

    // 本年度有效点数 / 被质量门控排除的点数（披露而非隐藏）
    const qstat = await db.one(
      `SELECT SUM(quality_flag = 'NORMAL') AS valid, SUM(quality_flag <> 'NORMAL') AS excluded
         FROM cems_reading WHERE ent_id = ? AND reading_time >= ?`,
      [ent.id, `${year}-01-01 00:00:00`]
    );
    const validPoints = Number((qstat && qstat.valid) || 0);
    const excludedPoints = Number((qstat && qstat.excluded) || 0);

    // 2) 配额账户（提前查询：既用于排放速率兜底，也用于缺口计算）
    const quota = await db.one('SELECT total_allocated, available FROM carbon_quota WHERE ent_id = ? AND year = ?', [ent.id, year]);
    const allocated = quota ? Number(quota.total_allocated) : 0;
    const available = quota ? Number(quota.available) : 0;
    const base = dailyBaseFor(ent, allocated);   // tCO2e/天（基准模型）
    const baseRate = base / 24;                  // tCO2e/h

    /* 3) ⭐ 权威年度累计（来源 ① 根治）：不再读库值，改由原始读数按唯一口径推导。
       口径与两条写入路径完全同一实现（observedCorrection 的实测偏差修正），
       因此"设备直报 vs 企业自举共用同一 cum 尺度"在结构上成立，无需再靠取值技巧兜底。 */
    const latestAt = latest ? new Date(latest.reading_time) : new Date();
    const hoursElapsed = Math.max(0, (latestAt.getTime() - new Date(year, 0, 1).getTime()) / 3600000);
    const elapsedDays = Math.max(1, hoursElapsed / 24);
    /* 一条读数都没有的企业保持"无账可算"（cumulative = 0），不退化成基准复读机；
       此时 predicted 仍为基准年量 baseRate×8760，与旧实现 dailyBaseFor×365 恒等。 */
    const corrNow = latest ? await observedCorrection(ent.id, latestAt) : 0;
    const cumulative = latest
      ? Number((baseRate * hoursElapsed + corrNow).toFixed(3))   // = annualCumAt(ent.id, latestAt)
      : 0;
    const cumDriftPct = storedCum > 0 ? (cumulative - storedCum) / storedCum : null;

    // 3b) 滚动日均排放速率（tCO2e/天）—— 描述性指标，口径稳定、不依赖"最近一天恰好有几条读数"
    const rate = cumulative > 0
      ? Number((cumulative / elapsedDays).toFixed(4))
      : base;

    // 4) 已用碳信用抵销量（第二类碳资产 CCER 等）—— 抵销履约缺口
    const offsetTotal = Number(await db.value(
      'SELECT IFNULL(SUM(amount),0) FROM credit_offset WHERE ent_id = ? AND year = ?', [ent.id, year]
    ) || 0);

    /* 5) 期末排放外推 —— ⭐ 改用全平台唯一口径 annualFrom（来源 ② 根治）。
       旧实现 `rate × 365` 会把实测偏差按 8760/hours（≈1.27 倍）放大，
       与不确定度模块的放大系数（≈12 倍）不一致，同一份数据两侧年化值相差 16.11%。
       现口径：年度量 = 基准速率 × 8760 + 实测偏差修正（偏差为绝对量，不随覆盖度放大），
       与 services/uncertainty.js 共用同一函数，口径分叉在结构上不可能再发生。
       恒等式：predicted = cumulative + baseRate × 剩余小时数（自检用）。 */
    const predicted = Number(annualFrom(baseRate, corrNow).toFixed(3));
    const netPredicted = predicted - offsetTotal;
    const gap = Number((netPredicted - allocated).toFixed(3));
    let risk = 'LOW';
    if (allocated > 0 && netPredicted > allocated * 1.1) risk = 'HIGH';
    else if (allocated > 0 && netPredicted > allocated) risk = 'MEDIUM';
    else if (allocated === 0 && cumulative > 0) risk = 'MEDIUM';

    // 6) 落库（UPSERT）
    await db.query(
      `INSERT INTO carbon_dynamic_account
         (ent_id, year, period, cumulative_emission, quota_allocated, quota_available, gap,
          predicted_eoy, offset_applied, emission_rate, risk_level, data_points, excluded_points, last_reading_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         period=VALUES(period), cumulative_emission=VALUES(cumulative_emission),
         quota_allocated=VALUES(quota_allocated), quota_available=VALUES(quota_available),
         gap=VALUES(gap), predicted_eoy=VALUES(predicted_eoy), offset_applied=VALUES(offset_applied),
         emission_rate=VALUES(emission_rate),
         risk_level=VALUES(risk_level), data_points=VALUES(data_points),
         excluded_points=VALUES(excluded_points), last_reading_at=VALUES(last_reading_at)`,
      [ent.id, year, period, cumulative, allocated, available, gap, predicted, offsetTotal, rate, risk,
        validPoints, excludedPoints, latest ? fmt(new Date(latest.reading_time)) : null]
    );
    results.push({
      entId: ent.id, cumulative, allocated, gap, predicted, offset: offsetTotal, rate, risk,
      validPoints, excludedPoints, qualityGated,
      /* 口径与可信度披露：库值与权威推导的漂移、基准速率、实测偏差修正 */
      storedCum, cumDriftPct, baseRate, correction: corrNow,
      expectedAnnual: predicted,        // = annualFrom(baseRate, corrNow)，全平台唯一口径
    });
  }

  // 6) 触发动态预警
  await emitAlerts(entId);
  return results;
}

/** 根据动态核算结果产生/更新监管预警（同企业同类 OPEN 预警不重复产生；
 *  风险降级后存量 OPEN 预警自动复核关闭，保证状态机闭环）。 */
async function emitAlerts(entId = null) {
  const where = entId ? 'AND a.ent_id = ?' : '';
  const params = entId ? [entId] : [];
  const rows = await db.query(
    `SELECT a.*, e.ent_name FROM carbon_dynamic_account a
     JOIN enterprise e ON e.id = a.ent_id
     WHERE a.risk_level IN ('HIGH','MEDIUM') ${where}`, params
  );
  let created = 0;
  for (const r of rows) {
    const open = await db.one(
      "SELECT id FROM alert_record WHERE ent_id = ? AND alert_type = 'OVER_QUOTA' AND status <> 'CLOSED'",
      [r.ent_id]
    );
    if (open) continue;
    const level = r.risk_level === 'HIGH' ? 'HIGH' : 'MEDIUM';
    /* 标题/内容必须带年度：企业总览页 KPI 展示的是「最近已申报年度」（如 2025，
     * 盈余 59,755），而滚动预警针对当前年度（如 2026 配额尚未分配）——
     * 不带年度时同一屏出现"盈余"与"缺口预警"，看起来自相矛盾且无从解释
     * （2026-10-31 巡检 P1）。配额未分配是独立成因，文案单独成段，不冒充"缺口"。 */
    const unassigned = !(Number(r.quota_allocated) > 0);
    const title = unassigned
      ? `${r.ent_name} ${r.year} 年度配额尚未分配，滚动核算存在预测缺口`
      : `${r.ent_name} ${r.year} 年度动态核算触发配额缺口预警`;
    const content = unassigned
      ? `${r.ent_name} ${r.year} 年度配额尚未分配（已分配 0 tCO₂e）。`
        + `截至最近实测，本年度累计排放 ${Number(r.cumulative_emission).toFixed(2)} tCO₂e；`
        + `按当前滚动速率（${Number(r.emission_rate).toFixed(2)} tCO₂e/天）外推，预计期末排放约 ${Number(r.predicted_eoy).toFixed(2)} tCO₂e。`
        + `请尽快完成 ${r.year} 年度配额核定与分配，再行滚动核算复核；`
        + `该预警与上一履约年度的盈亏结论无关。`
      : `${r.ent_name} ${r.year} 年度：截至最近实测累计排放 ${Number(r.cumulative_emission).toFixed(2)} tCO₂e，`
        + `已分配配额 ${Number(r.quota_allocated).toFixed(2)} tCO₂e；`
        + `按当前滚动速率（${Number(r.emission_rate).toFixed(2)} tCO₂e/天）外推，预计期末排放约 ${Number(r.predicted_eoy).toFixed(2)} tCO₂e，`
        + `预计期末缺口 ${Number(r.gap).toFixed(2)} tCO₂e（风险 ${level}）。`;
    await db.query(
      `INSERT INTO alert_record (alert_no, ent_id, alert_type, level, title, content, metric, status)
       VALUES (?,?, 'OVER_QUOTA', ?, ?, ?, ?, 'OPEN')`,
      [cu.bizNo('AL'), r.ent_id, level, title, content,
        unassigned
          ? `预计期末排放 ${Number(r.predicted_eoy).toFixed(2)} tCO2e（配额未分配）`
          : `预计缺口 ${Number(r.gap).toFixed(2)} tCO2e`]
    );
    created++;
  }

  /* 状态机闭环：动态核算风险降级（缺口已消除/配额已覆盖）后，存量 OPEN
   * 的 OVER_QUOTA 预警不能永远挂着 —— 自动复核关闭并留档，供监管端审计。
   * 此前只有"同企业同类 OPEN 不重复创建"守卫，没有退出路径（2026-10-31 巡检 P1）。 */
  let autoClosed = 0;
  const stale = await db.query(
    `SELECT id, ent_id FROM alert_record
     WHERE alert_type = 'OVER_QUOTA' AND status = 'OPEN'
     ${entId ? 'AND ent_id = ?' : ''}`,
    entId ? [entId] : []
  );
  const riskEntIds = new Set(rows.map((x) => x.ent_id));
  for (const a of stale) {
    if (riskEntIds.has(a.ent_id)) continue;   // 仍在 HIGH/MEDIUM 风险中，保留
    await db.query(
      `UPDATE alert_record SET status = 'CLOSED', closed_at = NOW(),
              handler = '动态核算自动复核',
              handle_note = '最新滚动核算未再触发 HIGH/MEDIUM 风险（预测缺口已消除或配额已覆盖），系统自动关闭留档。'
        WHERE id = ? AND status = 'OPEN'`, [a.id]
    );
    autoClosed++;
  }
  return created;
}

/** 动态核算总览（监管/企业看板用） */
async function overview(entId = null) {
  const { year, period } = currentPeriod();
  const where = entId ? 'WHERE a.ent_id = ?' : '';
  const params = entId ? [entId] : [];
  const [agg] = (await db.query(
    `SELECT COUNT(*) AS cnt,
            IFNULL(SUM(cumulative_emission),0) AS cum,
            IFNULL(SUM(quota_allocated),0) AS alloc,
            IFNULL(SUM(gap),0) AS gap,
            IFNULL(SUM(offset_applied),0) AS offset,
            SUM(risk_level='HIGH') AS high, SUM(risk_level='MEDIUM') AS medium, SUM(risk_level='LOW') AS low
     FROM carbon_dynamic_account a ${where}`, params
  )) || [{}];
  const rows = await db.query(
    `SELECT a.*, e.ent_name, e.industry, e.region, e.scale
     FROM carbon_dynamic_account a JOIN enterprise e ON e.id = a.ent_id
     ${where} ORDER BY FIELD(a.risk_level,'HIGH','MEDIUM','LOW'), a.gap DESC LIMIT 200`, params
  );
  const [reading] = (await db.query(
    `SELECT COUNT(*) AS cnt, IFNULL(AVG(flow_value),0) AS avg_flow, MAX(reading_time) AS last_at FROM cems_reading`
  )) || [{}];

  /* ⭐ 来源构成：`cems_reading` 同表混两类数据，必须分开报。
   *
   *   source='CEMS' 且 device_did IS NULL → 自举生成（dynamic.ingest）
   *   device_did IS NOT NULL              → 真实设备直报（HJ212 落库）
   *
   * 同一字段里混着"模型输出"与"设备实测"，如果只报总数，页面就无法诚实
   * 说明这些数是什么。这是院审"数据无出处"的根因 —— 所以这里把构成算出来，
   * 让前端能按真实比例声明，而不是靠文案自觉。 */
  const [srcMix] = (await db.query(
    `SELECT SUM(device_did IS NOT NULL) AS device_rows,
            SUM(device_did IS NULL) AS modeled_rows
       FROM cems_reading`
  )) || [{}];
  const deviceRows = Number(srcMix.device_rows || 0);
  const modeledRows = Number(srcMix.modeled_rows || 0);
  const totalRows = deviceRows + modeledRows;

  return {
    year, period,
    summary: {
      enterprises: Number(agg.cnt),
      cumulativeEmission: Number(agg.cum),
      quotaAllocated: Number(agg.alloc),
      totalGap: Number(agg.gap),
      totalOffset: Number(agg.offset),
      highRisk: Number(agg.high || 0),
      mediumRisk: Number(agg.medium || 0),
      lowRisk: Number(agg.low || 0),
    },
    readings: {
      total: Number(reading.cnt),
      avgFlow: Number(reading.avg_flow),
      lastAt: reading.last_at,
      /* 来源构成：前端据此决定说"设备实测"还是"建模生成" */
      deviceRows,
      modeledRows,
      deviceSharePct: totalRows > 0 ? Number((deviceRows / totalRows * 100).toFixed(2)) : 0,
      /* 本页整体该被称作什么：只要存在建模读数就不能自称"全量实测"。
       * 用"混合"而不是"部分真实"，因为前者对读者更可核查。 */
      sourceKind: deviceRows > 0 && modeledRows > 0 ? 'MIXED'
        : (deviceRows > 0 ? 'DEVICE' : 'MODELED'),
      disclaimer: deviceRows === 0
        ? '当前所有读数均为平台自举的建模值（按行业基准 + 确定性抖动生成），非任何真实排口的实测数据。'
        : (modeledRows > 0
          ? `当前 ${deviceRows.toLocaleString()} 条为设备直报、${modeledRows.toLocaleString()} 条为建模生成，两者混在同一序列中，请勿混用。`
          : '当前读数全部来自边缘设备直报（HJ 212-2017，逐帧 CRC/SM3 校验）。'),
    },
    accounts: rows.map((r) => ({
      entId: r.ent_id, entName: r.ent_name, industry: r.industry, region: r.region, scale: r.scale,
      period: r.period,
      cumulativeEmission: Number(r.cumulative_emission),
      quotaAllocated: Number(r.quota_allocated),
      quotaAvailable: Number(r.quota_available),
      gap: Number(r.gap),
      predictedEoy: Number(r.predicted_eoy),
      offsetApplied: Number(r.offset_applied),
      emissionRate: Number(r.emission_rate),
      riskLevel: r.risk_level,
      validPoints: Number(r.data_points),
      excludedPoints: Number(r.excluded_points) || 0,
      qualityGated: Number(r.excluded_points) > 0,
      lastReadingAt: r.last_reading_at,
      updatedAt: r.updated_at,
    })),
  };
}

/** 某企业的实时读数序列（近 n 条） */
async function readings(entId, limit = 48) {
  const rows = await db.query(
    `SELECT monitor_no, energy_type, reading_time, flow_value, cum_value, o2_content, temperature,
            status, quality_flag, source, device_did, batch_no, chain_tx_id
     FROM cems_reading WHERE ent_id = ? ORDER BY reading_time DESC, id DESC LIMIT ?`,
    [entId, Math.min(Number(limit) || 48, 500)]
  );
  return rows.reverse();
}

/* ---------------- 定时采数调度（准实时滚动） ---------------- */
let timer = null;

/**
 * 把「当前所有未锚定的读数」作为**一个批次**上链，并把 chain_tx_id 只回写到这批行。
 * ------------------------------------------------------------------
 * 这是 CEMS 读数上链的**唯一实现**（调度器与 scripts/anchor-real-rows.cjs 共用）。
 *
 * ⚠⚠ 为什么必须有这个函数、而不能就地写 `UPDATE ... WHERE chain_tx_id IS NULL`：
 *   那条语句的条件是**全表**的。任何一次 tick 都会把历史上所有尚未锚定的行
 *   （含别的设备、别的时段、甚至人工补录的行）统统挂到这一笔交易上，
 *   chain_tx_id 因此失去"这条读数属于哪次存证"的溯源意义 ——
 *   拿任何一行去链上比对都能"验过"，但验的其实是别人的批次。
 *   正确口径：本批 ≡ 提交时刻的未锚定行集合；payload 记下条数与 id 区间，
 *   回写用 `id IN (...)`，与 payload 一一对应，可逐条复算。
 *
 * @param {object} [opt]
 *   opt.where       额外过滤条件（SQL 片段，可含 `?`），如 "device_did LIKE ?"
 *   opt.params      与 where 中 `?` 对应的参数
 *   opt.txType      交易类型，默认 CEMS_READING
 *   opt.bizPrefix   业务单号前缀，默认 CEMS
 *   opt.scope       写进 payload 的范围标记，默认 ALL_PENDING
 * @returns {Promise<null|object>} 无待锚定行时返回 null（不产生空交易）
 */
async function anchorPendingBatch(opt = {}) {
  const where = opt.where ? ` AND (${opt.where})` : '';
  const params = opt.params || [];
  const rows = await db.query(
    `SELECT id FROM cems_reading WHERE chain_tx_id IS NULL${where} ORDER BY id ASC`,
    params
  );
  const ids = rows.map((r) => Number(r.id));
  if (!ids.length) return null;            // 无新行 ⇒ 不产生空交易

  const anchorSvc = require('./anchor');
  const batchNo = cu.bizNo(opt.bizPrefix || 'CEMS');
  const res = await anchorSvc.anchor({
    txType: opt.txType || 'CEMS_READING',
    bizNo: batchNo,
    fromLabel: 'regulator:system',
    payload: {
      batchNo,
      scope: opt.scope || 'ALL_PENDING',
      readingCount: ids.length,
      firstReadingId: ids[0],
      lastReadingId: ids[ids.length - 1],
      at: new Date().toISOString(),
    },
  });
  const w = await db.query(
    `UPDATE cems_reading SET chain_tx_id = ?
      WHERE chain_tx_id IS NULL AND id IN (?)`,
    [res.txId, ids]
  );
  return {
    batchNo,
    txId: res.txId,
    blockIndex: res.blockIndex,
    blockHash: res.blockHash,
    readingCount: ids.length,
    firstReadingId: ids[0],
    lastReadingId: ids[ids.length - 1],
    updatedRows: w && w.affectedRows !== undefined ? w.affectedRows : Number(w),
  };
}

/** 启动定时采数与核算；intervalMs 默认 60s（演示节奏，生产可按小时） */
function startScheduler(intervalMs = Number(process.env.CEMS_INTERVAL_MS || 60000)) {
  if (timer) return timer;
  const tick = async () => {
    try {
      await ingest({ days: 0 });     // 采集最近一个步长
      await recompute();             // 滚动重算全部企业
      // 采数批次上链存证（整批一次，体现"实测数据直接上链"）
      try {
        await anchorPendingBatch();
      } catch (e) { /* 上链失败不阻断采数 */ }
    } catch (e) {
      console.error('[dynamic] 定时核算失败：', e.message);
    }
  };
  timer = setInterval(tick, Math.max(5000, intervalMs));
  if (timer.unref) timer.unref();
  return timer;
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

/** 幂等自举：若尚无实测数据，生成一段历史读数并完成首轮核算 */
async function bootstrap() {
  const cnt = Number(await db.value('SELECT COUNT(*) FROM cems_reading')) || 0;
  if (cnt === 0) await ingest({ days: 30 });
  await recompute();
  return overview();
}

module.exports = {
  INDUSTRY_BASE, STEP_HOURS, NOMINAL_CAP_MIN, HOURS_PER_YEAR,
  dailyBase, dailyBaseFor, monitorsOf, sharesOf, currentPeriod,
  ingest, recompute, emitAlerts, overview, readings,
  observedCorrection, annualFrom, annualCumAt, resetCorrCache,
  anchorPendingBatch,
  startScheduler, stopScheduler, bootstrap,
};
