/**
 * refresh-notices.js —— 从权威源站抓取最新真实消息并入库
 *
 * 用法：
 *   node server/scripts/refresh-notices.js           抓取并入库
 *   node server/scripts/refresh-notices.js --dry     只抓取查看，不入库
 *
 * 生产环境可由 cron / setInterval 定时触发；server/routes/notice.js
 * 亦提供管理端手动触发端点。
 */
'use strict';

(async () => {
  const feed = require('../services/noticeFeed');
  const dry = process.argv.includes('--dry');

  console.log('→ 从权威源站抓取真实消息…');
  const { items, errors, fetchedAt } = await feed.fetchAll();

  console.log(`  抓取时间 ${fetchedAt}`);
  const byCat = {};
  for (const it of items) (byCat[it.categoryLabel] ||= []).push(it);
  for (const [cat, list] of Object.entries(byCat)) {
    console.log(`\n  [${cat}] ${list.length} 条 · 来源 ${list[0].sourceName}`);
    for (const it of list.slice(0, 3)) console.log(`    · ${it.date || '----'}  ${it.title.slice(0, 60)}`);
  }
  if (errors.length) {
    console.log('\n  ⚠ 失败源：');
    errors.forEach((e) => console.log(`    · ${e.source}: ${e.error}`));
  }

  if (dry) { console.log('\n(dry run，未入库)'); return; }

  const r = await feed.persist(items);
  console.log(`\n✔ 入库新增 ${r.inserted} 条，重复跳过 ${r.skipped} 条`);
  process.exit(0);
})().catch((e) => { console.error('✘ 失败：', e); process.exit(1); });
