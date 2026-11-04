import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type AppOverrides, AppModule } from './app.module';
import { AllExceptionsFilter } from './http/filters/exception.filter';
import type { LoggerPort } from '../application/ports';
import type { AppConfig } from './config/env';
import { LOGGER } from './http/tokens';
import { correlationMiddleware } from './observability/correlation';

export type { AppOverrides };

/** Builds and initialises the HTTP application without listening. Tests listen on port 0. */
export async function createApp(config: AppConfig, overrides: AppOverrides = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config, overrides), { logger: ['error', 'warn'] });
  app.use(correlationMiddleware(app.get<LoggerPort>(LOGGER)));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return app;
}
