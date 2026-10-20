// Export (CSV/PDF), Datenauskunft (Art. 15/20 DSGVO) und Kontolöschung (Art. 17) nach Plan.
import { type WorkDay, localDate, localTime } from '@timelog/rules';
import { deleteAccountRequest, deleteAccountResponse, exportQuery } from '@timelog/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type App, type AppContext, HttpError } from '../app.js';
import { type Tx, asOwner, withUser } from '../db/index.js';
import {
  absences,
  approvals,
  authTokens,
  corrections,
  devices,
  events,
  organizations,
  presenceSpans,
  refreshTokens,
  targetHours,
  users,
  workDays,
  workNetworks,
} from '../db/schema.js';
import { renderPdf } from '../export/pdf.js';
import { verifyPassword } from '../security/password.js';
import { loadDays } from './days.js';
import { toStoredEvent } from './events.js';
import { authOf, scopeOf } from './guard.js';

const security = [{ bearer: [] }];

const STATUS_DE: Record<WorkDay['status'], string> = {
  open: 'offen',
  unchecked: 'ungeprüft',
  auto: 'automatisch',
  confirmed: 'bestätigt',
};

export const CSV_HEADER = [
  'Personalnummer',
  'Datum',
  'Beginn',
  'Ende',
  'Pause (min)',
  'davon aufgefüllt (min)',
  'Netto (min)',
  'Abwesenheit (min)',
  'Status',
  'korrigiert',
  'Warnungen',
];

export function exportRows(days: WorkDay[], tz: string, personnelNumber: string): string[][] {
  const time = (iso: string | undefined, date: string) => {
    if (!iso) return '';
    const ms = Date.parse(iso);
    return localDate(ms, tz) === date ? localTime(ms, tz) : '24:00';
  };
  return days.map((d) => [
    personnelNumber,
    d.date,
    time(d.start, d.date),
    time(d.end, d.date),
    String(d.breakMinutes + d.breakTopUpMin),
    String(d.breakTopUpMin),
    String(d.netMinutes),
    String(d.absenceMinutes),
    STATUS_DE[d.status],
    d.corrected ? 'ja' : 'nein',
    d.warnings.join(' '),
  ]);
}

export function csvCell(v: string): string {
  return /[";\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** Löscht alle Daten eines Nutzers (Reihenfolge wegen Fremdschlüsseln). */
export async function deleteUserData(tx: Tx, userId: string, includeUser: boolean): Promise<void> {
  for (const table of [
    refreshTokens,
    authTokens,
    events,
    presenceSpans,
    workDays,
    corrections,
    approvals,
    absences,
    targetHours,
  ]) {
    await tx.delete(table).where(eq(table.userId, userId));
  }
  await tx.delete(workNetworks).where(eq(workNetworks.userId, userId));
  if (includeUser) {
    await tx.delete(devices).where(eq(devices.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  }
}

export function privacyRoutes(app: App, ctx: AppContext): void {
  app.get(
    '/export',
    {
      schema: {
        tags: ['export'],
        security,
        description:
          'Export als CSV (DATEV-tauglich vorbereitet, Semikolon, UTF-8 mit BOM) oder PDF. Pause = erkannte Pausen + Auffüllung.',
        querystring: exportQuery,
      },
    },
    async (request, reply) => {
      const claims = authOf(request);
      const { from, to, format } = request.query;
      const { days, timezone, user } = await withUser(ctx.db, scopeOf(claims), async (tx) => {
        const [u] = await tx.select().from(users).where(eq(users.id, claims.sub));
        if (!u) throw new HttpError(401, 'unauthorized');
        return { ...(await loadDays(tx, claims.sub, from, to, ctx.now())), user: u };
      });
      const settings = z
        .object({ personnelNumber: z.string().optional() })
        .safeParse(user.settings);
      const personnelNumber = (settings.success ? settings.data.personnelNumber : undefined) ?? '';
      const rows = exportRows(days, timezone, personnelNumber);
      const filename = `arbeitszeit_${from}_${to}`;
      if (format === 'pdf') {
        const pdf = renderPdf({
          title: `Arbeitszeit ${from} bis ${to}`,
          subtitle: `${user.name}${personnelNumber ? ` · ${personnelNumber}` : ''} · Zeitzone ${timezone}`,
          columns: [70, 65, 45, 45, 55, 75, 55, 70, 70, 55, 165].map((width, i) => ({
            label: CSV_HEADER[i] ?? '',
            width,
          })),
          rows,
        });
        return reply
          .header('content-type', 'application/pdf')
          .header('content-disposition', `attachment; filename="${filename}.pdf"`)
          .send(pdf);
      }
      const csv =
        '﻿' + [CSV_HEADER, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}.csv"`)
        .send(csv);
    },
  );

  app.get(
    '/me/export',
    {
      schema: {
        tags: ['privacy'],
        security,
        description:
          'Datenauskunft und Datenübertragbarkeit (Art. 15/20 DSGVO): alle eigenen Daten als JSON.',
      },
    },
    async (request, reply) => {
      const claims = authOf(request);
      const data = await withUser(ctx.db, scopeOf(claims), async (tx) => {
        const [u] = await tx.select().from(users).where(eq(users.id, claims.sub));
        if (!u) throw new HttpError(401, 'unauthorized');
        return {
          exportedAt: new Date(ctx.now()).toISOString(),
          user: {
            id: u.id,
            email: u.email,
            name: u.name,
            timezone: u.timezone,
            state: u.state,
            role: u.role,
            createdAt: u.createdAt.toISOString(),
            emailVerifiedAt: u.emailVerifiedAt?.toISOString() ?? null,
            totpEnabled: u.totpSecret !== null,
            settings: u.settings,
          },
          devices: (await tx.select().from(devices)).map((d) => ({
            id: d.id,
            kind: d.kind,
            os: d.os,
            name: d.name,
            lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
            revokedAt: d.revokedAt?.toISOString() ?? null,
          })),
          events: (await tx.select().from(events).orderBy(events.seq)).map(toStoredEvent),
          presenceSpans: (await tx.select().from(presenceSpans)).map((s) => ({
            id: s.id,
            deviceId: s.deviceId,
            start: s.start.toISOString(),
            end: s.end.toISOString(),
            open: s.open,
          })),
          absences: await tx.select().from(absences),
          targetHours: await tx.select().from(targetHours),
          workNetworks: await tx
            .select()
            .from(workNetworks)
            .where(eq(workNetworks.userId, claims.sub)),
          corrections: await tx.select().from(corrections),
          approvals: await tx.select().from(approvals),
        };
      });
      return reply
        .header('content-disposition', 'attachment; filename="timelog-datenauskunft.json"')
        .send(data);
    },
  );

  app.delete(
    '/me',
    {
      schema: {
        tags: ['privacy'],
        security,
        description:
          'Kontolöschung (Art. 17 DSGVO). Privatkonto: sofort alles gelöscht. Firmenkonto: sofort anonymisiert, Löschung nach Aufbewahrungsfrist durch den nächtlichen Job.',
        body: deleteAccountRequest,
        response: { 200: deleteAccountResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const user = await withUser(ctx.db, scopeOf(claims), async (tx) => {
        const [u] = await tx.select().from(users).where(eq(users.id, claims.sub));
        return u;
      });
      if (!user || !(await verifyPassword(user.passwordHash, request.body.password))) {
        throw new HttpError(403, 'invalid_password');
      }
      return asOwner(ctx.db, async (tx) => {
        const [org] = user.orgId
          ? await tx.select().from(organizations).where(eq(organizations.id, user.orgId))
          : [];
        if (org?.plan !== 'company') {
          await deleteUserData(tx, user.id, true);
          return { mode: 'deleted' as const };
        }
        const now = new Date(ctx.now());
        await tx
          .update(users)
          .set({
            email: `geloescht-${user.id}@invalid`,
            name: 'Gelöschtes Konto',
            passwordHash: '!',
            totpSecret: null,
            totpPendingSecret: null,
            settings: {},
            deletedAt: now,
          })
          .where(eq(users.id, user.id));
        await tx
          .update(devices)
          .set({ revokedAt: now, pushToken: null, name: '–' })
          .where(eq(devices.userId, user.id));
        await tx.delete(refreshTokens).where(eq(refreshTokens.userId, user.id));
        await tx.delete(authTokens).where(eq(authTokens.userId, user.id));
        await tx.delete(workNetworks).where(eq(workNetworks.userId, user.id));
        return { mode: 'anonymized' as const };
      });
    },
  );
}
