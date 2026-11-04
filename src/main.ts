import { startApplication } from './infrastructure/bootstrap';
import { ConfigError, loadEnv } from './infrastructure/config/env';
import { createLogger } from './infrastructure/observability/logger';

async function main(): Promise<void> {
  const config = loadEnv();
  const logger = createLogger({ level: config.logLevel });
  const running = await startApplication(config);
  logger.info('application started', { runners: config.runners, started: running.runners, httpPort: running.httpPort });

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    await running.stop();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
