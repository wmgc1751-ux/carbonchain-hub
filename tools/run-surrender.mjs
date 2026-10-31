/**
 * run-surrender.mjs —— 批量履约清缴（可重跑）
 * ==================================================================================
 * 用途：为某年度所有有排放依据的企业生成并执行清缴，
 *       让「配额被消耗 → 碳市场闭环」这件事在数据库里真的发生。
 *
 * 为什么需要单独一个脚本：
 *   initdb 只负责建库与首轮核算，不清缴 —— 因为清缴是**年度末的监管动作**，
 *   不是初始化的一部分。但没有清缴记录，平台就永远停在"有配额、有交易、
 *   没履约"的半截状态，配额 `used` 恒为 0，"履约率"统计读的是一个死列。
 *
 * ⚠ 这个脚本会**真实扣减配额**（available → used）并写入手续费罚款。
 *   默认 dry-run，必须显式 --execute 才落库。
 *
 * 用法：
 *   node tools/run-surrender.mjs --year 2026              # 试算，不改数据
 *   node tools/run-surrender.mjs --year 2026 --execute    # 真实执行
 *   node tools/run-surrender.mjs --year 2026 --execute --only-usable
 *        # 只清缴「可用于履约」的企业（有合格核算批次/核查报告）
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../server/db');
const compliance = require('../server/services/compliance');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

async function main() {
  const year = Number(arg('year', new Date().getFullYear()));
  const execute = process.argv.includes('--execute');
  const onlyUsable = process.argv.includes('--only-usable');

  console.log('═'.repeat(74));
  console.log(`批量履约清缴 · ${year} 年度 · ${execute ? '【真实执行】' : '【试算，不改数据】'}`);
  if (onlyUsable) console.log('模式：仅清缴有合格排放依据的企业');
  console.log('═'.repeat(74));

  /* 取候选企业。onlyUsable 时先筛出有可用依据的 —— 避免对每个企业
   * 都跑一遍 resolveVerifiedEmission 再抛异常（60 家企业会有大量噪声日志）。 */
  let ents;
  if (onlyUsable) {
    ents = await db.query(
      `SELECT DISTINCT e.id, e.ent_name FROM enterprise e
         JOIN carbon_quota q ON q.ent_id = e.id AND q.year = ?
        WHERE e.status <> 'SUSPENDED'
          AND (EXISTS (SELECT 1 FROM calc_batch b WHERE b.ent_id = e.id AND b.year = ?
                        AND b.usable_for_compliance = 1 AND b.status <> 'VOID')
            OR EXISTS (SELECT 1 FROM verify_report v WHERE v.ent_id = e.id
                        AND YEAR(v.issue_time) = ? AND v.conclusion IN ('PASS','CONDITIONAL')))
        ORDER BY e.id`, [year, year, year]
    );
  } else {
    ents = await db.query(
      `SELECT id, ent_name FROM enterprise WHERE status <> 'SUSPENDED' ORDER BY id`
    );
  }

  console.log(`候选企业：${ents.length} 家\n`);

  const rows = [];
  let ok = 0; let noBasis = 0; let failed = 0;
  let sumRequired = 0; let sumSurrendered = 0; let sumShortfall = 0; let sumPenalty = 0;

  for (const e of ents) {
    const label = `ent${String(e.id).padStart(3, '0')} ${String(e.ent_name).slice(0, 12)}`;
    try {
      const prep = await compliance.prepareSurrender({
        entId: Number(e.id), year, operator: 'run-surrender',
      });

      /* 已足额清缴的企业：跳过，不计入缺口统计（否则会把"已完成"误报成"新缺口"） */
      if (prep.alreadySurrendered) {
        rows.push({
          ent: label, required: prep.requiredQuota, available: prep.availableQuota,
          shortfall: 0, penalty: 0,
          status: 'ALREADY_DONE', cert: prep.certificateNo || '—', chain: '—',
        });
        sumRequired += Number(prep.requiredQuota) || 0;
        sumSurrendered += Number(prep.surrenderedQuota) || 0;
        ok++;
        continue;
      }

      if (!execute) {
        /* 试算只报告，不动数据 */
        rows.push({
          ent: label, required: prep.requiredQuota, available: prep.availableQuota,
          shortfall: prep.willShortfall, penalty: prep.estimatedPenalty,
          status: prep.willShortfall > 0 ? 'WOULD_SHORTFALL' : 'WOULD_PASS',
        });
        sumRequired += prep.requiredQuota;
        sumShortfall += prep.willShortfall;
        sumPenalty += prep.estimatedPenalty;
        ok++;
        continue;
      }

      const ex = await compliance.executeSurrender(prep.surrenderNo, {
        operator: 'run-surrender',
        /* 允许按缺口清缴：真实监管场景下，企业确实会不足额清缴并接受罚款。
         * 若不允许，整个流程会在第一家缺额企业处中断，后面的都没法清。 */
        allowShortfall: true,
      });

      rows.push({
        ent: label, required: ex.required, available: prep.availableQuota,
        surrendered: ex.surrendered, shortfall: ex.shortfall, penalty: ex.penalty,
        status: ex.status, cert: ex.certificateNo || '—',
        chain: ex.chain && ex.chain.blockIndex ? `#${ex.chain.blockIndex}` : (ex.chain && ex.chain.error ? 'ERR' : '—'),
      });
      /* ⚠ 累加必须防 null/undefined —— 早先写成 sumRequired += ex.required，
       * 而 executeSurrender 的返回值里 required 是有的，但 surrendered 在某些
       * 分支（alreadyDone）为 undefined，导致整个合计变成 NaN 并静默传播。
       * 用 Number(x) || 0 兜底，并在下面核对「合计 > 0」以捕捉问题。 */
      sumRequired += Number(ex.required) || 0;
      sumSurrendered += Number(ex.surrendered) || 0;
      sumShortfall += Number(ex.shortfall) || 0;
      sumPenalty += Number(ex.penalty) || 0;
      ok++;
    } catch (err) {
      const msg = String(err.message || err);
      if (msg.includes('既无合格核查报告') || msg.includes('无排放量依据')) {
        noBasis++;
      } else {
        failed++;
        console.log(`✘ ${label} — ${msg}`);
      }
    }
  }

  /* ---- 输出（最多显示 25 行，避免刷屏） ---- */
  const show = rows.slice(0, 25);
  console.log('序号 企业                     应缴(万t) 实缴(万t) 缺口     状态           链上');
  console.log('─'.repeat(88));
  show.forEach((x, i) => {
    const req = ((x.required || 0) / 10000).toFixed(2).padStart(8);
    const sur = ((x.surrendered || 0) / 10000).toFixed(2).padStart(8);
    const gap = ((x.shortfall || 0) / 10000).toFixed(2).padStart(7);
    console.log(
      `${String(i + 1).padStart(3)}  ${x.ent.padEnd(24)} ${req}  ${sur}  ${gap}  ` +
      `${String(x.status).padEnd(14)} ${x.chain || '—'}`
    );
  });
  if (rows.length > show.length) console.log(`  … 另有 ${rows.length - show.length} 家未显示`);

  console.log('─'.repeat(88));
  /* 合计的自检：应缴必须 > 0。若为 NaN 或 0，说明返回值字段缺失 —— 报错而不是打印 NaN。 */
  if (ok > 0 && !(sumRequired > 0)) {
    console.error(`✘ 合计异常：应缴合计为 ${sumRequired}，说明接口返回值缺字段（不是数据问题，是契约问题）`);
    process.exitCode = 1;
  }
  console.log(`成功 ${ok} · 无排放依据 ${noBasis} · 失败 ${failed} · 合计 ${ents.length} 家`);
  console.log(`应缴合计 ${(sumRequired / 10000).toFixed(2)} 万 tCO₂e`
    + (execute ? ` · 实缴 ${(sumSurrendered / 10000).toFixed(2)} 万 t` : ''));
  console.log(`缺口合计 ${(sumShortfall / 10000).toFixed(2)} 万 tCO₂e`
    + (sumPenalty > 0 ? ` · 罚款 ${(sumPenalty / 10000).toFixed(2)} 万元` : ''));

  /* ---- 落库后复核：配额 used 必须真的增加 ---- */
  if (execute) {
    const after = await db.query(
      `SELECT COUNT(*) n, SUM(used) u, SUM(available) a FROM carbon_quota WHERE year = ?`, [year]
    );
    console.log(`\n库内状态：${after[0].n} 个配额账户，used 合计 ${(Number(after[0].u) / 10000).toFixed(2)} 万 t，`
      + `available 合计 ${(Number(after[0].a) / 10000).toFixed(2)} 万 t`);
    const neg = await db.query(
      'SELECT COUNT(*) n FROM carbon_quota WHERE year = ? AND available < -0.01', [year]
    );
    console.log(`负余额账户：${neg[0].n} 个${Number(neg[0].n) === 0 ? ' ✔' : ' ✘ 存在缺陷'}`);
  } else {
    console.log('\n（试算模式未改动数据；加 --execute 才会真实扣减配额）');
  }

  await db.pool.end();
  try { await db.ledgerPool.end(); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error('✘ 执行崩溃：', e);
  try { await db.pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
