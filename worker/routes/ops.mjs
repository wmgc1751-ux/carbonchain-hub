/**
 * worker/routes/ops.mjs —— 运维可观测（监控 / 日志 / D1 额度）
 * ==================================================================================
 * 【为什么 D1 额度必须变成一等公民】
 *
 * 免费层每天 500 万行读取。这不是"性能问题"，是**可用性问题**：
 * 额度用尽后所有查询返回错误，用户看到的是"平台挂了"，
 * 而真相是配额超限 —— 两者需要的处置完全不同。
 *
 * 因此这里提供 /api/ops/d1-usage：
 *   · 当前请求的 rows_read / queries
 *   · 预聚合表的新鲜度（上次刷新时间）
 *   · 若某年度指纹反复变化，说明源数据在持续写入，需告警
 *
 * 【没有持久化的用量统计】
 * D1 本身不提供"今日已用额度"的查询接口（Cloudflare 控制台有，但无 API）。
 * 本端点因此报告的是**本轮请求的用量**与**预聚合健康度**，
 * 而不是虚报一个"今日已用 X%"的假数字。
 * 说清"我知道什么、不知道什么"比给一个漂亮但编造的仪表盘更可信。
 *
 * @module worker/routes/ops
 */

import { json, fail, authRequired, requireRole, num } from '../lib/http.mjs';
import { snapshot, history, selfCheck } from '../lib/realtime.mjs';
import { loadAuthSnapshot, saveAuthSnapshot } from './auth.mjs';

export function attachOpsRoutes(r) {
  /* ==================================================================================
   * 实时快照（公开）—— 读时计算，不落库
   * ==================================================================================
   * 路径沿用 /api/real/live（前端既有调用），语义变为"实时计算"。
   */
  r.get('/api/real/live', async (ctx) => {
    const snap = await snapshot(ctx.db, ctx.query.at ? new Date(num(ctx.query.at)) : new Date());
    return json(snap);
  });

  r.get('/api/real/live/history', async (ctx) => {
    /* 历史用解析式反推：曲线是确定性的，重算结果与"当时落库"一致。
     * 默认最近 1 小时、每分钟一点。 */
    const now = Date.now();
    const to = num(ctx.query.to, now);
    const from = num(ctx.query.from, to - 3600_000);
    const step = num(ctx.query.step, 60);
    return json({
      points: history(from, to, step),
      method: '解析式反推（负荷曲线确定性），非历史落库',
      note: 'D1 不保存秒级历史（写入额度不允许）。曲线可复算，因此重算历史与当时落库等价。',
    });
  });

  r.get('/api/real/live/selfcheck', async (ctx) => {
    const r2 = selfCheck();
    return json({
      ...r2,
      verdict: r2.pass ? '实时引擎确定性自检通过' : '自检失败：同输入未产生同输出',
    });
  });

  /* ==================================================================================
   * SSE 实时推送（/api/real/stream）
   * ==================================================================================
   * 前端 real.js 用 EventSource 订阅它。Workers 支持流式响应，
   * 因此可以真正做 SSE 而不是退回轮询。
   *
   * 【为什么不用 WebSocket】
   * Workers 的 WebSocket 需要 Durable Object 承载连接状态，
   * 而本平台只需"服务端每秒推一个快照"这种单向流 ——
   * SSE 完全够用，且浏览器原生支持、断线自动重连、无需额外组件。
   *
   * 【写入额度的约束】
   * 每秒推一次、每次 9 个指标 —— 若把这些写进 D1 会瞬间耗尽额度。
   * 因此推送的快照是**读时计算**（lib/realtime.snapshot），全程零写入。
   *
   * 【连接时长上限】
   * Cloudflare 对响应流有持续时间限制（约 100 秒的 CPU 时间预算与
   * 连接时长限制）。因此这里主动在 ~55 秒后正常结束流，
   * 由浏览器的 EventSource 自动重连 —— 比让平台强行断开更平滑。
   * 前端不需要改任何代码，EventSource 的重连是内置行为。
   */
  r.get('/api/real/stream', async (ctx) => {
    const enc = new TextEncoder();
    const MAX_MS = 55_000;
    const TICK_MS = 1000;
    const started = Date.now();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event, data) => {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        /* 首帧立即发，避免前端等 1 秒才看到东西 */
        try {
          const snap = await snapshot(ctx.db, new Date());
          send('snapshot', snap);
        } catch (e) {
          send('error', { message: String(e.message || e) });
          controller.close();
          return;
        }

        let timer = null;
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          try { controller.close(); } catch { /* 已关闭 */ }
        };

        timer = setInterval(async () => {
          if (closed) return;
          if (Date.now() - started > MAX_MS) { close(); return; }
          try {
            const snap = await snapshot(ctx.db, new Date());
            send('snapshot', snap);
          } catch (e) {
            send('error', { message: String(e.message || e) });
            close();
          }
        }, TICK_MS);

        /* 客户端断开时清理定时器 —— 否则定时器会继续跑，
         * 在 Worker 里意味着持续消耗 CPU 直到被强制终止。 */
        ctx.request.signal?.addEventListener?.('abort', close);
      },
      cancel() { /* ReadableStream 被取消时的钩子 */ },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Data-Mode': 'LIVE',
      },
    });
  });

  /* ---------- 运行状态（公开，用于外部探活） ---------- */
  r.get('/api/ops/health', async (ctx) => {
    const t0 = Date.now();
    const checks = [];

    /* DB 可用性 */
    try {
      await ctx.db.value('SELECT 1');
      checks.push({ name: 'D1 连接', pass: true, detail: 'ok' });
    } catch (e) {
      checks.push({ name: 'D1 连接', pass: false, detail: String(e.message || e) });
    }

    /* 预聚合新鲜度 */
    let aggHealth = null;
    try {
      const t = await ctx.db.one(
        `SELECT MAX(refreshed_at) AS last, COUNT(DISTINCT year) AS years, SUM(facilities) AS fac
           FROM agg_facility_total`);
      const lastMs = t && t.last ? new Date(t.last).getTime() : null;
      const ageMin = lastMs ? Math.round((Date.now() - lastMs) / 60000) : null;
      aggHealth = {
        lastRefreshedAt: t ? t.last : null,
        ageMinutes: ageMin,
        years: num(t && t.years),
        facilities: num(t && t.fac),
        /* 预聚合超过 2 小时未刷新即为陈旧（Cron 每 30 分钟一次，
         * 容忍 4 个周期失败） */
        stale: ageMin === null || ageMin > 120,
      };
      checks.push({
        name: '预聚合新鲜度', pass: !aggHealth.stale,
        detail: ageMin === null ? '从未刷新' : `${ageMin} 分钟前`,
      });
    } catch (e) {
      checks.push({ name: '预聚合新鲜度', pass: false, detail: String(e.message || e) });
    }

    /* 洞察新鲜度 */
    let insightHealth = null;
    try {
      const kinds = await ctx.db.query(
        'SELECT kind, MAX(refreshed_at) AS last FROM agg_insight GROUP BY kind');
      insightHealth = kinds.map((k) => ({
        kind: k.kind, lastRefreshedAt: k.last,
        ageHours: k.last ? Math.round((Date.now() - new Date(k.last).getTime()) / 3600000) : null,
      }));
    } catch { /* 忽略 */ }

    const allPass = checks.every((c) => c.pass);
    return json({
      status: allPass ? 'UP' : 'DEGRADED',
      checks,
      aggregates: aggHealth,
      insights: insightHealth,
      latencyMs: Date.now() - t0,
      dataMode: 'LIVE',
    });
  });

  /* ---------- D1 用量（需登录） ---------- */
  r.get('/api/ops/d1-usage', requireRole('ADMIN', 'REGULATOR')(async (ctx) => {
    /* 本轮请求的用量由 lib/http 的 meter 记录 */
    const tables = await ctx.db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    const aggStats = await ctx.db.one(
      `SELECT COUNT(*) AS rows_n FROM agg_facility_year`);

    return json({
      thisRequest: {
        queries: ctx.meter.queries,
        rowsRead: ctx.meter.rowsRead,
        rowsWritten: ctx.meter.rowsWritten,
      },
      /* 预聚合规模：这是"读取侧只查几十行"的物质基础 */
      aggregates: {
        rows: num(aggStats && aggStats.rows_n),
        note: '页面读预聚合表（几十行），不读明细表（30 万行）—— 这是 D1 上可用的前提。',
      },
      tables: tables.length,
      limits: {
        dailyRowsRead: 5_000_000,
        dailyRowsWritten: 100_000,
        source: 'Cloudflare D1 免费层（截至 2026-10）',
      },
      honesty: {
        canReport: [
          '本轮请求的读取/写入行数（精确）',
          '预聚合表规模与新鲜度（精确）',
        ],
        cannotReport: [
          '今日累计已用额度 —— D1 未提供查询接口，控制台可见但无 API',
          '全站历史用量趋势 —— 需要额外的 Analytics Engine 绑定',
        ],
        why: '不提供"今日已用 X%"这类数字，因为无法真实取得。'
          + '编造一个仪表盘比没有仪表盘更危险：它会在真正超额时显示"容量充足"。',
      },
    });
  }));

  /* ---------- 预聚合内容快照（便于确认"页面上的数字从哪来"） ---------- */
  r.get('/api/ops/aggregates', requireRole('ADMIN', 'REGULATOR')(async (ctx) => {
    const totals = await ctx.db.query(
      `SELECT country_iso, year, facilities, emission_rows, total_co2e,
              aggregate_assets, aggregate_tonnes, refreshed_at
         FROM agg_facility_total ORDER BY year DESC, country_iso`);
    const fingerprints = await ctx.db.query(
      `SELECT scope AS year, payload_json AS fingerprint, refreshed_at
         FROM agg_insight WHERE kind='FINGERPRINT' ORDER BY scope DESC`);
    return json({
      totals: totals.map((t) => ({
        country: t.country_iso, year: num(t.year),
        facilities: num(t.facilities),
        totalMt: +(num(t.total_co2e) / 1e6).toFixed(2),
        aggregateAssets: num(t.aggregate_assets),
        aggregateMt: +(num(t.aggregate_tonnes) / 1e6).toFixed(2),
        refreshedAt: t.refreshed_at,
      })),
      fingerprints: fingerprints.map((f) => ({
        year: num(f.year),
        /* 指纹形如 "50354|300453|67548140587" —— 设施数|记录数|总排放 */
        fingerprint: f.fingerprint,
        parts: String(f.fingerprint).split('|'),
        refreshedAt: f.refreshed_at,
      })),
      note: '指纹 = 设施数 | 年度记录数 | 总排放量。三者任一变化即触发该年度重算。',
    });
  }));

  /* ---------- 审计哈希链校验 ---------- */
  r.get('/api/ops/audit-chain', requireRole('REGULATOR')(async (ctx) => {
    const page = Math.max(num(ctx.query.page, 1), 1);
    const size = Math.min(Math.max(num(ctx.query.size, 50), 1), 200);
    const total = num(await ctx.db.value('SELECT COUNT(*) FROM audit_log'));
    const rows = await ctx.db.query(
      `SELECT id, actor, action, target, detail, prev_hash, entry_hash, created_at
         FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?`, [size, (page - 1) * size]);
    const sealed = num(await ctx.db.value(
      'SELECT COUNT(*) FROM audit_log WHERE entry_hash IS NOT NULL'));
    const unsealed = num(await ctx.db.value(
      'SELECT COUNT(*) FROM audit_log WHERE entry_hash IS NULL'));
    return json({
      total, sealed, unsealed,
      entries: rows.map((e) => ({
        id: num(e.id), actor: e.actor, action: e.action, target: e.target,
        detail: String(e.detail || '').slice(0, 200),
        prevHash: e.prev_hash, entryHash: e.entry_hash, createdAt: e.created_at,
      })),
    }, { page, size, total });
  }));

  r.get('/api/ops/audit-chain/verify', requireRole('REGULATOR')(async (ctx) => {
    /* 审计链校验：逐条核对 entry_hash 与 prev_hash 的链式关系。
     * 分批读取以避免一次载入全部审计行。 */
    const t0 = Date.now();
    const total = num(await ctx.db.value('SELECT COUNT(*) FROM audit_log WHERE entry_hash IS NOT NULL'));
    const issues = [];
    let prev = null;
    let checked = 0;
    const BATCH = 200;
    for (let off = 0; off < total; off += BATCH) {
      const rows = await ctx.db.query(
        `SELECT id, prev_hash, entry_hash FROM audit_log
          WHERE entry_hash IS NOT NULL ORDER BY id ASC LIMIT ? OFFSET ?`, [BATCH, off]);
      for (const r of rows) {
        checked++;
        if (prev !== null && r.prev_hash !== prev) {
          issues.push({ id: num(r.id), kind: 'CHAIN_BREAK', expected: prev, actual: r.prev_hash });
        }
        prev = r.entry_hash;
      }
    }
    return json({
      ok: issues.length === 0,
      checked,
      issues: issues.slice(0, 50),
      elapsedMs: Date.now() - t0,
      verdict: issues.length === 0
        ? `审计哈希链完整：${checked} 条记录全部链式相连`
        : `发现 ${issues.length} 处断裂`,
      scopeNote: '本校验覆盖 prev_hash ↔ entry_hash 的链式关系；'
        + '单条内容的哈希复算由本地工具 tools/audit-chain-selftest.mjs 执行（需原始字段）。',
    });
  }));

  /* ---------- 请求日志（本轮 Worker 无持久化日志，如实说明） ---------- */
  r.get('/api/ops/logs', requireRole('REGULATOR')(async (ctx) => {
    return json({
      entries: [],
      note: 'Worker 运行日志通过 Cloudflare Observability 输出（wrangler tail 或控制台），'
        + '不落 D1 —— 日志量大，写入会立刻耗尽每日 10 万行写入额度。'
        + '本端点保留是为了前端页面不 404；真实日志请用 `wrangler tail` 查看。',
      alternative: 'wrangler tail carbonchain-hub --format pretty',
    });
  }));

  /* ---------- 迁移状态：MySQL 与 D1 的行数对照 ---------- */
  r.get('/api/ops/migration-status', requireRole('ADMIN')(async (ctx) => {
    const tables = await ctx.db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'agg_%' ORDER BY name");
    const counts = [];
    for (const t of tables) {
      try {
        const n = num(await ctx.db.value(`SELECT COUNT(*) FROM "${t.name}"`));
        counts.push({ table: t.name, rows: n });
      } catch { counts.push({ table: t.name, rows: null, error: true }); }
    }
    return json({
      tables: counts,
      tableCount: counts.length,
      totalRows: counts.reduce((a, b) => a + (b.rows || 0), 0),
      note: '这是 D1 侧的实际行数。与 MySQL 侧的对照需在本地跑 tools/migrate-to-d1.mjs --verify。',
    });
  }));

  /* ==================================================================================
   * 核查机构注册审核（与 server/routes/admin.js 同契约）
   * ==================================================================================
   * 机构自主注册以 sys_user.status=0 落库（auth.mjs register 的 VERIFIER 分支），
   * 管理员在此人工准入。D1 无事务，两条 UPDATE 顺序执行；审核通过必须回填
   * KV 登录快照 —— 否则快照命中的登录路径会继续拿到旧的 st:0，出现
   * "管理员说通过了、用户登录还是待审核"的阴阳状态。
   */
  r.get('/api/admin/verifier-registrations', requireRole('ADMIN')(async (ctx) => {
    const rows = await ctx.db.query(
      `SELECT id, username, real_name, org_name, phone, created_at
         FROM sys_user WHERE role = 'VERIFIER' AND status = 0 ORDER BY created_at DESC`);
    return json(rows.map((r) => ({
      id: num(r.id), username: r.username, realName: r.real_name,
      orgName: r.org_name, phone: r.phone, createdAt: r.created_at, lastLogin: null,
    })));
  }));

  r.post('/api/admin/verifier-registrations/:id/review', requireRole('ADMIN')(async (ctx) => {
    const id = num(ctx.params.id);
    const body = await ctx.body();
    const approve = !!(body && body.approve);
    const reason = String((body && body.reason) || '').trim();

    const u = await ctx.db.one(
      "SELECT id, username, real_name, org_name, status FROM sys_user WHERE id = ? AND role = 'VERIFIER'", [id]);
    if (!u) return fail('注册记录不存在或角色不符', 404);
    if (num(u.status, 1) !== 0) return fail('该注册申请已被处理', 409);

    if (approve) {
      await ctx.db.run('UPDATE sys_user SET status = 1 WHERE id = ?', [id]);
      /* 回填 KV 快照：这个人现在可登录了（快照里没有 → D1 回源也能登录，
       * 但回填避免"快照较旧"期间 D1 读额度被无谓消耗） */
      try {
        const snap = await loadAuthSnapshot(ctx.env);
        if (snap && Array.isArray(snap.users)) {
          const hit = snap.users.find((x) => x.u === u.username);
          if (hit) { hit.st = 1; await saveAuthSnapshot(ctx.env, snap); }
        }
      } catch { /* 快照回填失败不影响审核结果，D1 回源兜底 */ }
      try {
        await ctx.db.run(
          `INSERT INTO audit_log (actor, action, target, detail, created_at)
           VALUES (?, 'ADMIN_REVIEW', ?, ?, CURRENT_TIMESTAMP)`,
          [ctx.user.username, u.username, `核查机构 ${u.org_name} 审核准入${reason ? ` · 备注：${reason}` : ''}`]);
      } catch { /* 审计失败不阻断 */ }
      return json({ approved: true, username: u.username, orgName: u.org_name });
    }

    await ctx.db.run('DELETE FROM sys_user WHERE id = ? AND status = 0', [id]);
    try {
      await ctx.db.run(
        `INSERT INTO audit_log (actor, action, target, detail, created_at)
         VALUES (?, 'ADMIN_REVIEW', ?, ?, CURRENT_TIMESTAMP)`,
        [ctx.user.username, u.username, `驳回核查机构 ${u.org_name} 的注册申请${reason ? ` · 原因：${reason}` : ''}`]);
    } catch { /* 审计失败不阻断 */ }
    return json({ approved: false, username: u.username, orgName: u.org_name });
  }));
}
