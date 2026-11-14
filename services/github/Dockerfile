# gantry-github: GitHub App broker on :9200. Build context: repository root.
#   docker build -f services/github/Dockerfile -t gantry-github:dev .
# Behind a TLS-intercepting proxy, add: --secret id=cacert,src=/path/to/ca-bundle.crt (optional; used only for npm ci and apk).
# The image carries git (the seed clone and reading workspace object data) and doubles as the never-started workspace helper image (GITHUB_HELPER_IMAGE).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/github/package.json services/github/
COPY packages/domain/package.json packages/domain/
RUN --mount=type=secret,id=cacert,required=false \
    if [ -f /run/secrets/cacert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cacert; fi; \
    npm ci -w @gantry/github --include-workspace-root --ignore-scripts
COPY services/github/tsconfig.json services/github/
COPY services/github/src services/github/src
RUN npm run build -w @gantry/github

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/github/package.json services/github/
COPY packages/domain/package.json packages/domain/
RUN --mount=type=secret,id=cacert,required=false \
    if [ -f /run/secrets/cacert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cacert; fi; \
    npm ci -w @gantry/github --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production
# INSTALL_GIT=false exists only for sandboxes without an Alpine mirror; the broker cannot seed or publish without git.
ARG INSTALL_GIT=true
RUN --mount=type=secret,id=cacert,required=false \
    if [ -f /run/secrets/cacert ]; then export SSL_CERT_FILE=/run/secrets/cacert; fi; \
    if [ "$INSTALL_GIT" = true ]; then apk add --no-cache git; fi
# The workspace helper (this same image, never started) mounts a run's empty ws-<id> volume first; Docker copies this directory's owner onto a new
# volume, so /workspace must belong to the runner's uid or the runner could not create files at the repository root.
RUN mkdir -p /workspace && chown 10001:10001 /workspace
WORKDIR /app/services/github
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/services/github/dist ./dist
COPY services/github/package.json ./package.json
USER 10001:10001
EXPOSE 9200
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9200/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
