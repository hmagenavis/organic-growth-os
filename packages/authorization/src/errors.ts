import type { Permission } from './permissions.js';

/**
 * Why authorization refused.
 *
 * These are internal categories for logs, metrics and the HTTP mapping. They are not
 * response bodies: the API deliberately collapses several of them into one
 * indistinguishable answer so an authorization boundary cannot be used to probe for
 * the existence of resources (docs/phases/PHASE-0.4.1-IMPLEMENTATION.md §"401/403").
 */
export type AuthorizationFailure =
  /** The requested organization identifier was not a well-formed id. */
  | 'malformed_organization_id'
  /** The caller holds no membership in the requested organization. */
  | 'no_membership'
  /** A membership exists but its role does not hold the required permission. */
  | 'permission_denied'
  /** The requested resource does not belong to the authorized organization. */
  | 'resource_not_in_organization'
  /** The role holds the permission, but the membership's client scope excludes it. */
  | 'client_out_of_scope';

export interface AuthorizationErrorDetails {
  /** The permission being checked, when the failure involved one. */
  readonly permission?: Permission;
  /** Resource kind (`client`, `site`, …) for logging. Never the resource id. */
  readonly resource?: string;
}

/**
 * A refusal from the authorization layer.
 *
 * The message is for developers and logs. It is never returned to a client: the HTTP
 * layer builds a problem+json body from `failure` alone, so nothing that leaked into
 * this message can leak into a response.
 */
export class AuthorizationError extends Error {
  readonly failure: AuthorizationFailure;
  readonly permission: Permission | undefined;
  readonly resource: string | undefined;

  constructor(failure: AuthorizationFailure, details: AuthorizationErrorDetails = {}) {
    super(`Authorization refused: ${failure}`);
    this.name = 'AuthorizationError';
    this.failure = failure;
    this.permission = details.permission;
    this.resource = details.resource;
  }
}

export function isAuthorizationError(value: unknown): value is AuthorizationError {
  return value instanceof AuthorizationError;
}
