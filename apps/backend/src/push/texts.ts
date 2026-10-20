// Texte der Push-Nachrichten (de/en). Nur Datum, Uhrzeit und Summen – keine Namen oder E-Mails.
import { localTime } from '@timelog/rules';
import type { EndPromptPayload, WeekPromptPayload } from '@timelog/shared';

export type PushLocale = 'de' | 'en';

/** Minuten als h:mm mit Vorzeichen bei Bedarf (reine Darstellung). */
export function hm(minutes: number, signed = false): string {
  const sign = minutes < 0 ? '−' : signed && minutes > 0 ? '+' : '';
  const abs = Math.abs(Math.round(minutes));
  return `${sign}${String(Math.floor(abs / 60))}:${String(abs % 60).padStart(2, '0')}`;
}

function day(date: string, locale: PushLocale): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'de-DE', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}

export function endConfirmText(
  p: EndPromptPayload,
  locale: PushLocale,
  today: string,
): { title: string; body: string } {
  const time = p.end ? localTime(Date.parse(p.end), p.tz) : '?';
  const other = p.date !== today;
  if (locale === 'en') {
    return {
      title: `End of work detected at ${time}`,
      body: `${other ? `${day(p.date, locale)}: ` : ''}Is that right? Tap “Correct” to change it.`,
    };
  }
  return {
    title: `Feierabend um ${time} erkannt`,
    body: `${other ? `${day(p.date, locale)}: ` : ''}Stimmt das? Mit „Korrigieren“ änderst du es.`,
  };
}

export function endMissingText(
  p: EndPromptPayload,
  locale: PushLocale,
): { title: string; body: string } {
  const time = p.end ? localTime(Date.parse(p.end), p.tz) : undefined;
  if (locale === 'en') {
    return {
      title: 'End of work missing',
      body: time
        ? `${day(p.date, locale)}: last activity at ${time}. Was that the end?`
        : `${day(p.date, locale)}: please add the end in the day log.`,
    };
  }
  return {
    title: 'Arbeitsende fehlt',
    body: time
      ? `${day(p.date, locale)}: zuletzt aktiv um ${time}. War das das Ende?`
      : `${day(p.date, locale)}: Bitte das Ende im Tagesprotokoll ergänzen.`,
  };
}

export function weekText(
  p: WeekPromptPayload,
  locale: PushLocale,
): { title: string; body: string } {
  const week = Number(p.week.slice(-2));
  if (locale === 'en') {
    const parts = [
      `${hm(p.netMinutes)} h net`,
      `balance ${hm(p.balanceMinutes, true)} h`,
      p.openDays === 1 ? '1 day to review' : `${String(p.openDays)} days to review`,
    ];
    if (p.legalHints > 0) parts.push(`${String(p.legalHints)} Working Hours Act notes`);
    return { title: `Your week ${String(week)}`, body: `${parts.join(', ')}.` };
  }
  const parts = [
    `${hm(p.netMinutes)} h netto`,
    `Saldo ${hm(p.balanceMinutes, true)} h`,
    p.openDays === 1 ? '1 Tag offen' : `${String(p.openDays)} Tage offen`,
  ];
  if (p.legalHints > 0) {
    parts.push(
      p.legalHints === 1 ? '1 Hinweis zum ArbZG' : `${String(p.legalHints)} Hinweise zum ArbZG`,
    );
  }
  return { title: `Dein Wochenrückblick KW ${String(week)}`, body: `${parts.join(', ')}.` };
}
