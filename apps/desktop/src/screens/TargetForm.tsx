import { STATE_NAMES } from '@timelog/app-core';
import { GERMAN_STATES, type GermanState, localDate } from '@timelog/rules';
import { type SyntheticEvent, useId, useState } from 'react';
import { useBackend, useT } from '../context.js';
import { refreshProfile } from '../profile.js';

type Week = [number, number, number, number, number, number, number];
/** Anzeige-Reihenfolge Montag bis Sonntag (Index 0 = Sonntag). */
const ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

function weekdayName(index: number, locale: string): string {
  // 2026-10-11 ist ein Sonntag
  const date = new Date(Date.UTC(2026, 9, 11 + index, 12));
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(date);
}

export function TargetForm({
  initialState,
  initialWeek,
  timezone,
  onSaved,
}: {
  initialState: GermanState;
  initialWeek: Week;
  timezone: string;
  onSaved: () => void;
}) {
  const backend = useBackend();
  const tr = useT();
  const { t } = tr;
  const id = useId();
  const [state, setState] = useState<GermanState>(initialState);
  const [hours, setHours] = useState<string[]>(initialWeek.map((m) => String(m / 60)));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const minutes = hours.map((h) => Math.round(Number(h.replace(',', '.')) * 60));
    if (minutes.some((m) => !Number.isFinite(m) || m < 0 || m > 1440)) {
      setError(t('error.generic'));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await backend.api.settings.put({ state });
      await backend.api.targetHours.put({
        validFrom: localDate(Date.now(), timezone),
        minutesByWeekday: minutes as Week,
      });
      await refreshProfile(backend);
      onSaved();
    } catch {
      setError(t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  const locale = tr.locale === 'en' ? 'en-GB' : 'de-DE';
  return (
    <form onSubmit={(e) => void submit(e)}>
      <label htmlFor={`${id}-state`}>{t('setup.state')}</label>
      <select
        id={`${id}-state`}
        value={state}
        onChange={(e) => {
          setState(e.target.value as GermanState);
        }}
      >
        {[...GERMAN_STATES]
          .sort((a, b) => STATE_NAMES[a].localeCompare(STATE_NAMES[b], 'de'))
          .map((s) => (
            <option key={s} value={s}>
              {STATE_NAMES[s]}
            </option>
          ))}
      </select>
      <fieldset>
        <legend>{t('setup.hours')}</legend>
        {ORDER.map((day) => (
          <div className="row" key={day}>
            <label htmlFor={`${id}-d${String(day)}`}>{weekdayName(day, locale)}</label>
            <input
              id={`${id}-d${String(day)}`}
              type="number"
              min={0}
              max={24}
              step={0.25}
              inputMode="decimal"
              value={hours[day]}
              onChange={(e) => {
                const next = [...hours];
                next[day] = e.target.value;
                setHours(next);
              }}
            />
          </div>
        ))}
      </fieldset>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button type="submit" className="primary" disabled={busy}>
        {t('action.save')}
      </button>
    </form>
  );
}
