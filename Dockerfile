FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --include=dev

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
RUN mkdir -p uploads && chown -R node:node /app

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/v1/ready', {signal: AbortSignal.timeout(4000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/src/main.js"]
