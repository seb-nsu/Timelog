// Push-Zugangsdaten nur aus Umgebungsvariablen (siehe .env.example und docs/PUSH.md).
import { readFileSync } from 'node:fs';
import { ApnsSender, http2Transport } from './apns.js';
import { FcmSender, parseServiceAccount } from './fcm.js';
import { CompositePushSender, type PushPlatform, type PushSender } from './sender.js';

export interface PushEnv {
  FCM_SERVICE_ACCOUNT?: string | undefined;
  FCM_SERVICE_ACCOUNT_FILE?: string | undefined;
  APNS_KEY?: string | undefined;
  APNS_KEY_FILE?: string | undefined;
  APNS_KEY_ID?: string | undefined;
  APNS_TEAM_ID?: string | undefined;
  APNS_BUNDLE_ID?: string | undefined;
  APNS_ENV?: 'production' | 'sandbox' | undefined;
}

export interface PushSetup {
  sender: PushSender;
  close: () => void;
}

/** In Umgebungsvariablen stehen Zeilenumbrüche oft als `\n`. */
const pem = (v: string) => v.replaceAll('\\n', '\n');

/**
 * Baut den Sender aus der Umgebung. Fehlen die Angaben einer Plattform, ist Push dafür aus; ein
 * Hinweis geht ins Log (ohne personenbezogene Daten und ohne Schlüssel).
 */
export function createPushSender(
  env: PushEnv,
  log: (msg: string) => void,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): PushSetup {
  const senders: Partial<Record<PushPlatform, PushSender>> = {};
  let close: () => void = () => undefined;

  const account =
    env.FCM_SERVICE_ACCOUNT ??
    (env.FCM_SERVICE_ACCOUNT_FILE ? read(env.FCM_SERVICE_ACCOUNT_FILE) : undefined);
  if (account) senders.android = new FcmSender(parseServiceAccount(account));

  const key = env.APNS_KEY ?? (env.APNS_KEY_FILE ? read(env.APNS_KEY_FILE) : undefined);
  if (key && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_BUNDLE_ID) {
    const transport = http2Transport();
    close = transport.close;
    senders.ios = new ApnsSender(
      {
        key: pem(key),
        keyId: env.APNS_KEY_ID,
        teamId: env.APNS_TEAM_ID,
        bundleId: env.APNS_BUNDLE_ID,
        production: env.APNS_ENV !== 'sandbox',
      },
      transport,
      Date.now,
      log,
    );
  } else if (key || env.APNS_KEY_ID || env.APNS_TEAM_ID) {
    log(
      'push: APNs unvollständig konfiguriert (APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID)',
    );
  }

  const platforms = Object.keys(senders);
  log(
    platforms.length === 0
      ? 'push: nicht konfiguriert – Rückfragen nur in den Apps, kein Push-Versand'
      : `push: aktiv für ${platforms.join(', ')}`,
  );
  return { sender: new CompositePushSender(senders), close };
}
