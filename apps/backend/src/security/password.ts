import { hash, verify } from '@node-rs/argon2';

// Argon2id mit den OWASP-Mindestwerten (19 MiB, 2 Durchläufe, 1 Thread).
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;
/** Gleicht die Laufzeit an, wenn es das Konto nicht gibt. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword('timing-equalizer-password');
  await verifyPassword(await dummy, password);
}
