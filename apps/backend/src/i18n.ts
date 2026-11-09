// Sprache serverseitig erzeugter Texte (E-Mails, Exporte). Deutsch ist führend; Englisch, wenn der
// Aufrufer es verlangt (Accept-Language) oder das Gerät es hinterlegt hat (devices.locale).
import { desc, eq, isNotNull, isNull, and } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { asSystem } from './db/index.js';
import { devices } from './db/schema.js';

export type Locale = 'de' | 'en';

/** Erste Sprache aus Accept-Language; nur de und en werden unterschieden. */
export function localeFromHeader(header: string | string[] | undefined): Locale | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const first = value?.split(',')[0]?.trim().toLowerCase();
  if (!first || first === '*') return undefined;
  return first.startsWith('en') ? 'en' : 'de';
}

/** Text in der gewünschten Sprache. */
export function tr(locale: Locale, de: string, en: string): string {
  return locale === 'en' ? en : de;
}

/** Gebietsschema für Intl. */
export const intlLocale = (locale: Locale): string => (locale === 'en' ? 'en-GB' : 'de-DE');

/** Hinterlegte Sprache eines Geräts (z. B. Desktop-App ohne Accept-Language). */
export async function deviceLocale(db: Db, deviceId: string): Promise<Locale | undefined> {
  const [row] = await asSystem(db, (tx) =>
    tx.select({ locale: devices.locale }).from(devices).where(eq(devices.id, deviceId)),
  );
  return row?.locale === 'en' ? 'en' : row?.locale === 'de' ? 'de' : undefined;
}

/** Sprache einer Person für E-Mails: zuletzt genutztes Gerät mit hinterlegter Sprache, sonst Deutsch. */
export async function userLocale(db: Db, userId: string): Promise<Locale> {
  const [row] = await asSystem(db, (tx) =>
    tx
      .select({ locale: devices.locale })
      .from(devices)
      .where(and(eq(devices.userId, userId), isNull(devices.revokedAt), isNotNull(devices.locale)))
      .orderBy(desc(devices.lastSeenAt))
      .limit(1),
  );
  return row?.locale === 'en' ? 'en' : 'de';
}

/** Sprache einer Anfrage: Accept-Language, sonst Sprache des Geräts aus dem Token, sonst Deutsch. */
export async function requestLocale(
  db: Db,
  headers: Record<string, string | string[] | undefined>,
  deviceId?: string,
): Promise<Locale> {
  return (
    localeFromHeader(headers['accept-language']) ??
    (deviceId ? await deviceLocale(db, deviceId) : undefined) ??
    'de'
  );
}
