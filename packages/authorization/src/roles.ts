/**
 * Organization roles.
 *
 * Platform administration is deliberately absent. It is not an organization role: it
 * lives on `users.is_platform_admin`, gates a separate route group, and confers
 * nothing inside an organization (docs/SECURITY.md §3). Nothing in this package reads
 * that flag, which is what makes "a platform admin does not bypass organization
 * policy" a property of the type system rather than of a code review.
 */
export const ORGANIZATION_ROLES = [
  'agency_admin',
  'seo_manager',
  'content_editor',
  'analyst',
  'client_viewer',
] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set<string>(ORGANIZATION_ROLES);

/**
 * Narrows an untrusted value to a known role.
 *
 * Deny-by-default starts here: a role string that this build does not know about —
 * a newer database enum member, a hand-edited row — is not a role, and every
 * permission check against it fails.
 */
export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return typeof value === 'string' && ROLE_SET.has(value);
}
