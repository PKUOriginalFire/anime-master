FROM node:24-bookworm-slim AS base
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources && apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci && sha256sum package-lock.json | cut -d ' ' -f 1 > node_modules/.anime-quiz-lock.sha256 && chown -R node:node /app

FROM dependencies AS development
COPY --chown=node:node . .
ENV HOST=0.0.0.0 PORT=3010 DATA_DIR=/data
USER node
EXPOSE 5173
CMD ["sh","scripts/dev-entrypoint.sh"]

FROM dependencies AS build
COPY . .
RUN npm run build && npm prune --omit=dev

FROM base AS production
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3010 DATA_DIR=/data
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node seed ./seed
COPY --chown=node:node scripts/backup.mjs ./scripts/backup.mjs
USER node
EXPOSE 3010
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3010/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist/server.mjs"]
