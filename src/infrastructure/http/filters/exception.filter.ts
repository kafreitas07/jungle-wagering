import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { type MappedError, mapError } from '../http-errors';

interface HttpResponse {
  status(code: number): { json(body: unknown): unknown };
  setHeader(name: string, value: string): unknown;
}

/** The single place that turns any thrown error into an HTTP response. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const mapped: MappedError = mapError(error);

    if (mapped.status >= 500 && mapped.status !== 503) {
      // Server side only: the body below never carries the message, stack or SQL.
      console.error(JSON.stringify({ level: 'error', message: 'unhandled error', errorName: (error as Error)?.name, errorMessage: (error as Error)?.message }));
    }
    if (mapped.retryAfter !== undefined) {
      response.setHeader('Retry-After', String(mapped.retryAfter));
    }
    response.status(mapped.status).json(mapped.body);
  }
}
