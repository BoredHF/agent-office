# syntax=docker/dockerfile:1
FROM node:22-bookworm AS build
WORKDIR /opt/agent-office
COPY . .
# The prepare script builds both the browser bundle and the server.
RUN npm ci --include=dev --no-audit --no-fund

FROM build AS test
RUN npm run typecheck && npm test

FROM build AS production-deps
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
ARG CLAUDE_CODE_VERSION=2.1.283
ARG CODEX_VERSION=0.158.0
ARG OPENCODE_VERSION=1.18.33

# Workers need a real development environment, including PTYs and port discovery.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash build-essential ca-certificates curl git gh iproute2 \
       openssh-client procps python3 ripgrep tini \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global --no-audit --no-fund \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force

ENV NODE_ENV=production \
    SHELL=/bin/bash \
    PORT=4600 \
    AGENT_OFFICE_HOME=/home/node/agent-office \
    AGENT_OFFICE_PROJECTS=/home/node/projects \
    AGENT_OFFICE_SELF_UPDATE=0

WORKDIR /opt/agent-office
COPY --from=production-deps /opt/agent-office/package.json /opt/agent-office/package-lock.json ./
COPY --from=production-deps /opt/agent-office/node_modules ./node_modules
COPY --from=build /opt/agent-office/dist ./dist
COPY --from=build /opt/agent-office/bin ./bin
COPY LICENSE ./
COPY --chmod=755 deploy/docker-entrypoint.sh /usr/local/bin/agent-office-entrypoint

# A fresh named volume inherits this ownership. Code and CLI binaries stay outside it.
RUN mkdir -p /home/node/agent-office /home/node/projects \
    && chown -R node:node /home/node \
    && chmod 700 /home/node
USER node

EXPOSE 4600
# SIGINT asks the office to save and stop workers before the container is replaced.
STOPSIGNAL SIGINT
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl --fail --silent "http://127.0.0.1:${PORT:-4600}/api/health" > /dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agent-office-entrypoint"]
CMD ["node", "bin/agent-office.js", "--host", "0.0.0.0", "--trust-proxy"]
