// Ein Tag: Arbeitszeiten, erkannte Pausen („War Arbeit“), Korrektur von Beginn/Ende und „Tag bestätigen“.
// Das Ereignisprotokoll (warum eine Zeit gilt) ist eingeklappt. Mit Verbindung gilt der Tag des Servers.
import {
  type LocalEvent,
  detectedBreaks,
  eventsOfDay,
  formatClock,
  formatDate,
  formatMinutes,
} from '@timelog/app-core';
import { addDays, type WorkDay, zonedToUtc } from '@timelog/rules';
import { ApiError, type CorrectionRequest } from '@timelog/shared';
import { type ReactNode, type SyntheticEvent, useEffect, useId, useState } from 'react';
import { useBackend, useT } from '../context.js';
import type { Extras } from '../useExtras.js';
import { DayExtras } from './DayExtras.js';

type Remote = { date: string; day: WorkDay | null | undefined };

export function DayLog({
  days,
  events,
  today,
  tz,
  extras,
  initialDate,
  back,
  onChanged,
}: {
  days: WorkDay[];
  events: LocalEvent[];
  today: string;
  tz: string;
  extras: Extras;
  /** Beim Öffnen aus einer Rückfrage oder der Tagesliste */
  initialDate?: string | undefined;
  back?: ReactNode;
  onChanged: () => void;
}) {
  const backend = useBackend();
  const tr = useT();
  const { t } = tr;
  const [date, setDate] = useState(initialDate ?? today);
  const [remote, setRemote] = useState<Remote>();
  const [version, setVersion] = useState(0);
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  const locale = tr.locale === 'en' ? 'en-GB' : 'de-DE';

  useEffect(() => {
    let current = true;
    backend.api.days({ from: date, to: date }).then(
      (r) => {
        if (current) setRemote({ date, day: r.days.find((d) => d.date === date) });
      },
      () => {
        // ohne Verbindung: Tag aus den Daten dieses Geräts
        if (current) setRemote({ date, day: null });
      },
    );
    return () => {
      current = false;
    };
  }, [backend, date, version]);

  const loaded = remote?.date === date ? remote : undefined;
  const online = loaded !== undefined && loaded.day !== null;
  const day = online ? (loaded.day ?? undefined) : days.find((d) => d.date === date);
  const list = eventsOfDay(events, date);
  const breaks = detectedBreaks(day);

  const done = (text: string) => {
    setMessage({ text, error: false });
    setVersion((v) => v + 1);
    onChanged();
  };
  const fail = (e: unknown) => {
    const text =
      e instanceof ApiError && e.code === 'reason_required'
        ? t('log.reasonRequired')
        : e instanceof ApiError
          ? t('error.generic')
          : t('log.needsServer');
    setMessage({ text, error: true });
  };

  const go = (step: number) => {
    setDate(addDays(date, step));
    setMessage(undefined);
  };

  return (
    <main className="screen">
      {back}
      <h1>{t('nav.log')}</h1>
      <div className="row">
        <button
          type="button"
          aria-label={t('log.prev')}
          onClick={() => {
            go(-1);
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
            go(1);
          }}
        >
          ›
        </button>
      </div>
      {day && (
        <p>
          {t('status.net')} {formatMinutes(day.netMinutes)} h ·{' '}
          {t('log.target', { target: formatMinutes(day.targetMinutes) })} ·{' '}
          {t('log.dayStatus', { status: tr.status(day.status) })}
          {day.corrected && <span className="muted"> · {t('log.manual')}</span>}
        </p>
      )}
      {day && day.warnings.length > 0 && (
        <ul className="warnings">
          {day.warnings.map((w) => (
            <li key={w}>{tr.warning(w)}</li>
          ))}
        </ul>
      )}

      <section className="card" aria-labelledby="day-sessions">
        <h3 id="day-sessions">{t('log.sessions')}</h3>
        {day && day.sessions.length > 0 ? (
          <ul className="log">
            {day.sessions.map((s) => (
              <li key={s.id}>
                {t('log.session', {
                  from: formatClock(s.start, s.tz),
                  to: s.end ? formatClock(s.end, s.tz) : s.open ? t('log.open') : t('log.noEnd'),
                  work: formatMinutes(s.workMinutes),
                })}
                {s.confirmed === false && (
                  <span className="muted"> · {tr.eventType('session_reject')}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('log.empty')}</p>
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
                      onClick={() =>
                        void backend.manualRange('manual_work', b.from, b.to).then(() => {
                          done(t('settings.saved'));
                        }, fail)
                      }
                    >
                      {t('action.wasWork')}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {online && day && day.status !== 'open' && day.status !== 'confirmed' && (
          <div className="actions">
            <button
              type="button"
              onClick={() =>
                void backend.api.corrections.confirmDay(date).then(() => {
                  done(t('log.dayConfirmed'));
                }, fail)
              }
            >
              {t('log.confirmDay')}
            </button>
          </div>
        )}
      </section>

      {message && (
        <p
          role={message.error ? 'alert' : 'status'}
          className={message.error ? 'error' : undefined}
        >
          {message.text}
        </p>
      )}

      <CorrectionForm
        key={date}
        date={date}
        tz={tz}
        onSave={(body) =>
          backend.api.corrections.correct(date, body).then(() => {
            done(t('log.corrected'));
          }, fail)
        }
        onInvalid={(text) => {
          setMessage({ text, error: true });
        }}
      />

      {(extras.projects || extras.homeOffice) && (
        <DayExtras date={date} tz={tz} projects={extras.projects} location={extras.homeOffice} />
      )}

      <details>
        <summary>{t('log.details')}</summary>
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
      </details>
    </main>
  );
}

type FieldKind = CorrectionRequest['field'];
const FIELDS: readonly FieldKind[] = ['start', 'end', 'break', 'work'];

/** Beginn/Ende setzen oder einen Zeitraum als Pause bzw. Arbeit nachtragen (Uhrzeit des Tages in `tz`). */
function CorrectionForm({
  date,
  tz,
  onSave,
  onInvalid,
}: {
  date: string;
  tz: string;
  onSave: (body: CorrectionRequest) => Promise<void>;
  onInvalid: (message: string) => void;
}) {
  const { t } = useT();
  const id = useId();
  const [field, setField] = useState<FieldKind>('start');
  const [time, setTime] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const ranged = field === 'break' || field === 'work';
  const toIso = (hhmm: string) => new Date(zonedToUtc(date, hhmm, tz)).toISOString();

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const why = reason.trim() ? { reason: reason.trim() } : {};
    if (!ranged) {
      void onSave({ field, time: toIso(time), ...why });
      return;
    }
    const a = toIso(from);
    const b = toIso(to);
    if (Date.parse(b) <= Date.parse(a)) {
      onInvalid(t('log.invalidRange'));
      return;
    }
    void onSave({ field, from: a, to: b, ...why });
  };

  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t('log.correctTitle')}</h3>
      <form className="stack" onSubmit={submit}>
        <label>
          {t('log.field')}{' '}
          <select
            value={field}
            onChange={(e) => {
              setField(FIELDS.find((f) => f === e.target.value) ?? 'start');
            }}
          >
            {FIELDS.map((f) => (
              <option key={f} value={f}>
                {t(`log.field.${f}`)}
              </option>
            ))}
          </select>
        </label>
        {ranged ? (
          <div className="actions">
            <label>
              {t('log.from')}{' '}
              <input
                type="time"
                required
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                }}
              />
            </label>
            <label>
              {t('log.to')}{' '}
              <input
                type="time"
                required
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                }}
              />
            </label>
          </div>
        ) : (
          <label>
            {t('log.time')}{' '}
            <input
              type="time"
              required
              value={time}
              onChange={(e) => {
                setTime(e.target.value);
              }}
            />
          </label>
        )}
        <label>
          {t('log.reason')}
          <input
            type="text"
            maxLength={500}
            aria-describedby={`${id}-hint`}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
        </label>
        <p id={`${id}-hint`} className="muted">
          {t('log.reasonHint')}
        </p>
        <div className="actions">
          <button type="submit" className="primary">
            {t('log.saveCorrection')}
          </button>
        </div>
      </form>
    </section>
  );
}
