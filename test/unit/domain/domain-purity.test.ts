import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';

// MON-09: the domain stays free of NestJS and ORM dependencies.
describe('domain purity (MON-09)', () => {
  const files = [...new Glob('src/domain/**/*.ts').scanSync('.')];

  test('there are domain files to inspect', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files)('%s imports neither NestJS nor the ORM', (file) => {
    const imports = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => /^\s*(import|export)\b.*\bfrom\b/.test(line));

    for (const line of imports) {
      expect(line).not.toMatch(/@nestjs|@mikro-orm|reflect-metadata/);
    }
  });
});
