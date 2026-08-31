/**
 * Authorization.
 *
 * This package answers exactly one question — *what may this authenticated user do,
 * and where?* — and deliberately answers no other. It contains no HTTP handling, no
 * cryptography, no session lifecycle and no SQL. It does not import
 * `@organic-os/auth`: authentication proves identity, authorization consumes a user
 * id, and neither can quietly grow into the other (docs/SECURITY.md §3).
 *
 * The pipeline it exists to serve:
 *
 *   AuthenticatedIdentity(user_id)
 *     → requested organization id (routing input, never authorization)
 *     → membership proven against persisted rows
 *     → AuthorizedOrganizationContext
 *     → tenant transaction with SET LOCAL app.current_org_id
 *
 * The last step lives in `@organic-os/database`, because it is the package that owns
 * transactions; `withAuthorizedOrganization` there is the only supported way to run
 * tenant work.
 */

export {
  authorizeOrganization,
  authorizeOrganizationOrThrow,
  type AuthorizationOutcome,
  type AuthorizeOrganizationOptions,
} from './authorize.js';

export {
  CLIENT_ACCESS_MODES,
  clientAccessAllows,
  isClientAccessMode,
  type ClientAccessMode,
} from './client-access.js';

export {
  authorizationMembershipSchema,
  buildAuthorizedOrganizationContext,
  InvalidMembershipRecordError,
  withAuthorizedClient,
  type AuthenticatedIdentityRef,
  type AuthorizationMembership,
  type AuthorizedClientContext,
  type AuthorizedOrganizationContext,
  type BuildAuthorizedOrganizationContextOptions,
} from './context.js';

export {
  AuthorizationError,
  isAuthorizationError,
  type AuthorizationErrorDetails,
  type AuthorizationFailure,
} from './errors.js';

export { isPermission, PERMISSIONS, type Permission } from './permissions.js';

export { can, PERMISSION_REGISTRY_VERSION, permissionsForRole } from './registry.js';

export { isOrganizationRole, ORGANIZATION_ROLES, type OrganizationRole } from './roles.js';

export type { MembershipStore, MembershipSummary } from './store.js';
