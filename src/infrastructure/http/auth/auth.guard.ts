import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { ProviderIdentityPort } from '../../../application/ports';
import { PROVIDER_IDENTITY } from '../tokens';

interface RequestLike {
  body?: unknown;
  params?: Record<string, string | undefined>;
}

/** The provider the request claims to act as: the body of a submission, or the path of a provider-scoped query. */
export function claimedProviderId(request: RequestLike): string | undefined {
  const fromBody = (request.body as { providerId?: unknown } | undefined)?.providerId;
  if (typeof fromBody === 'string') {
    return fromBody;
  }
  return request.params?.providerId;
}

/**
 * Delegates to the ProviderIdentityPort whenever the request names a provider. Requests that name none
 * (wallet routes) carry nothing to compare, so a real implementation protects them in its own layer.
 * Applied per controller: `/health/*` and `/metrics` have no guard.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const providerId = claimedProviderId(context.switchToHttp().getRequest<RequestLike>());
    if (providerId !== undefined) {
      await this.identity.assertCanActAs(providerId);
    }
    return true;
  }
}
