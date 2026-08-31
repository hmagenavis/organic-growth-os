/**
 * The permission vocabulary.
 *
 * Deliberately small: it covers exactly what the Phase-0 foundation can actually do
 * today. Permissions for crawling, opportunities, actions, content, execution and
 * budgets belong to the phases that build those features — inventing them now would
 * produce a matrix nobody can review against working code.
 *
 * Naming is `<resource>.<verb>`. Permissions are additive and there is no negative
 * permission: a role either holds one or does not (docs/SECURITY.md §3).
 */
export const PERMISSIONS = [
  /** Read the organization the request is authorized for. */
  'organization.read',

  'client.read',
  'client.create',
  'client.update',

  'site.read',
  'site.create',
  'site.update',

  /** Read the organization's membership list. Administrative, not directory data. */
  'member.read',
  'member.invite_or_create',
  'member.update_role',
  'member.update_scope',
  'member.remove',

  /** The caller's own sessions. Held by every role; it is not tenant data. */
  'session.read_own',
  'session.revoke_own',
  /** Force-logout of another member of the organization. Administrative. */
  'session.revoke_member',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS);

/** Narrows an untrusted value to a known permission. Unknown strings are never one. */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}
