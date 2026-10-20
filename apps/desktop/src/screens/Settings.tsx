import type { Profile } from '@timelog/app-core';
import type { NetworksResponse } from '@timelog/shared';
import { useCallback, useEffect, useId, useState } from 'react';
import type { AppState } from '../backend.js';
import { useBackend, useT } from '../context.js';
import { AddCurrentNetwork } from './NetworkStep.js';
import { ReminderForm } from './ReminderForm.js';
import { TargetForm } from './TargetForm.js';

type Week = [number, number, number, number, number, number, number];
const DEFAULT_WEEK: Week = [0, 480, 480, 480, 480, 480, 0];

export function Settings({
  state,
  profile,
  onLogout,
  onSaved,
}: {
  state: AppState;
  profile: Profile | undefined;
  onLogout: () => void;
  onSaved: () => void;
}) {
  const backend = useBackend();
  const { t } = useT();
  const id = useId();
  const [networks, setNetworks] = useState<NetworksResponse['networks']>();
  const [autostart, setAutostart] = useState<boolean>();
  const [message, setMessage] = useState<string>();

  const loadNetworks = useCallback(() => {
    backend.api.networks.get().then(
      (r) => {
        setNetworks(r.networks);
      },
      () => {
        setNetworks(undefined);
      },
    );
  }, [backend]);

  useEffect(() => {
    loadNetworks();
    void backend.autostart.isEnabled().then(setAutostart);
  }, [backend, loadNetworks]);

  const week = profile?.targetSchedule?.at(-1)?.minutesByWeekday ?? DEFAULT_WEEK;

  return (
    <main className="screen">
      <h1>{t('nav.settings')}</h1>

      <section className="card">
        <h2>{t('settings.account')}</h2>
        {state.baseUrl && <p>{t('settings.server', { url: state.baseUrl })}</p>}
        <button
          type="button"
          onClick={() => {
            void backend.logout().then(onLogout);
          }}
        >
          {t('action.logout')}
        </button>
      </section>

      <section className="card">
        <h2>{t('setup.target')}</h2>
        <TargetForm
          initialState={profile?.state ?? 'BE'}
          initialWeek={week}
          timezone={profile?.timezone ?? state.tracker.timezone}
          onSaved={() => {
            setMessage(t('settings.saved'));
          }}
        />
        {message && <p role="status">{message}</p>}
      </section>

      <section className="card">
        <h2>{t('settings.networks')}</h2>
        {networks && networks.length === 0 && <p>{t('settings.noNetworks')}</p>}
        {networks && networks.length > 0 && (
          <ul className="log">
            {networks.map((n) => (
              <li key={n.id}>
                {n.label}{' '}
                {n.scope === 'org' && <span className="muted">{t('settings.orgNetwork')}</span>}
                {n.scope === 'user' && (
                  <button
                    type="button"
                    aria-label={`${t('settings.remove')}: ${n.label}`}
                    onClick={() => void backend.api.networks.remove(n.id).then(loadNetworks)}
                  >
                    {t('settings.remove')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <AddCurrentNetwork onAdded={loadNetworks} />
      </section>

      <section className="card">
        <h2>{t('settings.reminders')}</h2>
        <ReminderForm initial={profile?.reminders} onSaved={onSaved} />
      </section>

      <section className="card">
        <h2>{t('settings.general')}</h2>
        <div className="row">
          <input
            id={`${id}-autostart`}
            type="checkbox"
            checked={autostart ?? false}
            disabled={autostart === undefined}
            onChange={(e) => {
              const enabled = e.target.checked;
              void backend.autostart.set(enabled).then(() => {
                setAutostart(enabled);
              });
            }}
          />
          <label htmlFor={`${id}-autostart`}>{t('settings.autostart')}</label>
        </div>
      </section>
    </main>
  );
}
