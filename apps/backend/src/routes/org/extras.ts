// Firmenversion: Schalter (Projekte, Kalender, Homeoffice-Monatszahlen), Firmenprojekte (auch je
// Team), Netz-Ort/Standardprojekt, Projektauswertung und Homeoffice-Tage je Monat.
//
// Datenschutz: Admins sehen Projektzeiten nur als Summen über die Organisation bzw. ein Team, nie je
// Person und Tag. Beim Homeoffice sehen sie nur die Anzahl Tage je Monat und Person (z. B. für eine
// Bescheinigung) – keine Tagesdetails oder Orte –, und nur, wenn die Organisation das eingeschaltet hat.
// Kalenderdaten sieht niemand außer der Person selbst (RLS).
import { type ProjectShare, homeOfficeSummary } from '@timelog/rules';
import {
  networkParams,
  networkResponse,
  networkUpdate,
  orgFeatures,
  orgFeaturesUpdate,
  orgHomeOfficeQuery,
  orgHomeOfficeResponse,
  orgProjectInput,
  orgProjectUpdate,
  projectParams,
  projectReportQuery,
  projectReportResponse,
  projectSchema,
  projectsResponse,
} from '@timelog/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { type App, type AppContext, HttpError } from '../../app.js';
import { type Tx, withMember, withUser } from '../../db/index.js';
import { organizations, projects, teams, workNetworks } from '../../db/schema.js';
import { loadDayExtras } from '../../extras.js';
import { parseFeatures } from '../../features.js';
import { toNetworkResponse } from '../profile.js';
import { buildReport, toProject } from '../projects.js';
import { ADMINS, actorOf, actorScope, audit } from './access.js';
import { visibleMembers } from './manage.js';

const tags = ['org'];
const security = [{ bearer: [] }];

/** Standardprojekt eines Firmen-Netzes muss ein aktives Firmenprojekt sein. */
export async function assertOrgProject(
  tx: Tx,
  orgId: string,
  projectId: string | null | undefined,
): Promise<void> {
  if (!projectId) return;
  const [p] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.archivedAt)));
  if (!p) throw new HttpError(400, 'invalid_project');
}

async function assertTeam(tx: Tx, orgId: string, teamId: string | null | undefined) {
  if (!teamId) return;
  const [t] = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.orgId, orgId)));
  if (!t) throw new HttpError(400, 'invalid_team');
}

export function orgExtrasRoutes(app: App, ctx: AppContext): void {
  // ── Schalter ────────────────────────────────────────────────────────────────
  app.get(
    '/features',
    {
      config: { roles: ADMINS },
      schema: { tags, security, response: { 200: orgFeatures } },
    },
    async (request) => {
      const actor = actorOf(request);
      return withUser(ctx.db, actorScope(actor), async (tx) => {
        const [org] = await tx
          .select({ features: organizations.features })
          .from(organizations)
          .where(eq(organizations.id, actor.orgId));
        return parseFeatures(org?.features);
      });
    },
  );

  app.put(
    '/features',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description:
          'Projekte für alle Mitglieder einschalten, Kalender-Anbindung erlauben, Homeoffice-Monatszahlen für Admins.',
        body: orgFeaturesUpdate,
        response: { 200: orgFeatures },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      return withUser(ctx.db, actorScope(actor), async (tx) => {
        const [org] = await tx
          .select({ features: organizations.features })
          .from(organizations)
          .where(eq(organizations.id, actor.orgId));
        const next = { ...parseFeatures(org?.features), ...request.body };
        await tx
          .update(organizations)
          .set({ features: next })
          .where(eq(organizations.id, actor.orgId));
        await audit(tx, actor, 'features.update', actor.orgId, request.body);
        return next;
      });
    },
  );

  // ── Firmenprojekte ──────────────────────────────────────────────────────────
  app.get(
    '/projects',
    {
      config: { roles: ADMINS },
      schema: { tags, security, response: { 200: projectsResponse } },
    },
    async (request) => {
      const actor = actorOf(request);
      return withUser(ctx.db, actorScope(actor), async (tx) => {
        const [org] = await tx
          .select({ features: organizations.features })
          .from(organizations)
          .where(eq(organizations.id, actor.orgId));
        const rows = await tx
          .select()
          .from(projects)
          .where(eq(projects.orgId, actor.orgId))
          .orderBy(asc(projects.name));
        return {
          enabled: parseFeatures(org?.features).projects,
          canManage: true,
          projects: rows.map(toProject),
        };
      });
    },
  );

  app.post(
    '/projects',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description: 'Firmenprojekt anlegen; mit teamId nur für dieses Team sichtbar.',
        body: orgProjectInput,
        response: { 200: projectSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const b = request.body;
      return withUser(ctx.db, actorScope(actor), async (tx) => {
        await assertTeam(tx, actor.orgId, b.teamId);
        const [row] = await tx
          .insert(projects)
          .values({
            orgId: actor.orgId,
            teamId: b.teamId ?? null,
            name: b.name,
            customer: b.customer ?? null,
            color: b.color,
            keywords: b.keywords,
          })
          .returning();
        if (!row) throw new HttpError(500, 'insert_failed');
        await audit(tx, actor, 'project.create', row.id, { name: b.name });
        return toProject(row);
      });
    },
  );

  app.patch(
    '/projects/:id',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        params: projectParams,
        body: orgProjectUpdate,
        response: { 200: projectSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const b = request.body;
      return withUser(ctx.db, actorScope(actor), async (tx) => {
        await assertTeam(tx, actor.orgId, b.teamId);
        const [row] = await tx
          .update(projects)
          .set({
            ...(b.name !== undefined ? { name: b.name } : {}),
            ...(b.customer !== undefined ? { customer: b.customer || null } : {}),
            ...(b.color !== undefined ? { color: b.color } : {}),
            ...(b.keywords !== undefined ? { keywords: b.keywords } : {}),
            ...(b.teamId !== undefined ? { teamId: b.teamId } : {}),
            ...(b.archived !== undefined
              ? { archivedAt: b.archived ? new Date(ctx.now()) : null }
              : {}),
          })
          .where(and(eq(projects.id, request.params.id), eq(projects.orgId, actor.orgId)))
          .returning();
        if (!row) throw new HttpError(404, 'not_found');
        await audit(tx, actor, 'project.update', row.id, {
          ...(b.archived !== undefined ? { archived: b.archived } : {}),
          ...(b.name !== undefined ? { name: b.name } : {}),
        });
        return toProject(row);
      });
    },
  );

  app.get(
    '/projects/report',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description:
          'Netto-Arbeitszeit je Firmenprojekt und Kunde, summiert über alle (bzw. die Mitglieder eines Teams) – nie je Person.',
        querystring: projectReportQuery.and(z.object({ teamId: z.uuid().optional() })),
        response: { 200: projectReportResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { from, to, teamId } = request.query;
      const { members, list } = await withUser(ctx.db, actorScope(actor), async (tx) => ({
        members: await visibleMembers(tx, actor, teamId),
        list: await tx.select().from(projects).where(eq(projects.orgId, actor.orgId)),
      }));
      const byDate = new Map<string, Map<string | null, ProjectShare>>();
      for (const m of members) {
        const extras = await withMember(ctx.db, actorScope(actor), m.id, (tx) =>
          loadDayExtras(tx, m.id, from, to, ctx.now()),
        );
        for (const d of extras.projects) {
          const acc = byDate.get(d.date) ?? new Map<string | null, ProjectShare>();
          for (const i of d.items) {
            const a = acc.get(i.projectId) ?? {
              ...i,
              workMinutes: 0,
              topUpMinutes: 0,
              netMinutes: 0,
              manual: false,
            };
            a.workMinutes += i.workMinutes;
            a.topUpMinutes += i.topUpMinutes;
            a.netMinutes += i.netMinutes;
            acc.set(i.projectId, a);
          }
          byDate.set(d.date, acc);
        }
      }
      const days = [...byDate]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, items]) => ({ date, items: [...items.values()] }));
      return buildReport(from, to, days, list);
    },
  );

  // ── Firmen-Netze: Ort und Standardprojekt ───────────────────────────────────
  app.patch(
    '/networks/:id',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description:
          'Bezeichnung, Ort (Büro/Homeoffice/sonstiges) und Standardprojekt eines Firmen-Netzes.',
        params: networkParams,
        body: networkUpdate,
        response: { 200: networkResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { label, location, defaultProjectId } = request.body;
      return withUser(ctx.db, actorScope(actor), async (tx) => {
        await assertOrgProject(tx, actor.orgId, defaultProjectId);
        const [row] = await tx
          .update(workNetworks)
          .set({
            ...(label !== undefined ? { label } : {}),
            ...(location !== undefined ? { location } : {}),
            ...(defaultProjectId !== undefined ? { defaultProjectId } : {}),
          })
          .where(and(eq(workNetworks.id, request.params.id), eq(workNetworks.orgId, actor.orgId)))
          .returning();
        if (!row) throw new HttpError(404, 'not_found');
        await audit(tx, actor, 'network.update', row.id, request.body);
        return toNetworkResponse(row);
      });
    },
  );

  // ── Homeoffice: nur Anzahl Tage je Monat ────────────────────────────────────
  app.get(
    '/home-office',
    {
      config: { roles: ADMINS },
      schema: {
        tags,
        security,
        description:
          'Anzahl Homeoffice-Tage je Monat und Mitglied (keine Tagesdetails). Nur wenn die Organisation es eingeschaltet hat.',
        querystring: orgHomeOfficeQuery,
        response: { 200: orgHomeOfficeResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { year } = request.query;
      const members = await withUser(ctx.db, actorScope(actor), async (tx) => {
        const [org] = await tx
          .select({ features: organizations.features })
          .from(organizations)
          .where(eq(organizations.id, actor.orgId));
        if (!parseFeatures(org?.features).homeOfficeReport) {
          throw new HttpError(403, 'feature_disabled');
        }
        return (await visibleMembers(tx, actor)).filter((m) => m.deactivatedAt === null);
      });
      const out = [];
      for (const m of members) {
        const extras = await withMember(ctx.db, actorScope(actor), m.id, (tx) =>
          loadDayExtras(tx, m.id, `${String(year)}-01-01`, `${String(year)}-12-31`, ctx.now()),
        );
        out.push({
          userId: m.id,
          name: m.name,
          homeDaysByMonth: homeOfficeSummary(extras.locations, ctx.homeOffice).homeDaysByMonth,
        });
      }
      await withUser(ctx.db, actorScope(actor), (tx) =>
        audit(tx, actor, 'home_office.view', String(year), { members: out.length }),
      );
      return { year, members: out };
    },
  );
}
