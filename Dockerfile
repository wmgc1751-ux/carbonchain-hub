# =====================================================================
#  碳链通 CarbonChain Hub —— 生产镜像
#  构建：docker build -t carbonchain-hub .
#  运行：docker compose up -d   （compose 已带 MySQL 与健康检查）
#
#  安全边界：
#   · .env / keystore 不打进镜像（见 .dockerignore），密钥一律运行时注入
#   · NODE_ENV=production ⇒ assertSecureConfig 缺密钥直接拒绝启动
# =====================================================================
FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# 依赖层单独缓存：package*.json 未变则跳过 npm ci
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY server ./server
COPY public ./public
COPY db ./db
COPY tools ./tools
# tools 内含 evidence-pack / metrics-ledger 等运行期被 require 的模块
COPY package.json ./

EXPOSE 8300
# 用 start-prod（幂等结构自检 + 增量迁移），不要用 initdb（会清库重建）
CMD ["node", "server/scripts/start-prod.js"]

# 健康检查：/api/health 注册在所有中间件之前，永远匿名可达
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8300/api/health >/dev/null 2>&1 || exit 1
