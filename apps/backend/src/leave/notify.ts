// Benachrichtigungen zu Anträgen: E-Mail über den bestehenden Mailer, dazu eine Hook-Stelle für
// Push (FCM/APNs baut ein eigenes Modul; hier nur die Schnittstelle).
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { AppContext } from '../app.js';
import { asSystem } from '../db/index.js';
import { teams, users } from '../db/schema.js';
import { type Locale, tr, userLocale } from '../i18n.js';

export interface LeaveNotice {
  kind: 'leave.requested' | 'leave.decided' | 'leave.cancelled';
  requestId: string;
  /** Empfänger (Nutzer-IDs). */
  userIds: string[];
  title: string;
  body: string;
}

/** Push-Versand; Standard: nichts tun. */
export type PushHook = (notice: LeaveNotice) => Promise<void>;
export const noPush: PushHook = () => Promise.resolve();

interface Recipient {
  id: string;
  email: string;
}

/**
 * Wer genehmigt? Die Teamleitung des Mitglieds, sonst alle Admins – nie das Mitglied selbst.
 * Liest nur Adressen (Systemzugriff, lesend), weil Mitglieder ihre Teamleitung nicht sehen dürfen.
 */
async function approversOf(ctx: AppContext, memberId: string): Promise<Recipient[]> {
  return asSystem(ctx.db, async (tx) => {
    const [member] = await tx.select().from(users).where(eq(users.id, memberId));
    if (!member?.orgId) return [];
    const active = and(
      isNull(users.deletedAt),
      isNull(users.deactivatedAt),
      ne(users.id, memberId),
    );
    if (member.teamId) {
      const [team] = await tx.select().from(teams).where(eq(teams.id, member.teamId));
      if (team?.managerId && team.managerId !== memberId) {
        const managers = await tx
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(
            and(eq(users.id, team.managerId), inArray(users.role, ['manager', 'admin']), active),
          );
        if (managers.length > 0) return managers;
      }
    }
    return tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.orgId, member.orgId), eq(users.role, 'admin'), active));
  });
}

async function emailOf(ctx: AppContext, userId: string): Promise<Recipient | undefined> {
  const [u] = await asSystem(ctx.db, (tx) =>
    tx.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, userId)),
  );
  return u;
}

const KIND = {
  de: { vacation: 'Urlaub', overtime: 'Überstundenabbau' },
  en: { vacation: 'vacation', overtime: 'overtime reduction' },
} as const;

export interface NoticeRequest {
  id: string;
  userId: string;
  kind: 'vacation' | 'overtime';
  from: string;
  to: string;
  days: number;
}

const period = (r: NoticeRequest, l: Locale) =>
  l === 'en'
    ? `${r.from === r.to ? r.from : `${r.from} to ${r.to}`} (${String(r.days)} days)`
    : `${r.from === r.to ? r.from : `${r.from} bis ${r.to}`} (${String(r.days).replace('.', ',')} Tage)`;

/** Text zum neuen Antrag in der Sprache des Empfängers. */
function requestedText(ctx: AppContext, r: NoticeRequest, memberName: string, l: Locale) {
  const kind = KIND[l][r.kind];
  return {
    title: tr(
      l,
      `TimeLog: Antrag auf ${kind} von ${memberName}`,
      `TimeLog: ${memberName} requests ${kind}`,
    ),
    body: tr(
      l,
      `${memberName} beantragt ${kind}: ${period(r, l)}. Bitte im Web-Admin unter „Urlaub“ genehmigen oder ablehnen: ${ctx.adminUrl}`,
      `${memberName} requests ${kind}: ${period(r, l)}. Please approve or reject it in the web admin under “Leave”: ${ctx.adminUrl}`,
    ),
  };
}

const OUTCOME = {
  de: { approved: 'genehmigt', rejected: 'abgelehnt', cancelled: 'storniert' },
  en: { approved: 'approved', rejected: 'rejected', cancelled: 'cancelled' },
} as const;

/** Neuer Antrag: E-Mail an die Genehmiger, Push-Hook. */
export async function notifyRequested(
  ctx: AppContext,
  r: NoticeRequest,
  memberName: string,
): Promise<void> {
  const to = await approversOf(ctx, r.userId);
  for (const rcpt of to) {
    const mail = requestedText(ctx, r, memberName, await userLocale(ctx.db, rcpt.id));
    await ctx.mailer.send({ to: rcpt.email, subject: mail.title, text: mail.body });
  }
  // Push-Hook: Deutsch als Vorgabe (Geräte-Sprache wählt der Push-Versand selbst).
  const { title, body } = requestedText(ctx, r, memberName, 'de');
  await ctx.push({
    kind: 'leave.requested',
    requestId: r.id,
    userIds: to.map((t) => t.id),
    title,
    body,
  });
}

/** Entscheidung bzw. Stornierung durch Manager/Admin: E-Mail an die Person, Push-Hook. */
export async function notifyDecided(
  ctx: AppContext,
  r: NoticeRequest,
  outcome: 'approved' | 'rejected' | 'cancelled',
  comment?: string,
): Promise<void> {
  const rcpt = await emailOf(ctx, r.userId);
  if (!rcpt) return;
  const l = await userLocale(ctx.db, r.userId);
  const kind = KIND[l][r.kind];
  const word = OUTCOME[l][outcome];
  const title = tr(l, `TimeLog: ${kind} ${word}`, `TimeLog: ${kind} ${word}`);
  const body = tr(
    l,
    `Dein Antrag auf ${kind} ${period(r, l)} wurde ${word}.${comment ? ` Kommentar: ${comment}` : ''}`,
    `Your request for ${kind} ${period(r, l)} was ${word}.${comment ? ` Comment: ${comment}` : ''}`,
  );
  await ctx.mailer.send({ to: rcpt.email, subject: title, text: body });
  await ctx.push({
    kind: outcome === 'cancelled' ? 'leave.cancelled' : 'leave.decided',
    requestId: r.id,
    userIds: [r.userId],
    title,
    body,
  });
}
