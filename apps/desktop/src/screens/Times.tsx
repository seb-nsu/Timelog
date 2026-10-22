// Zeiten: Woche oder Monat mit Soll/Ist und Tagesliste, ein Tag zum Prüfen und Korrigieren,
// Export und – nur mit Zusatzfunktionen – die Auswertung. Ersetzt Tagesprotokoll, Wochenrückblick und Auswertung.
import {
  type LocalEvent,
  type Profile,
  formatBalance,
  formatDate,
  formatMinutes,
  periodDays,
  weekSummary,
} from '@timelog/app-core';
import { addDays, isoWeekOf, type WorkDay } from '@timelog/rules';
import { useEffect, useId, useState } from 'react';
import { useBackend, useT } from '../context.js';
import type { Extras } from '../useExtras.js';
import { saveFile } from '../useLoad.js';
import { DayLog } from './DayLog.js';
import { Reports } from './Reports.js';

export interface TimesTarget {
  view: 'period' | 'day';
  date: string;
}

type View = { name: 'period' | 'day'; date: string } | { name: 'reports' };

export function Times({
  days,
  events,
  profile,
  today,
  tz,
  extras,
  initial,
  onChanged,
}: {
  days: WorkDay[];
  events: LocalEvent[];
  profile: Profile | undefined;
  today: string;
  tz: string;
  extras: Extras;
  initial?: TimesTarget | undefined;
  onChanged: () => void;
}) {
  const { t } = useT();
  const [view, setView] = useState<View>(
    initial ? { name: initial.view, date: initial.date } : { name: 'period', date: today },
  );
  // Rückweg in den Zeitraum, aus dem der Tag geöffnet wurde
  const [periodDate, setPeriodDate] = useState(initial?.date ?? today);
  const back = (
    <button
      type="button"
      className="link"
      onClick={() => {
        setView({ name: 'period', date: periodDate });
      }}
    >
      ‹ {t('times.back')}
    </button>
  );

  if (view.name === 'day') {
    return (
      <DayLog
        days={days}
        events={events}
        today={today}
        tz={tz}
        extras={extras}
        initialDate={view.date}
        back={back}
        onChanged={onChanged}
      />
    );
  }
  if (view.name === 'reports') return <Reports today={today} extras={extras} back={back} />;
  return (
    <Period
      localDays={days}
      profile={profile}
      today={today}
      tz={tz}
      initialDate={view.date}
      showReports={extras.projects || extras.homeOffice}
      onOpenDay={(date, from) => {
        setPeriodDate(from);
        setView({ name: 'day', date });
      }}
      onOpenReports={(from) => {
        setPeriodDate(from);
        setView({ name: 'reports' });
      }}
      onChanged={onChanged}
    />
  );
}

type Mode = 'week' | 'month';
type Remote = { key: string; days: WorkDay[] | null };

function monthRange(date: string): { from: string; to: string } {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const month = date.slice(0, 7);
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** Woche oder Monat. Mit Verbindung zählen die Tage des Servers (alle Geräte), sonst dieses Geräts. */
function Period({
  localDays,
  profile,
  today,
  tz,
  initialDate,
  showReports,
  onOpenDay,
  onOpenReports,
  onChanged,
}: {
  localDays: WorkDay[];
  profile: Profile | undefined;
  today: string;
  tz: string;
  initialDate: string;
  showReports: boolean;
  onOpenDay: (date: string, periodDate: string) => void;
  onOpenReports: (periodDate: string) => void;
  onChanged: () => void;
}) {
  const backend = useBackend();
  const tr = useT();
  const { t } = tr;
  const id = useId();
  const locale = tr.locale === 'en' ? 'en-GB' : 'de-DE';
  const [mode, setMode] = useState<Mode>('week');
  const [date, setDate] = useState(initialDate);
  const [remote, setRemote] = useState<Remote>();
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const week = isoWeekOf(date);
  const range = mode === 'week' ? { from: week.from, to: week.to } : monthRange(date);
  const key = `${range.from}/${range.to}`;
  const p: Profile = profile ?? { state: 'BE', timezone: tz };

  useEffect(() => {
    let current = true;
    backend.api.days({ from: range.from, to: range.to }).then(
      (r) => {
        if (current) setRemote({ key, days: r.days });
      },
      () => {
        if (current) setRemote({ key, days: null });
      },
    );
    return () => {
      current = false;
    };
  }, [backend, range.from, range.to, key, version]);

  const loaded = remote?.key === key ? remote : undefined;
  const days = loaded ? (loaded.days ?? localDays) : undefined;
  const online = loaded?.days != null;
  const period = days ? periodDays(days, p, range.from, range.to, today) : undefined;
  const summary = days && mode === 'week' ? weekSummary(days, p, date, today) : undefined;
  const workMinutes = period ? period.days.reduce((s, d) => s + d.workMinutes, 0) : 0;

  const move = (step: number) => {
    setMessage(undefined);
    if (mode === 'week') {
      setDate(addDays(week.from, 7 * step));
      return;
    }
    const [y, m] = date.split('-').map(Number) as [number, number];
    const first = new Date(Date.UTC(y, m - 1 + step, 1));
    setDate(first.toISOString().slice(0, 10));
  };

  const confirmWeek = async (dates: string[], list: WorkDay[]) => {
    setBusy(true);
    setMessage(undefined);
    try {
      let count = 0;
      for (const d of dates) {
        if (online) {
          await backend.api.corrections.confirmDay(d);
        } else {
          const day = list.find((x) => x.date === d);
          for (const s of day?.sessions ?? []) {
            if (s.confirmed === undefined && !s.open) await backend.decideSession(s.id, true);
          }
        }
        count += 1;
      }
      setMessage(t('week.confirmed', { count }));
      setVersion((v) => v + 1);
      onChanged();
    } catch {
      setMessage(t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    try {
      const blob = await backend.api.export({ ...range, format: 'csv' });
      saveFile(await blob.text(), `timelog_${range.from}_${range.to}.csv`);
      setMessage(t('export.done'));
    } catch {
      setMessage(t('times.exportNeedsServer'));
    }
  };

  const title =
    mode === 'week'
      ? t('week.range', {
          week: Number(week.id.slice(-2)),
          from: formatDate(week.from, locale),
          to: formatDate(week.to, locale),
        })
      : new Date(`${range.from}T12:00:00Z`).toLocaleDateString(locale, {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        });

  return (
    <main className="screen">
      <h1>{t('times.title')}</h1>
      <div className="actions" role="group" aria-label={t('times.period')}>
        {(['week', 'month'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            className={mode === m ? 'primary' : undefined}
            onClick={() => {
              setMode(m);
              setMessage(undefined);
            }}
          >
            {t(`times.${m}`)}
          </button>
        ))}
      </div>
      <div className="row">
        <button
          type="button"
          aria-label={t(mode === 'week' ? 'week.prev' : 'times.prevMonth')}
          onClick={() => {
            move(-1);
          }}
        >
          ‹
        </button>
        <h2 aria-live="polite">{title}</h2>
        <button
          type="button"
          aria-label={t(mode === 'week' ? 'week.next' : 'times.nextMonth')}
          disabled={range.to >= today}
          onClick={() => {
            move(1);
          }}
        >
          ›
        </button>
      </div>
      {!period || !days ? (
        <p role="status">…</p>
      ) : (
        <>
          {!online && <p className="muted">{t('week.sourceLocal')}</p>}
          <dl className="summary">
            <dt>{t('week.net')}</dt>
            <dd>{`${formatMinutes(period.netMinutes)} h`}</dd>
            <dt>{t('week.target')}</dt>
            <dd>{`${formatMinutes(period.targetMinutes)} h`}</dd>
            {period.absenceMinutes > 0 && (
              <>
                <dt>{t('week.absences')}</dt>
                <dd>{`${formatMinutes(period.absenceMinutes)} h`}</dd>
              </>
            )}
            <dt>{t('week.balance')}</dt>
            <dd>{`${formatBalance(period.balanceMinutes)} h`}</dd>
          </dl>
          {workMinutes > period.netMinutes && (
            <p className="muted">{t('week.topUp', { work: formatMinutes(workMinutes) })}</p>
          )}

          <section aria-labelledby={`${id}-days`}>
            <h3 id={`${id}-days`}>{t('times.days')}</h3>
            <ul className="days">
              {period.days
                .filter((d) => d.date <= today)
                .map((d) => (
                  <li key={d.date}>
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        onOpenDay(d.date, date);
                      }}
                    >
                      {formatDate(d.date, locale)}
                    </button>
                    <span>
                      {t('times.dayRow', {
                        net: formatMinutes(d.netMinutes + d.absenceMinutes),
                        target: formatMinutes(d.targetMinutes),
                      })}
                    </span>
                    {d.warnings.length > 0 && (
                      <span className="muted">
                        ⚠ {d.warnings.map((w) => tr.warning(w)).join(', ')}
                      </span>
                    )}
                  </li>
                ))}
            </ul>
          </section>

          {summary && summary.legalHints.length > 0 && (
            <section aria-labelledby={`${id}-hints`}>
              <h3 id={`${id}-hints`}>{t('week.hints')}</h3>
              <ul className="warnings">
                {summary.legalHints.map((h) => (
                  <li key={h.date}>
                    {`${formatDate(h.date, locale)}: ${h.warnings.map((w) => tr.warning(w)).join(', ')}`}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {summary &&
            (summary.confirmableDays.length === 0 ? (
              <p>{t('week.nothing')}</p>
            ) : (
              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  aria-describedby={`${id}-confirm`}
                  onClick={() => {
                    void confirmWeek(summary.confirmableDays, days);
                  }}
                >
                  {t('week.confirm')}
                </button>
                <p id={`${id}-confirm`} className="muted">
                  {t('week.confirmHint', { count: summary.confirmableDays.length })}
                </p>
              </div>
            ))}

          <section className="card" aria-labelledby={`${id}-export`}>
            <h3 id={`${id}-export`}>{t('times.export')}</h3>
            <p className="muted">{t('times.exportHint')}</p>
            <div className="actions">
              <button type="button" onClick={() => void exportCsv()}>
                {t('export.csv')}
              </button>
              {showReports && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenReports(date);
                  }}
                >
                  {t('nav.reports')}
                </button>
              )}
            </div>
          </section>
          {message && <p role="status">{message}</p>}
        </>
      )}
    </main>
  );
}
