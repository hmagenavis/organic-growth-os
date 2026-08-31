# Organic Growth OS

## Source of truth

- Product: docs/MASTER-PRD.md
- Architecture: docs/ARCHITECTURE.md
- Data: docs/DATA-MODEL.md
- Security: docs/SECURITY.md
- Execution safety: docs/EXECUTION-SAFETY.md

Read only the documents relevant to the current task.

## Core rules

- TypeScript strict.
- Never use `any` without documented justification.
- Keep domain logic out of UI components.
- All external services must use adapters/interfaces.
- All DB changes require migrations.
- All external writes must be idempotent where possible.
- No production SEO change may bypass Action -> Snapshot -> Risk -> QA.
- No LLM call without token budget, cache key and structured output.
- Prefer deterministic code over LLM.
- Do not send raw HTML to LLM when structured extraction is possible.
- Never log secrets or OAuth tokens.
- Multi-tenant isolation is mandatory.
- Tests are required for all critical domain logic.
- Do not create fake implementations.
- Do not silently swallow errors.
- Update relevant docs when architecture changes.

## Workflow

Before substantial changes:

1. Inspect relevant code/docs.
2. Produce a short implementation plan.
3. Implement smallest coherent change.
4. Run typecheck/lint/tests.
5. Review diff.
6. Update docs if required.
