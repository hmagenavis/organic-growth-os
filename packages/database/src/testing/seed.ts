import type { DatabaseHandle } from '../client.js';
import {
  provisionMembership,
  provisionOrganization,
  provisionUser,
  type OrganizationRecord,
} from '../provisioning.js';
import type { TenantContext } from '../tenant/context.js';
import { withTenantTransaction } from '../tenant/with-tenant-transaction.js';

export interface SeededOrganization {
  organization: OrganizationRecord;
  tenant: TenantContext;
  userId: string;
  membershipId: string;
  clientId: string;
  siteId: string;
}

export interface SeededTenants {
  a: SeededOrganization;
  b: SeededOrganization;
}

/**
 * Seeds two complete, independent tenants — organization → client → site — so every
 * isolation assertion has a real neighbour to fail against.
 *
 * Organizations, users and memberships are created through the privileged
 * provisioning path; clients and sites are created through ordinary tenant-scoped
 * repositories, exactly as the application would.
 */
async function seedOne(
  db: DatabaseHandle,
  provisioner: DatabaseHandle,
  suffix: string,
): Promise<SeededOrganization> {
  const organization = await provisionOrganization(provisioner.db, {
    name: `Organization ${suffix.toUpperCase()}`,
    slug: `org-${suffix}`,
  });

  const user = await provisionUser(provisioner.db, {
    email: `owner-${suffix}@example.test`,
    name: `Owner ${suffix.toUpperCase()}`,
  });

  const membership = await provisionMembership(provisioner.db, {
    organizationId: organization.id,
    userId: user.id,
    role: 'agency_admin',
    clientAccessMode: 'all_clients',
  });

  const tenant: TenantContext = {
    organizationId: organization.id,
    actor: { kind: 'user', userId: user.id },
  };

  const { clientId, siteId } = await withTenantTransaction(db.db, tenant, async (repositories) => {
    const client = await repositories.clients.create({ name: `Client ${suffix.toUpperCase()}` });
    const site = await repositories.sites.create({
      clientId: client.id,
      baseUrl: `https://${suffix}.example.test`,
    });
    await repositories.siteSettings.createForSite(site.id);

    return { clientId: client.id, siteId: site.id };
  });

  return {
    organization,
    tenant,
    userId: user.id,
    membershipId: membership.id,
    clientId,
    siteId,
  };
}

export async function seedTwoTenants(
  runtime: DatabaseHandle,
  provisioner: DatabaseHandle,
): Promise<SeededTenants> {
  return {
    a: await seedOne(runtime, provisioner, 'a'),
    b: await seedOne(runtime, provisioner, 'b'),
  };
}
