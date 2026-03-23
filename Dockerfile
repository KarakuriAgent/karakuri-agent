FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Dev override runs as an arbitrary host UID/GID, so keep node_modules cache-writable.
RUN npm ci --include=dev --no-audit --no-fund \
  && mkdir -p /app/node_modules/.cache \
  && chmod 1777 /app/node_modules /app/node_modules/.cache

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN node ./node_modules/typescript/bin/tsc -p tsconfig.build.json

FROM node:20-alpine
RUN apk add --no-cache tini
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist/
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
