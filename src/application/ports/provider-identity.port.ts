export class ProviderIdentityMismatchError extends Error {
  readonly code = 'PROVIDER_IDENTITY_MISMATCH';

  constructor(providerId: string) {
    super(`The caller cannot act as provider "${providerId}"`);
    this.name = 'ProviderIdentityMismatchError';
  }
}

/**
 * Extension point for authentication. A real implementation compares the provider of the
 * token with `providerId` and throws `ProviderIdentityMismatchError` (HTTP 403).
 */
export interface ProviderIdentityPort {
  assertCanActAs(providerId: string): Promise<void>;
}
