// FCM- und APNs-Sender gegen gefakte HTTP-Endpunkte: Signatur der Tokens, Nutzlast und
// Erkennung ungültiger Tokens. Ohne Netz und ohne echte Schlüssel.
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { decodeJwt, decodeProtectedHeader, importSPKI, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { ApnsSender, type ApnsRequest, http2Transport } from '../src/push/apns.js';
import { createPushSender } from '../src/push/config.js';
import { FcmSender, parseServiceAccount } from '../src/push/fcm.js';
import { type PushNotification, pushPlatform } from '../src/push/sender.js';

const notification: PushNotification = {
  title: 'Feierabend um 17:05 erkannt',
  body: 'Stimmt das?',
  category: 'timelog.end_confirm',
  data: { kind: 'end_confirm', sessionId: 'b1', date: '2026-10-14' },
  collapseId: 'end-2026-10-14',
  urgent: true,
};

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const rsaPublic = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecPem = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ecPublic = ec.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const account = JSON.stringify({
  type: 'service_account',
  project_id: 'timelog-test',
  client_email: 'push@timelog-test.iam.gserviceaccount.com',
  private_key: rsaPem,
});

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const fn: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(handler(url, init ?? {}));
  };
  return { fn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('FCM HTTP v1', () => {
  it('holt ein OAuth-Token per JWT-Grant, cacht es und sendet eine Datennachricht', async () => {
    let send = 0;
    const { fn, calls } = fakeFetch((url) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return json(200, { access_token: 'ya29.test', expires_in: 3600, token_type: 'Bearer' });
      }
      send += 1;
      return json(200, { name: `projects/timelog-test/messages/${String(send)}` });
    });
    const now = Date.parse('2026-10-20T10:00:00Z');
    const fcm = new FcmSender(parseServiceAccount(account), fn, () => now);
    expect(await fcm.send('android', 'tok-1', notification)).toBe('sent');
    expect(await fcm.send('android', 'tok-2', notification)).toBe('sent');
    expect(calls.map((c) => c.url)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://fcm.googleapis.com/v1/projects/timelog-test/messages:send',
      'https://fcm.googleapis.com/v1/projects/timelog-test/messages:send',
    ]);

    const form = new URLSearchParams(calls[0]?.init.body as string);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = form.get('assertion') ?? '';
    const { payload } = await jwtVerify(assertion, await importSPKI(rsaPublic, 'RS256'), {
      currentDate: new Date(now),
    });
    expect(payload).toMatchObject({
      iss: 'push@timelog-test.iam.gserviceaccount.com',
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(3600);

    const req = calls[1];
    expect((req?.init.headers as Record<string, string>).authorization).toBe('Bearer ya29.test');
    const body = JSON.parse(req?.init.body as string) as {
      message: { token: string; data: Record<string, string>; android: Record<string, string> };
    };
    expect(body.message.token).toBe('tok-1');
    expect(body.message.data).toEqual({
      title: notification.title,
      message: notification.body,
      body: JSON.stringify(notification.data),
      categoryId: 'timelog.end_confirm',
      channelId: 'prompts',
      tag: 'end-2026-10-14',
    });
    expect(body.message.android).toMatchObject({ priority: 'HIGH', ttl: '86400s' });
    // Keine notification-Nachricht: sonst zeigt Android sie ohne Aktionen an
    expect(body.message).not.toHaveProperty('notification');
  });

  it('erkennt UNREGISTERED (404) als ungültiges Token, andere Fehler nicht', async () => {
    const responses = [
      json(404, {
        error: {
          code: 404,
          status: 'NOT_FOUND',
          details: [
            {
              '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
              errorCode: 'UNREGISTERED',
            },
          ],
        },
      }),
      json(400, {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          details: [{ errorCode: 'UNREGISTERED' }],
        },
      }),
      json(503, { error: { code: 503, status: 'UNAVAILABLE' } }),
      json(401, { error: { code: 401, status: 'UNAUTHENTICATED' } }),
    ];
    let tokens = 0;
    const { fn } = fakeFetch((url) => {
      if (url.includes('oauth2')) {
        tokens += 1;
        return json(200, { access_token: `t${String(tokens)}`, expires_in: 3600 });
      }
      return responses.shift() ?? json(200, {});
    });
    const fcm = new FcmSender(parseServiceAccount(account), fn);
    expect(await fcm.send('android', 'a', notification)).toBe('invalid_token');
    expect(await fcm.send('android', 'b', notification)).toBe('invalid_token');
    expect(await fcm.send('android', 'c', notification)).toBe('failed');
    expect(await fcm.send('android', 'd', notification)).toBe('failed');
    // Nach 401 wird ein neues Zugriffstoken geholt
    expect(await fcm.send('android', 'e', notification)).toBe('sent');
    expect(tokens).toBe(2);
  });

  it('Token-Abruf fehlgeschlagen → failed; unvollständiges Dienstkonto wird abgelehnt', async () => {
    const { fn } = fakeFetch(() => json(400, { error: 'invalid_grant' }));
    const fcm = new FcmSender(parseServiceAccount(account), fn);
    expect(await fcm.send('android', 'a', notification)).toBe('failed');
    expect(() => parseServiceAccount('{"project_id":"x"}')).toThrow(/unvollständig/);
  });
});

describe('APNs', () => {
  const token = 'a'.repeat(64);
  const cfg = {
    key: ecPem,
    keyId: 'ABC123DEFG',
    teamId: 'DEF123GHIJ',
    bundleId: 'de.timelog.mobile',
    production: true,
  };

  it('signiert ES256 mit Key-ID und Team-ID und setzt die Header laut Apple', async () => {
    const requests: ApnsRequest[] = [];
    let now = Date.parse('2026-10-20T10:00:00Z');
    const apns = new ApnsSender(
      cfg,
      (req) => {
        requests.push(req);
        return Promise.resolve({ status: 200, body: '' });
      },
      () => now,
    );
    expect(await apns.send('ios', token, notification)).toBe('sent');
    now += 30 * 60_000;
    expect(await apns.send('ios', token, { ...notification, urgent: false })).toBe('sent');
    now += 15 * 60_000;
    expect(await apns.send('ios', token, notification)).toBe('sent');

    const [first, second, third] = requests;
    expect(first?.origin).toBe('https://api.push.apple.com:443');
    expect(first?.path).toBe(`/3/device/${token}`);
    expect(first?.headers).toMatchObject({
      'apns-push-type': 'alert',
      'apns-topic': 'de.timelog.mobile',
      'apns-priority': '10',
      'apns-collapse-id': 'end-2026-10-14',
    });
    expect(second?.headers['apns-priority']).toBe('5');
    const jwt = (first?.headers.authorization ?? '').replace('bearer ', '');
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    await jwtVerify(jwt, await importSPKI(ecPublic, 'ES256'));
    expect(decodeJwt(jwt).iss).toBe('DEF123GHIJ');
    // Token wird 30 min wiederverwendet, nach 45 min erneuert (Apple: 20–60 min)
    expect(second?.headers.authorization).toBe(first?.headers.authorization);
    expect(third?.headers.authorization).not.toBe(first?.headers.authorization);

    const payload = JSON.parse(first?.body ?? '{}') as Record<string, unknown>;
    expect(payload).toEqual({
      aps: {
        alert: { title: notification.title, body: notification.body },
        category: 'timelog.end_confirm',
        'thread-id': 'timelog',
      },
      body: notification.data,
    });
  });

  it('410 → Token löschen; BadDeviceToken nur Hinweis; Sandbox-Server', async () => {
    const warnings: string[] = [];
    const answers = [
      { status: 410, body: '{"reason":"Unregistered","timestamp":1792526400000}' },
      { status: 400, body: '{"reason":"BadDeviceToken"}' },
      { status: 403, body: '{"reason":"ExpiredProviderToken"}' },
      { status: 500, body: 'kaputt' },
    ];
    const origins: string[] = [];
    const apns = new ApnsSender(
      { ...cfg, production: false },
      (req) => {
        origins.push(req.origin);
        return Promise.resolve(answers.shift() ?? { status: 200, body: '' });
      },
      Date.now,
      (m) => warnings.push(m),
    );
    expect(await apns.send('ios', token, notification)).toBe('invalid_token');
    expect(await apns.send('ios', token, notification)).toBe('failed');
    expect(await apns.send('ios', token, notification)).toBe('failed');
    expect(await apns.send('ios', token, notification)).toBe('failed');
    expect(origins[0]).toBe('https://api.sandbox.push.apple.com:443');
    expect(warnings).toEqual([expect.stringContaining('BadDeviceToken')]);
    // Kein Hex-Token (z. B. FCM-Token auf einem iPhone-Eintrag) → ungültig, ohne Anfrage
    expect(await apns.send('ios', 'kein-token', notification)).toBe('invalid_token');
    const failing = new ApnsSender(cfg, () => Promise.reject(new Error('offline')));
    expect(await failing.send('ios', token, notification)).toBe('failed');
  });

  it('HTTP/2-Transport spricht einen echten HTTP/2-Server an', async () => {
    const server = createServer();
    const seen: Record<string, unknown>[] = [];
    server.on('stream', (stream, headers) => {
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', (c: string) => (body += c));
      stream.on('end', () => {
        seen.push({ ...headers, body });
        stream.respond({ ':status': 410, 'content-type': 'application/json' });
        stream.end('{"reason":"Unregistered"}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const transport = http2Transport();
    try {
      const res = await transport({
        origin: `http://127.0.0.1:${String(port)}`,
        path: '/3/device/abc',
        headers: { 'apns-topic': 'de.timelog.mobile' },
        body: '{"aps":{}}',
      });
      expect(res).toEqual({ status: 410, body: '{"reason":"Unregistered"}' });
      expect(seen[0]).toMatchObject({
        ':method': 'POST',
        ':path': '/3/device/abc',
        'apns-topic': 'de.timelog.mobile',
        body: '{"aps":{}}',
      });
    } finally {
      transport.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('Konfiguration', () => {
  it('ohne Angaben ist Push aus (Hinweis ohne personenbezogene Daten)', () => {
    const log: string[] = [];
    const { sender } = createPushSender({}, (m) => log.push(m));
    expect([...sender.platforms]).toEqual([]);
    expect(log).toEqual([
      'push: nicht konfiguriert – Rückfragen nur in den Apps, kein Push-Versand',
    ]);
  });

  it('liest Dienstkonto und .p8-Schlüssel aus Dateien', () => {
    const log: string[] = [];
    const files: Record<string, string> = { '/run/fcm.json': account, '/run/apns.p8': ecPem };
    const setup = createPushSender(
      {
        FCM_SERVICE_ACCOUNT_FILE: '/run/fcm.json',
        APNS_KEY_FILE: '/run/apns.p8',
        APNS_KEY_ID: 'ABC123DEFG',
        APNS_TEAM_ID: 'DEF123GHIJ',
        APNS_BUNDLE_ID: 'de.timelog.mobile',
        APNS_ENV: 'sandbox',
      },
      (m) => log.push(m),
      (p) => files[p] ?? '',
    );
    expect([...setup.sender.platforms].sort()).toEqual(['android', 'ios']);
    expect(log).toEqual(['push: aktiv für android, ios']);
    setup.close();
    const partial: string[] = [];
    createPushSender({ APNS_KEY: ecPem }, (m) => partial.push(m));
    expect(partial[0]).toMatch(/APNs unvollständig/);
  });

  it('Plattform aus dem Gerätesystem', () => {
    expect(pushPlatform('android')).toBe('android');
    expect(pushPlatform('iOS 27.1')).toBe('ios');
    expect(pushPlatform('windows')).toBeUndefined();
  });
});
