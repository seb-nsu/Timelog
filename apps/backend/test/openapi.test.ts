import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { generateOpenApi } from '../src/openapi.js';

describe('OpenAPI', () => {
  it('packages/shared/openapi.json ist aktuell (sonst: pnpm --filter @timelog/backend openapi)', async () => {
    const committed = await readFile(
      new URL('../../../packages/shared/openapi.json', import.meta.url),
      'utf8',
    );
    expect(JSON.parse(committed)).toEqual(JSON.parse(await generateOpenApi()));
  });
});
