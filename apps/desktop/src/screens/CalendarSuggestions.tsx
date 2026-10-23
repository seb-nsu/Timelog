// „Zu prüfen“: Vorschläge aus dem Kalender. Nichts wird automatisch gebucht; erst ein Klick erzeugt
// ein manual_work-Ereignis bzw. eine Abwesenheit.
import { formatClock, formatDate, suggestionKey, suggestionRange } from '@timelog/app-core';
import type { WorkDay } from '@timelog/rules';
import { useState } from 'react';
import { useBackend, useT } from '../context.js';
import { refreshProfile } from '../profile.js';
import { useLoad } from '../useLoad.js';

const HIDDEN_KEY = 'calendar.hidden';

export function CalendarSuggestions({
  days,
  today,
  tz,
  onChanged,
}: {
  days: WorkDay[];
  today: string;
  tz: string;
  onChanged: () => void;
}) {
  const backend = useBackend();
  const tr = useT();
  const { t } = tr;
  const locale = tr.locale === 'en' ? 'en-GB' : 'de-DE';
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(backend.storage.get(HIDDEN_KEY) ?? '[]') as unknown;
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  });
  const [message, setMessage] = useState<string>();
  const status = useLoad(() => backend.api.calendar.status(), [backend]);
  const connected = (status.data?.connections.length ?? 0) > 0;
  const sug = useLoad(
    () =>
      connected
        ? backend.api.calendar.suggestions(suggestionRange(today))
        : Promise.resolve({ gaps: [], absences: [] }),
    [backend, today, connected],
  );

  const hide = (key: string) => {
    const next = [...hidden, key].slice(-200);
    setHidden(next);
    backend.storage.set(HIDDEN_KEY, JSON.stringify(next));
  };

  const wasWork = async (from: string, to: string) => {
    await backend.manualRange('manual_work', from, to);
    hide(`${from}/${to}`);
    onChanged();
  };

  const addAbsence = async (date: string) => {
    try {
      const minutes = days.find((d) => d.date === date)?.targetMinutes ?? 0;
      await backend.api.absences.put({
        from: date,
        to: date,
        absences: [{ date, kind: 'vacation', minutes }],
      });
      await refreshProfile(backend);
      hide(date);
      setMessage(t('settings.saved'));
      onChanged();
    } catch {
      setMessage(t('error.generic'));
    }
  };

  const gaps = (sug.data?.gaps ?? []).filter((g) => !hidden.includes(suggestionKey(g)));
  const absences = (sug.data?.absences ?? []).filter((a) => !hidden.includes(suggestionKey(a)));
  if (gaps.length === 0 && absences.length === 0)
    return message ? <p role="status">{message}</p> : null;

  return (
    <section aria-labelledby="calendar-suggestions">
      <h3 id="calendar-suggestions">{t('suggest.title')}</h3>
      <ul className="cards">
        {gaps.map((g) => {
          const label = t(g.kind === 'break' ? 'suggest.break' : 'suggest.gap', {
            from: formatClock(g.from, tz),
            to: formatClock(g.to, tz),
          });
          const full = `${formatDate(g.date, locale)} · ${label}`;
          return (
            <li key={suggestionKey(g)}>
              <p>{full}</p>
              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  aria-label={`${t('suggest.wasMeeting')}: ${full}`}
                  onClick={() => void wasWork(g.from, g.to)}
                >
                  {t('suggest.wasMeeting')}
                </button>
                <button
                  type="button"
                  aria-label={`${t('suggest.dismiss')}: ${full}`}
                  onClick={() => {
                    hide(suggestionKey(g));
                  }}
                >
                  {t('suggest.dismiss')}
                </button>
              </div>
            </li>
          );
        })}
        {absences.map((a) => {
          const full = `${formatDate(a.date, locale)} · ${t('suggest.absence')}`;
          return (
            <li key={a.date}>
              <p>{full}</p>
              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  aria-label={`${t('suggest.addAbsence')}: ${full}`}
                  onClick={() => void addAbsence(a.date)}
                >
                  {t('suggest.addAbsence')}
                </button>
                <button
                  type="button"
                  aria-label={`${t('suggest.dismiss')}: ${full}`}
                  onClick={() => {
                    hide(a.date);
                  }}
                >
                  {t('suggest.dismiss')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
