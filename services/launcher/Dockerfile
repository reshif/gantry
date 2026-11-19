# gantry-launcher: start-run / stop-run / list-runs over the Docker socket. Build context: repository root.
#   docker build -f services/launcher/Dockerfile -t gantry-launcher:dev .
# Behind a TLS-intercepting proxy, add: --secret id=cacert,src=/path/to/ca-bundle.crt (optional; used only for npm ci).
FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/launcher/package.json services/launcher/
COPY packages/domain/package.json packages/domain/
RUN --mount=type=secret,id=cacert,required=false \
    if [ -f /run/secrets/cacert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cacert; fi; \
    npm ci -w @gantry/launcher -w @gantry/domain --include-workspace-root --ignore-scripts
COPY packages/domain/tsconfig.json packages/domain/
COPY packages/domain/src packages/domain/src
COPY services/launcher/tsconfig.json services/launcher/
COPY services/launcher/src services/launcher/src
RUN npm run build -w @gantry/domain && npm run build -w @gantry/launcher

FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/launcher/package.json services/launcher/
COPY packages/domain/package.json packages/domain/
RUN --mount=type=secret,id=cacert,required=false \
    if [ -f /run/secrets/cacert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cacert; fi; \
    npm ci -w @gantry/launcher -w @gantry/domain --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
ENV NODE_ENV=production
WORKDIR /app/services/launcher
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/packages/domain/dist /app/packages/domain/dist
COPY packages/domain/package.json /app/packages/domain/package.json
COPY --from=build /app/services/launcher/dist ./dist
COPY services/launcher/package.json ./package.json
# The Docker socket is group-owned by the host's docker group: compose adds that gid with group_add.
USER 10001:10001
EXPOSE 9100
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9100/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
