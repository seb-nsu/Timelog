// TOTP nach RFC 6238 (SHA-1, 30 s, 6 Stellen) mit node:crypto.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_S = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=+$/, '').toUpperCase()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Ungültiges Base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0xf;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

export function currentStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_S);
}

/** Prüft den Code mit ±1 Zeitschritt Toleranz; liefert den Schritt oder undefined. */
export function verifyTotp(
  secret: string,
  code: string,
  nowMs: number,
  afterStep = -1,
): number | undefined {
  const step = currentStep(nowMs);
  for (const s of [step - 1, step, step + 1]) {
    if (s <= afterStep) continue;
    const expected = Buffer.from(hotp(secret, s));
    const given = Buffer.from(code);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return s;
  }
  return undefined;
}

export function otpauthUrl(secret: string, account: string, issuer = 'TimeLog'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
