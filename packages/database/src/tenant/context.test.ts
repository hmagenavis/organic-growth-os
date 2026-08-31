import { describe, expect, it } from 'vitest';

import { createTenantContext, InvalidTenantContextError } from './context.js';

const ORG_ID = '018f4c1e-6f3a-7c21-9f8e-2b1a5d3c7e01';
const USER_ID = '018f4c1e-6f3a-7c21-9f8e-2b1a5d3c7e02';

describe('createTenantContext', () => {
  it('accepts a user actor', () => {
    const context = createTenantContext({
      organizationId: ORG_ID,
      actor: { kind: 'user', userId: USER_ID },
    });

    expect(context.organizationId).toBe(ORG_ID);
    expect(context.actor).toEqual({ kind: 'user', userId: USER_ID });
  });

  it('accepts system and worker actors', () => {
    expect(
      createTenantContext({ organizationId: ORG_ID, actor: { kind: 'system' } }).actor.kind,
    ).toBe('system');

    expect(
      createTenantContext({ organizationId: ORG_ID, actor: { kind: 'worker', queue: 'crawl' } })
        .actor.kind,
    ).toBe('worker');
  });

  it('rejects a missing context', () => {
    expect(() => createTenantContext(undefined)).toThrow(InvalidTenantContextError);
    expect(() => createTenantContext(null)).toThrow(InvalidTenantContextError);
    expect(() => createTenantContext({})).toThrow(InvalidTenantContextError);
  });

  it('rejects an organization id that is not a uuid', () => {
    expect(() =>
      createTenantContext({
        organizationId: 'all',
        actor: { kind: 'system' },
      }),
    ).toThrow(InvalidTenantContextError);

    expect(() =>
      createTenantContext({
        organizationId: "' OR 1=1 --",
        actor: { kind: 'system' },
      }),
    ).toThrow(InvalidTenantContextError);
  });

  it('rejects an unknown actor kind', () => {
    expect(() =>
      createTenantContext({ organizationId: ORG_ID, actor: { kind: 'superuser' } }),
    ).toThrow(InvalidTenantContextError);
  });

  it('strips unknown fields so extra input cannot widen access', () => {
    const context = createTenantContext({
      organizationId: ORG_ID,
      actor: { kind: 'system' },
      isPlatformAdmin: true,
      bypassRls: true,
    });

    expect(context).not.toHaveProperty('isPlatformAdmin');
    expect(context).not.toHaveProperty('bypassRls');
    expect(Object.keys(context).sort()).toEqual(['actor', 'organizationId']);
  });

  it('reports which field was invalid without echoing its value', () => {
    let caught: unknown;

    try {
      createTenantContext({ organizationId: 'sensitive-looking-value', actor: { kind: 'system' } });
    } catch (error) {
      caught = error;
    }

    if (!(caught instanceof InvalidTenantContextError)) {
      throw new Error('expected InvalidTenantContextError');
    }

    expect(caught.issues.join(' ')).toContain('organizationId');
    expect(caught.message).not.toContain('sensitive-looking-value');
  });
});
