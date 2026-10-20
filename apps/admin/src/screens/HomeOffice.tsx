import { monthNames } from '@timelog/app-core';
import { ApiError } from '@timelog/shared';
import { useState } from 'react';
import { ErrorText, Loading, useAdmin, useLoad } from '../ui.js';

/**
 * Homeoffice-Tage je Monat und Mitglied – nur die Anzahl, keine Tagesdetails oder Orte. Nur sichtbar,
 * wenn die Organisation es eingeschaltet hat; jeder Abruf wird im Audit-Log vermerkt.
 */
export function HomeOffice() {
  const { api, now } = useAdmin();
  const [year, setYear] = useState(() => new Date(now()).getFullYear());
  const data = useLoad(
    () =>
      api.org.homeOffice(year).catch((err: unknown) => {
        if (err instanceof ApiError && err.code === 'feature_disabled') return null;
        throw err;
      }),
    [api, year],
  );
  const months = monthNames('de-DE');

  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        Homeoffice-Tage {year}
      </h1>
      <p className="muted">
        Anzahl der Tage, an denen überwiegend im Homeoffice gearbeitet wurde (z. B. für eine
        Bescheinigung). Keine Tagesangaben, keine Orte. Jeder Abruf steht im Audit-Log.
      </p>
      <div className="row">
        <button
          type="button"
          onClick={() => {
            setYear(year - 1);
          }}
        >
          Vorjahr
        </button>
        <button
          type="button"
          disabled={year >= new Date(now()).getFullYear()}
          onClick={() => {
            setYear(year + 1);
          }}
        >
          Folgejahr
        </button>
      </div>
      <ErrorText text={data.error} />
      {data.data === undefined && !data.error && <Loading what="Zahlen" />}
      {data.data === null && (
        <p className="notice">
          Ausgeschaltet. Einschalten unter Einstellungen → Funktionen („Homeoffice-Tage je Monat für
          Admins“). Vorher die Mitglieder informieren.
        </p>
      )}
      {data.data && (
        <div className="scroll">
          <table>
            <caption>Homeoffice-Tage je Monat</caption>
            <thead>
              <tr>
                <th scope="col">Mitglied</th>
                {months.map((m) => (
                  <th key={m} scope="col">
                    {m}
                  </th>
                ))}
                <th scope="col">Summe</th>
              </tr>
            </thead>
            <tbody>
              {data.data.members.map((m) => (
                <tr key={m.userId}>
                  <th scope="row">{m.name}</th>
                  {m.homeDaysByMonth.map((n, i) => (
                    <td key={months[i] ?? i}>{n}</td>
                  ))}
                  <td>{m.homeDaysByMonth.reduce((s, n) => s + n, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
