import { describe, expect, it } from 'vitest';

import { CLIENT_ACCESS_MODES, type ClientAccessMode } from './client-access.js';
import {
  assertAgencyAdminRemains,
  assertClientAccessAllowedForRole,
  assertNotSelfMutation,
  isClientAccessNarrowing,
  isMembershipAdministrationError,
  MembershipAdministrationError,
  normalizeClientAccessForRole,
  type ClientAccessState,
} from './membership-administration.js';
import { ORGANIZATION_ROLES, type OrganizationRole } from './roles.js';

/**
 * Member administration policy, as values.
 *
 * The same properties are proven against real PostgreSQL — with locking, concurrency
 * and Row Level Security — in
 * `packages/database/src/administration/membership-administration.int.test.ts`.
 * Nothing here is evidence about concurrency; these are the decisions the
 * transaction makes once it holds its locks.
 */

const ADMIN_A = '018f9e1a-0000-7000-8000-0000000000a1';
const ADMIN_B = '018f9e1a-0000-7000-8000-0000000000b1';
const MEMBER_C = '018f9e1a-0000-7000-8000-0000000000c1';
const CLIENT_1 = '018f9e1a-0000-7000-8000-000000000101';
const CLIENT_2 = '018f9e1a-0000-7000-8000-000000000102';
const CLIENT_3 = '018f9e1a-0000-7000-8000-000000000103';

function state(mode: ClientAccessMode, ...clientIds: readonly string[]): ClientAccessState {
  return { mode, clientIds: new Set(clientIds) };
}

function failureOf(run: () => void): string {
  try {
    run();
  } catch (error: unknown) {
    if (isMembershipAdministrationError(error)) {
      return error.failure;
    }
    throw error;
  }

  return '(no failure)';
}

describe('self mutation', () => {
  it('refuses a mutation aimed at the caller own membership', () => {
    expect(
      failureOf(() => {
        assertNotSelfMutation(ADMIN_A, ADMIN_A);
      }),
    ).toBe('self_mutation_forbidden');
  });

  it('allows a mutation aimed at any other membership', () => {
    expect(() => {
      assertNotSelfMutation(ADMIN_A, ADMIN_B);
    }).not.toThrow();
  });

  it('refuses regardless of direction, because direction is never consulted', () => {
    // There is no argument describing what the change would do: the rule is the
    // identity comparison alone, so no future caller can pass "this one is a
    // narrowing" and be let through.
    expect(assertNotSelfMutation.length).toBe(2);
  });
});

describe('last agency admin', () => {
  it('allows demoting one of two admins', () => {
    expect(() => {
      assertAgencyAdminRemains({
        agencyAdminMembershipIds: [ADMIN_A, ADMIN_B],
        targetMembershipId: ADMIN_A,
        targetRemainsAgencyAdmin: false,
      });
    }).not.toThrow();
  });

  it('refuses demoting the only admin', () => {
    expect(
      failureOf(() => {
        assertAgencyAdminRemains({
          agencyAdminMembershipIds: [ADMIN_A],
          targetMembershipId: ADMIN_A,
          targetRemainsAgencyAdmin: false,
        });
      }),
    ).toBe('last_agency_admin');
  });

  it('refuses removing the only admin', () => {
    expect(
      failureOf(() => {
        assertAgencyAdminRemains({
          agencyAdminMembershipIds: [ADMIN_A],
          targetMembershipId: ADMIN_A,
          targetRemainsAgencyAdmin: false,
        });
      }),
    ).toBe('last_agency_admin');
  });

  it('allows a change that keeps the only admin an admin', () => {
    // e.g. a client-scope change on the sole administrator.
    expect(() => {
      assertAgencyAdminRemains({
        agencyAdminMembershipIds: [ADMIN_A],
        targetMembershipId: ADMIN_A,
        targetRemainsAgencyAdmin: true,
      });
    }).not.toThrow();
  });

  it('allows removing a non-admin while a single admin exists', () => {
    expect(() => {
      assertAgencyAdminRemains({
        agencyAdminMembershipIds: [ADMIN_A],
        targetMembershipId: MEMBER_C,
        targetRemainsAgencyAdmin: false,
      });
    }).not.toThrow();
  });

  it('refuses when the organization already has no admin', () => {
    expect(
      failureOf(() => {
        assertAgencyAdminRemains({
          agencyAdminMembershipIds: [],
          targetMembershipId: MEMBER_C,
          targetRemainsAgencyAdmin: false,
        });
      }),
    ).toBe('last_agency_admin');
  });

  it('allows promoting someone when the organization has no admin', () => {
    expect(() => {
      assertAgencyAdminRemains({
        agencyAdminMembershipIds: [],
        targetMembershipId: MEMBER_C,
        targetRemainsAgencyAdmin: true,
      });
    }).not.toThrow();
  });

  it('counts the target once, not twice, when it is already an admin', () => {
    // A naive `count >= 1` on the locked set would let the sole admin demote itself.
    expect(
      failureOf(() => {
        assertAgencyAdminRemains({
          agencyAdminMembershipIds: [ADMIN_A],
          targetMembershipId: ADMIN_A,
          targetRemainsAgencyAdmin: false,
        });
      }),
    ).toBe('last_agency_admin');
  });
});

describe('client_viewer is client-restricted', () => {
  it('refuses all_clients for client_viewer', () => {
    expect(
      failureOf(() => {
        assertClientAccessAllowedForRole('client_viewer', 'all_clients');
      }),
    ).toBe('client_viewer_requires_scoped');
  });

  it('allows scoped for every role', () => {
    for (const role of ORGANIZATION_ROLES) {
      expect(() => {
        assertClientAccessAllowedForRole(role, 'scoped');
      }).not.toThrow();
    }
  });

  it('allows all_clients for every role except client_viewer', () => {
    for (const role of ORGANIZATION_ROLES.filter((value) => value !== 'client_viewer')) {
      expect(() => {
        assertClientAccessAllowedForRole(role, 'all_clients');
      }).not.toThrow();
    }
  });
});

describe('role change normalisation', () => {
  it('narrows all_clients to an empty scope when becoming a client_viewer', () => {
    const normalized = normalizeClientAccessForRole('client_viewer', state('all_clients'));

    expect(normalized.mode).toBe('scoped');
    expect([...normalized.clientIds]).toEqual([]);
  });

  it('leaves an existing scope untouched when becoming a client_viewer', () => {
    const normalized = normalizeClientAccessForRole(
      'client_viewer',
      state('scoped', CLIENT_1, CLIENT_2),
    );

    expect(normalized.mode).toBe('scoped');
    expect([...normalized.clientIds].sort()).toEqual([CLIENT_1, CLIENT_2]);
  });

  it('never converts scoped into all_clients for any role', () => {
    for (const role of ORGANIZATION_ROLES) {
      const normalized = normalizeClientAccessForRole(role, state('scoped', CLIENT_1));

      expect(normalized.mode).toBe('scoped');
      expect([...normalized.clientIds]).toEqual([CLIENT_1]);
    }
  });

  it('never widens: the result is never a superset of what went in', () => {
    const cells = ORGANIZATION_ROLES.flatMap((role: OrganizationRole) =>
      CLIENT_ACCESS_MODES.map((mode) => ({ role, mode })),
    );

    for (const { role, mode } of cells) {
      const before = state(mode, CLIENT_1);
      const after = normalizeClientAccessForRole(role, before);

      expect(isClientAccessNarrowing(after, before)).toBe(false);
    }
  });
});

describe('narrowing detection', () => {
  it('treats all_clients to all_clients as unchanged', () => {
    expect(isClientAccessNarrowing(state('all_clients'), state('all_clients'))).toBe(false);
  });

  it('treats all_clients to scoped as narrowing, even with clients listed', () => {
    expect(isClientAccessNarrowing(state('all_clients'), state('scoped', CLIENT_1))).toBe(true);
    expect(isClientAccessNarrowing(state('all_clients'), state('scoped'))).toBe(true);
  });

  it('treats scoped to all_clients as broadening', () => {
    expect(isClientAccessNarrowing(state('scoped', CLIENT_1), state('all_clients'))).toBe(false);
  });

  it('detects a removed client', () => {
    expect(
      isClientAccessNarrowing(state('scoped', CLIENT_1, CLIENT_2), state('scoped', CLIENT_1)),
    ).toBe(true);
  });

  it('detects a swapped client', () => {
    // Same size, different membership: strictly a loss of CLIENT_1.
    expect(isClientAccessNarrowing(state('scoped', CLIENT_1), state('scoped', CLIENT_2))).toBe(
      true,
    );
  });

  it('does not treat an added client as narrowing', () => {
    expect(
      isClientAccessNarrowing(state('scoped', CLIENT_1), state('scoped', CLIENT_1, CLIENT_2)),
    ).toBe(false);
  });

  it('does not treat an identical scope as narrowing', () => {
    expect(
      isClientAccessNarrowing(
        state('scoped', CLIENT_1, CLIENT_2),
        state('scoped', CLIENT_2, CLIENT_1),
      ),
    ).toBe(false);
  });

  it('treats emptying a scope as narrowing', () => {
    expect(isClientAccessNarrowing(state('scoped', CLIENT_1), state('scoped'))).toBe(true);
  });

  it('treats an empty scope staying empty as unchanged', () => {
    expect(isClientAccessNarrowing(state('scoped'), state('scoped'))).toBe(false);
  });

  it('covers every mode pair', () => {
    const pairs = CLIENT_ACCESS_MODES.flatMap((before) =>
      CLIENT_ACCESS_MODES.map((after) => ({ before, after })),
    );

    expect(pairs).toHaveLength(4);

    for (const { before, after } of pairs) {
      // A total function: every pair produces a boolean, none throws.
      expect(typeof isClientAccessNarrowing(state(before, CLIENT_3), state(after, CLIENT_3))).toBe(
        'boolean',
      );
    }
  });
});

describe('the error type', () => {
  it('carries the failure category and nothing else', () => {
    const error = new MembershipAdministrationError('last_agency_admin');

    expect(error.name).toBe('MembershipAdministrationError');
    expect(error.failure).toBe('last_agency_admin');
    expect(isMembershipAdministrationError(error)).toBe(true);
    expect(isMembershipAdministrationError(new Error('other'))).toBe(false);
  });
});
