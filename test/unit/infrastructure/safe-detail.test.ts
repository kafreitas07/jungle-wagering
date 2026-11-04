import { describe, expect, test } from 'bun:test';
import { safeDetail } from '../../../src/infrastructure/health/dependency-probes';

describe('safeDetail', () => {
  test('masks credentials inside a connection string', () => {
    const error = new Error('connect failed for postgres://wagering:s3cr3tpass@db.internal:5432/wagering');

    const detail = safeDetail(error);

    expect(detail).not.toContain('s3cr3tpass');
    expect(detail).not.toContain('wagering:');
    expect(detail).toContain('db.internal');
  });

  test('prefers the error code over the class name', () => {
    expect(safeDetail(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED: refused');
    expect(safeDetail(new TypeError('bad'))).toBe('TypeError: bad');
  });

  test('keeps only the first line, so no stack or multi-line SQL', () => {
    expect(safeDetail(new Error('first line\nsecond line\n    at stack'))).toBe('Error: first line');
  });

  test('is bounded in length and handles non-errors', () => {
    expect(safeDetail(new Error('x'.repeat(1000))).length).toBeLessThanOrEqual(200);
    expect(safeDetail('a string')).toBe('unknown error');
  });
});
