# gantry-migrate: applies SQL migrations as gantry_owner, sets the gantry_app password, then exits 0.
# Build context is the repository root: docker build -f packages/db/Dockerfile -t gantry-migrate:dev .
# Behind a TLS-intercepting proxy, add: --secret id=cacert,src=/path/to/ca-bundle.crt (optional; used only for npm ci).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
RUN --mount=type=secret,id=cacert,required=false \
    if [ -f /run/secrets/cacert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cacert; fi; \
    npm ci -w @gantry/db --include-workspace-root --ignore-scripts
COPY packages/db/tsconfig.json packages/db/
COPY packages/db/src packages/db/src
RUN npm run build -w @gantry/db

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
RUN --mount=type=secret,id=cacert,required=false \
    if [ -f /run/secrets/cacert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cacert; fi; \
    npm ci -w @gantry/db --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY packages/db/package.json ./packages/db/package.json
COPY packages/db/migrations ./packages/db/migrations
USER 10001:10001
CMD ["node", "packages/db/dist/bin/migrate.js"]
