// Firmenversion (nur Admin): Lohn-Export aus freigegebenen Monaten (Snapshot) für DATEV LODAS,
// DATEV Lohn und Gehalt und Lexware lohn+gehalt; Übertragung an Personio (API v2).
import {
  type AbsenceKind,
  type WorkDay,
  addDays,
  dayWorkPeriods,
  localDate,
  localTime,
  payrollMonth,
  startOfLocalDay,
} from '@timelog/rules';
import {
  type PayrollConfig,
  type PayrollTransfer,
  absenceSchema,
  okResponse,
  payrollConfigSchema,
  payrollConfigUpdate,
  payrollExportQuery,
  payrollMemberSchema,
  payrollMemberUpdate,
  payrollMembersResponse,
  personioCredentialsInput,
  personioStatusResponse,
  personioTransferRequest,
  memberParams,
  transferSchema,
  transfersResponse,
  workDaySchema,
} from '@timelog/shared';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { type App, type AppContext, HttpError } from '../../app.js';
import { type Tx, withMember, withUser } from '../../db/index.js';
import {
  absences,
  approvals,
  memberPayroll,
  organizations,
  payrollCredentials,
  payrollTransfers,
  users,
} from '../../db/schema.js';
import { namesOf } from '../../leave/service.js';
import { PayrollConfigError, type PayrollRow, renderPayroll } from '../../payroll/formats.js';
import { PersonioClient, PersonioError } from '../../payroll/personio.js';
import { decrypt, encrypt } from '../../security/crypto.js';
import { loadRulesConfig } from '../days.js';
import { ADMINS, actorOf, actorScope, audit, loadMember } from './access.js';
import { monthRange } from './approvals.js';
import { visibleMembers } from './manage.js';

const tags = ['payroll'];
const security = [{ bearer: [] }];
const admins = { roles: ADMINS };

type UserRow = typeof users.$inferSelect;
type MappingRow = typeof memberPayroll.$inferSelect;

export function parsePayrollConfig(raw: unknown): PayrollConfig {
  const parsed = payrollConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : payrollConfigSchema.parse({});
}

const settingsPn = z.object({ personnelNumber: z.string().optional() });

/** Personalnummer: Lohn-Zuordnung des Admins, sonst die (ältere) Angabe in den Einstellungen. */
function personnelNumberOf(member: UserRow, mapping: MappingRow | undefined): string | undefined {
  if (mapping?.personnelNumber) return mapping.personnelNumber;
  const s = settingsPn.safeParse(member.settings);
  return s.success && s.data.personnelNumber ? s.data.personnelNumber : undefined;
}

const snapshotDays = z.array(workDaySchema);
const snapshotAbsences = z.array(absenceSchema.pick({ date: true, kind: true, minutes: true }));

interface MonthData {
  days: WorkDay[];
  absences: { date: string; kind: AbsenceKind; minutes: number }[];
  timezone: string;
}

/**
 * Daten eines freigegebenen Monats: Arbeitstage nur aus dem Snapshot (nie neu berechnet),
 * Abwesenheiten aus dem Snapshot der Freigabe (ältere Freigaben ohne: aus der Tabelle).
 * Nicht freigegeben → undefined.
 */
async function approvedMonthData(
  tx: Tx,
  memberId: string,
  month: string,
): Promise<MonthData | undefined> {
  const [row] = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.userId, memberId), eq(approvals.month, month)));
  if (row?.status !== 'approved') return undefined;
  const days = snapshotDays.safeParse(row.snapshot);
  if (!days.success) return undefined;
  const loaded = await loadRulesConfig(tx, memberId);
  let list = snapshotAbsences.safeParse(row.absencesSnapshot);
  if (!list.success || row.absencesSnapshot === null) {
    const { from, to } = monthRange(month);
    const live = await tx
      .select({ date: absences.date, kind: absences.kind, minutes: absences.minutes })
      .from(absences)
      .where(and(eq(absences.userId, memberId), gte(absences.date, from), lte(absences.date, to)));
    list = { success: true, data: live };
  }
  return {
    days: days.data,
    absences: list.data,
    timezone: loaded?.user.timezone ?? 'Europe/Berlin',
  };
}

async function loadOrgPayroll(tx: Tx, orgId: string) {
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw new HttpError(404, 'not_found');
  return org;
}

async function mappings(tx: Tx, orgId: string): Promise<Map<string, MappingRow>> {
  const rows = await tx.select().from(memberPayroll).where(eq(memberPayroll.orgId, orgId));
  return new Map(rows.map((r) => [r.userId, r]));
}

function toTransfer(
  r: typeof payrollTransfers.$inferSelect,
  names: ReadonlyMap<string, string>,
): PayrollTransfer {
  const result = z.array(transferSchema.shape.members.element).safeParse(r.result);
  const actorName = names.get(r.actorId);
  return {
    id: r.id,
    month: r.month,
    createdAt: r.createdAt.toISOString(),
    ...(actorName ? { actorName } : {}),
    status: r.status,
    members: result.success ? result.data : [],
  };
}

/** Lokale Zeit ohne Offset (Personio DateTimeWithoutTimezone). */
const personioTime = (iso: string, tz: string): string => {
  const ms = Date.parse(iso);
  return `${localDate(ms, tz)}T${localTime(ms, tz)}:00`;
};

export function orgPayrollRoutes(app: App, ctx: AppContext): void {
  app.get(
    '/payroll/config',
    { config: admins, schema: { tags, security, response: { 200: payrollConfigSchema } } },
    async (request) => {
      const actor = actorOf(request);
      const org = await withUser(ctx.db, actorScope(actor), (tx) =>
        loadOrgPayroll(tx, actor.orgId),
      );
      return parsePayrollConfig(org.payrollConfig);
    },
  );

  app.put(
    '/payroll/config',
    {
      config: admins,
      schema: {
        tags,
        security,
        description:
          'Berater-/Mandantennummer (DATEV), Lohnarten je Art (Stunden, Urlaub, Krankheit, Überstundenabbau), LODAS-Ausfallschlüssel, Personio-Optionen.',
        body: payrollConfigUpdate,
        response: { 200: payrollConfigSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      return withUser(ctx.db, actorScope(actor), async (tx) => {
        await tx
          .update(organizations)
          .set({ payrollConfig: request.body })
          .where(eq(organizations.id, actor.orgId));
        await audit(tx, actor, 'payroll.config', actor.orgId, { ...request.body });
        return request.body;
      });
    },
  );

  app.get(
    '/payroll/members',
    {
      config: admins,
      schema: {
        tags,
        security,
        description: 'Personalnummer und Personio-ID je Mitglied.',
        response: { 200: payrollMembersResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      return withUser(ctx.db, actorScope(actor), async (tx) => {
        const members = (await visibleMembers(tx, actor)).filter((m) => m.deactivatedAt === null);
        const map = await mappings(tx, actor.orgId);
        return {
          members: members.map((m) => {
            const mapping = map.get(m.id);
            const pn = personnelNumberOf(m, mapping);
            return {
              userId: m.id,
              name: m.name,
              email: m.email,
              ...(pn ? { personnelNumber: pn } : {}),
              ...(mapping?.personioId ? { personioId: mapping.personioId } : {}),
            };
          }),
        };
      });
    },
  );

  app.put(
    '/payroll/members/:id',
    {
      config: admins,
      schema: {
        tags,
        security,
        description: 'Personalnummer bzw. Personio-ID eines Mitglieds setzen (null entfernt).',
        params: memberParams,
        body: payrollMemberUpdate,
        response: { 200: payrollMemberSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const body = request.body;
      return withUser(ctx.db, actorScope(actor), async (tx) => {
        const member = await loadMember(tx, actor, request.params.id);
        const set = {
          ...(body.personnelNumber !== undefined ? { personnelNumber: body.personnelNumber } : {}),
          ...(body.personioId !== undefined ? { personioId: body.personioId } : {}),
          updatedAt: new Date(ctx.now()),
        };
        const [row] = await tx
          .insert(memberPayroll)
          .values({ userId: member.id, orgId: actor.orgId, ...set })
          .onConflictDoUpdate({ target: memberPayroll.userId, set })
          .returning();
        await audit(tx, actor, 'payroll.member', member.id, {
          ...(body.personnelNumber !== undefined ? { personnelNumber: body.personnelNumber } : {}),
          ...(body.personioId !== undefined ? { personioId: body.personioId } : {}),
        });
        const pn = personnelNumberOf(member, row);
        return {
          userId: member.id,
          name: member.name,
          email: member.email,
          ...(pn ? { personnelNumber: pn } : {}),
          ...(row?.personioId ? { personioId: row.personioId } : {}),
        };
      });
    },
  );

  app.get(
    '/payroll/export',
    {
      config: admins,
      schema: {
        tags,
        security,
        description:
          'Lohn-Export eines Monats: nur Mitglieder mit freigegebenem Monat (Snapshot, nie neu berechnet) und Personalnummer. Kopfzeilen x-timelog-exported/x-timelog-skipped nennen die Anzahl. Windows-1252, CR/LF.',
        querystring: payrollExportQuery,
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { month, format, teamId } = request.query;
      const { org, members, map } = await withUser(ctx.db, actorScope(actor), async (tx) => ({
        org: await loadOrgPayroll(tx, actor.orgId),
        members: await visibleMembers(tx, actor, teamId),
        map: await mappings(tx, actor.orgId),
      }));
      const cfg = parsePayrollConfig(org.payrollConfig);
      const rows: PayrollRow[] = [];
      let skipped = 0;
      for (const m of members) {
        const pn = personnelNumberOf(m, map.get(m.id));
        const data = await withMember(ctx.db, actorScope(actor), m.id, async (tx) => {
          const d = await approvedMonthData(tx, m.id, month);
          const loaded = await loadRulesConfig(tx, m.id);
          return d && loaded ? { ...d, config: loaded.config } : undefined;
        });
        if (!data || !pn) {
          skipped += 1;
          continue;
        }
        const summary = payrollMonth(data.days, data.absences, data.config);
        rows.push({
          personnelNumber: pn,
          netMinutes: summary.netMinutes,
          absences: summary.absences,
          daysByKind: summary.daysByKind,
        });
      }
      if (rows.length === 0) throw new HttpError(409, 'nothing_to_export');
      let file;
      try {
        file = renderPayroll(format, month, rows, cfg);
      } catch (err) {
        if (err instanceof PayrollConfigError) {
          throw new HttpError(400, 'payroll_config_incomplete', err.missing.join(', '));
        }
        throw err;
      }
      await withUser(ctx.db, actorScope(actor), (tx) =>
        audit(tx, actor, 'payroll.export', month, {
          format,
          teamId: teamId ?? null,
          exported: rows.length,
          skipped,
        }),
      );
      return reply
        .header('content-type', file.contentType)
        .header('content-disposition', `attachment; filename="${file.filename}"`)
        .header('x-timelog-exported', String(rows.length))
        .header('x-timelog-skipped', String(skipped))
        .send(file.content);
    },
  );

  // ── Personio ────────────────────────────────────────────────────────────────
  const credentialStatus = (row: typeof payrollCredentials.$inferSelect | undefined) =>
    row
      ? { configured: true, clientId: row.clientId, updatedAt: row.updatedAt.toISOString() }
      : { configured: false };

  app.get(
    '/payroll/personio',
    {
      config: admins,
      schema: {
        tags,
        security,
        description: 'Ob Personio-Zugangsdaten hinterlegt sind (das Secret wird nie ausgegeben).',
        response: { 200: personioStatusResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const [row] = await withUser(ctx.db, actorScope(actor), (tx) =>
        tx.select().from(payrollCredentials).where(eq(payrollCredentials.orgId, actor.orgId)),
      );
      return credentialStatus(row);
    },
  );

  app.put(
    '/payroll/personio',
    {
      config: admins,
      schema: {
        tags,
        security,
        description:
          'Personio-API-Zugang (Client-ID und Secret aus Personio → Einstellungen → API-Zugangsdaten). Das Secret wird mit AES-256-GCM verschlüsselt gespeichert (Schlüssel TOTP_ENCRYPTION_KEY).',
        body: personioCredentialsInput,
        response: { 200: personioStatusResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { clientId, clientSecret } = request.body;
      const now = new Date(ctx.now());
      const values = {
        provider: 'personio' as const,
        clientId,
        clientSecretEnc: encrypt(clientSecret, ctx.totpKey),
        updatedBy: actor.id,
        updatedAt: now,
      };
      const [row] = await withUser(ctx.db, actorScope(actor), async (tx) => {
        const saved = await tx
          .insert(payrollCredentials)
          .values({ orgId: actor.orgId, ...values })
          .onConflictDoUpdate({ target: payrollCredentials.orgId, set: values })
          .returning();
        await audit(tx, actor, 'payroll.credentials', actor.orgId, { provider: 'personio' });
        return saved;
      });
      return credentialStatus(row);
    },
  );

  app.delete(
    '/payroll/personio',
    { config: admins, schema: { tags, security, response: { 200: okResponse } } },
    async (request) => {
      const actor = actorOf(request);
      await withUser(ctx.db, actorScope(actor), async (tx) => {
        await tx.delete(payrollCredentials).where(eq(payrollCredentials.orgId, actor.orgId));
        await audit(tx, actor, 'payroll.credentials.delete', actor.orgId, { provider: 'personio' });
      });
      return { ok: true as const };
    },
  );

  app.get(
    '/payroll/transfers',
    {
      config: admins,
      schema: {
        tags,
        security,
        description: 'Ergebnisprotokolle der Übertragungen.',
        response: { 200: transfersResponse },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const rows = await withUser(ctx.db, actorScope(actor), (tx) =>
        tx
          .select()
          .from(payrollTransfers)
          .where(eq(payrollTransfers.orgId, actor.orgId))
          .orderBy(desc(payrollTransfers.createdAt))
          .limit(50),
      );
      const names = await namesOf(
        ctx.db,
        rows.map((r) => r.actorId),
      );
      return { transfers: rows.map((r) => toTransfer(r, names)) };
    },
  );

  app.post(
    '/payroll/personio/transfer',
    {
      config: admins,
      schema: {
        tags,
        security,
        description:
          'Überträgt die Arbeitszeiten eines freigegebenen Monats als Attendance Periods (WORK) an Personio – je Tag die tatsächlichen Arbeitsabschnitte aus dem Snapshot. Früher übertragene Perioden desselben Monats werden vorher entfernt. Ergebnis wird protokolliert.',
        body: personioTransferRequest,
        response: { 200: transferSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { month } = request.body;
      const { org, cred, members, map, previous } = await withUser(
        ctx.db,
        actorScope(actor),
        async (tx) => ({
          org: await loadOrgPayroll(tx, actor.orgId),
          cred: (
            await tx
              .select()
              .from(payrollCredentials)
              .where(eq(payrollCredentials.orgId, actor.orgId))
          )[0],
          members: (await visibleMembers(tx, actor)).filter((m) => m.deactivatedAt === null),
          map: await mappings(tx, actor.orgId),
          previous: (
            await tx
              .select()
              .from(payrollTransfers)
              .where(
                and(eq(payrollTransfers.orgId, actor.orgId), eq(payrollTransfers.month, month)),
              )
              .orderBy(desc(payrollTransfers.createdAt))
              .limit(1)
          )[0],
        }),
      );
      if (!cred) throw new HttpError(409, 'personio_not_configured');
      const cfg = parsePayrollConfig(org.payrollConfig);
      const client = new PersonioClient(
        ctx.personio,
        cred.clientId,
        decrypt(cred.clientSecretEnc, ctx.totpKey),
      );
      const prevIds = z.record(z.string(), z.array(z.string())).safeParse(previous?.periodIds);
      const periodIds: Record<string, string[]> = prevIds.success ? { ...prevIds.data } : {};
      const results: PayrollTransfer['members'] = [];

      for (const m of members) {
        const base = { userId: m.id, name: m.name };
        const data = await withMember(ctx.db, actorScope(actor), m.id, (tx) =>
          approvedMonthData(tx, m.id, month),
        );
        if (!data) {
          results.push({
            ...base,
            status: 'skipped',
            periods: 0,
            message: 'Monat nicht freigegeben',
          });
          continue;
        }
        try {
          const mapped = map.get(m.id)?.personioId;
          const personId =
            mapped ??
            (cfg.personio.matchBy === 'email' ? await client.personIdByEmail(m.email) : undefined);
          if (!personId) {
            results.push({
              ...base,
              status: 'skipped',
              periods: 0,
              message:
                cfg.personio.matchBy === 'email'
                  ? 'Keine Personio-Person zur E-Mail'
                  : 'Keine Personio-ID hinterlegt',
            });
            continue;
          }
          for (const id of periodIds[m.id] ?? []) await client.deletePeriod(id);
          periodIds[m.id] = [];
          const created: string[] = [];
          for (const day of data.days) {
            const dayStart = startOfLocalDay(day.date, data.timezone);
            const dayEnd = startOfLocalDay(addDays(day.date, 1), data.timezone);
            for (const p of dayWorkPeriods(day, dayStart, dayEnd)) {
              const id = await client.createWork(
                personId,
                {
                  start: personioTime(p.start, data.timezone),
                  end: personioTime(p.end, data.timezone),
                },
                `TimeLog ${month}`,
                cfg.personio.skipApproval,
              );
              created.push(id);
              periodIds[m.id] = [...created];
            }
          }
          results.push({ ...base, status: 'transferred', periods: created.length });
        } catch (err) {
          const message =
            err instanceof PersonioError
              ? `Personio ${String(err.status)}: ${err.code}`
              : 'Personio nicht erreichbar';
          results.push({
            ...base,
            status: 'failed',
            periods: periodIds[m.id]?.length ?? 0,
            message,
          });
        }
      }

      const transferred = results.filter((r) => r.status === 'transferred').length;
      const failed = results.filter((r) => r.status === 'failed').length;
      const status: PayrollTransfer['status'] =
        failed === 0 && transferred > 0 ? 'ok' : transferred > 0 ? 'partial' : 'failed';
      const row = await withUser(ctx.db, actorScope(actor), async (tx) => {
        const [inserted] = await tx
          .insert(payrollTransfers)
          .values({
            orgId: actor.orgId,
            month,
            provider: 'personio',
            actorId: actor.id,
            status,
            result: results,
            periodIds,
          })
          .returning();
        await audit(tx, actor, 'payroll.transfer', month, {
          provider: 'personio',
          status,
          transferred,
          failed,
          skipped: results.length - transferred - failed,
        });
        return inserted;
      });
      if (!row) throw new HttpError(500, 'insert_failed');
      return toTransfer(row, new Map([[actor.id, actor.name]]));
    },
  );
}
