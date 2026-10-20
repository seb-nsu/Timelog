// Push-Versand: Abstraktion über FCM (Android) und APNs (iOS). Ohne Konfiguration ist Push aus;
// Rückfragen entstehen trotzdem und erscheinen am Desktop und in der App (GET /prompts).
import type { PushData } from '@timelog/shared';

export type PushPlatform = 'android' | 'ios';

export interface PushNotification {
  title: string;
  body: string;
  /** Kategorie mit Aktionen (iOS `aps.category`, Android `categoryId` für expo-notifications) */
  category: string;
  /** Nur Kennungen, Datum und Uhrzeit (siehe `pushData` in @timelog/shared) */
  data: PushData;
  /** Gleiche Kennung ersetzt eine ältere Benachrichtigung (höchstens 64 Byte). */
  collapseId: string;
  /** Sofort zustellen (Rückfrage) oder stromsparend (Wochenrückblick). */
  urgent: boolean;
}

/** `invalid_token`: Token ist beim Dienst nicht mehr registriert und wird gelöscht. */
export type PushOutcome = 'sent' | 'invalid_token' | 'failed';

export interface PushSender {
  /** Plattformen, für die Zugangsdaten konfiguriert sind. */
  readonly platforms: ReadonlySet<PushPlatform>;
  send(platform: PushPlatform, token: string, n: PushNotification): Promise<PushOutcome>;
}

/** Plattform aus dem Feld `devices.os` (die Handy-App meldet `android` bzw. `ios`). */
export function pushPlatform(os: string): PushPlatform | undefined {
  const v = os.trim().toLowerCase();
  if (v.startsWith('android')) return 'android';
  if (v.startsWith('ios') || v.startsWith('ipados')) return 'ios';
  return undefined;
}

/** Ohne Konfiguration: nichts senden. */
export const disabledPushSender: PushSender = {
  platforms: new Set(),
  send: () => Promise.resolve('failed'),
};

/** Für Tests: merkt sich alle Nachrichten; einzelne Tokens lassen sich als ungültig markieren. */
export class MemoryPushSender implements PushSender {
  readonly platforms: ReadonlySet<PushPlatform> = new Set<PushPlatform>(['android', 'ios']);
  readonly sent: { platform: PushPlatform; token: string; notification: PushNotification }[] = [];
  readonly invalid = new Set<string>();
  readonly failing = new Set<string>();

  send(
    platform: PushPlatform,
    token: string,
    notification: PushNotification,
  ): Promise<PushOutcome> {
    if (this.invalid.has(token)) return Promise.resolve('invalid_token');
    if (this.failing.has(token)) return Promise.resolve('failed');
    this.sent.push({ platform, token, notification });
    return Promise.resolve('sent');
  }
}

/** Verteilt auf die Sender je Plattform. */
export class CompositePushSender implements PushSender {
  readonly platforms: ReadonlySet<PushPlatform>;

  constructor(private readonly senders: Partial<Record<PushPlatform, PushSender>>) {
    this.platforms = new Set(Object.keys(senders) as PushPlatform[]);
  }

  send(platform: PushPlatform, token: string, n: PushNotification): Promise<PushOutcome> {
    const sender = this.senders[platform];
    return sender ? sender.send(platform, token, n) : Promise.resolve('failed');
  }
}
