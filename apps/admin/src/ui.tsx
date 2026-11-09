// Kleine Bausteine: Daten laden, Meldungen, Kontext.
import type { ApiClient, OrgMeResponse } from '@timelog/shared';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { L, errorText } from './texts.js';

export interface AdminContextValue {
  api: ApiClient;
  me: OrgMeResponse;
  baseUrl: string;
  now: () => number;
  /** Meldung in der Live-Region (für Screenreader und sichtbar). */
  notify: (text: string) => void;
}

export const AdminContext = createContext<AdminContextValue | undefined>(undefined);

export function useAdmin(): AdminContextValue {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error('AdminContext fehlt');
  return ctx;
}

export const isAdmin = (me: OrgMeResponse): boolean => me.user.role === 'admin';

export interface Loaded<T> {
  data: T | undefined;
  error: string | undefined;
  reload: () => void;
}

/** Lädt Daten beim ersten Rendern und bei Änderung von deps neu. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  const run = useCallback(load, deps);
  useEffect(() => {
    let alive = true;
    run().then(
      (d) => {
        if (alive) {
          setData(d);
          setError(undefined);
        }
      },
      (e: unknown) => {
        if (alive) setError(errorText(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [run, tick]);
  return {
    data,
    error,
    reload: () => {
      setTick((t) => t + 1);
    },
  };
}

export function ErrorText({ text }: { text: string | undefined }) {
  if (!text) return null;
  return (
    <p role="alert" className="error">
      {text}
    </p>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="muted">{L(`${what} werden geladen …`, `Loading ${what} …`)}</p>;
}
