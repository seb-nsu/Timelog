import { describe, expect, it } from 'vitest';
import { localeFromHeader } from '../src/i18n.js';

describe('localeFromHeader', () => {
  it('nimmt die erste Sprache; nur Englisch weicht von Deutsch ab', () => {
    expect(localeFromHeader('en-US,en;q=0.9')).toBe('en');
    expect(localeFromHeader('de-DE,de;q=0.9,en;q=0.8')).toBe('de');
    expect(localeFromHeader('fr-FR')).toBe('de');
    expect(localeFromHeader(['en'])).toBe('en');
    expect(localeFromHeader(undefined)).toBeUndefined();
    expect(localeFromHeader('*')).toBeUndefined();
  });
});
