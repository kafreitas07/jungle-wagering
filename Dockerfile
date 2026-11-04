# One image, many roles: which of API / SQS consumer / outbox publisher / pending worker an instance runs is
# decided by the RUN_* environment variables, not by the image.
FROM oven/bun:1.4.4-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 3100
CMD ["bun", "run", "src/main.ts"]
