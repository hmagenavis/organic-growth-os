# ADR-0014: Default autopilot mode = REVIEW (deviation from PRD §106)

Status: Accepted (2026-08-31 — PRD §106 amended accordingly)

## Context
PRD §106 originally set SAFE AUTOPILOT (green actions auto-execute) as the default. PRD §185
says safety wins over autonomy in V1; PRD §169 gates execution maturity on QA/rollback
proof; PRD §181 demands zero system-caused site breakage. A brand-new site connection
has no track record: capability detection, cache behavior, theme quirks and plugin
conflicts are all unproven at that moment.

## Decision
New sites default to **REVIEW** (everything needs approval). SAFE_AUTOPILOT is an
explicit per-site opt-in (audited, admin-only) gated by a **configurable Safety
Graduation Policy** (`site_settings.graduation_policy`; org defaults overridable —
no threshold is hardcoded). Recommended baseline:
≥20 successfully completed GREEN production actions, all required QA passed, zero
critical site-impact incidents, no unresolved rollback failures, explicit user
opt-in. The system may surface "this site is ready for Safe Autopilot" — it never
flips the switch itself in V1. Full policy: EXECUTION-SAFETY.md §3.1.

## Alternatives considered
- PRD-as-written (SAFE AUTOPILOT default): one bad interaction with an unusual theme
  on day one damages exactly the trust the product's moat depends on (PRD §183:
  verified safe execution).

## Consequences
- Slightly more friction in early usage; deliberate.
- PRD §106 amended 2026-08-31 to match (default REVIEW + Safety Graduation Policy).
