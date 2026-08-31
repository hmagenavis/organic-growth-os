import { describe, expect, it } from 'vitest';

import { PERMISSIONS, type Permission } from './permissions.js';
import { can, PERMISSION_REGISTRY_VERSION, permissionsForRole } from './registry.js';
import { ORGANIZATION_ROLES, type OrganizationRole } from './roles.js';

/**
 * The permission matrix, exhaustively.
 *
 * Every role is checked against every permission — 5 × 16 cells — against an
 * expectation written out here independently of the registry. A registry change that
 * nobody meant to make fails this file rather than shipping.
 */

/** The expected matrix, restated. Deliberately not derived from the implementation. */
const EXPECTED: Readonly<Record<OrganizationRole, readonly Permission[]>> = {
  agency_admin: [
    'organization.read',
    'client.read',
    'client.create',
    'client.update',
    'site.read',
    'site.create',
    'site.update',
    'member.read',
    'member.invite_or_create',
    'member.update_role',
    'member.update_scope',
    'member.remove',
    'session.read_own',
    'session.revoke_own',
    'session.revoke_member',
  ],
  seo_manager: [
    'organization.read',
    'client.read',
    'site.read',
    'session.read_own',
    'session.revoke_own',
  ],
  content_editor: [
    'organization.read',
    'client.read',
    'site.read',
    'session.read_own',
    'session.revoke_own',
  ],
  analyst: [
    'organization.read',
    'client.read',
    'site.read',
    'session.read_own',
    'session.revoke_own',
  ],
  client_viewer: [
    'organization.read',
    'client.read',
    'site.read',
    'session.read_own',
    'session.revoke_own',
  ],
};

describe('role × permission matrix', () => {
  const cells = ORGANIZATION_ROLES.flatMap((role) =>
    PERMISSIONS.map((permission) => ({
      role,
      permission,
      expected: EXPECTED[role].includes(permission),
    })),
  );

  it('covers every role and every permission', () => {
    expect(cells).toHaveLength(ORGANIZATION_ROLES.length * PERMISSIONS.length);
    expect(PERMISSIONS.length).toBeGreaterThan(0);
  });

  it.each(cells)('$role $expected $permission', ({ role, permission, expected }) => {
    expect(can(role, permission)).toBe(expected);
  });

  it('grants agency_admin every defined permission and nothing beyond the vocabulary', () => {
    expect([...permissionsForRole('agency_admin')].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('grants no role a permission outside the vocabulary', () => {
    for (const role of ORGANIZATION_ROLES) {
      for (const permission of permissionsForRole(role)) {
        expect(PERMISSIONS).toContain(permission);
      }
    }
  });
});

describe('deny by default', () => {
  const notPermissions = [
    'organization.delete',
    'client.delete',
    'billing.read',
    'action.approve',
    '',
    'organization.read ',
    'ORGANIZATION.READ',
    '*',
    '__proto__',
    'toString',
    'constructor',
  ];

  it.each(ORGANIZATION_ROLES)('denies every undefined permission to %s', (role) => {
    for (const permission of notPermissions) {
      expect(can(role, permission)).toBe(false);
    }
  });

  it.each(notPermissions)('denies %s to an unknown role', (permission) => {
    expect(can('super_admin', permission)).toBe(false);
    expect(can('platform_admin', permission)).toBe(false);
  });

  it('denies an unknown role every defined permission', () => {
    // There is no organization role for platform administration, so a value that
    // looks like one authorizes nothing (docs/SECURITY.md §3).
    for (const permission of PERMISSIONS) {
      expect(can('super_admin', permission)).toBe(false);
      expect(can('owner', permission)).toBe(false);
      expect(can('', permission)).toBe(false);
    }
  });

  it('denies non-string inputs rather than coercing them', () => {
    const hostile: unknown[] = [null, undefined, 0, 1, true, {}, [], () => true];

    for (const value of hostile) {
      expect(can(value, 'organization.read')).toBe(false);
      expect(can('agency_admin', value)).toBe(false);
    }
  });
});

describe('registry metadata', () => {
  it('states the version that produced a decision', () => {
    expect(PERMISSION_REGISTRY_VERSION).toBe(1);
  });

  it('has no organization role called super_admin or platform admin', () => {
    expect(ORGANIZATION_ROLES).not.toContain('super_admin');
    expect(ORGANIZATION_ROLES).not.toContain('platform_admin');
    expect(ORGANIZATION_ROLES).toHaveLength(5);
  });
});
