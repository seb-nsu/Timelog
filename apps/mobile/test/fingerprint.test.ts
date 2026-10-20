import { describe, expect, it } from '@jest/globals';
import { createHmac } from 'node:crypto';
import vectors from '../modules/timelog-native/fingerprint-vectors.json';
import {
  isWeakFingerprint,
  networkFingerprint,
  normalizeForHmac,
} from '../modules/timelog-native/src/fingerprint';

describe('Netzwerk-Kennung (gemeinsame Testfälle mit Kotlin)', () => {
  it.each(vectors.cases)('$name', ({ link, fingerprint, weak }) => {
    const fp = networkFingerprint(link);
    expect(fp).toBe(fingerprint);
    if (fp) expect(isWeakFingerprint(fp)).toBe(weak);
  });

  it.each(vectors.hmac)('HMAC wie Backend: $value', ({ value, hex }) => {
    const key = Buffer.from(vectors.hmacKey, 'base64');
    expect(createHmac('sha256', key).update(normalizeForHmac(value)).digest('hex')).toBe(hex);
  });

  it('Desktop-Kennung gilt nie als schwach', () => {
    expect(isWeakFingerprint('gw=aa:bb:cc:dd:ee:ff')).toBe(false);
  });

  it('enthält keine IPv6-Adressen und keine WLAN-Namen', () => {
    for (const c of vectors.cases) {
      const fp = networkFingerprint(c.link) ?? '';
      expect(fp).not.toMatch(/fe80|ssid/i);
    }
  });
});
