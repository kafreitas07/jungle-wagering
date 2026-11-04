import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { PrometheusMetrics } from '../observability/metrics';
import { METRICS_REGISTRY } from './tokens';

/** Open to everyone, like /health: the scraper has no credentials. Expose it on an internal network only. */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly metrics: PrometheusMetrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.scrape();
  }
}
