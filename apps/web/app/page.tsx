import { publicEnv } from '@organic-os/config/client';
import type { ReactElement } from 'react';

export default function HomePage(): ReactElement {
  const { NEXT_PUBLIC_APP_NAME: appName } = publicEnv();

  return (
    <main style={{ maxWidth: '42rem', margin: '0 auto', padding: '4rem 1.5rem' }}>
      <h1 style={{ fontSize: '1.75rem', margin: '0 0 0.5rem' }}>{appName}</h1>

      <p style={{ color: 'var(--color-muted)', margin: '0 0 2rem' }}>
        Repository and tooling foundation (Phase 0.1).
      </p>

      <p>
        This application shell exists so the monorepo, TypeScript configuration and build pipeline
        are exercised end to end. It intentionally renders no product data: authentication, tenancy
        and the dashboard are built in later Phase 0 sub-phases.
      </p>

      <p style={{ color: 'var(--color-muted)' }}>
        Architecture and phase plans live in <code>docs/</code>.
      </p>
    </main>
  );
}
