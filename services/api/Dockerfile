# gantry-api: Fastify REST API, sessions/OIDC, decision point, commands, SSE, /internal/v1. Build context: repository root.
#   docker build -f services/api/Dockerfile -t gantry-api:dev .
# The same image tree is reused by gantry-worker with a different command (it imports @gantry/api/core).
# Behind a TLS-intercepting proxy, add: --secret id=cacert,src=/path/to/ca-bundle.crt (optional; used only for npm ci).
FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY services/api/package.json services/api/
RUN --mount=type=secret,id=cacert,required=false \
    if [ -f /run/secrets/cacert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cacert; fi; \
    npm ci -w @gantry/api -w @gantry/db -w @gantry/domain --include-workspace-root --ignore-scripts
COPY packages/domain/tsconfig.json packages/domain/
COPY packages/domain/src packages/domain/src
COPY packages/db/tsconfig.json packages/db/
COPY packages/db/src packages/db/src
COPY services/api/tsconfig.json services/api/
COPY services/api/src services/api/src
RUN npm run build -w @gantry/domain && npm run build -w @gantry/db && npm run build -w @gantry/api

FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY services/api/package.json services/api/
RUN --mount=type=secret,id=cacert,required=false \
    if [ -f /run/secrets/cacert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cacert; fi; \
    npm ci -w @gantry/api -w @gantry/db -w @gantry/domain --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/packages/domain/dist ./packages/domain/dist
COPY packages/domain/package.json ./packages/domain/package.json
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY packages/db/package.json ./packages/db/package.json
COPY --from=build /app/services/api/dist ./services/api/dist
COPY services/api/package.json ./services/api/package.json
WORKDIR /app/services/api
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
