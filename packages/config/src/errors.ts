/** A single environment validation failure, reduced to non-sensitive fields. */
export interface EnvIssue {
  /** Dotted path of the offending variable, e.g. `API_PORT`. */
  readonly path: string;
  /** Validation failure code, e.g. `invalid_type`. */
  readonly code: string;
  /**
   * Human-readable reason. Validator messages describe expected/received *types*,
   * never the received value, so this is safe to surface in logs.
   */
  readonly message: string;
}

/**
 * Structural shape of a validation issue. Declared locally so the public error API
 * does not depend on validator internals.
 */
interface IssueLike {
  readonly path: readonly PropertyKey[];
  readonly code: string;
  readonly message: string;
}

export function toEnvIssues(issues: readonly IssueLike[]): EnvIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * Thrown when environment validation fails, so a misconfigured process fails fast at
 * startup rather than misbehaving later.
 *
 * The message lists only variable names and failure codes — environment values are
 * never interpolated into it, because this error is logged and any variable may hold
 * a secret (docs/SECURITY.md §5).
 */
export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    const summary = issues.map((issue) => `${issue.path} (${issue.code})`).join(', ');
    super(`Invalid environment configuration: ${summary}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}
