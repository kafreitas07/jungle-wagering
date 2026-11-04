import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../config/env';

/**
 * Only the construction of the client. Credentials come from the standard AWS provider chain
 * (environment, profile or role); the endpoint is set only against LocalStack.
 */
export function createSqsClient(config: AppConfig['sqs']): SQSClient {
  return new SQSClient({
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
  });
}
