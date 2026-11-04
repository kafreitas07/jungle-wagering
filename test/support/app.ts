import type { INestApplication } from '@nestjs/common';
import type { ProviderIdentityPort } from '../../src/application/ports';
import { type AppOverrides, createApp } from '../../src/infrastructure/app.factory';
import { type AppConfig, loadEnv } from '../../src/infrastructure/config/env';
import { testDatabaseConfig } from './db';

/** Config for a test app: the test database and LocalStack, with room to break either one. */
export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  return loadEnv({
    DATABASE_URL: testDatabaseConfig().url,
    SQS_ENDPOINT: 'http://localhost:4566',
    AWS_REGION: 'us-east-1',
    ...overrides,
  });
}

export interface TestApp {
  readonly app: INestApplication;
  readonly url: string;
  close(): Promise<void>;
}

export async function startTestApp(config: AppConfig = testConfig(), overrides: AppOverrides = {}): Promise<TestApp> {
  const app = await createApp(config, overrides);
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number };
  return { app, url: `http://127.0.0.1:${address.port}`, close: () => app.close() };
}

export interface ApiResponse {
  readonly status: number;
  readonly body: any;
  readonly headers: Headers;
}

export async function api(
  base: string,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResponse> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text), headers: response.headers };
}

export const denyAllProviders: ProviderIdentityPort = {
  async assertCanActAs(providerId: string) {
    const { ProviderIdentityMismatchError } = await import('../../src/application/ports');
    throw new ProviderIdentityMismatchError(providerId);
  },
};
