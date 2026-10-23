// HMAC-SHA256 (RFC 2104) auf einer austauschbaren SHA-256-Funktion (expo-crypto bzw. node:crypto).
// Nur für „Nur lokal“: Ohne Server erzeugt die App ihren HMAC-Schlüssel selbst und speichert
// Arbeitsnetze wie der Server nur als HMAC.

export type Bytes = Uint8Array<ArrayBuffer>;
export type Sha256 = (data: Bytes) => Promise<Bytes>;

const BLOCK = 64;

export function base64ToBytes(b64: string): Bytes {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function concat(a: Bytes, b: Bytes): Bytes {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export async function hmacSha256(sha256: Sha256, key: Bytes, message: Bytes): Promise<Bytes> {
  let k = key.length > BLOCK ? await sha256(key) : key;
  if (k.length < BLOCK) {
    const padded = new Uint8Array(BLOCK);
    padded.set(k);
    k = padded;
  }
  const ipad = k.map((b) => b ^ 0x36);
  const opad = k.map((b) => b ^ 0x5c);
  const inner = await sha256(concat(ipad, message));
  return sha256(concat(opad, inner));
}

/** HMAC als Hex über einen UTF-8-Text, Schlüssel als Base64 (wie GET /networks). */
export async function hmacHex(sha256: Sha256, keyB64: string, text: string): Promise<string> {
  return toHex(await hmacSha256(sha256, base64ToBytes(keyB64), new TextEncoder().encode(text)));
}
