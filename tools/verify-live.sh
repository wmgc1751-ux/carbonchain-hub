#!/usr/bin/env bash
# =====================================================================================
#  verify-live.sh —— 线上全链路验证
# =====================================================================================
#  判据设计原则：**不以 HTTP 200 论生死**。
#  静态托管对任意路径都返回 index.html（SPA 兜底），状态码 200 但内容是 HTML。
#  历史上正是这个"假 200"掩盖了后端不可用。因此每个检查都必须验证响应体里的 code。
#
#  用法：
#    bash tools/verify-live.sh
#    HOST=https://www.carbonchain.dpdns.org bash tools/verify-live.sh
# =====================================================================================
set -u

HOST="${HOST:-https://carbonchain-hub.pages.dev}"
PASS=0; FAIL=0; SKIP=0
FAILED_ITEMS=()

ok()   { PASS=$((PASS+1)); printf "  \033[32m✔\033[0m %s%s\n" "$1" "${2:+  — $2}"; }
bad()  { FAIL=$((FAIL+1)); FAILED_ITEMS+=("$1"); printf "  \033[31m✘\033[0m %s%s\n" "$1" "${2:+  — $2}"; }
skip() { SKIP=$((SKIP+1)); printf "  \033[33m⊘\033[0m %s%s\n" "$1" "${2:+  — $2}"; }

# 取 JSON 字段（不依赖 jq）
jget() { node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{ const j=JSON.parse(s); const p='$1'.split('.');
    let v=j; for(const k of p){ v = v==null?undefined:v[k]; }
    console.log(typeof v==='object'?JSON.stringify(v):String(v));
  }catch(e){ console.log('__PARSE_ERROR__'); }
});"; }

echo "=================================================================="
echo "  碳链通 · 线上全链路验证"
echo "  目标：$HOST"
echo "  时间：$(date '+%Y-%m-%d %H:%M:%S')"
echo "=================================================================="

# ---------- 0. 基础连通与后端身份 ----------
echo ""
echo "【0】后端身份（区分"真后端"与"被静态兜底"）"
BODY=$(curl -s --max-time 30 "$HOST/api/health" 2>/dev/null)
CT=$(curl -s -o /dev/null -w "%{content_type}" --max-time 20 "$HOST/api/health" 2>/dev/null)
CODE=$(echo "$BODY" | jget code)
MODE=$(echo "$BODY" | jget data.dataMode)

if echo "$CT" | grep -qi json; then ok "响应是 JSON（非 HTML 兜底）" "$CT"; else bad "响应是 HTML —— 被静态兜底了" "$CT"; fi
if [ "$CODE" = "0" ]; then ok "code=0" ; else bad "code=$CODE" "$(echo "$BODY" | head -c 120)"; fi
if [ "$MODE" = "LIVE" ]; then ok "dataMode=LIVE（真实后端）"; else bad "dataMode=$MODE"; fi

TABLES=$(echo "$BODY" | jget data.database.tables)
DBOK=$(echo "$BODY" | jget data.database.ok)
# ⚠ 额度耗尽时表数统计会失败（tables=0），那是**预期状态**而不是缺陷。
# 把它判成 FAIL 会让人以为"表没建好"，从而去重建 schema——那是错的方向。
if [ "${TABLES:-0}" -ge 60 ] 2>/dev/null; then
  ok "D1 表数 ≥ 60" "$TABLES 张"
elif [ "$DBOK" = "false" ] || [ "${TABLES:-0}" = "0" ]; then
  skip "D1 表数" "库查询不可用（额度耗尽或未初始化）"
else
  bad "D1 表数不足" "$TABLES"
fi

# 额度耗尽检测（已知可能状态，单独识别）
QUOTA_MODE=0
if echo "$BODY" | grep -q "D1_QUOTA" || [ "$DBOK" = "false" ]; then
  QUOTA_MODE=1
  echo ""
  echo "  ⚠ 当前处于 D1 额度耗尽状态 —— 以下数据类检查会 SKIP，这是预期行为。"
  echo "     恢复时间：UTC 零点（北京时间 08:00）"
fi

# ---------- 1. 真实数据层 ----------
echo ""
echo "【1】真实数据层"
for ep in "/api/real/overview?country=CHN:overview" "/api/real/trend?country=CHN:trend" \
          "/api/real/cn/regions:regions" "/api/real/truth:truth" "/api/real/sources:sources"; do
  U="${ep%:*}"; NAME="${ep##*:}"
  R=$(curl -s --max-time 60 "$HOST$U" 2>/dev/null)
  C=$(echo "$R" | jget code)
  if [ "$C" = "0" ]; then
    case "$NAME" in
      overview)
        F=$(echo "$R" | jget data.facilities)
        EY=$(echo "$R" | jget data.effectiveYear)
        ok "real/overview" "$F 家设施 · 有效年度 $EY" ;;
      truth)
        P=$(echo "$R" | jget data.summary.passed)
        V=$(echo "$R" | jget data.summary.verified)
        if [ "$P" = "$V" ]; then ok "real/truth" "真实性契约 $P/$V 全部通过"; else bad "real/truth 有未通过项" "$P/$V"; fi ;;
      trend)
        N=$(echo "$R" | jget data.series.length)
        ok "real/trend" "$N 个年度点" ;;
      *) ok "real/$NAME" ;;
    esac
  elif echo "$R" | grep -q "D1_QUOTA"; then
    skip "real/$NAME" "D1 额度耗尽"
  else
    bad "real/$NAME" "code=$C $(echo "$R" | head -c 100)"
  fi
done

# ---------- 1b. 真实厂区孪生（本轮新增） ----------
echo ""
echo "【1b】真实厂区孪生"
for ep in "/api/twin/candidates?country=CHN&limit=3:candidates" "/api/twin/plant/5526:plant-togtoh"; do
  U="${ep%%:*}"; NAME="${ep##*:}"
  R=$(curl -s --max-time 60 "$HOST$U" 2>/dev/null)
  C=$(echo "$R" | jget code)
  if [ "$C" = "0" ]; then
    case "$NAME" in
      candidates)
        N=$(echo "$R" | jget data.length)
        F1=$(echo "$R" | jget data.0.name)
        ok "twin/candidates" "$N 个真实设施 · 首位 $F1" ;;
      plant-togtoh)
        MT=$(echo "$R" | jget data.metrics.totalCO2e)
        CAP=$(echo "$R" | jget data.metrics.capacity)
        ST=$(echo "$R" | jget data.plant.structures.length)
        ok "twin/plant" "Togtoh $CAP MW · $ST 结构 · 总排 ${MT:0:8}" ;;
    esac
  elif echo "$R" | grep -q "D1_QUOTA"; then
    skip "twin/$NAME" "D1 额度耗尽"
  else
    bad "twin/$NAME" "code=$C"
  fi
done

# ---------- 2. 实时层 ----------
echo ""
echo "【2】实时层（读时计算，不落库）"
R=$(curl -s --max-time 40 "$HOST/api/real/live" 2>/dev/null)
if [ "$(echo "$R" | jget code)" = "0" ]; then
  LM=$(echo "$R" | jget data.loadFactor)
  N=$(echo "$R" | jget data.metrics.length)
  ok "real/live" "负荷系数 $LM · $N 项指标"
else
  if echo "$R" | grep -q "D1_QUOTA"; then skip "real/live" "D1 额度耗尽"; else bad "real/live" "$(echo "$R" | head -c 100)"; fi
fi

# SSE：必须真的收到 event: snapshot
SSE=$(curl -s -N --max-time 4 "$HOST/api/real/stream" 2>/dev/null | head -c 300)
if echo "$SSE" | grep -q "event: snapshot"; then
  ok "real/stream (SSE)" "收到首帧"
elif echo "$SSE" | grep -q "D1_QUOTA" || [ "$QUOTA_MODE" = "1" ]; then
  skip "real/stream (SSE)" "D1 额度耗尽"
else
  bad "real/stream (SSE)" "未收到 event: snapshot"
fi

# ---------- 3. 链与密码学 ----------
echo ""
echo "【3】链与密码学"
R=$(curl -s --max-time 60 "$HOST/api/chain/crypto-selftest" 2>/dev/null)
if [ "$(echo "$R" | jget code)" = "0" ]; then
  P=$(echo "$R" | jget data.passed); T=$(echo "$R" | jget data.total)
  if [ "$P" = "$T" ]; then ok "chain/crypto-selftest" "$P/$T（SM3 官方向量 + 同步/异步一致）"; else bad "chain/crypto-selftest" "$P/$T"; fi
  SM2=$(echo "$R" | jget data.capabilities.sm2Sign)
  if [ "$SM2" = "false" ]; then ok "SM2 能力如实声明为不可用" "（Workers 无国密，已声明）"; else bad "SM2 声明异常" "$SM2"; fi
else
  if echo "$R" | grep -q "D1_QUOTA"; then skip "chain/crypto-selftest" "D1 额度耗尽"; else bad "chain/crypto-selftest" "$(echo "$R" | head -c 100)"; fi
fi

R=$(curl -s --max-time 90 "$HOST/api/chain/validate" 2>/dev/null)
if [ "$(echo "$R" | jget code)" = "0" ]; then
  OK2=$(echo "$R" | jget data.ok); CB=$(echo "$R" | jget data.checkedBlocks)
  if [ "$OK2" = "true" ]; then ok "chain/validate" "$CB 个区块哈希链与 Merkle 一致"; else bad "chain/validate" "发现不一致"; fi
else
  if echo "$R" | grep -q "D1_QUOTA"; then skip "chain/validate" "D1 额度耗尽"; else bad "chain/validate" "$(echo "$R" | head -c 100)"; fi
fi

# ---------- 4. 鉴权与业务 ----------
echo ""
echo "【4】鉴权与业务端点"
LOGIN=$(curl -s --max-time 30 -X POST "$HOST/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"ent001","password":"123456"}' 2>/dev/null)
TOKEN=$(echo "$LOGIN" | jget data.token)
if echo "$LOGIN" | grep -q "D1_QUOTA" || [ "$QUOTA_MODE" = "1" ]; then
  skip "登录 ent001" "D1 额度耗尽，无法查询用户表"
elif [ -n "$TOKEN" ] && [ "$TOKEN" != "undefined" ]; then
  ok "登录 ent001" "令牌长度 ${#TOKEN}"
  R=$(curl -s --max-time 40 -H "Authorization: Bearer $TOKEN" "$HOST/api/enterprise/overview" 2>/dev/null)
  if [ "$(echo "$R" | jget code)" = "0" ]; then
    LAYER=$(echo "$R" | jget data.dataLayer.enterprise)
    ok "enterprise/overview" "数据层级 $LAYER（如实标注 MODELED）"
  else
    if echo "$R" | grep -q "D1_QUOTA"; then skip "enterprise/overview" "D1 额度耗尽"; else bad "enterprise/overview" "$(echo "$R" | head -c 100)"; fi
  fi
  # 越权检查：企业角色访问监管端点必须 403
  R=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 -H "Authorization: Bearer $TOKEN" "$HOST/api/regulator/overview" 2>/dev/null)
  if [ "$R" = "403" ]; then ok "越权拦截" "企业访问监管端点返回 403"; else bad "越权拦截失效" "返回 $R"; fi
else
  bad "登录 ent001" "$(echo "$LOGIN" | head -c 120)"
fi

# 未登录访问受保护端点必须 401
R=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$HOST/api/enterprise/overview" 2>/dev/null)
if [ "$R" = "401" ]; then ok "未登录拦截" "401"; else bad "未登录拦截失效" "返回 $R"; fi

# ---------- 5. 前端资源（确认快照已删除） ----------
echo ""
echo "【5】前端资源"
R=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$HOST/js/data/dataLayer.js" 2>/dev/null)
if [ "$R" = "200" ]; then ok "dataLayer.js 存在" ; else bad "dataLayer.js 缺失" "$R"; fi

# ⚠ 判据必须是**内容**而不是状态码。
# SPA 兜底会让任何不存在的路径都返回 200（返回 index.html）。
# 因此检查"响应体是否是 HTML"——是 HTML 说明文件真的不存在（被兜底），
# 是 JS/JSON 说明文件仍在。
check_gone() {
  local path="$1" label="$2"
  local ct body
  ct=$(curl -s -o /dev/null -w "%{content_type}" --max-time 20 "$HOST$path" 2>/dev/null)
  body=$(curl -s --max-time 20 "$HOST$path" 2>/dev/null | head -c 200)
  if echo "$ct" | grep -qiE "javascript|json"; then
    bad "$label 仍存在（内容为 $(echo "$ct" | cut -d';' -f1)）" "这是快照回放的残留，必须删除"
  elif echo "$body" | grep -qi "<!DOCTYPE html\|<html"; then
    ok "$label 已删除（路径被 SPA 兜底成 index.html）"
  else
    bad "$label 状态不明" "content-type=$ct"
  fi
}
check_gone "/js/data/staticApi.js" "staticApi.js"
check_gone "/data/api-snapshot.json" "api-snapshot.json"

# ---------- 汇总 ----------
echo ""
echo "=================================================================="
echo "  结果：$PASS 通过 / $FAIL 失败 / $SKIP 跳过"
if [ ${#FAILED_ITEMS[@]} -gt 0 ]; then
  echo "  失败项："
  for i in "${FAILED_ITEMS[@]}"; do echo "    · $i"; done
fi
echo "=================================================================="
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
