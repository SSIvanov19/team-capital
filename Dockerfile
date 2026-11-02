# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 DATABASE_PATH=/data/game.sqlite
RUN groupadd --system --gid 1001 game && useradd --system --uid 1001 --gid game game && mkdir -p /data && chown game:game /data /app
COPY --from=build --chown=game:game /app/.next/standalone ./
COPY --from=build --chown=game:game /app/.next/static ./.next/static
COPY --from=build --chown=game:game /app/public ./public
USER game
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
