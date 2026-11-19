# gantry-web: the React SPA built to static files and served by nginx-unprivileged.
# Build context is the repository root:  docker build -f apps/web/Dockerfile -t gantry-web:dev .
# Behind a TLS-intercepting proxy, add: --secret id=cacert,src=/path/to/ca-bundle.crt (optional; used only for npm ci).

FROM node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /repo
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

# Manifests first so the dependency layer is cached until a package.json or the lockfile changes.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY services/api/package.json services/api/package.json
COPY services/edge/package.json services/edge/package.json
COPY services/github/package.json services/github/package.json
COPY services/launcher/package.json services/launcher/package.json
COPY services/worker/package.json services/worker/package.json
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=secret,id=cacert,required=false \
    if [ -f /run/secrets/cacert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cacert; fi; \
    npm ci --workspace @gantry/domain --workspace @gantry/web --include-workspace-root --ignore-scripts

# The web app imports types and the catalogue from @gantry/domain, which resolves to its dist.
COPY packages/domain packages/domain
RUN npm run build --workspace @gantry/domain

COPY apps/web apps/web
RUN npm run build --workspace @gantry/web

FROM nginxinc/nginx-unprivileged:1.31.7-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e AS runtime
COPY apps/web/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
# nginx-unprivileged already runs as uid 101; pin the uid the compose file expects (10001:10001 is set by compose `user:`).
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
CMD ["nginx", "-g", "daemon off;"]
