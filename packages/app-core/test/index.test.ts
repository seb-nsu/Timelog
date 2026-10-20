import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('Paket', () => {
  it('ist eingebunden', () => {
    expect(PACKAGE_NAME).toMatch(/^@timelog\//);
  });
});
