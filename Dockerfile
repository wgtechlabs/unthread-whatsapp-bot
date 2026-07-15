# syntax=docker/dockerfile:1

ARG NODE_VERSION=26.5.0-alpine3.24
ARG BUN_VERSION=1.3.9

FROM oven/bun:${BUN_VERSION}-alpine AS bun

# Base image uses Node.js 26 Alpine.
FROM node:${NODE_VERSION} AS base

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /usr/src/app
RUN apk upgrade --no-cache && apk add --no-cache dumb-init

FROM base AS deps

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS final

ENV NODE_ENV=production

COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

RUN addgroup -S app -g 1001 && \
    adduser -S app -u 1001 -G app && \
    chown -R app:app /usr/src/app

USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "-e", "const port=process.env.PORT||3000;fetch(`http://localhost:${port}/health`).then((res)=>process.exit(res.ok?0:1)).catch(()=>process.exit(1));"]
ENTRYPOINT ["dumb-init", "--"]
CMD ["bun", "src/index.ts"]
