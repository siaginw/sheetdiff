# SheetDiff — self-hosted container image
#
# Build:  docker build -t sheetdiff .
# Run:    see docker-compose.yml (recommended — persists ./data and .env)

FROM node:22-alpine AS deps
WORKDIR /app
# native build tools for better-sqlite3
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build \
  # snapshots live in /app/data — mount a volume; run as the non-root node user
  && mkdir -p /app/data && chown -R node:node /app
USER node
ENV DATABASE_PATH=/app/data/sheetdiff.db
VOLUME /app/data
EXPOSE 3000
# alpine ships busybox wget (no curl)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s   CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
# next start respects PORT
CMD ["npm", "start"]
