// Rückfragen per Push (Arbeitsende, Wochenrückblick): Antworten auf Benachrichtigungen auswerten.
// Rein und ohne Expo-Abhängigkeit, damit es in Jest und im Hintergrund-Task gleich läuft.
import { PUSH_ACTIONS, PUSH_CATEGORIES, type PushData, pushData } from '@timelog/shared';
import type { Route } from './ui/context';

/** Standard-Aktion „Benachrichtigung angetippt“ (Notifications.DEFAULT_ACTION_IDENTIFIER) */
export const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';

export type PromptAnswer =
  | { kind: 'confirm'; data: PushData; key: string }
  | { kind: 'open'; route: Route }
  | { kind: 'none' };

/**
 * Daten einer Benachrichtigung: expo-notifications liefert sie als `content.data` (iOS: `body`
 * der APNs-Nutzlast, Android: JSON in `data.body`). Fremde oder unvollständige Daten → undefined.
 */
export function parsePushData(raw: unknown): PushData | undefined {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  const parsed = pushData.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Ziel in der App: Tagesprotokoll bzw. Wochenrückblick. */
export function routeFor(data: PushData): Route {
  return data.kind === 'week_review'
    ? { name: 'week', date: data.date }
    : { name: 'log', date: data.date };
}

/** Was eine Antwort auf eine Rückfrage auslöst. `id` ist die Kennung der Benachrichtigung. */
export function answerFor(action: string, raw: unknown, id: string): PromptAnswer {
  const data = parsePushData(raw);
  if (!data) return { kind: 'none' };
  if (action === PUSH_ACTIONS.confirm) {
    if (data.kind === 'week_review') return { kind: 'open', route: routeFor(data) };
    if (data.kind === 'end_missing' && !data.end) return { kind: 'open', route: routeFor(data) };
    return { kind: 'confirm', data, key: `${data.kind}:${data.sessionId}:${id}` };
  }
  if (
    action === PUSH_ACTIONS.correct ||
    action === PUSH_ACTIONS.open ||
    action === DEFAULT_ACTION
  ) {
    return { kind: 'open', route: routeFor(data) };
  }
  return { kind: 'none' };
}

export interface CategoryAction {
  identifier: string;
  buttonTitle: string;
  options: { opensAppToForeground: boolean };
}

/**
 * Kategorien mit Aktionen. „Stimmt“ öffnet die App nicht (Android: Hintergrund-Task,
 * iOS: nativer Handler im Modul timelog-native); „Korrigieren“ und „Ansehen“ öffnen sie.
 */
export function promptCategories(labels: {
  yes: string;
  correct: string;
  open: string;
}): { identifier: string; actions: CategoryAction[] }[] {
  const yes = {
    identifier: PUSH_ACTIONS.confirm,
    buttonTitle: labels.yes,
    options: { opensAppToForeground: false },
  };
  const correct = {
    identifier: PUSH_ACTIONS.correct,
    buttonTitle: labels.correct,
    options: { opensAppToForeground: true },
  };
  return [
    { identifier: PUSH_CATEGORIES.end_confirm, actions: [yes, correct] },
    { identifier: PUSH_CATEGORIES.end_missing, actions: [yes, correct] },
    {
      identifier: PUSH_CATEGORIES.week_review,
      actions: [
        {
          identifier: PUSH_ACTIONS.open,
          buttonTitle: labels.open,
          options: { opensAppToForeground: true },
        },
      ],
    },
  ];
}
