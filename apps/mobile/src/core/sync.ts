// Zustand und Fehlerklassen der Synchronisation; Backoff wie im Desktop-Kern.
import { ApiError } from '@timelog/shared';

export type SyncState =
  | { state: 'idle' }
  | { state: 'ok'; at: string }
  | { state: 'offline'; failures: number; retryAt: string }
  | { state: 'needsLogin' }
  | { state: 'localOnly' };

/** Höchstwerte aus @timelog/shared (MAX_BATCH_EVENTS, presenceRequest). */
export const MAX_BATCH_EVENTS = 500;
export const MAX_BATCH_SPANS = 200;
export const PAGE_SIZE = 500;

/** 30 s, 1, 2, 4 … min, höchstens 30 min. */
export function backoffMs(failures: number): number {
  const shift = Math.min(Math.max(failures - 1, 0), 16);
  return Math.min(30_000 * 2 ** shift, 30 * 60_000);
}

export type Failure = 'unavailable' | 'unauthorized' | 'rejected';

/** Nicht erreichbar, Zeitüberschreitung, 429 oder 5xx: später erneut versuchen. */
export function classify(error: unknown): Failure {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'unauthorized';
    if (error.status === 408 || error.status === 429 || error.status >= 500) return 'unavailable';
    return 'rejected';
  }
  return 'unavailable';
}
