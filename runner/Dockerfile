# gantry-runner base image (spec 3.2, 4.1). Build context: repository root.
#   docker build -f runner/Dockerfile -t gantry-runner:dev .
# Holds no secrets. Runs as uid 10001 with a read-only root: writable paths are /workspace (volume) and /tmp (tmpfs).
# Behind a TLS-intercepting proxy, add: --secret id=cacert,src=/path/to/ca-bundle.crt (optional; used only for npm).
# Variants for other tech stacks: FROM gantry-runner:dev as a base (as root), install the toolchain, then `USER 10001:10001`.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS wrapper-build
WORKDIR /src/runner/wrapper
COPY tsconfig.base.json /src/
COPY runner/wrapper/package.json runner/wrapper/package-lock.json ./
RUN --mount=type=secret,id=cacert,required=false \
    if [ -f /run/secrets/cacert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cacert; fi; \
    npm ci --ignore-scripts
COPY runner/wrapper/tsconfig.json ./
COPY runner/wrapper/src ./src
RUN npx tsc -p tsconfig.json

FROM ${NODE_IMAGE} AS wrapper-deps
WORKDIR /opt/gantry-wrapper
COPY runner/wrapper/package.json runner/wrapper/package-lock.json ./
RUN --mount=type=secret,id=cacert,required=false \
    if [ -f /run/secrets/cacert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cacert; fi; \
    npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM ${NODE_IMAGE}
# Pinned harness release (stable channel at the time of writing). Unverified against a live model: see runner/README.md.
ARG CLAUDE_CODE_VERSION=2.1.311
# `full` installs git and the common build tools. `minimal` skips the OS packages (for hosts that cannot reach the
# Debian mirrors at build time); a minimal image has no git, so it cannot run build stations.
ARG RUNNER_TOOLCHAIN=full
ENV DEBIAN_FRONTEND=noninteractive
RUN if [ "$RUNNER_TOOLCHAIN" = "full" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends git ca-certificates build-essential python3 pkg-config jq \
      && rm -rf /var/lib/apt/lists/*; \
    fi
RUN --mount=type=secret,id=cacert,required=false \
    if [ -f /run/secrets/cacert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/cacert; fi; \
    npm install -g --no-audit --no-fund @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force
RUN groupadd -g 10001 runner \
 && useradd -u 10001 -g 10001 -M -d /workspace -s /usr/sbin/nologin runner \
 && mkdir -p /workspace && chown 10001:10001 /workspace
COPY --from=wrapper-deps /opt/gantry-wrapper /opt/gantry-wrapper
COPY --from=wrapper-build /src/runner/wrapper/dist /opt/gantry-wrapper/dist
# Hooks never run inside git operations the agent performs (spec 5.4 T9): hooksPath points at nothing.
# The agent commits locally as Gantry; it never pushes (gantry-github publishes after the step).
ENV NODE_ENV=production \
    HOME=/tmp/home \
    npm_config_cache=/tmp/npm-cache \
    npm_config_update_notifier=false \
    GIT_AUTHOR_NAME="Gantry Agent" GIT_AUTHOR_EMAIL="agent@gantry.invalid" \
    GIT_COMMITTER_NAME="Gantry Agent" GIT_COMMITTER_EMAIL="agent@gantry.invalid" \
    GIT_CONFIG_COUNT=3 \
    GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null \
    GIT_CONFIG_KEY_1=safe.directory GIT_CONFIG_VALUE_1=/workspace \
    GIT_CONFIG_KEY_2=core.fsmonitor GIT_CONFIG_VALUE_2=false \
    GIT_TERMINAL_PROMPT=0
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/gantry-wrapper/dist/main.js"]
