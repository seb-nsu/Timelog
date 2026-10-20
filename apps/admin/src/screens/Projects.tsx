import { parseKeywords } from '@timelog/app-core';
import { type SyntheticEvent, useState } from 'react';
import { errorText, hours } from '../texts.js';
import { ErrorText, Loading, useAdmin, useLoad } from '../ui.js';

const firstOfMonth = (nowMs: number) => {
  const d = new Date(nowMs);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};
const isoDay = (nowMs: number) => {
  const d = new Date(nowMs);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Firmenprojekte (optional je Team) und Auswertung. Datenschutz: Projektzeiten gibt es hier nur als
 * Summe über alle bzw. ein Team, nie je Person und Tag.
 */
export function Projects() {
  const { api, now, notify } = useAdmin();
  const list = useLoad(() => api.org.projects.list(), [api]);
  const teams = useLoad(() => api.org.teams.list(), [api]);
  const [name, setName] = useState('');
  const [customer, setCustomer] = useState('');
  const [color, setColor] = useState('#1d4ed8');
  const [keywords, setKeywords] = useState('');
  const [teamId, setTeamId] = useState('');
  const [error, setError] = useState<string>();
  const [from, setFrom] = useState(() => firstOfMonth(now()));
  const [to, setTo] = useState(() => isoDay(now()));
  const [reportTeam, setReportTeam] = useState('');
  const valid = from !== '' && to !== '' && from <= to;
  const report = useLoad(
    () =>
      valid
        ? api.org.projects.report({ from, to, ...(reportTeam ? { teamId: reportTeam } : {}) })
        : Promise.resolve(undefined),
    [api, from, to, reportTeam, valid],
  );
  const teamName = (id: string | undefined) =>
    teams.data?.teams.find((t) => t.id === id)?.name ?? '';

  const add = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.org.projects.create({
        name: name.trim(),
        ...(customer.trim() ? { customer: customer.trim() } : {}),
        color,
        keywords: parseKeywords(keywords),
        ...(teamId ? { teamId } : {}),
      });
      notify(`Projekt ${name.trim()} angelegt.`);
      setName('');
      setCustomer('');
      setKeywords('');
      list.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const archive = (id: string, label: string, archived: boolean) => {
    api.org.projects.update(id, { archived }).then(
      () => {
        notify(`Projekt ${label} ${archived ? 'archiviert' : 'wiederhergestellt'}.`);
        list.reload();
      },
      (err: unknown) => {
        setError(errorText(err));
      },
    );
  };

  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        Projekte
      </h1>
      {list.data && !list.data.enabled && (
        <p className="notice">
          Projekte sind für die Mitglieder noch ausgeschaltet. Einschalten unter Einstellungen →
          Funktionen.
        </p>
      )}
      <p className="muted">
        Mitglieder ordnen Arbeitszeit im Tagesprotokoll Projekten zu. Automatisch: Standardprojekt
        je Firmen-Netz und Stichwörter im Kalendertermin. Von Hand gewinnt immer.
      </p>
      <ErrorText text={list.error} />
      {!list.data && !list.error && <Loading what="Projekte" />}
      {list.data && list.data.projects.length === 0 && <p>Noch keine Projekte angelegt.</p>}
      {list.data && list.data.projects.length > 0 && (
        <ul className="plain">
          {list.data.projects.map((p) => (
            <li key={p.id} className="row card">
              <span>
                <span aria-hidden="true" style={{ color: p.color }}>
                  ●
                </span>{' '}
                <strong>{p.name}</strong>
                {p.customer ? ` · ${p.customer}` : ''}
                {p.teamId ? ` · nur Team ${teamName(p.teamId)}` : ''}
                {p.keywords.length > 0 ? ` · Stichwörter: ${p.keywords.join(', ')}` : ''}
                {p.archived ? ' · archiviert' : ''}
              </span>
              <button
                type="button"
                onClick={() => {
                  archive(p.id, p.name, !p.archived);
                }}
              >
                {p.archived ? 'Wiederherstellen' : 'Archivieren'}
                <span className="visually-hidden">: {p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="card" onSubmit={(e) => void add(e)}>
        <h2>Projekt anlegen</h2>
        <label>
          Name
          <input
            required
            maxLength={100}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </label>
        <label>
          Kunde (optional)
          <input
            maxLength={100}
            value={customer}
            onChange={(e) => {
              setCustomer(e.target.value);
            }}
          />
        </label>
        <label>
          Farbe
          <input
            type="color"
            value={color}
            onChange={(e) => {
              setColor(e.target.value);
            }}
          />
        </label>
        <label>
          Kalender-Stichwörter (durch Komma getrennt)
          <input
            value={keywords}
            onChange={(e) => {
              setKeywords(e.target.value);
            }}
          />
        </label>
        <label>
          Sichtbar für
          <select
            value={teamId}
            onChange={(e) => {
              setTeamId(e.target.value);
            }}
          >
            <option value="">alle Mitglieder</option>
            {(teams.data?.teams ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                nur Team {t.name}
              </option>
            ))}
          </select>
        </label>
        <ErrorText text={error} />
        <button type="submit" className="primary">
          Anlegen
        </button>
      </form>

      <section aria-labelledby="report-title" className="card stack">
        <h2 id="report-title">Auswertung</h2>
        <p className="muted">Netto-Arbeitszeit als Summe – keine Angaben je Person.</p>
        <div className="row">
          <label>
            Von
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
              }}
            />
          </label>
          <label>
            Bis
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
              }}
            />
          </label>
          <label>
            Team
            <select
              value={reportTeam}
              onChange={(e) => {
                setReportTeam(e.target.value);
              }}
            >
              <option value="">alle Mitglieder</option>
              {(teams.data?.teams ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ErrorText text={report.error} />
        {report.data && report.data.totals.length === 0 && <p>Keine Projektzeiten im Zeitraum.</p>}
        {report.data && report.data.totals.length > 0 && (
          <>
            <table>
              <caption>Je Projekt</caption>
              <thead>
                <tr>
                  <th scope="col">Projekt</th>
                  <th scope="col">Kunde</th>
                  <th scope="col">Netto</th>
                  <th scope="col">davon Pausenauffüllung abgezogen</th>
                </tr>
              </thead>
              <tbody>
                {report.data.totals.map((x) => (
                  <tr key={x.projectId ?? 'none'}>
                    <th scope="row">{x.name ?? 'ohne Projekt'}</th>
                    <td>{x.customer ?? '–'}</td>
                    <td>{hours(x.netMinutes)}</td>
                    <td>{hours(x.topUpMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table>
              <caption>Je Kunde</caption>
              <thead>
                <tr>
                  <th scope="col">Kunde</th>
                  <th scope="col">Netto</th>
                </tr>
              </thead>
              <tbody>
                {report.data.customers.map((c) => (
                  <tr key={c.customer ?? 'none'}>
                    <th scope="row">{c.customer ?? 'ohne Kunde'}</th>
                    <td>{hours(c.netMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </section>
  );
}
