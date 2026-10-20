// Tagesort und Homeoffice-Nachweis: Jahresübersicht, manuelle Korrektur je Tag (nur Insert), Export.
import { type HomeOfficeAllowance, homeOfficeSummary } from '@timelog/rules';
import {
  dateParams,
  dayLocationSchema,
  locationUpdate,
  locationsExportQuery,
  locationsQuery,
  locationsResponse,
} from '@timelog/shared';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { type App, type AppContext, HttpError } from '../app.js';
import { type Tx, withUser } from '../db/index.js';
import { dayLocations, users } from '../db/schema.js';
import { renderPdf } from '../export/pdf.js';
import { loadDayExtras } from '../extras.js';
import { assertMonthOpen } from './corrections.js';
import { authOf, scopeOf } from './guard.js';
import { csvCell } from './privacy.js';

const tags = ['locations'];
const security = [{ bearer: [] }];

/** Rechtsgrundlage der Tagespauschale (Stand der Prüfung: docs/PROJEKTE_KALENDER.md). */
export const LEGAL_BASIS = '§ 4 Abs. 5 Satz 1 Nr. 6c EStG (Tagespauschale)';

export const LOCATION_DE = { office: 'Büro', home: 'Homeoffice', other: 'unterwegs/unbekannt' };

/** Tagesorte eines Kalenderjahres samt Übersicht. */
export async function yearLocations(
  tx: Tx,
  userId: string,
  year: number,
  nowMs: number,
  allowance: HomeOfficeAllowance,
): Promise<z.infer<typeof locationsResponse>> {
  const extras = await loadDayExtras(
    tx,
    userId,
    `${String(year)}-01-01`,
    `${String(year)}-12-31`,
    nowMs,
  );
  return {
    year,
    days: extras.locations,
    summary: homeOfficeSummary(extras.locations, allowance),
    allowance: { ...allowance, legalBasis: LEGAL_BASIS },
  };
}

/** Betrag als „1.260,00 EUR“ (ohne €-Zeichen, das die PDF-Schrift WinAnsi hier nicht abbildet). */
export const euro = (cents: number): string =>
  `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)} EUR`;

export const LOCATION_CSV_HEADER = ['Datum', 'Ort', 'Quelle', 'Büro (min)', 'Homeoffice (min)'];

export function locationRows(data: z.infer<typeof locationsResponse>): string[][] {
  const rows = data.days
    .filter((d) => d.location !== undefined)
    .map((d) => [
      d.date,
      d.location ? LOCATION_DE[d.location] : '',
      d.source === 'manual' ? 'manuell' : 'automatisch',
      String(d.officeMinutes),
      String(d.homeMinutes),
    ]);
  const s = data.summary;
  rows.push(
    [],
    ['Homeoffice-Tage', String(s.homeDays)],
    ['Bürotage', String(s.officeDays)],
    ['unterwegs/unbekannt', String(s.otherDays)],
    [
      'Tagespauschale',
      `${euro(data.allowance.perDayCents)} je Tag, höchstens ${euro(data.allowance.maxPerYearCents)} (${data.allowance.legalBasis})`,
    ],
    ['rechnerisch', euro(s.amountCents)],
    [
      'Hinweis',
      'Nachweis aus der Zeiterfassung, keine Steuerberatung. Werte vor der Abgabe prüfen.',
    ],
  );
  return rows;
}

export function locationRoutes(app: App, ctx: AppContext): void {
  app.get(
    '/locations',
    {
      schema: {
        tags,
        security,
        description:
          'Tagesorte (Büro, Homeoffice, unterwegs/unbekannt) eines Jahres mit Anzahl Homeoffice-Tagen und Hinweis auf die Tagespauschale.',
        querystring: locationsQuery,
        response: { 200: locationsResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      return withUser(ctx.db, scopeOf(claims), (tx) =>
        yearLocations(tx, claims.sub, request.query.year, ctx.now(), ctx.homeOffice),
      );
    },
  );

  app.put(
    '/days/:date/location',
    {
      schema: {
        tags,
        security,
        description:
          'Manueller Tagesort (überschreibt die Automatik, gesperrt); null = wieder automatisch. Nur Insert.',
        params: dateParams,
        body: locationUpdate,
        response: { 200: dayLocationSchema },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const { date } = request.params;
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const [user] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, claims.sub));
        if (!user) throw new HttpError(401, 'unauthorized');
        await assertMonthOpen(tx, claims.sub, date);
        await tx.insert(dayLocations).values({
          userId: claims.sub,
          date,
          location: request.body.location,
          authorId: claims.sub,
          createdAt: new Date(ctx.now()),
        });
        const extras = await loadDayExtras(tx, claims.sub, date, date, ctx.now());
        return (
          extras.locations.find((l) => l.date === date) ?? {
            date,
            source: 'auto' as const,
            officeMinutes: 0,
            homeMinutes: 0,
          }
        );
      });
    },
  );

  app.get(
    '/locations/export',
    {
      schema: {
        tags,
        security,
        description: 'Homeoffice-Nachweis eines Jahres als CSV oder PDF (für die Steuererklärung).',
        querystring: locationsExportQuery,
      },
    },
    async (request, reply) => {
      const claims = authOf(request);
      const { year, format } = request.query;
      const { data, name } = await withUser(ctx.db, scopeOf(claims), async (tx) => {
        const [u] = await tx
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, claims.sub));
        return {
          data: await yearLocations(tx, claims.sub, year, ctx.now(), ctx.homeOffice),
          name: u?.name ?? '',
        };
      });
      const rows = locationRows(data);
      const filename = `homeoffice_${String(year)}`;
      if (format === 'pdf') {
        const pdf = renderPdf({
          title: `Nachweis Arbeitsort ${String(year)}`,
          subtitle: name,
          columns: [110, 330, 110, 100, 120].map((width, i) => ({
            label: LOCATION_CSV_HEADER[i] ?? '',
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
        '﻿' +
        [LOCATION_CSV_HEADER, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') +
        '\r\n';
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}.csv"`)
        .send(csv);
    },
  );
}
