import { describe, expect, test } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { ProviderIdentityMismatchError, type ProviderIdentityPort } from '../../../../src/application/ports';
import { AllowAllProviderIdentity } from '../../../../src/infrastructure/http/auth/allow-all-provider-identity';
import { AuthGuard, claimedProviderId } from '../../../../src/infrastructure/http/auth/auth.guard';

const contextFor = (request: { body?: unknown; params?: Record<string, string> }) =>
  ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

class RecordingIdentity implements ProviderIdentityPort {
  readonly asked: string[] = [];

  constructor(private readonly allowed: string | 'all') {}

  async assertCanActAs(providerId: string): Promise<void> {
    this.asked.push(providerId);
    if (this.allowed !== 'all' && providerId !== this.allowed) {
      throw new ProviderIdentityMismatchError(providerId);
    }
  }
}

describe('claimedProviderId', () => {
  test('reads the provider from the body of a submission', () => {
    expect(claimedProviderId({ body: { providerId: 'provider-a' } })).toBe('provider-a');
  });

  test('reads the provider from the path of a provider-scoped query', () => {
    expect(claimedProviderId({ params: { providerId: 'provider-b' } })).toBe('provider-b');
  });

  test('the body wins over the path', () => {
    expect(claimedProviderId({ body: { providerId: 'from-body' }, params: { providerId: 'from-path' } })).toBe('from-body');
  });

  test('is undefined when the request names no provider, or names a non-string one', () => {
    expect(claimedProviderId({})).toBeUndefined();
    expect(claimedProviderId({ body: { providerId: 42 } })).toBeUndefined();
    expect(claimedProviderId({ body: 'not an object' })).toBeUndefined();
  });
});

describe('AuthGuard (AUTH-01, AUTH-02)', () => {
  test('delegates the provider of the body to the port and lets the request through', async () => {
    const identity = new RecordingIdentity('all');

    expect(await new AuthGuard(identity).canActivate(contextFor({ body: { providerId: 'provider-a' } }))).toBe(true);
    expect(identity.asked).toEqual(['provider-a']);
  });

  test('a port that denies surfaces ProviderIdentityMismatchError', async () => {
    const guard = new AuthGuard(new RecordingIdentity('someone-else'));

    await expect(guard.canActivate(contextFor({ body: { providerId: 'provider-a' } }))).rejects.toBeInstanceOf(ProviderIdentityMismatchError);
  });

  test('the same port decision applies to a provider-scoped query', async () => {
    const guard = new AuthGuard(new RecordingIdentity('provider-ok'));

    expect(await guard.canActivate(contextFor({ params: { providerId: 'provider-ok' } }))).toBe(true);
    await expect(guard.canActivate(contextFor({ params: { providerId: 'provider-bad' } }))).rejects.toBeInstanceOf(
      ProviderIdentityMismatchError,
    );
  });

  test('a request that names no provider is not sent to the port', async () => {
    const identity = new RecordingIdentity('nobody');

    expect(await new AuthGuard(identity).canActivate(contextFor({ params: { walletId: 'w' } }))).toBe(true);
    expect(identity.asked).toEqual([]);
  });

  test('AllowAllProviderIdentity accepts every provider', async () => {
    await expect(new AllowAllProviderIdentity().assertCanActAs()).resolves.toBeUndefined();
    expect(await new AuthGuard(new AllowAllProviderIdentity()).canActivate(contextFor({ body: { providerId: 'anyone' } }))).toBe(true);
  });
});
