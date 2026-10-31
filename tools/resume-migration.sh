#!/usr/bin/env bash
# =====================================================================================
#  resume-migration.sh —— 额度恢复后一键续跑迁移
# =====================================================================================
#  用途：D1 每日额度耗尽后，等 UTC 零点重置，跑这一个脚本即可完成剩余迁移。
#
#  设计要点：
#    ① 不轮询 D1 查进度（那会额外消耗额度）。进度只看脚本自己的日志。
#    ② 大表按年度分段，段间 sleep —— 避开 D1 的连续写入限流。
#    ③ 每段结束核对一次行数（这是"迁移成功"的唯一硬判据）。
#    ④ 任一段失败不终止全局，记录后继续 —— 最后汇总，人工决定是否重跑该段。
#
#  用法：
#    bash tools/resume-migration.sh              # 续跑全部
#    bash tools/resume-migration.sh --years-only # 只跑年度表
#    bash tools/resume-migration.sh --verify     # 只核对
# =====================================================================================
set -u

cd "$(dirname "$0")/.." || exit 1
export WRANGLER_SEND_METRICS=false

LOG="tools/out/resume-migration-$(date +%Y%m%d-%H%M%S).log"
mkdir -p tools/out

say() { echo "$@" | tee -a "$LOG"; }

say "=================================================================="
say "  碳链通 · D1 迁移续跑   $(date '+%Y-%m-%d %H:%M:%S')"
say "=================================================================="
say ""

# ---------- 只核对 ----------
if [ "${1:-}" = "--verify" ]; then
  say "【行数核对】"
  node tools/migrate-to-d1.mjs --verify 2>&1 | tee -a "$LOG"
  exit $?
fi

FAILED=()

# ---------- 1. 年度排放记录（28 万行，最关键） ----------
if [ "${1:-}" != "--years-only" ] || [ "${1:-}" = "--years-only" ]; then
  for y in 2022 2023 2024 2025 2026; do
    say ""
    say "───── real_emission_year · $y ─────"
    OUT=$(node tools/migrate-to-d1.mjs --batch 500 --only real_emission_year --year "$y" --force 2>&1)
    echo "$OUT" >> "$LOG"
    if echo "$OUT" | grep -q "✔ 核对"; then
      say "  ✔ $y 完成：$(echo "$OUT" | grep '✔ 核对' | tail -1 | sed 's/^ *//')"
    else
      say "  ✘ $y 失败"
      FAILED+=("real_emission_year:$y")
    fi
    # 段间等待：让 D1 的写入限流窗口过去
    sleep 20
  done
fi

# ---------- 2. 其余业务表 ----------
if [ "${1:-}" != "--years-only" ]; then
  say ""
  say "───── 其余业务表 ─────"
  OUT=$(node tools/migrate-to-d1.mjs --batch 500 2>&1)
  echo "$OUT" >> "$LOG"
  say "$OUT" | tail -20

  # 汇总失败表
  echo "$OUT" | grep -E "^\s+· .*: " | while read -r line; do
    say "  ✘ $line"
  done
fi

# ---------- 3. 行数核对 ----------
say ""
say "───── 行数核对 ─────"
VERIFY_OUT=$(node tools/migrate-to-d1.mjs --verify 2>&1)
echo "$VERIFY_OUT" >> "$LOG"
say "$VERIFY_OUT" | tail -25

# ---------- 4. 汇总 ----------
say ""
say "=================================================================="
if [ ${#FAILED[@]} -eq 0 ]; then
  say "  续跑完成，无失败段"
else
  say "  有 ${#FAILED[@]} 段失败：${FAILED[*]}"
  say "  可单独重跑：node tools/migrate-to-d1.mjs --only <表> --year <年> --force"
fi
say "  详细日志：$LOG"
say "=================================================================="
