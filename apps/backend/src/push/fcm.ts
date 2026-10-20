// Firebase Cloud Messaging, HTTP v1 API (geprüft am 20.10.2026):
// - POST https://fcm.googleapis.com/v1/projects/<projekt>/messages:send, Bearer-Token mit Scope
//   https://www.googleapis.com/auth/firebase.messaging
//   (firebase.google.com/docs/cloud-messaging/migrate-v1)
// - Token per JWT-Grant des Dienstkontos: RS256, iss = client_email, aud = Token-Endpunkt,
//   exp ≤ iat + 1 h, grant_type urn:ietf:params:oauth:grant-type:jwt-bearer
//   (developers.google.com/identity/protocols/oauth2/service-account)
// - Fehler UNREGISTERED (HTTP 404): Token löschen; nur dieser Code verlangt das
//   (firebase.google.com/docs/cloud-messaging/error-codes)
// Gesendet wird eine reine Datennachricht im Format von expo-notifications (title, message,
// body = JSON, categoryId, channelId), damit Android die Aktionen der Kategorie anzeigt.
import { SignJWT, importPKCS8 } from 'jose';
import { z } from 'zod';
import type { PushNotification, PushOutcome, PushSender } from './sender.js';

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Android-Kanal, den die App für Rückfragen anlegt. */
export const ANDROID_CHANNEL = 'prompts';

const serviceAccount = z.object({
  project_id: z.string().min(1),
  client_email: z.email(),
  private_key: z.string().includes('PRIVATE KEY'),
  token_uri: z.url().optional(),
});

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

/** Liest die JSON-Datei des Dienstkontos (Firebase-Konsole → Dienstkonten). */
export function parseServiceAccount(json: string): FcmConfig {
  const parsed = serviceAccount.safeParse(JSON.parse(json));
  if (!parsed.success) throw new Error('FCM: Dienstkonto-JSON unvollständig');
  return {
    projectId: parsed.data.project_id,
    clientEmail: parsed.data.client_email,
    privateKey: parsed.data.private_key,
    tokenUri: parsed.data.token_uri ?? GOOGLE_TOKEN_URL,
  };
}

const tokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.number() });
const errorResponse = z.object({
  error: z.object({
    status: z.string().optional(),
    details: z.array(z.object({ errorCode: z.string().optional() }).loose()).optional(),
  }),
});

export class FcmSender implements PushSender {
  readonly platforms = new Set(['android'] as const);
  private access: { token: string; until: number } | undefined;

  constructor(
    private readonly cfg: FcmConfig,
    private readonly http: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.access && this.access.until > this.now()) return this.access.token;
    const key = await importPKCS8(this.cfg.privateKey, 'RS256');
    const iat = Math.floor(this.now() / 1000);
    const assertion = await new SignJWT({ scope: FCM_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.cfg.clientEmail)
      .setAudience(this.cfg.tokenUri)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(key);
    const res = await this.http(this.cfg.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!res.ok) throw new Error(`FCM: Token-Abruf fehlgeschlagen (${String(res.status)})`);
    const body = tokenResponse.parse(await res.json());
    // Eine Minute Reserve vor Ablauf
    this.access = { token: body.access_token, until: this.now() + (body.expires_in - 60) * 1000 };
    return body.access_token;
  }

  async send(
    _platform: 'android' | 'ios',
    token: string,
    n: PushNotification,
  ): Promise<PushOutcome> {
    let access: string;
    try {
      access = await this.accessToken();
    } catch {
      return 'failed';
    }
    const message = {
      message: {
        token,
        data: {
          title: n.title,
          message: n.body,
          body: JSON.stringify(n.data),
          categoryId: n.category,
          channelId: ANDROID_CHANNEL,
          tag: n.collapseId,
        },
        android: {
          priority: n.urgent ? 'HIGH' : 'NORMAL',
          ttl: '86400s',
          collapse_key: n.collapseId,
        },
      },
    };
    const res = await this.http(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.cfg.projectId)}/messages:send`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: JSON.stringify(message),
      },
    );
    if (res.ok) return 'sent';
    if (res.status === 401) this.access = undefined;
    const err = errorResponse.safeParse(await res.json().catch(() => undefined));
    const codes = err.success ? (err.data.error.details ?? []).map((d) => d.errorCode) : [];
    if (res.status === 404 || codes.includes('UNREGISTERED')) return 'invalid_token';
    return 'failed';
  }
}
