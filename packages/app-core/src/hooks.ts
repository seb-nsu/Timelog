// React-Hooks für Desktop- und Mobile-Oberfläche.
import { useEffect, useMemo, useState } from 'react';
import { type Locale, type Translator, createTranslator } from './i18n.js';

/** Aktuelle Zeit als ISO-String, aktualisiert im Takt (Standard: jede Minute). */
export function useNow(intervalMs = 60_000, clock: () => number = Date.now): string {
  const [now, setNow] = useState(() => new Date(clock()).toISOString());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(new Date(clock()).toISOString());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs, clock]);
  return now;
}

export function useTranslator(locale: Locale): Translator {
  return useMemo(() => createTranslator(locale), [locale]);
}

export type AsyncState<T> =
  { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; error: unknown };

/** Lädt einen Wert neu, sobald sich `deps` ändern; verwirft veraltete Antworten. */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  useEffect(() => {
    let current = true;
    load().then(
      (value) => {
        if (current) setState({ status: 'ready', value });
      },
      (error: unknown) => {
        if (current) setState({ status: 'error', error });
      },
    );
    return () => {
      current = false;
    };
  }, deps);
  return state;
}
