# PHASE-0.1 — Repository & Tooling Foundation (implementation record)

Status: COMPLETE — 2026-08-31
Scope source: `docs/phases/PHASE-0.md` §0.1
Next: Phase 0.2 (database foundation & migrations) — not started, awaiting approval

---

## 1. What was implemented

**Monorepo:** pnpm workspaces + Turborepo, TypeScript strict base config, ESLint
(type-aware) + Prettier, root scripts, `.gitignore`, `.gitattributes`, `.env.example`,
GitHub Actions CI.

**Apps**

| App | Contents |
|---|---|
| `apps/api` | Fastify 5 instance; `GET /health` returning the shared health contract; RFC 9457 problem+json error and not-found handlers; per-request id; explicit request logging; graceful shutdown |
| `apps/worker` | Process lifecycle (start / liveness heartbeat / graceful stop) that states plainly it has **zero registered job processors**; queue wiring is Phase 0.5 |
| `apps/web` | Next.js 16 App Router shell rendering a factual status page (no mock dashboard), baseline security headers |

**Packages**

| Package | Contents |
|---|---|
| `@organic-os/contracts` | Zod contract architecture: `healthResponseSchema`, `problemDetailsSchema`, problem media type/base URL |
| `@organic-os/config` | Zod-validated, fail-fast environment loading with a hard server/client split (`/server`, `/client` subpath exports, no root export); `EnvValidationError` that never interpolates values |
| `@organic-os/observability` | `Logger` interface + pino-backed `createLogger` with serializer-level secret redaction; `LogDestination` so consumers never import pino types |

## 2. Important decisions

1. **TypeScript 5.9.3, not 7.x.** TypeScript 7.0.2 is published, but
   `typescript-eslint@8.68` supports `>=4.8.4 <6.1.0`. Type-aware linting is a
   CLAUDE.md requirement (`no-explicit-any` and friends), so the lint toolchain wins.
   Recorded as an addendum in `docs/ADR/README.md`; revisit when typescript-eslint
   ships TS 7 support.

2. **pnpm pinned to 10.34.5** (`packageManager` field). pnpm 11.24.0 fails
   deterministically on Windows while importing `esbuild`:
   `EPERM … rename 'esbuild_tmp_x' -> 'esbuild'`. Verified it is not antivirus, not a
   stale directory and not a corrupted store — pnpm pre-creates the destination
   directory and Windows cannot rename onto an existing directory. pnpm 10.34.5
   installs cleanly. CI reads `packageManager`, so all environments agree.

3. **No dependency build scripts are allowed** (`onlyBuiltDependencies: []`).
   esbuild's install script is skipped; it resolves its platform binary through its
   optional dependency and all 38 tests pass. Smaller supply-chain surface.

4. **Only three packages were created.** `database`, `auth`, `integrations`,
   `crawler-core`, `technical-seo`, `ui` and `llm` are *not* created: an empty package
   is a placeholder, which PRD §0 and the session brief forbid. Names stay reserved in
   `ARCHITECTURE.md` §4 and each is created by the sub-phase that fills it. This is a
   deliberate deviation from the package list in `PHASE-0.md` §0.1, which has been
   updated to match.

5. **No `wordpress-plugin/` directory.** `PHASE-0.md` puts "WordPress anything"
   explicitly out of scope for Phase 0; the plugin is created in Phase 1 per ADR-0010.

6. **Logging is an owned interface.** `Logger`/`LogDestination` are declared by the
   observability package; pino is an implementation detail no consumer imports. This
   also keeps pnpm's strict dependency isolation intact (the worker has no pino
   dependency).

7. **Fastify's built-in logger is disabled**; the API logs requests through the
   redacting logger with an explicit field list (`requestId`, `method`, `url`,
   `statusCode`, `durationMs`) rather than whatever the framework decides to emit.

8. **No CORS, and none by accident.** No CORS plugin is installed; a test asserts no
   `access-control-allow-origin` header is produced for a cross-origin request.

9. **Prettier does not format `docs/`.** The planning documents are hand-formatted
   prose with tables, diagrams and mixed RTL/LTR text; reflowing them is destructive
   churn on approved deliverables.

10. **Tailwind, shadcn/ui, commit hooks, OpenTelemetry and OpenAPI generation were not
    added.** Each belongs to the sub-phase that needs it (0.4 for the dashboard and
    OpenAPI, 0.6 for tracing/metrics). Adding them now would be unused configuration.

## 3. Commands

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
```

CI (`.github/workflows/ci.yml`) runs install → format:check → lint → typecheck → test
→ build → `pnpm audit --audit-level critical`, on push to `main` and every PR.

## 4. Tests

38 tests, all passing:

| Suite | Tests | Covers |
|---|---|---|
| `packages/contracts` | 7 | health/problem schema acceptance, rejection, unknown-key stripping |
| `packages/config` | 12 | defaults, coercion, unknown-variable stripping, invalid input, **error messages never contain env values**, public schema drops non-public keys |
| `packages/observability` | 7 | JSON shape, top-level/nested/header redaction, child-logger redaction, level filtering |
| `apps/api` | 6 | health contract validity, uptime, `no-store` + `nosniff`, no CORS header, problem+json 404, request id |
| `apps/worker` | 6 | lifecycle, idempotent start, heartbeat interval, clean stop, stop-before-start |

## 5. Known limitations

- No database, migrations, RLS, authentication, RBAC, queue, feature flags or
  observability exporters yet — Phases 0.2–0.7.
- The worker consumes no queues; its heartbeat exists to prove and keep alive the
  lifecycle, and it says so in its startup record.
- The web app renders no product data and has no design system yet.
- No commit hooks; CI is the enforcement gate (deferred from `PHASE-0.md` §0.1).
- `pnpm audit` runs only in CI, not locally.
- The first `app.inject()` in the API test takes ~4s on Windows (framework warm-up);
  harmless, but worth watching if it grows.

## 6. Deviations from the architecture documents

| Deviation | Rationale | Doc updated |
|---|---|---|
| 3 packages instead of the `PHASE-0.md` §0.1 list | no placeholder packages | `PHASE-0.md` §0.1 |
| No `wordpress-plugin/` scaffold | out of Phase 0 scope | — (already correct) |
| Commit hooks deferred | CI enforces the same checks | `PHASE-0.md` §0.1 |
| TypeScript 5.9 rather than latest | lint toolchain compatibility | `ADR/README.md` addendum |
| pnpm 10 rather than latest | pnpm 11 Windows regression | this document, README |

No architectural boundary was changed: apps depend on packages only, domain logic is
outside UI components, and no provider is referenced without an adapter seam.
