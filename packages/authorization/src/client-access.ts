/**
 * Client-level access, stated explicitly.
 *
 * The previous model (docs/DATA-MODEL.md §3 as written for Phase 0.2) gave an empty
 * `membership_client_scopes` collection two meanings depending on who read it: "all
 * clients the role permits" by convention, "no clients" to any code that took the
 * collection at face value. That ambiguity is exactly the shape of a
 * privilege-escalation bug, so the mode now lives on the membership row and the
 * scope collection is consulted only when the mode says to.
 */
export const CLIENT_ACCESS_MODES = ['all_clients', 'scoped'] as const;

export type ClientAccessMode = (typeof CLIENT_ACCESS_MODES)[number];

const MODE_SET: ReadonlySet<string> = new Set<string>(CLIENT_ACCESS_MODES);

export function isClientAccessMode(value: unknown): value is ClientAccessMode {
  return typeof value === 'string' && MODE_SET.has(value);
}

/**
 * Whether a membership's client access covers `clientId`.
 *
 * `all_clients` covers every client of the organization; the caller has already
 * established that `clientId` belongs to it. `scoped` covers exactly the listed
 * clients, so an empty collection covers none — never all. Any value that is not a
 * known mode denies, so a corrupted or newer-than-this-build row fails closed.
 *
 * This is only half of a client authorization: the role must also hold the
 * permission (`can`), and the client must be proven to belong to the authorized
 * organization. `withAuthorizedOrganization` in `@organic-os/database` composes all
 * three; nothing should call this alone.
 */
export function clientAccessAllows(
  mode: unknown,
  scopedClientIds: ReadonlySet<string>,
  clientId: string,
): boolean {
  if (mode === 'all_clients') {
    return true;
  }

  if (mode === 'scoped') {
    return scopedClientIds.has(clientId);
  }

  return false;
}
