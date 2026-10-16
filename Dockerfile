# DevSentinel AI — one image for every role (ADR-010).
# APP_ROLE decides what the container does at runtime:
#   web     Next.js UI + API routes (no worker, no CLI spawns)
#   worker  queue consumer / TestSprite runs / monitoring / retention (no port)
#   all     both in one process (single-container hosts, local dev)
# Multi-stage, non-root, pinned Node 22; includes the pinned
# @testsprite/testsprite-cli so worker/all roles can run real TestSprite jobs.

# ---- deps: install exactly from the lockfile ----
FROM node:22.14.0-bookworm-slim AS deps
WORKDIR /app
# OpenSSL is required by the Prisma engines on Debian slim (also at build time:
# `prisma generate` in postinstall and `next build` both load them).
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# postinstall runs `prisma generate`, which needs the schema.
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

# ---- builder: compile the Next.js app (standalone output) ----
FROM node:22.14.0-bookworm-slim AS builder
WORKDIR /app
# OpenSSL is required by the Prisma engines on Debian slim (also at build time:
# `prisma generate` in postinstall and `next build` both load them).
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT_STANDALONE=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time placeholder URL (never connected to; all real configuration is
# validated at container start, see src/lib/config.ts).
ENV DATABASE_URL="postgresql://buildtime:buildtime@localhost:5432/buildtime" \
    DIRECT_URL="postgresql://buildtime:buildtime@localhost:5432/buildtime"
RUN npm run build

# ---- runner: single image, role selected by APP_ROLE ----
FROM node:22.14.0-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# OpenSSL is required by Prisma engines on Debian slim.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Standalone server (server.js + its traced node_modules)…
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
# …plus the full production tree the worker role needs at runtime:
# prisma CLI + migrations, tsx worker entry, and the pinned TestSprite CLI.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/worker ./worker
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER node
EXPOSE 3000

# Liveness for web/all; the worker has no inbound port and self-reports healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "if(process.env.APP_ROLE==='worker')process.exit(0);fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
