// Einstellungen: Projekte ein-/ausschalten (Privatkonto), anlegen, Stichwörter, archivieren.
import { parseKeywords } from '@timelog/app-core';
import { useId, useState } from 'react';
import { useBackend, useT } from '../context.js';
import { useLoad } from '../useLoad.js';

export function ProjectSettings({ onChanged }: { onChanged: () => void }) {
  const backend = useBackend();
  const { t } = useT();
  const id = useId();
  const list = useLoad(() => backend.api.projects.list(), [backend]);
  const settings = useLoad(() => backend.api.settings.get(), [backend]);
  const [name, setName] = useState('');
  const [customer, setCustomer] = useState('');
  const [color, setColor] = useState('#1d4ed8');
  const [keywords, setKeywords] = useState('');
  const [message, setMessage] = useState<string>();

  const done = (text = t('settings.saved')) => {
    setMessage(text);
    list.reload();
    onChanged();
  };

  const toggle = async (enabled: boolean) => {
    if (!settings.data) return;
    try {
      settings.set(
        await backend.api.settings.put({
          settings: { ...settings.data.settings, projects: enabled },
        }),
      );
      done();
    } catch {
      setMessage(t('error.generic'));
    }
  };

  const add = async () => {
    try {
      await backend.api.projects.create({
        name: name.trim(),
        ...(customer.trim() ? { customer: customer.trim() } : {}),
        color,
        keywords: parseKeywords(keywords),
      });
      setName('');
      setCustomer('');
      setKeywords('');
      done();
    } catch {
      setMessage(t('error.generic'));
    }
  };

  const archive = async (projectId: string, archived: boolean) => {
    try {
      await backend.api.projects.update(projectId, { archived });
      done();
    } catch {
      setMessage(t('error.generic'));
    }
  };

  const data = list.data;
  if (!data) return null;
  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('projects.title')}</h2>
      {data.canManage ? (
        <div className="row">
          <input
            id={`${id}-enabled`}
            type="checkbox"
            checked={data.enabled}
            disabled={!settings.data}
            aria-describedby={`${id}-hint`}
            onChange={(e) => void toggle(e.target.checked)}
          />
          <label htmlFor={`${id}-enabled`}>{t('projects.enable')}</label>
        </div>
      ) : (
        <p>{data.enabled ? t('projects.orgManaged') : t('projects.off')}</p>
      )}
      <p id={`${id}-hint`} className="muted">
        {t('projects.enableHint')}
      </p>
      {data.enabled && (
        <>
          {data.projects.length === 0 ? (
            <p>{t('projects.none')}</p>
          ) : (
            <ul className="log">
              {data.projects.map((p) => (
                <li key={p.id} className="row">
                  <span>
                    <span aria-hidden="true" style={{ color: p.color }}>
                      ●
                    </span>{' '}
                    {p.name}
                    {p.customer && <span className="muted"> · {p.customer}</span>}
                    {p.keywords.length > 0 && (
                      <span className="muted"> · {p.keywords.join(', ')}</span>
                    )}
                    {p.archived && <span className="muted"> {t('projects.archived')}</span>}
                  </span>
                  {data.canManage && (
                    <button
                      type="button"
                      aria-label={`${t(p.archived ? 'projects.restore' : 'projects.archive')}: ${p.name}`}
                      onClick={() => void archive(p.id, !p.archived)}
                    >
                      {t(p.archived ? 'projects.restore' : 'projects.archive')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {data.canManage && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <label htmlFor={`${id}-name`}>{t('projects.name')}</label>
              <input
                id={`${id}-name`}
                required
                maxLength={100}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
              <label htmlFor={`${id}-customer`}>{t('projects.customer')}</label>
              <input
                id={`${id}-customer`}
                maxLength={100}
                value={customer}
                onChange={(e) => {
                  setCustomer(e.target.value);
                }}
              />
              <label htmlFor={`${id}-color`}>{t('projects.color')}</label>
              <input
                id={`${id}-color`}
                type="color"
                value={color}
                onChange={(e) => {
                  setColor(e.target.value);
                }}
              />
              <label htmlFor={`${id}-keywords`}>{t('projects.keywords')}</label>
              <input
                id={`${id}-keywords`}
                value={keywords}
                onChange={(e) => {
                  setKeywords(e.target.value);
                }}
              />
              <button type="submit" disabled={name.trim() === ''}>
                {t('projects.add')}
              </button>
            </form>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
