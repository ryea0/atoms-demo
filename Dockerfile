# Atoms-Demo 生产镜像（multi-stage，node:22-alpine）
#
# 说明：
# - runner 只跑 `next start`，不携带任何构建工具链（typescript/tailwind/drizzle-kit 等被裁剪）
# - better-sqlite3 优先用 prebuilt 二进制；alpine(musl) 若无匹配预编译产物则需源码编译，
#   因此 deps 阶段补 python3/make/g++，并保留 node-gyp（.npmrc 已把 node-gyp 指到项目内版本）
#   ——先全量 `npm ci` 再 `npm prune --omit=dev`，保证兜底路径可用且产物体积接近生产依赖
# - schema 在首次连接时自举（src/lib/db/provider/sqlite/ddl.ts 的 ensureSchema），容器内无需 db:push
# - mock 样例按 process.cwd()/src/lib/agents/roles/samples 读取（src/lib/llm/mock.ts readSample），
#   runner 阶段按相同 WORKDIR 布局拷贝该目录；改 standalone 输出或 WORKDIR 时必须一并调整

# ---------- deps：安装依赖（含原生模块编译兜底工具链） ----------
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# ---------- build：生产构建 ----------
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 构建期不依赖 LLM 与数据库（env 晚绑定；页面按需动态渲染）
RUN npm run build

# ---------- prod-deps：裁剪出运行时依赖（保留已编译的 .node 产物） ----------
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json .npmrc ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev

# ---------- runner：仅运行时 ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DB_DRIVER=sqlite \
    DB_FILE=/app/data/app.db \
    LLM_PROVIDER=mock
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nextjs:nodejs /app/.next ./.next
COPY --from=build --chown=nextjs:nodejs /app/public ./public
# mock provider 黄金样例（readSample 首选 cwd 相对路径，见文件头注释）
COPY --from=build --chown=nextjs:nodejs /app/src/lib/agents/roles/samples ./src/lib/agents/roles/samples
COPY --chown=nextjs:nodejs package.json next.config.ts ./
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data
USER nextjs
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null 2>&1 || exit 1
CMD ["npm", "run", "start"]
