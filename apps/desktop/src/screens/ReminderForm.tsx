import {
  DEFAULT_REMINDERS,
  type MessageKey,
  REMINDER_KINDS,
  type ReminderKind,
  type ReminderSettings,
  remindersToAccount,
  weekdayName,
} from '@timelog/app-core';
import { type SyntheticEvent, useId, useState } from 'react';
import { useBackend, useT } from '../context.js';
import { refreshProfile } from '../profile.js';

const LABELS: Record<ReminderKind, MessageKey> = {
  end_forgotten: 'settings.reminder.end_forgotten',
  over_10h: 'settings.reminder.over_10h',
  break_missing: 'settings.reminder.break_missing',
};

/** Montag zuerst, Sonntag (0) zuletzt */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
const DEFAULT_WEEK_REVIEW = { enabled: true, weekday: 5, time: '15:00' };

/** Erinnerungen und Ruhezeit; gespeichert in den Kontoeinstellungen (für alle Geräte). */
export function ReminderForm({
  initial,
  onSaved,
}: {
  initial: ReminderSettings | undefined;
  onSaved: () => void;
}) {
  const backend = useBackend();
  const tr = useT();
  const { t } = tr;
  const id = useId();
  const [value, setValue] = useState<ReminderSettings>(initial ?? DEFAULT_REMINDERS);
  const week = value.weekReview ?? DEFAULT_WEEK_REVIEW;
  const [message, setMessage] = useState<string>();

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    void (async () => {
      try {
        const current = await backend.api.settings.get();
        await backend.api.settings.put({
          settings: {
            ...current.settings,
            notifications: { ...current.settings.notifications, ...remindersToAccount(value) },
          },
        });
        await refreshProfile(backend);
        setMessage(t('settings.saved'));
        onSaved();
      } catch {
        setMessage(t('error.generic'));
      }
    })();
  };

  return (
    <form onSubmit={submit}>
      <fieldset>
        <legend>{t('settings.reminders')}</legend>
        {REMINDER_KINDS.map((kind) => (
          <div className="row" key={kind}>
            <input
              id={`${id}-${kind}`}
              type="checkbox"
              checked={value.enabled[kind]}
              onChange={(e) => {
                setValue({ ...value, enabled: { ...value.enabled, [kind]: e.target.checked } });
              }}
            />
            <label htmlFor={`${id}-${kind}`}>{t(LABELS[kind])}</label>
          </div>
        ))}
        <div className="row">
          <input
            id={`${id}-confirmEnd`}
            type="checkbox"
            checked={value.confirmEnd ?? true}
            onChange={(e) => {
              setValue({ ...value, confirmEnd: e.target.checked });
            }}
          />
          <label htmlFor={`${id}-confirmEnd`}>{t('settings.reminder.confirmEnd')}</label>
        </div>
        <div className="row">
          <label htmlFor={`${id}-from`}>{t('settings.quietFrom')}</label>
          <input
            id={`${id}-from`}
            type="time"
            required
            value={value.quietFrom}
            onChange={(e) => {
              setValue({ ...value, quietFrom: e.target.value });
            }}
          />
          <label htmlFor={`${id}-to`}>{t('settings.quietTo')}</label>
          <input
            id={`${id}-to`}
            type="time"
            required
            value={value.quietTo}
            onChange={(e) => {
              setValue({ ...value, quietTo: e.target.value });
            }}
          />
        </div>
        <p className="muted">{t('settings.quietHint')}</p>
      </fieldset>
      <fieldset>
        <legend>{t('settings.weekReview')}</legend>
        <div className="row">
          <input
            id={`${id}-week`}
            type="checkbox"
            checked={week.enabled}
            onChange={(e) => {
              setValue({ ...value, weekReview: { ...week, enabled: e.target.checked } });
            }}
          />
          <label htmlFor={`${id}-week`}>{t('settings.weekReviewOn')}</label>
        </div>
        <div className="row">
          <label htmlFor={`${id}-weekday`}>{t('settings.weekReviewDay')}</label>
          <select
            id={`${id}-weekday`}
            value={week.weekday}
            disabled={!week.enabled}
            onChange={(e) => {
              setValue({ ...value, weekReview: { ...week, weekday: Number(e.target.value) } });
            }}
          >
            {WEEKDAYS.map((d) => (
              <option key={d} value={d}>
                {weekdayName(d, tr)}
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-weektime`}>{t('settings.weekReviewTime')}</label>
          <input
            id={`${id}-weektime`}
            type="time"
            required
            disabled={!week.enabled}
            value={week.time}
            onChange={(e) => {
              setValue({ ...value, weekReview: { ...week, time: e.target.value } });
            }}
          />
        </div>
      </fieldset>
      <button type="submit">{t('action.save')}</button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
