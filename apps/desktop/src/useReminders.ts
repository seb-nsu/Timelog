// Sendet fällige Erinnerungen als Systembenachrichtigung, je Tag und Art höchstens einmal.
import {
  DEFAULT_REMINDERS,
  type MessageKey,
  type Profile,
  type ReminderKind,
  type Translator,
  dueReminders,
  formatDate,
} from '@timelog/app-core';
import type { WorkDay } from '@timelog/rules';
import { useEffect } from 'react';
import { z } from 'zod';
import type { DesktopBackend } from './backend.js';

export const SENT_KEY = 'reminders.sent';
/** Gesendete Schlüssel so lange merken. */
const KEEP = 60;

const TEXT: Record<ReminderKind, { title: MessageKey; body: MessageKey }> = {
  end_forgotten: { title: 'reminder.end_forgotten.title', body: 'reminder.end_forgotten.body' },
  over_10h: { title: 'reminder.over_10h.title', body: 'reminder.over_10h.body' },
  break_missing: { title: 'reminder.break_missing.title', body: 'reminder.break_missing.body' },
};

function loadSent(storage: DesktopBackend['storage']): string[] {
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(storage.get(SENT_KEY) ?? '[]'));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function useReminders(
  backend: DesktopBackend,
  days: readonly WorkDay[],
  profile: Profile | undefined,
  now: string,
  tz: string | undefined,
  translator: Translator,
): void {
  useEffect(() => {
    if (!tz || days.length === 0) return;
    const sent = loadSent(backend.storage);
    const due = dueReminders(days, now, tz, profile?.reminders ?? DEFAULT_REMINDERS, new Set(sent));
    if (due.length === 0) return;
    for (const r of due) {
      const text = TEXT[r.kind];
      void backend
        .notify(
          translator.t(text.title),
          translator.t(text.body, {
            date: formatDate(r.date, translator.locale === 'en' ? 'en-GB' : 'de-DE'),
          }),
        )
        .catch(() => undefined);
    }
    const next = [...sent, ...due.map((r) => r.key)].slice(-KEEP);
    backend.storage.set(SENT_KEY, JSON.stringify(next));
  }, [backend, days, profile, now, tz, translator]);
}
