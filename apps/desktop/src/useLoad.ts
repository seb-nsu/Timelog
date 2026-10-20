// Lädt Daten vom Server; Fehler (z. B. 403 bei ausgeschalteten Projekten) werden als Zustand geliefert.
import { ApiError } from '@timelog/shared';
import { useCallback, useEffect, useState } from 'react';

export interface Loaded<T> {
  data: T | undefined;
  /** HTTP-Status bzw. 0 ohne Verbindung */
  error: number | undefined;
  reload: () => void;
  set: (value: T) => void;
}

export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<number>();
  const [version, setVersion] = useState(0);
  const run = useCallback(load, deps);
  useEffect(() => {
    let current = true;
    run().then(
      (d) => {
        if (!current) return;
        setData(d);
        setError(undefined);
      },
      (e: unknown) => {
        if (!current) return;
        setData(undefined);
        setError(e instanceof ApiError ? e.status : 0);
      },
    );
    return () => {
      current = false;
    };
  }, [run, version]);
  const reload = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);
  return { data, error, reload, set: setData };
}

/** Datei im Webview speichern (Download). */
export function saveFile(text: string, filename: string, type = 'text/csv;charset=utf-8'): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const href = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(href);
  }, 1000);
}
