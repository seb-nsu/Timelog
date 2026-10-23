import { formatBalance, formatClock, formatMinutes, todaySummary } from '@timelog/app-core';
import { HINT_WARNINGS, type Warning, computeBalance, type WorkDay } from '@timelog/rules';
import { useEffect } from 'react';
import type { AppState } from '../backend.js';
import { useBackend, useT } from '../context.js';
import type { Extras } from '../useExtras.js';
import { Review } from './Review.js';

export function SyncLine({ state }: { state: AppState }) {
  const { t } = useT();
  if (state.sync.state === 'needsLogin') return <span>{t('sync.needsLogin')}</span>;
  if (state.sync.state === 'offline') return <span>{t('sync.offline')}</span>;
  if (state.pending > 0) return <span>{t('sync.pending', { count: state.pending })}</span>;
  return <span>{t('sync.ok')}</span>;
}

/** Heute: Status, Start/Stopp, Erkennung und alles, was zu prüfen ist. */
/** Vertrauensanzeige: Läuft die Automatik, und ist ein Arbeitsnetz da? */
function DetectionLine({ state }: { state: AppState }) {
  const { t } = useT();
  if (!state.tracker.active) return <span>{t('status.idle')}</span>;
  return (
    <span>
      {t('status.detectionOn')} ·{' '}
      {t(state.tracker.networkId ? 'status.inNetwork' : 'status.notInNetwork')}
    </span>
  );
}

export function Status({
  state,
  days,
  now,
  extras,
  onChanged,
  onOpenDay,
}: {
  state: AppState;
  days: WorkDay[];
  now: string;
  extras: Extras;
  onChanged: () => void;
  onOpenDay: (date: string) => void;
}) {
  const backend = useBackend();
  const tr = useT();
  const { t } = tr;
  const tz = state.tracker.timezone;
  const summary = todaySummary(days, now, tz);
  const month = summary.date.slice(0, 7);
  const balance = computeBalance(
    days.filter((d) => d.date.startsWith(month) && d.date <= summary.date),
  );
  const net = formatMinutes(summary.netMinutes);
  // Hinweise zum Arbeitszeitgesetz für heute (aus dem Regelwerk)
  const legal: readonly Warning[] = [...HINT_WARNINGS, 'break_violation', 'break_placement'];
  const hints = [
    ...new Set([
      ...(summary.day?.warnings ?? []),
      ...(summary.day?.sessions.flatMap((s) => s.warnings) ?? []),
    ]),
  ].filter((w) => legal.includes(w));
  const since = summary.since ? formatClock(summary.since, tz) : undefined;

  // Tray-Text aus derselben Berechnung
  const trayText =
    summary.running && since
      ? t('status.trayRunning', { time: since, net })
      : t('status.trayStopped', { net });
  useEffect(() => {
    void backend.setTrayStatus(trayText);
  }, [backend, trayText]);

  return (
    <main className="screen">
      <h1>{t('nav.today')}</h1>
      <section aria-live="polite" className="card">
        <p className="state">{t(summary.running ? 'status.running' : 'status.stopped')}</p>
        {since && <p>{t('status.since', { time: since })}</p>}
        <dl>
          <div>
            <dt>{t('status.net')}</dt>
            <dd className="big">{net} h</dd>
          </div>
          <div>
            <dt>{t('status.breaks')}</dt>
            <dd>{formatMinutes(summary.breakMinutes)} h</dd>
          </div>
          <div>
            <dt>{t('status.month')}</dt>
            <dd>{formatBalance(balance)} h</dd>
          </div>
        </dl>
      </section>
      {hints.length > 0 && (
        <section className="card" aria-labelledby="hints">
          <h2 id="hints">{t('status.hints')}</h2>
          <ul className="warnings">
            {hints.map((w) => (
              <li key={w}>{tr.warning(w)}</li>
            ))}
          </ul>
        </section>
      )}
      <button
        type="button"
        className="primary"
        onClick={() => void backend.manual(summary.running ? 'manual_end' : 'manual_start')}
      >
        {t(summary.running ? 'action.stop' : 'action.start')}
      </button>
      <Review
        days={days}
        today={summary.date}
        tz={tz}
        calendar={extras.calendar}
        onChanged={onChanged}
        onOpenDay={onOpenDay}
      />
      <p className="muted">
        <DetectionLine state={state} /> · <SyncLine state={state} />{' '}
        {state.pending > 0 && (
          <button type="button" className="link" onClick={() => void backend.syncNow()}>
            {t('sync.now')}
          </button>
        )}
      </p>
    </main>
  );
}
