// Projektaufteilung und Tagesorte zu berechneten Arbeitstagen. Gerechnet wird ausschließlich mit
// @timelog/rules; hier werden nur die Eingaben geladen. Freigegebene Monate kommen aus dem Snapshot.
import {
  type DayLocation,
  type DayProjects,
  type ProjectAssignment,
  type WorkDay,
  type WorkLocation,
  addDays,
  allocateProjects,
  dayLocation,
  networkRanges,
} from '@timelog/rules';
import { and, asc, eq, gt, gte, isNotNull, lt, lte, or } from 'drizzle-orm';
import type { Tx } from './db/index.js';
import {
  calendarEntries,
  dayLocations,
  projectAssignments,
  projects,
  users,
  workNetworks,
} from './db/schema.js';
import { type EffectiveFeatures, featuresOf } from './features.js';
import { type Computed, type FrozenExtras, loadDays } from './routes/days.js';

type UserRow = typeof users.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;

/** Projekte, die ein Nutzer sieht: eigene und die seiner Organisation (Teamprojekte nur fürs Team). */
export async function visibleProjects(tx: Tx, user: UserRow): Promise<ProjectRow[]> {
  const rows = await tx
    .select()
    .from(projects)
    .where(
      user.orgId
        ? or(eq(projects.userId, user.id), eq(projects.orgId, user.orgId))
        : eq(projects.userId, user.id),
    )
    .orderBy(asc(projects.name));
  return rows.filter(
    (p) =>
      p.orgId === null || p.teamId === null || p.teamId === user.teamId || user.role !== 'user',
  );
}

export interface DayExtras extends Computed {
  approvedMonths: string[];
  features: EffectiveFeatures;
  /** je Tag mit Arbeitszeit; leer, wenn Projekte ausgeschaltet sind */
  projects: DayProjects[];
  locations: DayLocation[];
  /** alle Zuordnungen (manuell, Kalender, Netz) im Zeitraum */
  assignments: ProjectAssignment[];
}

const EPOCH = '1970-01-01T00:00:00.000Z';

/** Neueste manuelle Angabe je Datum (unveränderliche Zeilen, jüngste gewinnt). */
export async function locationOverrides(
  tx: Tx,
  userId: string,
  from: string,
  to: string,
): Promise<Map<string, WorkLocation | null>> {
  const rows = await tx
    .select()
    .from(dayLocations)
    .where(
      and(
        eq(dayLocations.userId, userId),
        gte(dayLocations.date, from),
        lte(dayLocations.date, to),
      ),
    )
    .orderBy(asc(dayLocations.createdAt), asc(dayLocations.id));
  const out = new Map<string, WorkLocation | null>();
  for (const r of rows) out.set(r.date, r.location);
  return out;
}

/** Arbeitstage samt Projektaufteilung und Tagesort im Zeitraum. */
export async function loadDayExtras(
  tx: Tx,
  userId: string,
  from: string,
  to: string,
  nowMs: number,
): Promise<DayExtras> {
  const loaded = await loadDays(tx, userId, from, to, nowMs);
  const [user] = await tx.select().from(users).where(eq(users.id, userId));
  if (!user) {
    return {
      ...loaded,
      features: { projects: false, calendar: false, homeOfficeReport: false },
      projects: [],
      locations: [],
      assignments: [],
    };
  }
  const features = await featuresOf(tx, user);
  const now = new Date(nowMs).toISOString();

  const nets = await tx
    .select({
      id: workNetworks.id,
      location: workNetworks.location,
      defaultProjectId: workNetworks.defaultProjectId,
    })
    .from(workNetworks)
    .where(
      user.orgId
        ? or(eq(workNetworks.userId, user.id), eq(workNetworks.orgId, user.orgId))
        : eq(workNetworks.userId, user.id),
    );
  const locationOf: Record<string, WorkLocation> = {};
  const projectOf = new Map<string, string>();
  for (const n of nets) {
    locationOf[n.id] = n.location;
    if (n.defaultProjectId) projectOf.set(n.id, n.defaultProjectId);
  }
  const ranges = networkRanges(loaded.events, loaded.spans);

  const assignments: ProjectAssignment[] = [];
  if (features.projects) {
    const loadFrom = addDays(from, -1);
    const loadTo = addDays(to, 1);
    const manual = await tx
      .select()
      .from(projectAssignments)
      .where(
        and(
          eq(projectAssignments.userId, userId),
          gte(projectAssignments.date, loadFrom),
          lte(projectAssignments.date, loadTo),
        ),
      );
    for (const m of manual) {
      assignments.push({
        from: m.fromTs.toISOString(),
        to: m.toTs.toISOString(),
        projectId: m.projectId,
        source: 'manual',
        createdAt: m.createdAt.toISOString(),
      });
    }
    const cal = await tx
      .select()
      .from(calendarEntries)
      .where(
        and(
          eq(calendarEntries.userId, userId),
          eq(calendarEntries.kind, 'busy'),
          eq(calendarEntries.allDay, false),
          isNotNull(calendarEntries.projectId),
          lt(calendarEntries.startAt, new Date(`${addDays(to, 2)}T00:00:00Z`)),
          gt(calendarEntries.endAt, new Date(`${loadFrom}T00:00:00Z`)),
        ),
      );
    for (const c of cal) {
      assignments.push({
        from: c.startAt.toISOString(),
        to: c.endAt.toISOString(),
        projectId: c.projectId,
        source: 'calendar',
        createdAt: EPOCH,
      });
    }
    for (const r of ranges) {
      const projectId = projectOf.get(r.networkId);
      if (projectId) {
        assignments.push({
          from: r.from,
          to: r.to,
          projectId,
          source: 'network',
          createdAt: EPOCH,
        });
      }
    }
  }

  const overrides = await locationOverrides(tx, userId, from, to);
  const frozenMonth = (date: string): FrozenExtras | undefined | null =>
    loaded.frozen.has(date.slice(0, 7)) ? (loaded.frozen.get(date.slice(0, 7)) ?? null) : undefined;

  const outProjects: DayProjects[] = [];
  const outLocations: DayLocation[] = [];
  const seen = new Set<string>();
  for (const day of loaded.days) {
    seen.add(day.date);
    const snap = frozenMonth(day.date);
    if (snap) {
      // Snapshot (Version 2): nie neu berechnen
      const p = snap.projects.find((x) => x.date === day.date);
      if (p && features.projects) outProjects.push(p);
      const l = snap.locations.find((x) => x.date === day.date);
      if (l) outLocations.push(l);
      continue;
    }
    if (features.projects && day.workMinutes > 0) {
      outProjects.push(allocateProjects(day, assignments, now));
    }
    const override = overrides.get(day.date) ?? undefined;
    const loc = dayLocation(day, ranges, locationOf, override, undefined, now);
    if (loc.location) outLocations.push(loc);
  }
  for (const [date, location] of overrides) {
    if (seen.has(date) || !location || frozenMonth(date)) continue;
    outLocations.push({ date, location, source: 'manual', officeMinutes: 0, homeMinutes: 0 });
  }
  outLocations.sort((a, b) => a.date.localeCompare(b.date));
  return { ...loaded, features, projects: outProjects, locations: outLocations, assignments };
}

/** Für den Snapshot einer Freigabe: Tage, Projekte und Orte des Monats. */
export function snapshotOf(extras: DayExtras): {
  version: 2;
  days: WorkDay[];
  projects: DayProjects[];
  locations: DayLocation[];
} {
  return { version: 2, days: extras.days, projects: extras.projects, locations: extras.locations };
}
