// Lädt Zustand, Profil und lokale Daten und berechnet die Arbeitstage mit @timelog/rules.
import { type LocalData, type Profile, computeLocalDays } from '@timelog/app-core';
import type { WorkDay } from '@timelog/rules';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppState, DesktopBackend } from './backend.js';

/** Rückblick für Hinweise wie den 24-Wochen-Durchschnitt. */
export const LOOKBACK_DAYS = 175;
const DAY_MS = 86_400_000;

export interface DesktopData {
  state: AppState | undefined;
  profile: Profile | undefined;
  data: LocalData;
  days: WorkDay[];
  reload: () => void;
}

export function useDesktop(backend: DesktopBackend, now: string): DesktopData {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<AppState>();
  const [profile, setProfile] = useState<Profile>();
  const [data, setData] = useState<LocalData>({ events: [], spans: [] });
  const reload = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => backend.onChange(reload), [backend, reload]);

  useEffect(() => {
    let current = true;
    const nowMs = Date.parse(now);
    const from = new Date(nowMs - LOOKBACK_DAYS * DAY_MS).toISOString();
    const to = new Date(nowMs + 2 * DAY_MS).toISOString();
    void Promise.all([backend.getState(), backend.getProfile(), backend.localData(from, to)]).then(
      ([s, p, d]) => {
        if (!current) return;
        setState(s);
        setProfile(p);
        setData(d);
      },
    );
    return () => {
      current = false;
    };
  }, [backend, now, version]);

  const days = useMemo(() => {
    if (!state) return [];
    const p: Profile = profile ?? { state: 'BE', timezone: state.tracker.timezone };
    return computeLocalDays(data, p, now);
  }, [data, profile, state, now]);

  return { state, profile, data, days, reload };
}
