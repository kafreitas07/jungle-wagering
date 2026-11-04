import { Controller, Get, Inject, Res } from '@nestjs/common';
import { type DependencyProbe, safeDetail } from '../health/dependency-probes';
import { DEPENDENCY_PROBES } from './tokens';

/** The only part of the HTTP response this controller needs; avoids a dependency on express types. */
interface StatusSetter {
  status(code: number): unknown;
}

type DependencyStatus = { status: 'up' } | { status: 'down'; detail: string };

/** Open to everyone: no guard on purpose (a probe must work without credentials). */
@Controller('health')
export class HealthController {
  constructor(@Inject(DEPENDENCY_PROBES) private readonly probes: readonly DependencyProbe[]) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: StatusSetter) {
    const dependencies: Record<string, DependencyStatus> = {};
    await Promise.all(
      this.probes.map(async (probe) => {
        try {
          await probe.check();
          dependencies[probe.name] = { status: 'up' };
        } catch (error) {
          dependencies[probe.name] = { status: 'down', detail: safeDetail(error) };
        }
      }),
    );
    const healthy = Object.values(dependencies).every((dependency) => dependency.status === 'up');
    response.status(healthy ? 200 : 503);
    return { status: healthy ? 'ok' : 'unavailable', dependencies };
  }
}
