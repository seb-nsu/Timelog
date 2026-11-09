import { monthNames } from '@timelog/app-core';
import { ApiError } from '@timelog/shared';
import { useState } from 'react';
import { L, intlLocale } from '../texts.js';
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
  const months = monthNames(intlLocale);

  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        {L('Homeoffice-Tage', 'Home office days')} {year}
      </h1>
      <p className="muted">
        {L(
          'Anzahl der Tage, an denen überwiegend im Homeoffice gearbeitet wurde (z. B. für eine Bescheinigung). Keine Tagesangaben, keine Orte. Jeder Abruf steht im Audit-Log.',
          'Number of days worked mainly from home (e.g. for a certificate). No individual days, no locations. Every view is recorded in the audit log.',
        )}
      </p>
      <div className="row">
        <button
          type="button"
          onClick={() => {
            setYear(year - 1);
          }}
        >
          {L('Vorjahr', 'Previous year')}
        </button>
        <button
          type="button"
          disabled={year >= new Date(now()).getFullYear()}
          onClick={() => {
            setYear(year + 1);
          }}
        >
          {L('Folgejahr', 'Next year')}
        </button>
      </div>
      <ErrorText text={data.error} />
      {data.data === undefined && !data.error && <Loading what={L('Zahlen', 'figures')} />}
      {data.data === null && (
        <p className="notice">
          {L(
            'Ausgeschaltet. Einschalten unter Einstellungen → Funktionen („Homeoffice-Tage je Monat für Admins“). Vorher die Mitglieder informieren.',
            'Turned off. Turn it on under Settings → Features (“Home office days per month for admins”). Inform members beforehand.',
          )}
        </p>
      )}
      {data.data && (
        <div className="scroll">
          <table>
            <caption>{L('Homeoffice-Tage je Monat', 'Home office days per month')}</caption>
            <thead>
              <tr>
                <th scope="col">{L('Mitglied', 'Member')}</th>
                {months.map((m) => (
                  <th key={m} scope="col">
                    {m}
                  </th>
                ))}
                <th scope="col">{L('Summe', 'Total')}</th>
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
