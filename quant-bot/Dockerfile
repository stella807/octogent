# Build stage: full toolchain, discarded afterwards.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# Runtime stage: production dependencies and compiled output only.
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune
COPY --from=build /app/dist ./dist

# Runs unprivileged. A trading process has no reason to be root, and the two
# directories it writes are the only ones it needs to own.
RUN useradd --system --uid 10001 quant \
  && mkdir -p /app/.quant-bot /app/data/cache \
  && chown -R quant:quant /app/.quant-bot /app/data
USER quant

# Paper trading by default. Live trading additionally requires --live and
# QUANT_BOT_LIVE_CONFIRM, neither of which is baked into this image.
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["paper", "--exchange", "coinbase", "--symbol", "BTC/USD", "--timeframe", "1d", "--strategy", "donchian-breakout"]
