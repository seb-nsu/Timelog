// Tagesprotokoll: Projektaufteilung mit manueller Zuordnung je Zeitabschnitt und Arbeitsort des Tages.
// Die Aufteilung rechnet der Server mit @timelog/rules; hier wird nur angezeigt und zugeordnet.
import {
  formatClock,
  formatMinutes,
  projectName,
  selectableProjects,
  sortShares,
} from '@timelog/app-core';
import type { WorkLocation } from '@timelog/rules';
import { useId, useState } from 'react';
import { useBackend, useT } from '../context.js';
import { useLoad } from '../useLoad.js';

const LOCATIONS: readonly WorkLocation[] = ['office', 'home', 'other'];
const NONE = '';

export function DayExtras({ date, tz }: { date: string; tz: string }) {
  const backend = useBackend();
  const { t } = useT();
  const id = useId();
  const [message, setMessage] = useState<string>();
  const list = useLoad(() => backend.api.projects.list(), [backend]);
  const day = useLoad(() => backend.api.projects.day(date), [backend, date]);
  const year = Number(date.slice(0, 4));
  const locations = useLoad(() => backend.api.locations.year(year), [backend, year]);
  const projects = list.data?.projects ?? [];
  const loc = locations.data?.days.find((d) => d.date === date);
  const locked = day.data?.locked === true;

  const assign = async (from: string, to: string, value: string) => {
    try {
      day.set(
        await backend.api.projects.assign(date, {
          from,
          to,
          projectId: value === NONE ? null : value,
        }),
      );
      setMessage(t('settings.saved'));
    } catch {
      setMessage(t('error.generic'));
    }
  };

  const setLocation = async (value: string) => {
    try {
      await backend.api.locations.set(date, value === NONE ? null : (value as WorkLocation));
      locations.reload();
      setMessage(t('settings.saved'));
    } catch {
      setMessage(t('error.generic'));
    }
  };

  return (
    <>
      {list.data?.enabled && day.data && (
        <section className="card" aria-labelledby={`${id}-projects`}>
          <h3 id={`${id}-projects`}>{t('projects.day')}</h3>
          {day.data.day.items.length === 0 ? (
            <p>{t('log.empty')}</p>
          ) : (
            <ul className="log">
              {sortShares(day.data.day.items, projects).map((i) => (
                <li key={i.projectId ?? 'none'}>
                  {t('projects.share', {
                    name: projectName(projects, i.projectId, t('projects.unassigned')),
                    time: formatMinutes(i.netMinutes),
                  })}
                  {i.manual && <span className="muted"> ({t('projects.manual')})</span>}
                  {i.topUpMinutes > 0 && (
                    <span className="muted">
                      {' '}
                      · {t('projects.topUp', { minutes: i.topUpMinutes })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {locked ? (
            <p>{t('projects.locked')}</p>
          ) : (
            <ul className="log">
              {day.data.segments.map((s) => {
                const label = t('projects.assign', {
                  from: formatClock(s.from, tz),
                  to: formatClock(s.to, tz),
                });
                const fieldId = `${id}-${s.from}`;
                return (
                  <li key={s.from} className="row">
                    <label htmlFor={fieldId}>{label}</label>
                    <select
                      id={fieldId}
                      value={s.projectId ?? NONE}
                      onChange={(e) => void assign(s.from, s.to, e.target.value)}
                    >
                      <option value={NONE}>{t('projects.unassigned')}</option>
                      {selectableProjects(projects, s.projectId).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      {locations.data && (
        <div className="row">
          <label htmlFor={`${id}-location`}>{t('location.title')}</label>
          <select
            id={`${id}-location`}
            value={loc?.source === 'manual' ? (loc.location ?? NONE) : NONE}
            disabled={locked}
            aria-describedby={`${id}-location-hint`}
            onChange={(e) => void setLocation(e.target.value)}
          >
            <option value={NONE}>
              {t('location.auto')}
              {loc?.source === 'auto' && loc.location ? `: ${t(`location.${loc.location}`)}` : ''}
            </option>
            {LOCATIONS.map((l) => (
              <option key={l} value={l}>
                {t(`location.${l}`)}
              </option>
            ))}
          </select>
          <span id={`${id}-location-hint`} className="muted">
            {loc?.source === 'manual' ? t('location.manual') : ''}
          </span>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </>
  );
}
