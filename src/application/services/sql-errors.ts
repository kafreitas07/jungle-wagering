interface DriverError {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
}

export const SQLSTATE = {
  uniqueViolation: '23505',
  lockNotAvailable: '55P03',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
} as const;

export function sqlState(error: unknown): string | undefined {
  const code = (error as DriverError | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** A unique violation of the named constraint or index. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (sqlState(error) !== SQLSTATE.uniqueViolation) {
    return false;
  }
  const driver = error as DriverError;
  return driver.constraint === constraint || (typeof driver.message === 'string' && driver.message.includes(constraint));
}
