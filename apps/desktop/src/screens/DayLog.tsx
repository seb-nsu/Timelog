import {
  type LocalEvent,
  detectedBreaks,
  eventsOfDay,
  formatClock,
  formatDate,
  formatMinutes,
} from '@timelog/app-core';
import { addDays, type WorkDay } from '@timelog/rules';
import { useState } from 'react';
import { useBackend, useT } from '../context.js';

export function DayLog({
  days,
  events,
  today,
  tz,
}: {
  days: WorkDay[];
  events: LocalEvent[];
  today: string;
  tz: string;
}) {
  const backend = useBackend();
  const tr = useT();
  const { t } = tr;
  const [date, setDate] = useState(today);
  const day = days.find((d) => d.date === date);
  const list = eventsOfDay(events, date);
  const breaks = detectedBreaks(day);
  const locale = tr.locale === 'en' ? 'en-GB' : 'de-DE';

  return (
    <main className="screen">
      <h1>{t('nav.log')}</h1>
      <div className="row">
        <button
          type="button"
          aria-label={t('log.prev')}
          onClick={() => {
            setDate(addDays(date, -1));
          }}
        >
          ‹
        </button>
        <h2 aria-live="polite">{formatDate(date, locale)}</h2>
        <button
          type="button"
          aria-label={t('log.next')}
          disabled={date >= today}
          onClick={() => {
            setDate(addDays(date, 1));
          }}
        >
          ›
        </button>
      </div>
      {day && (
        <p>
          {t('status.net')} {formatMinutes(day.netMinutes)} h ·{' '}
          {t('log.dayStatus', { status: tr.status(day.status) })}
        </p>
      )}
      {day && day.warnings.length > 0 && (
        <ul className="warnings">
          {day.warnings.map((w) => (
            <li key={w}>{tr.warning(w)}</li>
          ))}
        </ul>
      )}
      <h3>{t('log.events')}</h3>
      {list.length === 0 ? (
        <p>{t('log.empty')}</p>
      ) : (
        <ul className="log">
          {list.map((e) => (
            <li key={e.id}>
              <time dateTime={e.ts}>{formatClock(e.ts, e.tz)}</time> {tr.eventType(e.type)}
              {e.endTs && <> – {formatClock(e.endTs, e.tz)}</>}{' '}
              <span className="muted">({tr.source(e.source)})</span>
            </li>
          ))}
        </ul>
      )}
      {breaks.length > 0 && (
        <>
          <h3>{t('log.breaks')}</h3>
          <ul className="log">
            {breaks.map((b) => {
              const label = t('log.break', {
                from: formatClock(b.from, b.tz || tz),
                to: formatClock(b.to, b.tz || tz),
              });
              return (
                <li key={`${b.sessionId}-${b.from}`}>
                  {label}{' '}
                  <button
                    type="button"
                    aria-label={`${t('action.wasWork')}: ${label}`}
                    onClick={() => void backend.manualRange('manual_work', b.from, b.to)}
                  >
                    {t('action.wasWork')}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}
