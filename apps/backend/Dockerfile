# Backend als Container. Bauen aus dem Repository-Wurzelverzeichnis:
#   docker build -f apps/backend/Dockerfile -t timelog-backend .
# Konfiguration nur über Umgebungsvariablen (siehe .env.example); Migrationen laufen beim Start.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @timelog/backend...
RUN pnpm --filter @timelog/backend... run build
RUN pnpm --filter @timelog/backend deploy --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/drizzle ./drizzle
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "dist/server.js"]
