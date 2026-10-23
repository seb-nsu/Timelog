// Rückfragen vom Server (Arbeitsende, Wochenrückblick). Der Desktop hat keinen Push: Er fragt
// regelmäßig nach, zeigt jede Rückfrage einmal als Systembenachrichtigung und als Karte in der App.
import { type Translator, notifyOnDesktop, promptMessage } from '@timelog/app-core';
import { localDate } from '@timelog/rules';
import type { Prompt } from '@timelog/shared';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import type { DesktopBackend } from './backend.js';
import { SENT_KEY } from './useReminders.js';

export const PROMPTS_KEY = 'prompts.notified';
/** Abfrageintervall */
export const PROMPT_POLL_MS = 5 * 60_000;
const KEEP = 60;

function loadKeys(storage: DesktopBackend['storage'], key: string): string[] {
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(storage.get(key) ?? '[]'));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export const promptKey = (p: Prompt) => `${p.kind}:${p.ref}`;

export interface PromptsState {
  prompts: Prompt[];
  refresh: () => void;
}

export function usePrompts(
  backend: DesktopBackend,
  active: boolean,
  tz: string | undefined,
  translator: Translator,
  clock: () => number = Date.now,
): PromptsState {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(refresh, PROMPT_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [active, refresh]);

  useEffect(() => {
    if (!active || !tz) {
      setPrompts([]);
      return;
    }
    let current = true;
    backend.api.prompts.list().then(
      ({ prompts: list }) => {
        if (!current) return;
        setPrompts(list);
        const notified = loadKeys(backend.storage, PROMPTS_KEY);
        const fresh = list.filter((p) => !notified.includes(promptKey(p)));
        if (fresh.length === 0) return;
        const today = localDate(clock(), tz);
        for (const p of fresh.filter(notifyOnDesktop)) {
          const { title, body } = promptMessage(p, translator, today);
          void backend.notify(title, body).catch(() => undefined);
        }
        backend.storage.set(
          PROMPTS_KEY,
          JSON.stringify([...notified, ...fresh.map(promptKey)].slice(-KEEP)),
        );
        // Kein zweites „Ende vergessen?“ für einen Tag, nach dem schon gefragt wurde
        const missing = fresh.filter((p) => p.kind === 'end_missing');
        if (missing.length > 0) {
          const sent = loadKeys(backend.storage, SENT_KEY);
          const keys = missing.map((p) => `${p.payload.date}:end_forgotten`);
          backend.storage.set(SENT_KEY, JSON.stringify([...sent, ...keys].slice(-KEEP)));
        }
      },
      () => {
        // offline oder abgemeldet: beim nächsten Durchlauf erneut
      },
    );
    return () => {
      current = false;
    };
  }, [backend, active, tz, translator, clock, version]);

  return { prompts, refresh };
}
