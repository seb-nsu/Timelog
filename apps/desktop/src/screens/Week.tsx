// Wochenrückblick: Summen aus dem Regelwerk, „Woche bestätigen“ für unproblematische Tage.
// Mit Verbindung zählen die Tage des Servers (alle Geräte), sonst die Daten dieses Geräts.
import {
  type Profile,
  formatBalance,
  formatDate,
  formatMinutes,
  weekSummary,
} from '@timelog/app-core';
import { addDays, isoWeekOf, type WorkDay } from '@timelog/rules';
import { useEffect, useId, useState } from 'react';
import { useBackend, useT } from '../context.js';

type Remote = { week: string; days: WorkDay[] | null };

export function Week({
  localDays,
  profile,
  today,
  tz,
  initialDate,
  onOpenDay,
  onChanged,
}: {
  localDays: WorkDay[];
  profile: Profile | undefined;
  today: string;
  tz: string;
  initialDate?: string | undefined;
  onOpenDay: (date: string) => void;
  onChanged: () => void;
}) {
  const backend = useBackend();
  const tr = useT();
  const { t } = tr;
  const id = useId();
  const [date, setDate] = useState(initialDate ?? today);
  const [remote, setRemote] = useState<Remote>();
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const week = isoWeekOf(date);
  const locale = tr.locale === 'en' ? 'en-GB' : 'de-DE';

  useEffect(() => {
    let current = true;
    backend.api.days({ from: week.from, to: week.to }).then(
      (r) => {
        if (current) setRemote({ week: week.id, days: r.days });
      },
      () => {
        if (current) setRemote({ week: week.id, days: null });
      },
    );
    return () => {
      current = false;
    };
  }, [backend, week.id, week.from, week.to, version]);

  const loaded = remote?.week === week.id ? remote : undefined;
  const days = loaded ? (loaded.days ?? localDays) : undefined;
  const summary = days
    ? weekSummary(days, profile ?? { state: 'BE', timezone: tz }, date, today)
    : undefined;

  const confirmWeek = async (dates: string[], list: WorkDay[], online: boolean) => {
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

  const range = t('week.range', {
    week: Number(week.id.slice(-2)),
    from: formatDate(week.from, locale),
    to: formatDate(week.to, locale),
  });

  return (
    <main className="screen">
      <h1>{t('week.title')}</h1>
      <div className="row">
        <button
          type="button"
          aria-label={t('week.prev')}
          onClick={() => {
            setDate(addDays(week.from, -7));
            setMessage(undefined);
          }}
        >
          ‹
        </button>
        <h2 aria-live="polite">{range}</h2>
        <button
          type="button"
          aria-label={t('week.next')}
          disabled={week.to >= today}
          onClick={() => {
            setDate(addDays(week.from, 7));
            setMessage(undefined);
          }}
        >
          ›
        </button>
      </div>
      {!summary || !days ? (
        <p role="status">…</p>
      ) : (
        <>
          {loaded?.days === null && <p className="muted">{t('week.sourceLocal')}</p>}
          <dl className="summary">
            <dt>{t('week.work')}</dt>
            <dd>{`${formatMinutes(summary.workMinutes)} h`}</dd>
            <dt>{t('week.net')}</dt>
            <dd>{`${formatMinutes(summary.netMinutes)} h`}</dd>
            <dt>{t('week.target')}</dt>
            <dd>{`${formatMinutes(summary.targetMinutes)} h`}</dd>
            {summary.absenceMinutes > 0 && (
              <>
                <dt>{t('week.absences')}</dt>
                <dd>{`${formatMinutes(summary.absenceMinutes)} h`}</dd>
              </>
            )}
            <dt>{t('week.balance')}</dt>
            <dd>{`${formatBalance(summary.balanceMinutes)} h`}</dd>
          </dl>

          <section aria-labelledby={`${id}-open`}>
            <h3 id={`${id}-open`}>{t('week.open')}</h3>
            {summary.openDays.length === 0 ? (
              <p>{t('week.openNone')}</p>
            ) : (
              <>
                <p className="muted">{t('week.openHint')}</p>
                <ul className="log">
                  {summary.openDays.map((d) => {
                    const day = days.find((x) => x.date === d);
                    return (
                      <li key={d}>
                        <button
                          type="button"
                          className="link"
                          onClick={() => {
                            onOpenDay(d);
                          }}
                        >
                          {t('week.openDay', { date: formatDate(d, locale) })}
                        </button>
                        {day && day.warnings.length > 0 && (
                          <span className="muted">
                            {' '}
                            ({day.warnings.map((w) => tr.warning(w)).join(', ')})
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>

          <section aria-labelledby={`${id}-hints`}>
            <h3 id={`${id}-hints`}>{t('week.hints')}</h3>
            {summary.legalHints.length === 0 ? (
              <p>{t('week.hintsNone')}</p>
            ) : (
              <ul className="warnings">
                {summary.legalHints.map((h) => (
                  <li key={h.date}>
                    {`${formatDate(h.date, locale)}: ${h.warnings.map((w) => tr.warning(w)).join(', ')}`}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {summary.confirmableDays.length === 0 ? (
            <p>{t('week.nothing')}</p>
          ) : (
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={busy}
                aria-describedby={`${id}-confirm`}
                onClick={() => {
                  void confirmWeek(summary.confirmableDays, days, loaded?.days != null);
                }}
              >
                {t('week.confirm')}
              </button>
              <p id={`${id}-confirm`} className="muted">
                {t('week.confirmHint', { count: summary.confirmableDays.length })}
              </p>
            </div>
          )}
          {message && <p role="status">{message}</p>}
        </>
      )}
    </main>
  );
}
