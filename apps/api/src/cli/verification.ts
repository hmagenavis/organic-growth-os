import {
  clientListResponseSchema,
  memberListResponseSchema,
  clientResponseSchema,
  csrfTokenResponseSchema,
  loginResponseSchema,
  organizationListResponseSchema,
  siteListResponseSchema,
  siteResponseSchema,
  type Client,
  type OrganizationMembership,
  type Site,
} from '@organic-os/contracts';

/**
 * The end-to-end verification checks, as a function.
 *
 * This is the manual counterpart to the CI suites, and it answers a different
 * question. CI proves the *logic* against a disposable database it built itself.
 * This proves the *deployment*: that a real process, holding a real pooled connection
 * to the managed database, over verified TLS, actually serves a login, keeps a
 * session, enforces CSRF, and applies the Phase 0.4 authorization rules to real rows
 * that outlive the run.
 *
 * Nothing here logs the password, and no check prints a cookie value, a CSRF token or
 * a session id. The password is read by the command in `verify-e2e.ts`, from a
 * terminal with the echo off, and arrives here as an argument.
 *
 * It is **idempotent**. There is no site or client deletion in Phase 0.4.2, so the
 * script reuses the fixtures it finds by name rather than creating a new set on every
 * run. A second run against the same environment changes nothing and still exercises
 * every path.
 */

export const DEFAULT_API = 'http://127.0.0.1:3001';

/** Names this script owns. Reused across runs so staging does not accumulate rows. */
const MARKER_CLIENT = 'E2E verification';
const MARKER_CLIENT_SECONDARY = 'E2E verification (secondary)';
const MARKER_SITE_URL = 'https://e2e-verification.organic-os.test';

/** A uuid that will not exist, for the non-enumeration checks. */
const ABSENT_UUID = '018f9e1a-0000-7000-8000-0000000000ff';

/** A minimal cookie jar. Values are carried, never printed. */
class Jar {
  readonly #cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const value of response.headers.getSetCookie()) {
      const [pair = ''] = value.split(';');
      const separator = pair.indexOf('=');

      if (separator === -1) {
        continue;
      }

      const name = pair.slice(0, separator).trim();
      const cookieValue = decodeURIComponent(pair.slice(separator + 1).trim());

      if (cookieValue === '') {
        this.#cookies.delete(name);
      } else {
        this.#cookies.set(name, cookieValue);
      }
    }
  }

  header(): string {
    return [...this.#cookies]
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join('; ');
  }

  /** The CSRF token the server last issued, found by cookie name rather than guessed. */
  csrf(): string | undefined {
    for (const [name, value] of this.#cookies) {
      if (name.endsWith('csrf')) {
        return value;
      }
    }

    return undefined;
  }

  snapshot(): Jar {
    const copy = new Jar();

    for (const [name, value] of this.#cookies) {
      copy.#cookies.set(name, value);
    }

    return copy;
  }
}

interface Outcome {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface CallOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  /** Omit the CSRF header on a state-changing call, to prove it is required. */
  readonly withoutCsrf?: boolean;
  readonly csrfHeaderName: string;
}

interface Call {
  readonly status: number;
  readonly json: unknown;
  readonly text: string;
}

/** A non-JSON body is a fact about the response, not a reason to stop. */
function parseJson(text: string): unknown {
  if (text === '') {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function call(api: string, jar: Jar, path: string, options: CallOptions): Promise<Call> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  const cookie = jar.header();

  if (cookie !== '') {
    headers['cookie'] = cookie;
  }

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const token = jar.csrf();

  if (method !== 'GET' && options.withoutCsrf !== true && token !== undefined) {
    headers[options.csrfHeaderName] = token;
  }

  const response = await fetch(`${api}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  jar.absorb(response);

  const text = await response.text();

  return { status: response.status, json: parseJson(text), text };
}

function organizationsUrl(organizationId: string): string {
  return `/organizations/${organizationId}`;
}

function clientsUrl(organizationId: string): string {
  return `${organizationsUrl(organizationId)}/clients`;
}

function sitesUrl(organizationId: string, clientId: string): string {
  return `${clientsUrl(organizationId)}/${clientId}/sites`;
}

/** What the verification needs. The password arrives read; it is never read here. */
export interface VerificationInput {
  readonly api: string;
  readonly email: string;
  readonly password: string;
}

/**
 * Runs every check against a live API and reports whether all of them passed.
 *
 * Separate from the command so the checks can be exercised without a terminal, and so
 * reading the password is the command's problem rather than this function's.
 */
export async function runVerification(options: VerificationInput): Promise<boolean> {
  const password = options.password;
  const outcomes: Outcome[] = [];

  const record = (name: string, ok: boolean, detail: string): boolean => {
    outcomes.push({ name, ok, detail });
    process.stdout.write(
      `${ok ? '  ok  ' : ' FAIL '} ${name}${detail === '' ? '' : ` — ${detail}`}
`,
    );
    return ok;
  };

  const jar = new Jar();
  // Replaced by the value the server states on /auth/csrf; the client must not
  // hardcode a header name the server owns.
  let csrfHeaderName = 'x-csrf-token';
  const go = async (path: string, extra: Partial<CallOptions> = {}): Promise<Call> =>
    call(options.api, jar, path, { csrfHeaderName, ...extra });

  process.stdout.write('Health and the unauthenticated surface\n');

  const health = await go('/health');
  record('GET /health', health.status === 200, `status ${health.status}`);

  const ready = await go('/health/ready');
  record(
    'GET /health/ready proves the pooled connection to the database',
    ready.status === 200,
    `status ${ready.status}`,
  );

  for (const path of ['/auth/me', '/auth/organizations']) {
    const response = await go(path);
    record(`GET ${path} without a session`, response.status === 401, `status ${response.status}`);
  }

  const anonymousClients = await go(clientsUrl(ABSENT_UUID));
  record(
    'GET clients without a session',
    anonymousClients.status === 401,
    `status ${anonymousClients.status}`,
  );

  const anonymousSites = await go(sitesUrl(ABSENT_UUID, ABSENT_UUID));
  record(
    'GET sites without a session',
    anonymousSites.status === 401,
    `status ${anonymousSites.status}`,
  );

  process.stdout.write('\nCSRF and login\n');

  const csrf = await go('/auth/csrf');
  const csrfBody = csrfTokenResponseSchema.safeParse(csrf.json);

  if (!csrfBody.success) {
    record('GET /auth/csrf', false, `status ${csrf.status}, unexpected body`);
    throw new Error('cannot continue without a CSRF token');
  }

  csrfHeaderName = csrfBody.data.headerName;
  record('GET /auth/csrf issues a token', csrf.status === 200, `header ${csrfHeaderName}`);

  const noCsrf = await go('/auth/login', {
    method: 'POST',
    body: { email: options.email, password },
    withoutCsrf: true,
  });
  record(
    'POST /auth/login without the CSRF header is refused',
    noCsrf.status === 403,
    `status ${noCsrf.status}`,
  );

  const wrongPassword = await go('/auth/login', {
    method: 'POST',
    body: { email: options.email, password: `${password}-definitely-wrong` },
  });
  record(
    'POST /auth/login with a wrong password is refused',
    wrongPassword.status === 401,
    `status ${wrongPassword.status}`,
  );

  const login = await go('/auth/login', {
    method: 'POST',
    body: { email: options.email, password },
  });
  const loginBody = loginResponseSchema.safeParse(login.json);

  if (login.status !== 200 || !loginBody.success) {
    record('POST /auth/login', false, `status ${login.status}`);
    throw new Error(
      'login failed. Provision an agency_admin with `pnpm provision:organization`, ' +
        'and check the address and password.',
    );
  }

  record('POST /auth/login succeeds and issues a session', true, loginBody.data.user.email);

  const me = await go('/auth/me');
  record(
    'GET /auth/me returns the signed-in user',
    me.status === 200 &&
      typeof me.json === 'object' &&
      me.json !== null &&
      (me.json as { user?: { id?: string } }).user?.id === loginBody.data.user.id,
    `status ${me.status}`,
  );

  const organizations = await go('/auth/organizations');
  const organizationsBody = organizationListResponseSchema.safeParse(organizations.json);

  if (!organizationsBody.success || organizationsBody.data.organizations.length === 0) {
    record('GET /auth/organizations', false, 'no membership returned');
    throw new Error('the account holds no organization membership');
  }

  const membership: OrganizationMembership =
    organizationsBody.data.organizations.find((row) => row.role === 'agency_admin') ??
    organizationsBody.data.organizations[0]!;

  record(
    'GET /auth/organizations returns a membership',
    true,
    `${membership.organizationSlug} as ${membership.role} (${membership.clientAccessMode})`,
  );

  if (membership.role !== 'agency_admin') {
    throw new Error('the write checks need an agency_admin membership');
  }

  const organizationId = membership.organizationId;

  process.stdout.write('\nMembers (sub-phase 0.4.2A)\n');

  const membersUrl = `${organizationsUrl(organizationId)}/members`;

  const members = await go(membersUrl);
  const membersBody = memberListResponseSchema.safeParse(members.json);
  record(
    'GET members lists the organization, including the caller',
    members.status === 200 &&
      membersBody.success &&
      membersBody.data.members.some((row) => row.membershipId === membership.membershipId),
    `status ${members.status}`,
  );

  // Nothing is mutated here on purpose. The only member mutation safe to attempt
  // against a live environment is one the server must refuse, and self-demotion is
  // that mutation: refusing it is what stops an organization losing its last
  // administrator (ADR-0017).
  const selfDemotion = await go(`${membersUrl}/${membership.membershipId}/role`, {
    method: 'PATCH',
    body: { role: 'analyst' },
  });
  record(
    'PATCH the caller own role is refused, so no self-demotion is possible',
    selfDemotion.status === 403 || selfDemotion.status === 409,
    `status ${selfDemotion.status}`,
  );

  const stillAdmin = await go('/auth/organizations');
  const stillAdminBody = organizationListResponseSchema.safeParse(stillAdmin.json);
  record(
    'the refused member mutation changed nothing',
    stillAdminBody.success &&
      stillAdminBody.data.organizations.some(
        (row) => row.organizationId === organizationId && row.role === 'agency_admin',
      ),
    'still agency_admin',
  );

  process.stdout.write('\nClients (sub-phase 0.4.2B1)\n');

  async function findOrCreateClient(name: string): Promise<Client> {
    const listed = await go(`${clientsUrl(organizationId)}?limit=100`);
    const page = clientListResponseSchema.safeParse(listed.json);

    if (listed.status !== 200 || !page.success) {
      throw new Error(`listing clients failed with status ${listed.status}`);
    }

    const existing = page.data.clients.find((row) => row.name === name);

    if (existing !== undefined) {
      return existing;
    }

    const created = await go(clientsUrl(organizationId), { method: 'POST', body: { name } });
    const body = clientResponseSchema.safeParse(created.json);

    if (created.status !== 201 || !body.success) {
      throw new Error(`creating a client failed with status ${created.status}`);
    }

    return body.data.client;
  }

  const listed = await go(`${clientsUrl(organizationId)}?limit=100`);
  const listedBody = clientListResponseSchema.safeParse(listed.json);
  record(
    'GET clients returns a bounded page with no total count',
    listed.status === 200 &&
      listedBody.success &&
      Object.keys(listedBody.data.page).sort().join(',') === 'limit,nextCursor',
    `status ${listed.status}`,
  );

  const clientNoCsrf = await go(clientsUrl(organizationId), {
    method: 'POST',
    body: { name: 'should not be created' },
    withoutCsrf: true,
  });
  record(
    'POST a client without the CSRF header is refused',
    clientNoCsrf.status === 403,
    `status ${clientNoCsrf.status}`,
  );

  const client = await findOrCreateClient(MARKER_CLIENT);
  const secondary = await findOrCreateClient(MARKER_CLIENT_SECONDARY);
  record('the verification clients exist', true, `${client.id}, ${secondary.id}`);

  const single = await go(`${clientsUrl(organizationId)}/${client.id}`);
  record('GET one client', single.status === 200, `status ${single.status}`);

  const stamp = new Date().toISOString();
  const patched = await go(`${clientsUrl(organizationId)}/${client.id}`, {
    method: 'PATCH',
    body: { industry: `verified ${stamp}` },
  });
  const patchedBody = clientResponseSchema.safeParse(patched.json);
  record(
    'PATCH a client applies the change',
    patched.status === 200 &&
      patchedBody.success &&
      patchedBody.data.client.industry === `verified ${stamp}`,
    `status ${patched.status}`,
  );

  const immutableClient = await go(`${clientsUrl(organizationId)}/${client.id}`, {
    method: 'PATCH',
    body: { status: 'archived' },
  });
  record(
    'PATCH a client rejects an immutable field',
    immutableClient.status === 400,
    `status ${immutableClient.status}`,
  );

  const absentClient = await go(`${clientsUrl(organizationId)}/${ABSENT_UUID}`);
  record(
    'GET an absent client is a non-enumerating 404',
    absentClient.status === 404,
    `status ${absentClient.status}`,
  );

  const foreignOrganization = await go(clientsUrl(ABSENT_UUID));
  record(
    'GET clients of an organization the caller is not a member of is a 404',
    foreignOrganization.status === 404,
    `status ${foreignOrganization.status}`,
  );

  process.stdout.write('\nSites (sub-phase 0.4.2B2)\n');

  const chosenMode = await go(sitesUrl(organizationId, client.id), {
    method: 'POST',
    body: { baseUrl: 'https://autopilot-attempt.organic-os.test', autopilotMode: 'safe_autopilot' },
  });
  record(
    'POST a site cannot choose an autopilot mode',
    chosenMode.status === 400,
    `status ${chosenMode.status}`,
  );

  async function findOrCreateSite(): Promise<Site> {
    const created = await go(sitesUrl(organizationId, client.id), {
      method: 'POST',
      body: { baseUrl: MARKER_SITE_URL },
    });

    if (created.status === 201) {
      const body = siteResponseSchema.safeParse(created.json);

      if (!body.success) {
        throw new Error('the created site did not match the contract');
      }

      record('POST a site creates it', true, `201, autopilotMode ${body.data.site.autopilotMode}`);
      return body.data.site;
    }

    if (created.status !== 409) {
      throw new Error(`creating a site failed with status ${created.status}`);
    }

    record(
      'POST a duplicate base URL is a 409 from the database constraint',
      true,
      'reusing the site from an earlier run',
    );

    const page = await go(`${sitesUrl(organizationId, client.id)}?limit=100`);
    const body = siteListResponseSchema.safeParse(page.json);
    const existing = body.success
      ? body.data.sites.find((row) => row.baseUrl === MARKER_SITE_URL)
      : undefined;

    if (existing === undefined) {
      throw new Error(
        'the base URL is taken but no site under this client holds it; a previous run may ' +
          'have created it under a different client',
      );
    }

    return existing;
  }

  const site = await findOrCreateSite();

  record(
    'the site starts in review, by system policy',
    site.autopilotMode === 'review',
    `autopilotMode ${String(site.autopilotMode)}`,
  );

  const siteList = await go(`${sitesUrl(organizationId, client.id)}?limit=100`);
  const siteListBody = siteListResponseSchema.safeParse(siteList.json);
  record(
    'GET sites lists it under its parent client',
    siteList.status === 200 &&
      siteListBody.success &&
      siteListBody.data.sites.some((row) => row.id === site.id) &&
      Object.keys(siteListBody.data.page).sort().join(',') === 'limit,nextCursor',
    `status ${siteList.status}`,
  );

  const singleSite = await go(`${sitesUrl(organizationId, client.id)}/${site.id}`);
  record('GET one site', singleSite.status === 200, `status ${singleSite.status}`);

  const nextTimezone = site.timezone === 'UTC' ? 'Asia/Jerusalem' : 'UTC';
  const patchedSite = await go(`${sitesUrl(organizationId, client.id)}/${site.id}`, {
    method: 'PATCH',
    body: { timezone: nextTimezone },
  });
  const patchedSiteBody = siteResponseSchema.safeParse(patchedSite.json);
  record(
    'PATCH a site applies the change and leaves the autopilot mode alone',
    patchedSite.status === 200 &&
      patchedSiteBody.success &&
      patchedSiteBody.data.site.timezone === nextTimezone &&
      patchedSiteBody.data.site.autopilotMode === 'review',
    `status ${patchedSite.status}, timezone ${nextTimezone}`,
  );

  for (const [label, body] of [
    ['an autopilot mode', { autopilotMode: 'safe_autopilot' }],
    ['a client move', { clientId: secondary.id }],
    ['an immutable field', { status: 'archived' }],
    ['an unknown field', { unknown: true }],
  ] as const) {
    const rejected = await go(`${sitesUrl(organizationId, client.id)}/${site.id}`, {
      method: 'PATCH',
      body,
    });
    record(`PATCH a site rejects ${label}`, rejected.status === 400, `status ${rejected.status}`);
  }

  const wrongParent = await go(`${sitesUrl(organizationId, secondary.id)}/${site.id}`);
  record(
    'GET a real site under the wrong parent client is a 404',
    wrongParent.status === 404,
    `status ${wrongParent.status}`,
  );

  const crossClientDuplicate = await go(sitesUrl(organizationId, secondary.id), {
    method: 'POST',
    body: { baseUrl: MARKER_SITE_URL },
  });
  record(
    'the base URL is unique across the organization',
    crossClientDuplicate.status === 409,
    `status ${crossClientDuplicate.status}`,
  );

  const badUrl = await go(sitesUrl(organizationId, client.id), {
    method: 'POST',
    body: { baseUrl: 'ftp://example.test' },
  });
  record(
    'a base URL that cannot be normalized is refused',
    badUrl.status === 400 && !badUrl.text.includes('ftp://example.test'),
    `status ${badUrl.status}, value not echoed`,
  );

  for (const [method, path] of [
    ['DELETE', `${sitesUrl(organizationId, client.id)}/${site.id}`],
    ['GET', `${sitesUrl(organizationId, client.id)}/${site.id}/settings`],
    ['PATCH', `${sitesUrl(organizationId, client.id)}/${site.id}/settings`],
  ] as const) {
    const absent = await go(path, { method, body: method === 'GET' ? undefined : {} });
    record(
      `${method} ${method === 'DELETE' ? 'a site' : 'site settings'} is not served in this phase`,
      absent.status === 404,
      `status ${absent.status}`,
    );
  }

  process.stdout.write('\nSession lifecycle\n');

  const stale = jar.snapshot();

  const logout = await go('/auth/logout', { method: 'POST', body: {} });
  record(
    'POST /auth/logout',
    logout.status === 200 || logout.status === 204,
    `status ${logout.status}`,
  );

  const afterLogout = await go('/auth/me');
  record(
    'GET /auth/me after logout is refused',
    afterLogout.status === 401,
    `status ${afterLogout.status}`,
  );

  const replayed = await call(options.api, stale, '/auth/me', { csrfHeaderName });
  record(
    'the old session cookie is dead server-side, not just cleared in the browser',
    replayed.status === 401,
    `status ${replayed.status}`,
  );

  const failures = outcomes.filter((outcome) => !outcome.ok);

  process.stdout.write(`\n${outcomes.length - failures.length}/${outcomes.length} checks passed\n`);

  if (failures.length > 0) {
    process.stdout.write('\nFailed:\n');

    for (const failure of failures) {
      process.stdout.write(`  - ${failure.name} (${failure.detail})\n`);
    }

    return false;
  }

  process.stdout.write(
    '\nThe verification client and site are left in place on purpose: there is no ' +
      'deletion endpoint in Phase 0.4.2, and reusing them is what makes this script ' +
      'safe to run again.\n',
  );

  return true;
}
