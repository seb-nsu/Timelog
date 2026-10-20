// Apple Push Notification service, tokenbasiert über HTTP/2 (geprüft am 20.10.2026):
// - api.push.apple.com:443 bzw. api.sandbox.push.apple.com:443, POST /3/device/<token>,
//   Header authorization (bearer <JWT>), apns-push-type, apns-topic (Bundle-ID), apns-priority,
//   apns-expiration, apns-collapse-id (≤ 64 Byte); Nutzlast ≤ 4096 Byte
//   (developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
// - JWT ES256 mit kid = Key-ID und iss = Team-ID, iat höchstens 1 h alt; erneuern frühestens
//   alle 20, spätestens alle 60 Minuten
//   (…/establishing-a-token-based-connection-to-apns)
// - 410 Unregistered/ExpiredToken: Token löschen. BadDeviceToken heißt laut Apple auch
//   „falsche Umgebung“; das Token bleibt, es wird ein Hinweis geloggt
//   (…/handling-notification-responses-from-apns)
// Die Daten stehen unter `body`, wo expo-notifications sie als `content.data` liefert.
import { SignJWT, importPKCS8 } from 'jose';
import { type ClientHttp2Session, connect, constants } from 'node:http2';
import { z } from 'zod';
import type { PushNotification, PushOutcome, PushSender } from './sender.js';

export interface ApnsConfig {
  /** Inhalt der .p8-Datei (PKCS#8, PEM) */
  key: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  production: boolean;
}

export interface ApnsRequest {
  origin: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export type ApnsTransport = (req: ApnsRequest) => Promise<{ status: number; body: string }>;

/** Token alle 40 Minuten erneuern (zwischen 20 und 60 Minuten). */
const TOKEN_TTL_MS = 40 * 60_000;
const MAX_PAYLOAD = 4096;

const errorBody = z.object({ reason: z.string() });

/** HTTP/2-Verbindung je Ursprung, wiederverwendet bis zum Schließen. */
export function http2Transport(): ApnsTransport & { close: () => void } {
  const sessions = new Map<string, ClientHttp2Session>();
  const session = (origin: string): ClientHttp2Session => {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = connect(origin);
    s.on('error', () => {
      sessions.delete(origin);
    });
    s.on('close', () => {
      sessions.delete(origin);
    });
    s.unref();
    sessions.set(origin, s);
    return s;
  };
  const transport = (req: ApnsRequest) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const stream = session(req.origin).request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: req.path,
        ...req.headers,
      });
      let status = 0;
      let body = '';
      stream.setEncoding('utf8');
      stream.setTimeout(10_000, () => {
        stream.close(constants.NGHTTP2_CANCEL);
        reject(new Error('APNs: Zeitüberschreitung'));
      });
      stream.on('response', (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      stream.on('data', (chunk: string) => {
        body += chunk;
      });
      stream.on('end', () => {
        resolve({ status, body });
      });
      stream.on('error', reject);
      stream.end(req.body);
    });
  return Object.assign(transport, {
    close: () => {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  });
}

export class ApnsSender implements PushSender {
  readonly platforms = new Set(['ios'] as const);
  private provider: { token: string; at: number } | undefined;

  constructor(
    private readonly cfg: ApnsConfig,
    private readonly transport: ApnsTransport,
    private readonly now: () => number = Date.now,
    private readonly warn: (msg: string) => void = () => undefined,
  ) {}

  get origin(): string {
    return this.cfg.production
      ? 'https://api.push.apple.com:443'
      : 'https://api.sandbox.push.apple.com:443';
  }

  private async providerToken(): Promise<string> {
    if (this.provider && this.now() - this.provider.at < TOKEN_TTL_MS) return this.provider.token;
    const key = await importPKCS8(this.cfg.key, 'ES256');
    const at = this.now();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.cfg.keyId })
      .setIssuer(this.cfg.teamId)
      .setIssuedAt(Math.floor(at / 1000))
      .sign(key);
    this.provider = { token, at };
    return token;
  }

  async send(
    _platform: 'android' | 'ios',
    token: string,
    n: PushNotification,
  ): Promise<PushOutcome> {
    if (!/^[0-9a-fA-F]{32,200}$/.test(token)) return 'invalid_token';
    const payload = JSON.stringify({
      aps: {
        alert: { title: n.title, body: n.body },
        category: n.category,
        'thread-id': 'timelog',
      },
      body: n.data,
    });
    if (Buffer.byteLength(payload) > MAX_PAYLOAD) return 'failed';
    let res: { status: number; body: string };
    try {
      res = await this.transport({
        origin: this.origin,
        path: `/3/device/${token}`,
        headers: {
          authorization: `bearer ${await this.providerToken()}`,
          'apns-push-type': 'alert',
          'apns-topic': this.cfg.bundleId,
          'apns-priority': n.urgent ? '10' : '5',
          'apns-expiration': String(Math.floor(this.now() / 1000) + 86_400),
          'apns-collapse-id': n.collapseId.slice(0, 64),
          'content-type': 'application/json',
        },
        body: payload,
      });
    } catch {
      return 'failed';
    }
    if (res.status === 200) return 'sent';
    if (res.status === 410) return 'invalid_token';
    const reason = errorBody.safeParse(safeJson(res.body));
    const code = reason.success ? reason.data.reason : '';
    if (code === 'ExpiredProviderToken' || code === 'InvalidProviderToken')
      this.provider = undefined;
    if (code === 'BadDeviceToken' || code === 'DeviceTokenNotForTopic') {
      this.warn(`push: APNs ${code} – Umgebung (APNS_ENV) und Bundle-ID prüfen`);
    }
    return 'failed';
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
