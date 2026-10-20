import type { CalendarProviderId } from '@timelog/shared';
import { dateTime, errorText } from '../texts.js';
import { ErrorText, Loading, useAdmin, useLoad } from '../ui.js';

const NAMES: Record<CalendarProviderId, string> = {
  google: 'Google Kalender',
  microsoft: 'Microsoft 365 / Outlook',
};

/** Eigener Kalender (nur lesend). Die Anmeldung beim Anbieter springt danach hierher zurück. */
export function Calendar({
  redirectTo,
  returnUrl,
  result,
}: {
  redirectTo: (url: string) => void;
  returnUrl: string;
  /** Ergebnis des Rücksprungs (?calendar=…) */
  result?: string;
}) {
  const { api, notify } = useAdmin();
  const status = useLoad(() => api.calendar.status(), [api]);

  const act = (task: () => Promise<string>) => {
    task().then(
      (text) => {
        notify(text);
        status.reload();
      },
      (err: unknown) => {
        notify(errorText(err));
      },
    );
  };

  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        Mein Kalender
      </h1>
      <p className="muted">
        Nur lesend und nur für dich: Gespeichert werden Beginn, Ende und Art eines Termins – keine
        Titel, Teilnehmer oder Orte. Termine schlagen in „Zu prüfen“ vor, eine Pause als Arbeit zu
        werten, oder eine ganztägige Abwesenheit einzutragen. Gebucht wird nie automatisch. Admins
        sehen die Kalender anderer nicht.
      </p>
      {result === 'connected' && <p className="notice">Kalender verbunden.</p>}
      {result && result !== 'connected' && (
        <p role="alert" className="error">
          Kalender nicht verbunden ({result}).
        </p>
      )}
      <ErrorText text={status.error} />
      {!status.data && !status.error && <Loading what="Verbindungen" />}
      {status.data && !status.data.allowed && <p>In der Organisation ausgeschaltet.</p>}
      {status.data?.allowed &&
        status.data.providers.map(({ provider, configured }) => {
          const conn = status.data?.connections.find((c) => c.provider === provider);
          return (
            <div key={provider} className="card stack">
              <h2>{NAMES[provider]}</h2>
              {!configured && <p className="muted">Auf diesem Server nicht eingerichtet.</p>}
              {conn && (
                <p>
                  {conn.status === 'error'
                    ? `Abruf fehlgeschlagen (${conn.lastError ?? '?'}). Bitte neu verbinden.`
                    : conn.lastSyncAt
                      ? `Verbunden · zuletzt abgerufen ${dateTime(conn.lastSyncAt)} · ${String(conn.entries)} Termine`
                      : 'Verbunden · noch nicht abgerufen'}
                </p>
              )}
              <div className="row">
                {configured && (!conn || conn.status === 'error') && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      api.calendar.connect(provider, returnUrl).then(
                        (r) => {
                          redirectTo(r.url);
                        },
                        (err: unknown) => {
                          notify(errorText(err));
                        },
                      );
                    }}
                  >
                    {NAMES[provider]} verbinden
                  </button>
                )}
                {conn && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        act(async () => {
                          const r = await api.calendar.sync(provider);
                          return `${String(r.entries)} Termine abgerufen.`;
                        });
                      }}
                    >
                      Jetzt abrufen<span className="visually-hidden">: {NAMES[provider]}</span>
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        act(async () => {
                          await api.calendar.disconnect(provider);
                          return 'Verbindung getrennt, gespeicherte Termine gelöscht.';
                        });
                      }}
                    >
                      Trennen<span className="visually-hidden">: {NAMES[provider]}</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
    </section>
  );
}
