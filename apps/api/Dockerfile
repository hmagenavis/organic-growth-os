# syntax=docker/dockerfile:1
#
# apps/api — the long-lived Fastify service.
#
# Built from the repository root, not from this directory:
#
#   docker build -f apps/api/Dockerfile -t organic-os-api .
#
# Three properties this file is responsible for, each of them load-bearing:
#
#  1. **No secret is in the image.** Nothing is baked in and no `ARG` carries one.
#     Every credential arrives as an environment variable at run time, from the
#     platform's secret store (docs/cloud/ENVIRONMENT-MATRIX.md). `.dockerignore`
#     excludes `.env*` so a developer's local file cannot be copied in by accident.
#  2. **No migration runs here.** There is no entrypoint script and no `db:migrate`.
#     The image holds the runtime credential only and could not migrate if it tried;
#     schema changes go through the manual `staging-database` workflow (ADR-0003).
#  3. **The process is PID 1 and handles SIGTERM itself.** `CMD` is in exec form so
#     the signal reaches Node rather than a shell, and `src/index.ts` drains the
#     server and the pool on it, with its own bounded timeout.
#
# `certs/` is deliberately *included*: it holds the published Supabase root CA that
# makes the database connection `verify-full`. A root certificate is public by
# construction — it is a variable, never a secret (docs/cloud/ENVIRONMENT-MATRIX.md §2).

ARG NODE_VERSION=24.13.0

# Debian rather than Alpine: `@node-rs/argon2` ships prebuilt binaries per platform and
# the glibc build is the one CI actually exercises. A musl image would swap the
# password-hashing implementation for one nothing has tested.
FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo

# ---------------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------------
FROM base AS build

# Switching an existing install to `--prod` makes pnpm rebuild the modules directory,
# and it refuses to do that unattended without being told it is not at a terminal.
# Scoped to this stage so the flag does not travel into the runtime image.
ENV CI=true

# Manifests first, so a source-only change does not re-resolve the dependency graph.
# Every workspace manifest is copied because pnpm resolves the whole workspace before
# it can filter to one project.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/auth/package.json packages/auth/
COPY packages/authorization/package.json packages/authorization/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY packages/observability/package.json packages/observability/

# `corepack install` reads `packageManager` from package.json, so the pnpm version is
# pinned by the repository rather than restated here.
RUN corepack enable && corepack install

# `--frozen-lockfile` makes a drifted lockfile a build failure rather than a silent
# re-resolution — the same guarantee CI enforces. The filter installs the API and the
# packages it depends on, and nothing else: Next.js and Playwright are not in this
# image.
RUN pnpm install --frozen-lockfile --filter @organic-os/api...

COPY . .

# pnpm's own topological runner rather than turbo: turbo is a *root* devDependency and
# the filtered install above deliberately does not include the root, so the image has
# one fewer build tool in it and no cache directory to reason about.
RUN pnpm --filter @organic-os/api... run build

# Re-resolve without dev dependencies now that the TypeScript is compiled. `tsx`,
# `vitest`, `typescript` and the Testcontainers client have no business in a serving
# image.
RUN pnpm install --frozen-lockfile --prod --filter @organic-os/api...

# ---------------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------------
FROM base AS runtime

# `API_HOST` is set because a container must bind every interface and the schema
# defaults to loopback. `API_PORT` is deliberately *not* set: leaving it unset is what
# lets a platform-injected `PORT` decide, and an image-level value would silently win
# over it and leave the service listening where nothing routes.
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    NODE_OPTIONS=--enable-source-maps

# `node` is an unprivileged user the base image already provides. The application
# never writes to the filesystem, so it owns nothing it does not need to read.
COPY --from=build --chown=node:node /repo /repo

USER node
WORKDIR /repo/apps/api

EXPOSE 3001

# Liveness only. Readiness is `/health/ready`, and it is the *platform's* health check
# rather than Docker's, because a database outage must stop traffic being routed here
# without restarting a process that is otherwise fine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const p=process.env.API_PORT||process.env.PORT||3001;fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
