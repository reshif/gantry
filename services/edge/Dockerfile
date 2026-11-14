# gantry-edge: model gateway :8443 and forward proxy :8444. Build context: repository root.
#   docker build -f services/edge/Dockerfile -t gantry-edge:dev .
# Behind a TLS-intercepting proxy, add: --secret id=cacert,src=/path/to/ca-bundle.crt (optional; used only for npm ci).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/edge/package.json services/edge/
COPY packages/domain/package.json packages/domain/
RUN --mount=type=secret,id=cacert,required=false \
    if [ -f /run/secrets/cacert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cacert; fi; \
    npm ci -w @gantry/edge --include-workspace-root --ignore-scripts
COPY services/edge/tsconfig.json services/edge/
COPY services/edge/src services/edge/src
RUN npm run build -w @gantry/edge

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/edge/package.json services/edge/
COPY packages/domain/package.json packages/domain/
RUN --mount=type=secret,id=cacert,required=false \
    if [ -f /run/secrets/cacert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cacert; fi; \
    npm ci -w @gantry/edge --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/services/edge
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/services/edge/dist ./dist
COPY services/edge/package.json ./package.json
USER 10001:10001
EXPOSE 8443 8444
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8443/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
