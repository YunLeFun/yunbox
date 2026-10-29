# syntax=docker/dockerfile:1
#
# YunBox Git LFS server image. See docs/deploy.md for CloudBase CloudRun.
#
# Every setting comes from environment variables (command-line options in CMD
# override them). The image defaults to COS storage and to listening on all
# interfaces inside the container, so the configuration self-check refuses to
# start until YUNBOX_PUBLIC_URL (https), YUNBOX_COS_BUCKET, YUNBOX_COS_REGION
# and the TENCENTCLOUD_* credentials are provided. Never bake credentials into
# the image.

# Both stages use the same base image: the Node.js LTS line in .node-version,
# pinned to a multi-arch index digest so rebuilds are reproducible. Dependabot
# (.github/dependabot.yml) proposes minor and patch updates; it only reads
# literal FROM lines, so keep the two in sync.
FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS build
WORKDIR /src

# Install the pnpm version pinned in package.json#packageManager.
COPY package.json ./
RUN npm install --global "$(node -p "require('./package.json').packageManager")"

# Download dependencies from the lockfile alone so this layer is cached until
# the lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install --offline --frozen-lockfile \
  && pnpm --filter "@yunbox/server..." run build \
  && pnpm --filter @yunbox/server deploy --prod --legacy /app

FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS runtime

ENV NODE_ENV=production \
  YUNBOX_HOST=0.0.0.0 \
  YUNBOX_STORAGE=cos \
  YUNBOX_STORAGE_DIR=/data

WORKDIR /app
# Application files stay owned by root, so the service user cannot modify them.
COPY --from=build /app /app
# Only used with YUNBOX_STORAGE=local (testing); production uses COS.
RUN mkdir /data && chown node:node /data

USER node

# The port is YUNBOX_PORT, else PORT (which CloudBase CloudRun sets to the
# configured listen port), else 8080.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.YUNBOX_PORT || process.env.PORT || 8080}/_health`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["node", "/app/dist/cli.mjs"]
CMD ["serve"]
