import type { Profile } from '@timelog/app-core';
import { selectableProjects } from '@timelog/app-core';
import type { WorkLocation } from '@timelog/rules';
import type { NetworksResponse, ProjectsResponse } from '@timelog/shared';
import { useCallback, useEffect, useId, useState } from 'react';
import type { AppState } from '../backend.js';
import { useBackend, useT } from '../context.js';
import { CalendarSettings } from './CalendarSettings.js';
import { AddCurrentNetwork } from './NetworkStep.js';
import { ProjectSettings } from './ProjectSettings.js';
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
  const [projects, setProjects] = useState<ProjectsResponse>();

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

  const loadProjects = useCallback(() => {
    backend.api.projects.list().then(setProjects, () => {
      setProjects(undefined);
    });
  }, [backend]);

  const updateNetwork = async (
    networkId: string,
    body: { location?: WorkLocation; defaultProjectId?: string | null },
  ) => {
    try {
      await backend.api.networks.update(networkId, body);
      loadNetworks();
      setNetMessage(t('settings.saved'));
    } catch {
      setNetMessage(t('error.generic'));
    }
  };
  const [netMessage, setNetMessage] = useState<string>();

  useEffect(() => {
    loadNetworks();
    loadProjects();
    void backend.autostart.isEnabled().then(setAutostart);
  }, [backend, loadNetworks, loadProjects]);

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
              <li key={n.id} className="stack">
                <span>
                  {n.label}{' '}
                  {n.scope === 'org' && (
                    <span className="muted">
                      {t('settings.orgNetwork')} · {t(`location.${n.location}`)}
                    </span>
                  )}
                </span>
                {n.scope === 'user' && (
                  <div className="actions">
                    <label htmlFor={`${id}-loc-${n.id}`}>
                      {t('location.ofNetwork', { label: n.label })}
                    </label>
                    <select
                      id={`${id}-loc-${n.id}`}
                      value={n.location}
                      onChange={(e) =>
                        void updateNetwork(n.id, { location: e.target.value as WorkLocation })
                      }
                    >
                      {(['office', 'home', 'other'] as const).map((l) => (
                        <option key={l} value={l}>
                          {t(`location.${l}`)}
                        </option>
                      ))}
                    </select>
                    {projects?.enabled && (
                      <>
                        <label htmlFor={`${id}-prj-${n.id}`}>
                          {t('projects.defaultProject')} ({n.label})
                        </label>
                        <select
                          id={`${id}-prj-${n.id}`}
                          value={n.defaultProjectId ?? ''}
                          onChange={(e) =>
                            void updateNetwork(n.id, {
                              defaultProjectId: e.target.value === '' ? null : e.target.value,
                            })
                          }
                        >
                          <option value="">{t('projects.noDefault')}</option>
                          {selectableProjects(projects.projects, n.defaultProjectId).map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                    <button
                      type="button"
                      aria-label={`${t('settings.remove')}: ${n.label}`}
                      onClick={() => void backend.api.networks.remove(n.id).then(loadNetworks)}
                    >
                      {t('settings.remove')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <AddCurrentNetwork onAdded={loadNetworks} />
        {netMessage && <p role="status">{netMessage}</p>}
      </section>

      <ProjectSettings onChanged={loadProjects} />

      <CalendarSettings onChanged={onSaved} />

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
