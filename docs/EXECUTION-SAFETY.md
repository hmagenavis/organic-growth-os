# EXECUTION-SAFETY.md
# Organic Growth OS — Safe Execution Architecture

Version: 1.0 (planning baseline)
Golden rule (PRD §188): no direct write to production without
Action + Snapshot + Risk Evaluation + Validation + Audit Log.
Golden conflict rule (PRD §185): when autonomy conflicts with safety, V1 chooses safety.

This document specifies the pipeline implemented from Phase 4 onward. **No write-path
code exists in the repository before Phase 4.**

---

## 1. Action lifecycle (state machine)

```text
draft → pending_approval → approved → queued → snapshotting → preflight
      → executing → qa → committed

qa failure, or executing failure AFTER any production write:
      → rolling_back → rolled_back            (rollback succeeded)
      → rolling_back → rollback_failed        (rollback itself failed → EXECUTION_FREEZE)

Any pre-execute state → cancelled | rejected
Failure BEFORE any production write (snapshotting/preflight error,
provider unavailable pre-write, budget stop) → failed
```

**Terminal-state semantics (exact):**

| Terminal state | Meaning |
|---|---|
| `committed` | executed, QA passed, change kept |
| `rolled_back` | a production write occurred (fully or partially) and was successfully reverted; failure reason stored |
| `rollback_failed` | a production write occurred, rollback was attempted and did not restore the pre-change state; triggers site-wide `EXECUTION_FREEZE` (§12) + highest-severity alert; requires human resolution, after which the action is annotated resolved but keeps this status |
| `failed` | the operation failed **without any production write having been made** — nothing needed restoring. This is the only valid use of `failed`; if any write may have landed (ambiguous CMS response, timeout mid-write), the engine MUST assume a write occurred and go through `rolling_back` |
| `cancelled` / `rejected` | never reached execution |

- States are persisted on `actions.status`; the legal-transition table is enforced in
  `execution-engine` AND by a DB trigger rejecting illegal jumps (defense in depth).
  `rolling_back` is a real persisted state (crash-recovery resumes rollback, never
  skips it).
- Every action has a unique `action_uid` (`ACT-YYYY-NNNNNN`) and an
  `idempotency_key`; re-running any step is a no-op if already completed (PRD §162).
- Every transition writes an `audit_logs` row (actor, before→after, source).

## 2. Risk engine (PRD §105)

Risk classification is **deterministic rules over the action type + scope**, never an
LLM output. Defaults (per-org/site overridable within bounds — RED can never be
downgraded below YELLOW):

| Class | Examples |
|---|---|
| GREEN | add missing ALT; safe meta description; additive schema; fix broken internal link with certain destination |
| YELLOW | title; H1; content additions; internal-link batches; schema replacement; GTM workspace change |
| RED | URL changes; mass redirects; noindex; deletion; robots.txt; navigation; templates; builder structure; GTM publish; mass content replacement |

Scope escalates risk: any GREEN action touching > N pages (default 25) becomes YELLOW;
any YELLOW touching > N pages becomes RED.

## 3. Autopilot modes (PRD §106 as amended 2026-08-31)

| Mode | GREEN | YELLOW | RED |
|---|---|---|---|
| OFF (research only) | no actions created for execution | — | — |
| REVIEW (**default for new sites**) | approval required | approval required | approval required |
| SAFE_AUTOPILOT (opt-in via graduation) | automatic | configurable (default: approval) | approval required (agency_admin) |
| FULL_AUTOPILOT | future only; RED still passes enhanced safeguards | | |

Mode is per-site (`site_settings.autopilot_mode`); changing it is an audited,
admin-only operation.

### 3.1 Safety Graduation Policy (approved; configurable, never hardcoded)

A site may be switched to SAFE_AUTOPILOT only when the effective graduation policy
(`site_settings.graduation_policy`, org-level defaults overridable) is satisfied.
Recommended baseline defaults:

- ≥ 20 successfully completed GREEN production actions on this site
- all required QA checks passed on those actions
- zero critical site-impact incidents attributed to the system
- no unresolved rollback failures
- explicit user opt-in by an authorized role (agency_admin+), recorded with
  `graduated_at` / `graduation_approved_by` and an audit-log entry

The system evaluates the policy and may surface "site is ready for Safe Autopilot";
it never switches the mode itself in V1. Any rollback failure or critical incident
after graduation resets eligibility signals and recommends returning to REVIEW
(the downgrade itself remains a human decision, except the automatic
`EXECUTION_FREEZE` in §12 which always applies).

## 4. Snapshot system (PRD §107) — tiered

Every write is preceded by a snapshot, but the snapshot **tier** is matched to the
action type + risk class, so low-risk metadata changes don't pay for Playwright
screenshots.

| Tier | Contents |
|---|---|
| `SNAPSHOT_LITE` | WP/CMS canonical payload (restore source of truth); relevant metadata (SEO plugin fields); content/metadata/schema hashes; rendered `<head>`/HTML validation of the relevant fragment. No mandatory screenshot. |
| `SNAPSHOT_STANDARD` | LITE + full rendered HTML, desktop+mobile screenshots, link/schema validation as relevant, response headers |
| `SNAPSHOT_ENHANCED` | STANDARD + builder/source data, template/navigation context, enhanced restore validation (dry-run restore check), any risk-specific artifacts, relevant current metrics |

**Tier mapping (platform-defined minimums; safety policy may raise, never lower):**

| Action type example | Risk | Minimum tier |
|---|---|---|
| meta description, image ALT | GREEN | LITE |
| additive schema, internal link fix | GREEN | LITE |
| title, H1, visible content additions, internal-link batch | YELLOW | STANDARD |
| schema replacement | YELLOW | STANDARD |
| URL/redirect/noindex/robots/template/builder/structural | RED | ENHANCED |

The required minimum tier per action type ships in the same registry as the QA
required-check matrix (§9). `page_snapshots.tier` records what was captured.
Rules: snapshot completeness is validated per tier before proceeding — a missing
mandatory artifact for the resolved tier is a hard stop. The CMS canonical payload
is mandatory at every tier. Snapshots are immutable and retained per
DATA-MODEL.md §12.

## 5. Patches

- Patches are **structured and typed** (`action_patches.format`), e.g.
  `wp_meta`, `schema_jsonld`, `wp_content_blocks`, `redirect`. Never raw SQL, never
  arbitrary HTML blobs into builders (PRD §18: no blind Elementor overwrite —
  builder formats without an adapter are unsupported targets and the action is
  rejected at preflight).
- Every patch ships an `inverse_patch` where derivable; restore otherwise falls back
  to the snapshot payload.
- Patch generation may involve LLM content, but the patch itself is validated data —
  schema-checked, length-checked, encoding-checked — before preflight.

## 6. Preflight (before any write)

1. Target still matches expectation: current content hash == hash at plan time
   (stale plan ⇒ abort back to draft; the world changed).
2. Integration healthy; WP capabilities sufficient; maintenance mode not active.
3. Patch validates (format, fields, constraints, banned-pattern checks).
4. Risk/mode/approval consistency re-checked (TOCTOU guard).
5. Budget & rate limits for write operations respected.

## 7. Execution

- Writes go through the CMS adapter with the action's idempotency key; the plugin
  endpoint is itself idempotent (same key ⇒ same result, no double-apply).
- One action = smallest coherent change set. Bulk operations are **batches** of
  individual actions under a `batch_id` with canary rollout.

## 8. Canary deployment (PRD §108)

Batches execute 5 → QA → 10 → QA → 50 → QA → remainder. Batch sizing is dynamic:
consecutive QA passes widen steps; any failure halts the batch, rolls back the failed
action, and pauses remaining actions pending review. Small batches (<5) skip canary.

## 9. QA engine (PRD §109–110) — required-check registry per action type

QA does **not** run the complete suite for every change. A deterministic
**required-check registry** maps each action type to its mandatory checks (the same
registry that defines snapshot-tier minimums, §4). The full PRD §109 checklist is the
superset; per-type subsets:

| Action type | Required checks |
|---|---|
| meta description | expected metadata diff; HTTP status; canonical/robots unchanged; rendered `<head>` verification |
| image ALT | image still present; expected ALT in HTML; HTML validity of the fragment |
| additive schema / schema replacement | expected JSON-LD diff; schema syntax + type + required-field validation; content/schema consistency; rendered presence of the JSON-LD |
| internal link fix | link present and resolving (200, non-redirect-loop); anchor as expected; no other link changes |
| content addition | expected content diff; HTTP status; canonical/robots unchanged; links resolve; forms present if page has forms; visual regression (deterministic diff); no new JS console errors |
| title / H1 | expected diff; rendered verification; canonical/robots unchanged; visual regression of affected region |
| structural / RED types | full enhanced QA: complete §109 checklist incl. mobile rendering, GTM/analytics presence, screenshots, performance check |

- Checks not in a type's required set may still run as scheduled site monitoring —
  they just don't gate that action.
- **Expensive performance tests (Lighthouse etc.)** run only when the action type can
  plausibly affect rendering/performance (content additions, structural, template)
  or via configurable sampling on lighter types — never on every metadata change.
- The registry is versioned config (code-reviewed data, not hardcoded logic);
  `qa_runs.checks` records exactly which checks ran and their results.

**Visual regression:** deterministic pixel/layout diff first; LLM vision is invoked
ONLY when the deterministic diff flags an anomaly needing judgment (PRD §110) —
budgeted like any LLM task.

## 10. Auto-rollback (PRD §111)

- Any critical QA failure triggers automatic rollback: status moves to
  `rolling_back` (inverse patch, else snapshot restore), then `rolled_back` on
  success, with the failure reason stored and an alert raised.
- Rollback itself runs QA (verify restoration matches pre-change snapshot hashes).
- If rollback does not restore the pre-change state, the action terminates as
  `rollback_failed`: highest-severity alert + automatic site-wide
  `EXECUTION_FREEZE` (§12) until a human intervenes. Target: rollback success
  ~100% (PRD §181).

## 11. SEO Change Guard (Phase 8; PRD §112)

Scheduled comparisons of live state vs last-known-good: title removed, noindex
appeared, page deleted, canonical changed, schema disappeared, redirects changed.
Out-of-band changes raise alerts and update the twin — they are never silently
"fixed" (self-healing is Phase 12, GREEN scenarios only, PRD §113).

## 12. Kill switches

- Per-site and global `EXECUTION_FREEZE` flags checked at queue-consume time and at
  preflight; freezing never loses queued work, it parks it.
- The `execute`/`qa` queues can be drained independently of read-only pipelines.

## 13. Reliability KPIs (PRD §181)

Execution QA pass rate > 98%; critical site breakage caused by the system: 0;
rollback success ~100%. These are dashboard metrics from Phase 4 day one, and gate
any expansion of autopilot defaults.
