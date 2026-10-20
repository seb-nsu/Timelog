// App-Zustand für alle Screens: Kern, berechnete Tage, Übersetzer und einfache Navigation.
import { type Locale, useNow } from '@timelog/app-core';
import type { WorkDay } from '@timelog/rules';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { MobileCore, MobileState } from '../core/core';
import { type MobileTranslator, createMobileTranslator } from '../i18n';

export type Route =
  | { name: 'today' }
  | { name: 'log'; date?: string }
  | { name: 'review' }
  | { name: 'week'; date?: string }
  | { name: 'overview' }
  | { name: 'absences' }
  | { name: 'leave' }
  | { name: 'settings' }
  | { name: 'setup' };

/** Plattform-Aktionen, die Tests ersetzen (Teilen-Menü, Berechtigungen). */
export interface PlatformActions {
  shareFile(name: string, mime: string, data: Blob | string): Promise<void>;
  requestNotifications(): Promise<boolean>;
}

export interface MobileContextValue {
  core: MobileCore;
  state: MobileState;
  days: WorkDay[];
  now: string;
  t: MobileTranslator;
  /** steigt bei jeder Änderung; für nachgeladene Listen */
  version: number;
  route: Route;
  go: (route: Route) => void;
  actions: PlatformActions;
}

const Ctx = createContext<MobileContextValue | null>(null);

export function useMobile(): MobileContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('MobileProvider fehlt');
  return value;
}

export interface MobileProviderProps {
  core: MobileCore;
  locale: Locale;
  actions: PlatformActions;
  /** Nach jeder Neuberechnung, z. B. Widget und Erinnerungen aktualisieren */
  onUpdate?: (value: {
    state: MobileState;
    days: WorkDay[];
    now: string;
    t: MobileTranslator;
  }) => void;
  clock?: () => number;
  /** Navigation von außen, z. B. beim Antippen einer Benachrichtigung; liefert eine Abmeldung */
  externalRoutes?: (go: (route: Route) => void) => () => void;
  children: ReactNode;
  loading?: ReactNode;
}

export function MobileProvider({
  core,
  locale,
  actions,
  onUpdate,
  clock,
  externalRoutes,
  children,
  loading = null,
}: MobileProviderProps) {
  const t = useMemo(() => createMobileTranslator(locale), [locale]);
  const tick = useNow(30_000, clock);
  const [data, setData] = useState<{
    state: MobileState;
    days: WorkDay[];
    now: string;
    version: number;
  } | null>(null);
  const [route, setRoute] = useState<Route>({ name: 'today' });

  useEffect(() => externalRoutes?.(setRoute), [externalRoutes]);

  const reload = useCallback(async () => {
    const now = core.now();
    const [state, days] = await Promise.all([core.getState(), core.days(now)]);
    setData((prev) => ({ state, days, now, version: (prev?.version ?? 0) + 1 }));
  }, [core]);

  useEffect(() => {
    void reload();
    return core.onChange(() => {
      void reload();
    });
  }, [core, reload]);

  // Laufende Sitzung: jede halbe Minute neu berechnen
  useEffect(() => {
    void reload();
  }, [tick, reload]);

  useEffect(() => {
    if (data && onUpdate) onUpdate({ state: data.state, days: data.days, now: data.now, t });
  }, [data, t, onUpdate]);

  const value = useMemo<MobileContextValue | null>(
    () =>
      data
        ? {
            core,
            state: data.state,
            days: data.days,
            now: data.now,
            t,
            version: data.version,
            route,
            go: setRoute,
            actions,
          }
        : null,
    [core, data, t, route, actions],
  );
  if (!value) return <>{loading}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
