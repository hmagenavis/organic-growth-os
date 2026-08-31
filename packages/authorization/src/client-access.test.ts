import { describe, expect, it } from 'vitest';

import { CLIENT_ACCESS_MODES, clientAccessAllows, isClientAccessMode } from './client-access.js';
import { PERMISSIONS, type Permission } from './permissions.js';
import { can } from './registry.js';
import { ORGANIZATION_ROLES } from './roles.js';

/**
 * Client access mode, including the case the mode exists to disambiguate: a `scoped`
 * membership with an empty scope collection reaches zero clients, never all of them.
 */

const CLIENT_A = '018f9e1a-0000-7000-8000-00000000000a';
const CLIENT_B = '018f9e1a-0000-7000-8000-00000000000b';

describe('all_clients', () => {
  it('covers any client of the organization, regardless of the scope collection', () => {
    expect(clientAccessAllows('all_clients', new Set(), CLIENT_A)).toBe(true);
    expect(clientAccessAllows('all_clients', new Set([CLIENT_B]), CLIENT_A)).toBe(true);
  });
});

describe('scoped', () => {
  it('covers a listed client', () => {
    expect(clientAccessAllows('scoped', new Set([CLIENT_A]), CLIENT_A)).toBe(true);
  });

  it('does not cover an unlisted client', () => {
    expect(clientAccessAllows('scoped', new Set([CLIENT_B]), CLIENT_A)).toBe(false);
  });

  it('covers nothing when the scope collection is empty', () => {
    // The whole point of the mode: an empty collection is zero clients, and there is
    // no branch anywhere that reads it as "all".
    expect(clientAccessAllows('scoped', new Set(), CLIENT_A)).toBe(false);
    expect(clientAccessAllows('scoped', new Set(), CLIENT_B)).toBe(false);
  });
});

describe('unknown modes', () => {
  it('denies rather than defaulting', () => {
    const hostile: unknown[] = ['ALL_CLIENTS', 'all', '', null, undefined, true, 1, {}];

    for (const mode of hostile) {
      expect(clientAccessAllows(mode, new Set([CLIENT_A]), CLIENT_A)).toBe(false);
    }
  });

  it('recognises exactly two modes', () => {
    expect([...CLIENT_ACCESS_MODES]).toEqual(['all_clients', 'scoped']);
    expect(isClientAccessMode('all_clients')).toBe(true);
    expect(isClientAccessMode('scoped')).toBe(true);
    expect(isClientAccessMode('every_client')).toBe(false);
  });
});

describe('role × permission × client access mode', () => {
  // Both halves are required for a client resource: neither a permissive role nor a
  // permissive access mode is sufficient alone (docs/SECURITY.md §3).
  const clientPermissions: readonly Permission[] = PERMISSIONS.filter((permission) =>
    permission.startsWith('client.'),
  );

  const cells = ORGANIZATION_ROLES.flatMap((role) =>
    clientPermissions.flatMap((permission) =>
      CLIENT_ACCESS_MODES.map((mode) => ({ role, permission, mode })),
    ),
  );

  it.each(cells)(
    '$role / $permission / $mode requires both halves',
    ({ role, permission, mode }) => {
      const roleAllows = can(role, permission);
      const scopeAllows = clientAccessAllows(mode, new Set([CLIENT_A]), CLIENT_A);
      const outOfScope = clientAccessAllows(mode, new Set([CLIENT_B]), CLIENT_A);

      // An in-scope client is reachable only when the role also holds the permission.
      expect(roleAllows && scopeAllows).toBe(roleAllows);

      // A scoped membership cannot reach an unlisted client whatever its role is.
      if (mode === 'scoped') {
        expect(roleAllows && outOfScope).toBe(false);
      }
    },
  );
});
