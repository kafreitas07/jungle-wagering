import type { ProviderIdentityPort } from '../../../application/ports';

/**
 * Accepts every provider. This is the extension point, not a security control: a deployment must replace it
 * with an implementation that compares the provider of the authenticated credential with `providerId`.
 */
export class AllowAllProviderIdentity implements ProviderIdentityPort {
  async assertCanActAs(): Promise<void> {}
}
