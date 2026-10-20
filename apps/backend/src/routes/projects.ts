// Projekte und Tätigkeiten: eigene Projekte (Privatkonto), Zuordnung je Zeitabschnitt (nur Insert,
// mit corrections-Zeile), Auswertung je Projekt/Kunde/Zeitraum und Export.
import { type DayProjects, assignedPieces, projectTotals, workRanges } from '@timelog/rules';
import {
  MAX_PROJECTS,
  dateParams,
  dayProjectsResponse,
  projectAssignmentInput,
  projectExportQuery,
  projectInput,
  projectParams,
  projectReportQuery,
  projectReportResponse,
  projectSchema,
  projectUpdate,
  projectsResponse,
} from '@timelog/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { type App, type AppContext, HttpError } from '../app.js';
import { type Tx, withUser } from '../db/index.js';
import { corrections, projectAssignments, projects, users } from '../db/schema.js';
import { renderPdf } from '../export/pdf.js';
import { type ProjectRow, loadDayExtras, visibleProjects } from '../extras.js';
import { featuresOf } from '../features.js';
import { assertMonthOpen } from './corrections.js';
import { authOf, scopeOf } from './guard.js';
import { csvCell } from './privacy.js';

const tags = ['projects'];
const security = [{ bearer: [] }];
const DAY_MS = 86_400_000;

type UserRow = typeof users.$inferSelect;

export function toProject(p: ProjectRow): z.infer<typeof projectSchema> {
  return {
    id: p.id,
    scope: p.orgId ? 'org' : 'user',
    ...(p.teamId ? { teamId: p.teamId } : {}),
    name: p.name,
    ...(p.customer ? { customer: p.customer } : {}),
    color: p.color,
    keywords: p.keywords,
    archived: p.archivedAt !== null,
  };
}

async function loadUser(tx: Tx, userId: string): Promise<UserRow> {
  const [user] = await tx.select().from(users).where(eq(users.id, userId));
  if (!user) throw new HttpError(401, 'unauthorized');
  return user;
}

const minutes = (m: number): string =>
  `${String(Math.floor(m / 60))}:${String(m % 60).padStart(2, '0')}`;

/** Kurztext der Projektaufteilung eines Tages für den Arbeitszeit-Export. */
export function projectCell(p: DayProjects | undefined, names: Map<string, string>): string {
  if (!p) return '';
  return p.items
    .map(
      (i) =>
        `${i.projectId ? (names.get(i.projectId) ?? '?') : 'ohne Projekt'} ${minutes(i.netMinutes)}`,
    )
    .join(', ');
}

/** Auswertung: Tage, Summen je Projekt und je Kunde. */
export function buildReport(
  from: string,
  to: string,
  days: readonly DayProjects[],
  list: readonly ProjectRow[],
): z.infer<typeof projectReportResponse> {
  const byId = new Map(list.map((p) => [p.id, p]));
  const totals = projectTotals(days).map((t) => {
    const p = t.projectId ? byId.get(t.projectId) : undefined;
    return {
      ...t,
      ...(p ? { name: p.name } : {}),
      ...(p?.customer ? { customer: p.customer } : {}),
    };
  });
  const customers = new Map<string, number>();
  for (const t of totals)
    customers.set(t.customer ?? '', (customers.get(t.customer ?? '') ?? 0) + t.netMinutes);
  return {
    from,
    to,
    days: [...days],
    totals,
    customers: [...customers]
      .map(([customer, netMinutes]) => ({ ...(customer ? { customer } : {}), netMinutes }))
      .sort((a, b) => b.netMinutes - a.netMinutes),
  };
}

export const PROJECT_CSV_HEADER = [
  'Datum',
  'Projekt',
  'Kunde',
  'Arbeit (min)',
  'davon Auffüllung (min)',
  'Netto (min)',
];

export function projectExportRows(
  report: z.infer<typeof projectReportResponse>,
  list: readonly ProjectRow[],
): string[][] {
  const byId = new Map(list.map((p) => [p.id, p]));
  const rows: string[][] = [];
  for (const d of report.days) {
    for (const i of d.items) {
      const p = i.projectId ? byId.get(i.projectId) : undefined;
      rows.push([
        d.date,
        p?.name ?? (i.projectId ? '?' : 'ohne Projekt'),
        p?.customer ?? '',
        String(i.workMinutes),
        String(i.topUpMinutes),
        String(i.netMinutes),
      ]);
    }
  }
  for (const t of report.totals) {
    rows.push([
      'Summe',
      t.name ?? (t.projectId ? '?' : 'ohne Projekt'),
      t.customer ?? '',
      String(t.workMinutes),
      String(t.topUpMinutes),
      String(t.netMinutes),
    ]);
  }
  return rows;
}

export function projectRoutes(app: App, ctx: AppContext): void {
  app.get(
    '/projects',
    {
      schema: {
        tags,
        security,
        description:
          'Sichtbare Projekte: eigene (Privatkonto) und die der Organisation (Teamprojekte nur fürs eigene Team).',
        response: { 200: projectsResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const user = await loadUser(tx, claims.sub);
        const features = await featuresOf(tx, user);
        return {
          enabled: features.projects,
          canManage: user.orgId === null,
          projects: (await visibleProjects(tx, user)).map(toProject),
        };
      });
    },
  );

  app.post(
    '/projects',
    {
      schema: {
        tags,
        security,
        description:
          'Eigenes Projekt anlegen (nur Privatkonten; Firmenprojekte legt der Admin an).',
        body: projectInput,
        response: { 200: projectSchema },
      },
    },
    async (request) => {
      const claims = authOf(request);
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const user = await loadUser(tx, claims.sub);
        if (user.orgId) throw new HttpError(403, 'org_managed');
        const own = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.userId, user.id));
        if (own.length >= MAX_PROJECTS) throw new HttpError(409, 'too_many_projects');
        const b = request.body;
        const [row] = await tx
          .insert(projects)
          .values({
            userId: user.id,
            name: b.name,
            customer: b.customer ?? null,
            color: b.color,
            keywords: b.keywords,
          })
          .returning();
        if (!row) throw new HttpError(500, 'insert_failed');
        return toProject(row);
      });
    },
  );

  app.patch(
    '/projects/:id',
    {
      schema: {
        tags,
        security,
        description: 'Eigenes Projekt ändern oder archivieren (Projekte werden nie gelöscht).',
        params: projectParams,
        body: projectUpdate,
        response: { 200: projectSchema },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const b = request.body;
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const [row] = await tx
          .update(projects)
          .set({
            ...(b.name !== undefined ? { name: b.name } : {}),
            ...(b.customer !== undefined ? { customer: b.customer || null } : {}),
            ...(b.color !== undefined ? { color: b.color } : {}),
            ...(b.keywords !== undefined ? { keywords: b.keywords } : {}),
            ...(b.archived !== undefined
              ? { archivedAt: b.archived ? new Date(ctx.now()) : null }
              : {}),
          })
          .where(and(eq(projects.id, request.params.id), eq(projects.userId, claims.sub)))
          .returning();
        if (!row) throw new HttpError(404, 'not_found');
        return toProject(row);
      });
    },
  );

  // ── Zuordnung im Tagesprotokoll ─────────────────────────────────────────────
  async function dayView(
    tx: Tx,
    userId: string,
    date: string,
  ): Promise<z.infer<typeof dayProjectsResponse>> {
    const extras = await loadDayExtras(tx, userId, date, date, ctx.now());
    if (!extras.features.projects) throw new HttpError(403, 'projects_disabled');
    const day = extras.days.find((d) => d.date === date);
    const projectsOfDay = extras.projects.find((p) => p.date === date) ?? { date, items: [] };
    const rows = await tx
      .select()
      .from(projectAssignments)
      .where(and(eq(projectAssignments.userId, userId), eq(projectAssignments.date, date)))
      .orderBy(asc(projectAssignments.createdAt));
    const now = new Date(ctx.now()).toISOString();
    const segments = day
      ? mergePieces(assignedPieces(workRanges(day, now), extras.assignments))
      : [];
    return {
      day: projectsOfDay,
      segments,
      assignments: rows.map((r) => ({
        id: r.id,
        from: r.fromTs.toISOString(),
        to: r.toTs.toISOString(),
        projectId: r.projectId,
        createdAt: r.createdAt.toISOString(),
      })),
      locked: extras.approvedMonths.includes(date.slice(0, 7)),
    };
  }

  app.get(
    '/days/:date/projects',
    {
      schema: {
        tags,
        security,
        description:
          'Projektaufteilung eines Tages, Zeitabschnitte mit manueller Zuordnung und die eigenen Zuordnungen.',
        params: dateParams,
        response: { 200: dayProjectsResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      return withUser(ctx.db, scopeOf(claims), (tx) =>
        dayView(tx, claims.sub, request.params.date),
      );
    },
  );

  app.post(
    '/days/:date/projects',
    {
      schema: {
        tags,
        security,
        description:
          'Ordnet einen Zeitabschnitt einem Projekt zu (oder keinem: projectId null). Überschreibt die Automatik, ist unveränderlich und wird als Korrektur protokolliert.',
        params: dateParams,
        body: projectAssignmentInput,
        response: { 200: dayProjectsResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      const { date } = request.params;
      const b = request.body;
      return withUser(ctx.db, scopeOf(claims), async (tx) => {
        const user = await loadUser(tx, claims.sub);
        const features = await featuresOf(tx, user);
        if (!features.projects) throw new HttpError(403, 'projects_disabled');
        await assertMonthOpen(tx, claims.sub, date);
        const dayStart = Date.parse(`${date}T00:00:00Z`) - DAY_MS;
        const dayEnd = Date.parse(`${date}T00:00:00Z`) + 2 * DAY_MS;
        if (Date.parse(b.from) < dayStart || Date.parse(b.to) > dayEnd) {
          throw new HttpError(400, 'out_of_range');
        }
        if (b.projectId) {
          const ok = (await visibleProjects(tx, user)).some(
            (p) => p.id === b.projectId && p.archivedAt === null,
          );
          if (!ok) throw new HttpError(400, 'invalid_project');
        }
        const [row] = await tx
          .insert(projectAssignments)
          .values({
            userId: claims.sub,
            date,
            fromTs: new Date(b.from),
            toTs: new Date(b.to),
            projectId: b.projectId,
            authorId: claims.sub,
            createdAt: new Date(ctx.now()),
          })
          .returning({ id: projectAssignments.id });
        if (!row) throw new HttpError(500, 'insert_failed');
        await tx.insert(corrections).values({
          userId: claims.sub,
          date,
          eventId: row.id,
          field: 'project',
          oldValue: null,
          newValue: `${b.from}/${b.to}=${b.projectId ?? 'none'}`,
          reason: b.reason ?? null,
          authorId: claims.sub,
        });
        return dayView(tx, claims.sub, date);
      });
    },
  );

  // ── Auswertung und Export ───────────────────────────────────────────────────
  async function report(tx: Tx, userId: string, from: string, to: string) {
    const user = await loadUser(tx, userId);
    const extras = await loadDayExtras(tx, userId, from, to, ctx.now());
    if (!extras.features.projects) throw new HttpError(403, 'projects_disabled');
    const list = await visibleProjects(tx, user);
    return { report: buildReport(from, to, extras.projects, list), list, user };
  }

  app.get(
    '/projects/report',
    {
      schema: {
        tags,
        security,
        description:
          'Netto-Arbeitszeit je Projekt, Kunde und Tag im Zeitraum (höchstens 400 Tage).',
        querystring: projectReportQuery,
        response: { 200: projectReportResponse },
      },
    },
    async (request) => {
      const claims = authOf(request);
      return withUser(
        ctx.db,
        scopeOf(claims),
        async (tx) => (await report(tx, claims.sub, request.query.from, request.query.to)).report,
      );
    },
  );

  app.get(
    '/projects/export',
    {
      schema: {
        tags,
        security,
        description:
          'Projektzeiten je Tag und Projekt als CSV (Semikolon, UTF-8 mit BOM) oder PDF.',
        querystring: projectExportQuery,
      },
    },
    async (request, reply) => {
      const claims = authOf(request);
      const { from, to, format } = request.query;
      const {
        report: r,
        list,
        user,
      } = await withUser(ctx.db, scopeOf(claims), (tx) => report(tx, claims.sub, from, to));
      const rows = projectExportRows(r, list);
      const filename = `projekte_${from}_${to}`;
      if (format === 'pdf') {
        const pdf = renderPdf({
          title: `Projektzeiten ${from} bis ${to}`,
          subtitle: user.name,
          columns: [80, 220, 160, 90, 110, 90].map((width, i) => ({
            label: PROJECT_CSV_HEADER[i] ?? '',
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
        [PROJECT_CSV_HEADER, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n') +
        '\r\n';
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}.csv"`)
        .send(csv);
    },
  );
}

/** Benachbarte Stücke mit gleicher Zuordnung zusammenfassen (Anzeige im Tagesprotokoll). */
function mergePieces(
  pieces: ReturnType<typeof assignedPieces>,
): { from: string; to: string; projectId: string | null; manual: boolean }[] {
  const out: { a: number; b: number; projectId: string | null; manual: boolean }[] = [];
  for (const p of pieces) {
    const last = out.at(-1);
    if (last && last.b === p.r[0] && last.projectId === p.projectId && last.manual === p.manual) {
      last.b = p.r[1];
    } else {
      out.push({ a: p.r[0], b: p.r[1], projectId: p.projectId, manual: p.manual });
    }
  }
  return out.map((x) => ({
    from: new Date(x.a).toISOString(),
    to: new Date(x.b).toISOString(),
    projectId: x.projectId,
    manual: x.manual,
  }));
}
