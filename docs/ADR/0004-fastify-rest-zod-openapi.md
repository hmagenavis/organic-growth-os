# ADR-0004: Fastify REST API; OpenAPI generated from Zod contracts

Status: Accepted (2026-08-31 — accepted with the Phase 0 go decision)

## Context
PRD §135: TypeScript backend, lightweight framework, REST first, OpenAPI contracts.
The dashboard is the only consumer initially; a public API may follow.

## Decision
Fastify with a Zod validation boundary (`fastify-type-provider-zod`). All request/
response schemas live in `packages/contracts` and generate OpenAPI 3.1; the same
schemas type the web client. REST conventions (problem+json, cursor pagination,
idempotency keys, 202+job pattern) per API-CONTRACTS.md. No GraphQL/tRPC.

## Alternatives considered
- tRPC: tight coupling web↔api and no clean path to a public/OpenAPI surface.
- NestJS: heavy abstraction layer contrary to "lightweight" requirement.
- Next.js API routes: mixes dashboard and API deployment/scaling concerns; API must
  scale and deploy independently of the web app.

## Consequences
- One schema source of truth; drift between docs, server and client is structurally
  impossible.
- Public API later = publishing the same OpenAPI surface behind feature flags/keys.
