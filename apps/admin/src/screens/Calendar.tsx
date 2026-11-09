import type { CalendarProviderId } from '@timelog/shared';
import { L, dateTime, errorText } from '../texts.js';
import { ErrorText, Loading, useAdmin, useLoad } from '../ui.js';

const NAMES: Record<CalendarProviderId, string> = {
  google: L('Google Kalender', 'Google Calendar'),
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
        {L('Mein Kalender', 'My calendar')}
      </h1>
      <p className="muted">
        {L(
          'Nur lesend und nur für dich: Gespeichert werden Beginn, Ende und Art eines Termins – keine Titel, Teilnehmer oder Orte. Termine schlagen in „Zu prüfen“ vor, eine Pause als Arbeit zu werten, oder eine ganztägige Abwesenheit einzutragen. Gebucht wird nie automatisch. Admins sehen die Kalender anderer nicht.',
          'Read-only and only for you: only the start, end and type of an appointment are stored, never titles, attendees or locations. In “To review”, appointments suggest counting a break as work or entering a full-day absence. Nothing is ever booked automatically. Admins cannot see other people’s calendars.',
        )}
      </p>
      {result === 'connected' && (
        <p className="notice">{L('Kalender verbunden.', 'Calendar connected.')}</p>
      )}
      {result && result !== 'connected' && (
        <p role="alert" className="error">
          {L(`Kalender nicht verbunden (${result}).`, `Calendar not connected (${result}).`)}
        </p>
      )}
      <ErrorText text={status.error} />
      {!status.data && !status.error && <Loading what={L('Verbindungen', 'connections')} />}
      {status.data && !status.data.allowed && (
        <p>{L('In der Organisation ausgeschaltet.', 'Turned off for the organisation.')}</p>
      )}
      {status.data?.allowed &&
        status.data.providers.map(({ provider, configured }) => {
          const conn = status.data?.connections.find((c) => c.provider === provider);
          return (
            <div key={provider} className="card stack">
              <h2>{NAMES[provider]}</h2>
              {!configured && (
                <p className="muted">
                  {L('Auf diesem Server nicht eingerichtet.', 'Not set up on this server.')}
                </p>
              )}
              {conn && (
                <p>
                  {conn.status === 'error'
                    ? L(
                        `Abruf fehlgeschlagen (${conn.lastError ?? '?'}). Bitte neu verbinden.`,
                        `Fetch failed (${conn.lastError ?? '?'}). Please reconnect.`,
                      )
                    : conn.lastSyncAt
                      ? L(
                          `Verbunden · zuletzt abgerufen ${dateTime(conn.lastSyncAt)} · ${String(conn.entries)} Termine`,
                          `Connected · last fetched ${dateTime(conn.lastSyncAt)} · ${String(conn.entries)} appointments`,
                        )
                      : L('Verbunden · noch nicht abgerufen', 'Connected · not fetched yet')}
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
                    {L(`${NAMES[provider]} verbinden`, `Connect ${NAMES[provider]}`)}
                  </button>
                )}
                {conn && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        act(async () => {
                          const r = await api.calendar.sync(provider);
                          return L(
                            `${String(r.entries)} Termine abgerufen.`,
                            `${String(r.entries)} appointments fetched.`,
                          );
                        });
                      }}
                    >
                      {L('Jetzt abrufen', 'Fetch now')}
                      <span className="visually-hidden">: {NAMES[provider]}</span>
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        act(async () => {
                          await api.calendar.disconnect(provider);
                          return L(
                            'Verbindung getrennt, gespeicherte Termine gelöscht.',
                            'Disconnected, stored appointments deleted.',
                          );
                        });
                      }}
                    >
                      {L('Trennen', 'Disconnect')}
                      <span className="visually-hidden">: {NAMES[provider]}</span>
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
