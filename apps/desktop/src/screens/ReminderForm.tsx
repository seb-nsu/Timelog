import {
  DEFAULT_REMINDERS,
  type MessageKey,
  REMINDER_KINDS,
  type ReminderKind,
  type ReminderSettings,
  remindersToAccount,
} from '@timelog/app-core';
import { type SyntheticEvent, useId, useState } from 'react';
import { useBackend, useT } from '../context.js';
import { refreshProfile } from '../profile.js';

const LABELS: Record<ReminderKind, MessageKey> = {
  end_forgotten: 'settings.reminder.end_forgotten',
  over_10h: 'settings.reminder.over_10h',
  break_missing: 'settings.reminder.break_missing',
};

/** Erinnerungen und Ruhezeit; gespeichert in den Kontoeinstellungen (für alle Geräte). */
export function ReminderForm({
  initial,
  onSaved,
}: {
  initial: ReminderSettings | undefined;
  onSaved: () => void;
}) {
  const backend = useBackend();
  const { t } = useT();
  const id = useId();
  const [value, setValue] = useState<ReminderSettings>(initial ?? DEFAULT_REMINDERS);
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
      <button type="submit">{t('action.save')}</button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
