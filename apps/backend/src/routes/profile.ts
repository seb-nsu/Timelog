// Einstellungen, Arbeitsnetze, Sollzeiten, Abwesenheiten und Feiertage.
import { GERMAN_STATES, type GermanState, holidaysOf } from '@timelog/rules';
import {
  absencesQuery,
  absencesResponse,
  absencesUpdate,
  holidaysQuery,
  holidaysResponse,
  networksResponse,
  networksUpdate,
  okResponse,
  settingsResponse,
  settingsSchema,
  settingsUpdate,
  targetHoursResponse,
  targetHoursUpdate,
} from '@timelog/shared';
import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import type { z } from 'zod';
import { type App, type AppContext, HttpError } from '../app.js';
import { type Tx, withUser } from '../db/index.js';
import { absences, organizations, targetHours, users, workNetworks } from '../db/schema.js';
import { authOf, scopeOf } from './guard.js';

const security = [{ bearer: [] }];

const asState = (s: string): GermanState =>
  (GERMAN_STATES as readonly string[]).includes(s) ? (s as GermanState) : 'BE';

/**
 * HMAC-Schlüssel je Nutzer bzw. Organisation. Netzwerk-Kennungen werden nur als HMAC gespeichert;
 * ein einfacher Hash einer MAC-Adresse wäre per Durchprobieren umkehrbar.
 */
export function networkKey(secret: string, scope: string): Buffer {
  return createHmac('sha256', secret).update(scope).digest();
}

export function networkHmac(key: Buffer, value: string): string {
  return createHmac('sha256', key)
    .update(value.trim().toLowerCase().replaceAll('-', ':'))
    .digest('hex');
}

async function loadUser(tx: Tx, userId: string) {
  const [user] = await tx.select().from(users).where(eq(users.id, userId));
  if (!user) throw new HttpError(401, 'unauthorized');
  return user;
}

async function keysFor(ctx: AppContext, tx: Tx, user: typeof users.$inferSelect) {
  const userKey = networkKey(ctx.networkSecret, `user:${user.id}`);
  let orgKey: Buffer | undefined;
  if (user.orgId) {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, user.orgId));
    if (org) orgKey = networkKey(ctx.networkSecret, `org:${org.id}:${org.fingerprintSalt}`);
  }
  return { userKey, orgKey };
}

export function profileRoutes(app: App, ctx: AppContext): void {
  // ── Einstellungen ───────────────────────────────────────────────────────────
  const toSettings = (user: typeof users.$inferSelect): z.infer<typeof settingsResponse> => ({
    name: user.name,
    email: user.email,
    timezone: user.timezone,
    state: asState(user.state),
    settings: settingsSchema.parse(user.settings),
  });

  app.get(
    '/settings',
    { schema: { tags: ['settings'], security, response: { 200: settingsResponse } } },
    async (request) => {
      const claims = authOf(request);
      return withUser(ctx.db, scopeOf(claims), async (tx) =>
        toSettings(await loadUser(tx, claims.sub)),
      );
    },
  );

  app.put(
    '/settings',
    {
      schema: {
        tags: ['settings'],
        security,
        body: settingsUpdate,
        response: { 200: settingsResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const { name, timezone, state, settings } = request.body;
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const [user] = await tx
          .update(users)
          .set({
            ...(name !== undefined ? { name } : {}),
            ...(timezone !== undefined ? { timezone } : {}),
            ...(state !== undefined ? { state } : {}),
            ...(settings !== undefined ? { settings } : {}),
          })
          .where(eq(users.id, claims.sub))
          .returning();
        if (!user) throw new HttpError(401, 'unauthorized');
        return toSettings(user);
      });
    },
  );

  // ── Arbeitsnetze ────────────────────────────────────────────────────────────
  app.get(
    '/networks',
    { schema: { tags: ['networks'], security, response: { 200: networksResponse } } },
    async (request) => {
      const claims = authOf(request);
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const user = await loadUser(tx, claims.sub);
        const { userKey, orgKey } = await keysFor(ctx, tx, user);
        const rows = await tx
          .select()
          .from(workNetworks)
          .where(
            user.orgId
              ? or(eq(workNetworks.userId, user.id), eq(workNetworks.orgId, user.orgId))
              : eq(workNetworks.userId, user.id),
          );
        return {
          networks: rows.map((r) => {
            const n: z.infer<typeof networksResponse>['networks'][number] = {
              id: r.id,
              scope: r.orgId ? 'org' : 'user',
              kind: r.kind,
              label: r.label,
            };
            if (r.ssid) n.ssid = r.ssid;
            if (r.bssidHmac) n.bssidHmac = r.bssidHmac;
            if (r.fingerprintHmac) n.fingerprintHmac = r.fingerprintHmac;
            if (r.lat !== null) n.lat = r.lat;
            if (r.lng !== null) n.lng = r.lng;
            if (r.radius !== null) n.radius = r.radius;
            return n;
          }),
          keys: {
            user: userKey.toString('base64'),
            ...(orgKey ? { org: orgKey.toString('base64') } : {}),
          },
        };
      });
    },
  );

  app.put(
    '/networks',
    {
      schema: {
        tags: ['networks'],
        security,
        description:
          'Ersetzt die eigenen Arbeitsnetze. BSSID und Netzwerk-Kennung werden nur als HMAC gespeichert.',
        body: networksUpdate,
        response: { 200: okResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      await withUser(ctx.db, scopeOf(claims), async (tx) => {
        const user = await loadUser(tx, claims.sub);
        const { userKey } = await keysFor(ctx, tx, user);
        await tx
          .delete(workNetworks)
          .where(and(eq(workNetworks.userId, user.id), isNull(workNetworks.orgId)));
        if (request.body.networks.length === 0) return;
        await tx.insert(workNetworks).values(
          request.body.networks.map((n) => ({
            userId: user.id,
            label: n.label,
            kind: n.kind,
            ssid: n.kind === 'ssid' ? n.ssid : null,
            bssidHmac: n.kind === 'ssid' && n.bssid ? networkHmac(userKey, n.bssid) : null,
            fingerprintHmac: n.kind === 'fingerprint' ? networkHmac(userKey, n.fingerprint) : null,
            lat: n.kind === 'geofence' ? n.lat : null,
            lng: n.kind === 'geofence' ? n.lng : null,
            radius: n.kind === 'geofence' ? n.radius : null,
          })),
        );
      });
      return { ok: true as const };
    },
  );

  // ── Sollzeiten ──────────────────────────────────────────────────────────────
  app.get(
    '/target-hours',
    { schema: { tags: ['target-hours'], security, response: { 200: targetHoursResponse } } },
    async (request) => {
      const claims = authOf(request);
      const rows = await withUser(ctx.db, scopeOf(claims), (tx) =>
        tx.select().from(targetHours).orderBy(targetHours.validFrom, targetHours.weekday),
      );
      const byDate = new Map<string, z.infer<typeof targetHoursResponse>['schedule'][number]>();
      for (const r of rows) {
        let e = byDate.get(r.validFrom);
        if (!e) {
          e = { validFrom: r.validFrom, minutesByWeekday: [0, 0, 0, 0, 0, 0, 0] };
          byDate.set(r.validFrom, e);
        }
        e.minutesByWeekday[r.weekday] = r.minutes;
      }
      return { schedule: [...byDate.values()] };
    },
  );

  app.put(
    '/target-hours',
    {
      schema: {
        tags: ['target-hours'],
        security,
        description:
          'Setzt die Sollzeiten je Wochentag (0 = Sonntag) ab einem Datum (Teilzeit-Wechsel).',
        body: targetHoursUpdate,
        response: { 200: okResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const { validFrom, minutesByWeekday } = request.body;
      await withUser(ctx.db, scopeOf(claims), async (tx) => {
        await tx
          .delete(targetHours)
          .where(and(eq(targetHours.userId, claims.sub), eq(targetHours.validFrom, validFrom)));
        await tx.insert(targetHours).values(
          minutesByWeekday.map((minutes, weekday) => ({
            userId: claims.sub,
            weekday,
            minutes,
            validFrom,
          })),
        );
      });
      return { ok: true as const };
    },
  );

  // ── Abwesenheiten ───────────────────────────────────────────────────────────
  app.get(
    '/absences',
    {
      schema: {
        tags: ['absences'],
        security,
        querystring: absencesQuery,
        response: { 200: absencesResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const rows = await withUser(ctx.db, scopeOf(claims), (tx) =>
        tx
          .select()
          .from(absences)
          .where(and(gte(absences.date, request.query.from), lte(absences.date, request.query.to)))
          .orderBy(absences.date),
      );
      return {
        absences: rows.map((a) => ({
          date: a.date,
          kind: a.kind,
          minutes: a.minutes,
          ...(a.note ? { note: a.note } : {}),
        })),
      };
    },
  );

  app.put(
    '/absences',
    {
      schema: {
        tags: ['absences'],
        security,
        description: 'Ersetzt alle Abwesenheiten im Zeitraum.',
        body: absencesUpdate,
        response: { 200: okResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const { from, to, absences: list } = request.body;
      await withUser(ctx.db, scopeOf(claims), async (tx) => {
        await tx
          .delete(absences)
          .where(
            and(eq(absences.userId, claims.sub), gte(absences.date, from), lte(absences.date, to)),
          );
        if (list.length > 0) {
          await tx
            .insert(absences)
            .values(list.map((a) => ({ userId: claims.sub, ...a, note: a.note ?? null })));
        }
      });
      return { ok: true as const };
    },
  );

  // ── Feiertage ───────────────────────────────────────────────────────────────
  app.get(
    '/holidays',
    {
      schema: {
        tags: ['absences'],
        security,
        description: 'Gesetzliche Feiertage im Bundesland des Nutzers.',
        querystring: holidaysQuery,
        response: { 200: holidaysResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const user = await withUser(ctx.db, scopeOf(claims), (tx) => loadUser(tx, claims.sub));
      const state = asState(user.state);
      return { state, holidays: holidaysOf(request.query.year, state) };
    },
  );
}
