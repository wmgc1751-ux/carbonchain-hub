/**
 * utils/time.js —— 链上时间的时区口径（唯一实现）
 * ==================================================================
 * 【为什么需要这个模块】
 * `chain_block.block_time` / `chain_tx.created_at` 在账本库里存的是
 * **按 UTC 格式化的字面量**（见 blockchain/chain.js 的 utcDateString 与时区约定：
 * 区块哈希的输入是绝对秒数，所以"写进去的字符串"必须与"读出来的秒数"恒等）。
 *
 * 而 MySQL 的 `UNIX_TIMESTAMP()` 按【会话时区】解释输入。会话时区是连接级状态：
 * 链内核启动时执行的 `SET time_zone='+00:00'` 只作用于池里当时那条连接，
 * 其余连接仍是 SYSTEM(+08)。于是同一个字面量在不同请求上会解出相差 28800 秒的
 * epoch —— 表现为「区块列表 07:46、CEMS 曲线 16:16」这种同屏差 8 小时
 * （2026-10-29 巡检 P0-7 / P0-7b）。
 *
 * 结论：**凡是把库里的时间给到前端，都不要经过 UNIX_TIMESTAMP，一律按 UTC 字面量解析。**
 * 本模块就是那唯一一处实现，各路由 require 它即可，不要再各写一份。
 */
'use strict';

/** epoch 秒 → 本地时区 `YYYY-MM-DD HH:mm:ss`（也接受 Date） */
function fmtLocalTs(ts) {
  if (ts instanceof Date) ts = ts.getTime() / 1000;
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + ` ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** UTC 字面量 `YYYY-MM-DD HH:mm:ss` → epoch 秒（解析失败返回 null） */
function utcLiteralToEpoch(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(v == null ? '' : v));
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000);
}

/**
 * 库里取出的 UTC 时间字面量 → 本地可读字符串。
 * 非字面量（已是 epoch 或 Date）时退回通用路径，保证调用方不必判断类型。
 */
function localFromUtcLiteral(v) {
  if (v === null || v === undefined) return null;
  const e = utcLiteralToEpoch(v);
  if (e !== null) return fmtLocalTs(e);
  return fmtLocalTs(v);
}

module.exports = { fmtLocalTs, utcLiteralToEpoch, localFromUtcLiteral };
