# syntax=docker/dockerfile:1

ARG BUN_VERSION=1.3.9

FROM oven/bun:${BUN_VERSION}-alpine AS base

RUN apk update && apk upgrade && \
    apk add --no-cache dumb-init && \
    rm -rf /var/cache/apk/*

WORKDIR /usr/src/app

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

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --quiet --spider --tries=1 "http://localhost:${PORT:-3000}/health" || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["bun", "src/index.ts"]
