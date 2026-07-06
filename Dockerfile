# glibc ベース（slim）を使う: sqlite-vec の npm プリビルド（vec0.so）は glibc 向けで、
# Alpine (musl) では dlopen に失敗しベクトル検索が無効化されるため。
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Dev override runs as an arbitrary host UID/GID, so keep node_modules cache-writable.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci --include=dev --no-audit --no-fund \
  && mkdir -p /app/node_modules/.cache \
  && chmod 1777 /app/node_modules /app/node_modules/.cache

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN node ./node_modules/typescript/bin/tsc -p tsconfig.build.json

FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini build-essential python3 \
  && npm ci --omit=dev --no-audit --no-fund \
  && npm cache clean --force \
  && apt-get purge -y build-essential python3 \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist/
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
