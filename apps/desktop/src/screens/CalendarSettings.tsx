// Einstellungen: Kalender (Google, Microsoft 365) verbinden, abrufen, trennen. Die Anmeldung läuft im
// Browser; der Desktop zeigt die Adresse zum Öffnen bzw. Kopieren (kein Browser-Start aus der App).
import type { CalendarProviderId } from '@timelog/shared';
import { useId, useState } from 'react';
import { useBackend, useT } from '../context.js';
import { useLoad } from '../useLoad.js';

export function CalendarSettings({ onChanged }: { onChanged: () => void }) {
  const backend = useBackend();
  const tr = useT();
  const { t } = tr;
  const id = useId();
  const status = useLoad(() => backend.api.calendar.status(), [backend]);
  const [link, setLink] = useState<{ provider: CalendarProviderId; url: string }>();
  const [message, setMessage] = useState<string>();
  const locale = tr.locale === 'en' ? 'en-GB' : 'de-DE';
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(
      new Date(iso),
    );

  const run = async (action: () => Promise<string>) => {
    try {
      setMessage(await action());
      status.reload();
      onChanged();
    } catch {
      setMessage(t('error.generic'));
    }
  };

  const data = status.data;
  if (!data) return null;
  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('calendar.title')}</h2>
      <p className="muted">{t('calendar.hint')}</p>
      {!data.allowed && <p>{t('calendar.notAllowed')}</p>}
      {data.allowed &&
        data.providers.map(({ provider, configured }) => {
          const name = t(`calendar.${provider}`);
          const conn = data.connections.find((c) => c.provider === provider);
          return (
            <div key={provider} className="stack">
              <h3>{name}</h3>
              {!configured && <p className="muted">{t('calendar.notConfigured')}</p>}
              {configured && conn && (
                <>
                  <p className={conn.status === 'error' ? 'error' : undefined}>
                    {conn.status === 'error'
                      ? t('calendar.error', { code: conn.lastError ?? '?' })
                      : conn.lastSyncAt
                        ? t('calendar.connected', { time: when(conn.lastSyncAt) })
                        : t('calendar.never')}
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      aria-label={`${t('calendar.sync')}: ${name}`}
                      onClick={() =>
                        void run(async () => {
                          const r = await backend.api.calendar.sync(provider);
                          return t('calendar.synced', { count: r.entries });
                        })
                      }
                    >
                      {t('calendar.sync')}
                    </button>
                    <button
                      type="button"
                      aria-label={`${t('calendar.disconnect')}: ${name}`}
                      onClick={() =>
                        void run(async () => {
                          await backend.api.calendar.disconnect(provider);
                          return t('calendar.disconnected');
                        })
                      }
                    >
                      {t('calendar.disconnect')}
                    </button>
                  </div>
                </>
              )}
              {configured && (!conn || conn.status === 'error') && (
                <button
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      const r = await backend.api.calendar.connect(provider);
                      setLink({ provider, url: r.url });
                      return t('calendar.openHint');
                    })
                  }
                >
                  {t('calendar.connect', { provider: name })}
                </button>
              )}
              {link?.provider === provider && (
                <div className="stack">
                  <label htmlFor={`${id}-${provider}-url`}>{t('calendar.openHint')}</label>
                  <input id={`${id}-${provider}-url`} readOnly value={link.url} />
                  <button
                    type="button"
                    onClick={() => {
                      void Promise.resolve()
                        .then(() => navigator.clipboard.writeText(link.url))
                        .then(
                          () => {
                            setMessage(t('calendar.copied'));
                          },
                          () => {
                            setMessage(t('error.generic'));
                          },
                        );
                    }}
                  >
                    {t('calendar.copy')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
