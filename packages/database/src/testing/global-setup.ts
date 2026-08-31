import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

/**
 * Provides a real PostgreSQL server for the integration suite.
 *
 * Default: a disposable Testcontainers instance using an image that ships pgvector.
 *
 * Override: set `TEST_DATABASE_ADMIN_URL` to a superuser connection string and the
 * suite uses that server instead. The override exists because Docker is not always
 * available on a developer machine; it changes *where* PostgreSQL comes from, never
 * *what* is tested — Row Level Security is always exercised against real PostgreSQL,
 * never a substitute engine (docs/TESTING.md §2).
 *
 * The server must have the `vector` extension available, and the connecting user
 * must be able to create databases and roles.
 */

/** Image tag pinned so the tested PostgreSQL version is deterministic. */
const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';

declare module 'vitest' {
  interface ProvidedContext {
    postgresAdminUri: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const externalUri = process.env['TEST_DATABASE_ADMIN_URL'];

  if (externalUri !== undefined && externalUri !== '') {
    project.provide('postgresAdminUri', externalUri);
    return async (): Promise<void> => {
      // Nothing to tear down: the server is not ours.
    };
  }

  let container: StartedPostgreSqlContainer;

  try {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(
      `Could not start PostgreSQL via Testcontainers (${message}). ` +
        'Start Docker, or point TEST_DATABASE_ADMIN_URL at a PostgreSQL 16+ superuser ' +
        'connection with the pgvector extension available.',
      { cause: error },
    );
  }

  project.provide('postgresAdminUri', container.getConnectionUri());

  return async (): Promise<void> => {
    await container.stop();
  };
}
