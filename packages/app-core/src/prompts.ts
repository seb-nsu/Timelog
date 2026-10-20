// Rückfragen (Arbeitsende, Wochenrückblick) und Wochenrückblick für Desktop und Handy.
// Die Zahlen kommen aus `summarizeWeek` des Regelwerks; hier wird nur gelesen und beschriftet.
import { type WeekSummary, type WorkDay, localTime, summarizeWeek } from '@timelog/rules';
import { configOf, type Profile } from './days.js';
import { formatBalance, formatDate, formatMinutes } from './format.js';
import type { Translator } from './i18n.js';

/** Rückfrage, wie sie GET /prompts liefert (Struktur aus `promptSchema` in @timelog/shared). */
export type PromptLike =
  | {
      kind: 'end_confirm' | 'end_missing';
      ref: string;
      payload: {
        sessionId: string;
        date: string;
        end?: string | undefined;
        tz: string;
        endSource?: string | undefined;
      };
    }
  | {
      kind: 'week_review';
      ref: string;
      payload: {
        week: string;
        from: string;
        to: string;
        netMinutes: number;
        balanceMinutes: number;
        openDays: number;
        legalHints: number;
      };
    };

/** Wochenrückblick für die Woche, in der `date` liegt (Saldo bis `until`). */
export function weekSummary(
  days: readonly WorkDay[],
  profile: Profile,
  date: string,
  until: string,
): WeekSummary {
  return summarizeWeek(days, configOf(profile), date, until);
}

/**
 * Desktop-Benachrichtigung nur, wenn der Desktop das Ende nicht selbst erkannt hat: Ein Ende durch
 * Herunterfahren kennt der Laptop (und ist dabei aus); Netzverlust, fehlendes Ende und der
 * Wochenrückblick kommen auch am Desktop.
 */
export function notifyOnDesktop(p: PromptLike): boolean {
  return !(p.kind === 'end_confirm' && p.payload.endSource === 'shutdown');
}

const tagOf = (tr: Translator) => (tr.locale === 'en' ? 'en-GB' : 'de-DE');

/** Titel und Text einer Rückfrage in der Sprache der App. */
export function promptMessage(
  p: PromptLike,
  tr: Translator,
  today: string,
): { title: string; body: string } {
  if (p.kind === 'week_review') {
    return {
      title: tr.t('prompt.week_review.title', { week: Number(p.payload.week.slice(-2)) }),
      body: tr.t('prompt.week_review.body', {
        net: formatMinutes(p.payload.netMinutes),
        balance: formatBalance(p.payload.balanceMinutes),
        open: p.payload.openDays,
        hints: p.payload.legalHints,
      }),
    };
  }
  const { end, tz, date } = p.payload;
  const time = end ? localTime(Date.parse(end), tz) : undefined;
  const day = formatDate(date, tagOf(tr));
  if (p.kind === 'end_confirm') {
    return {
      title: tr.t('prompt.end_confirm.title', { time: time ?? '?' }),
      body:
        date === today
          ? tr.t('prompt.end_confirm.body')
          : `${day}: ${tr.t('prompt.end_confirm.body')}`,
    };
  }
  return {
    title: tr.t('prompt.end_missing.title'),
    body: time
      ? tr.t('prompt.end_missing.body', { date: day, time })
      : tr.t('prompt.end_missing.bodyNoTime', { date: day }),
  };
}

/** Wochentag für die Einstellung (0 = Sonntag). */
export function weekdayName(index: number, tr: Translator): string {
  // 04.01.2026 ist ein Sonntag
  return new Intl.DateTimeFormat(tagOf(tr), { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, 0, 4 + index, 12)),
  );
}
