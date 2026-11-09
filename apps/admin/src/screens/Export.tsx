import { type SyntheticEvent, useState } from 'react';
import { L, errorText, previousMonth } from '../texts.js';
import { ErrorText, useAdmin, useLoad } from '../ui.js';

/** Monatsexport (CSV DATEV-tauglich vorbereitet, PDF); freigegebene Monate aus dem Snapshot. */
export function Export({ download }: { download: (blob: Blob, filename: string) => void }) {
  const { api, now, notify } = useAdmin();
  const teams = useLoad(() => api.org.teams.list(), [api]);
  const [month, setMonth] = useState(() => previousMonth(now()));
  const [teamId, setTeamId] = useState('');
  const [format, setFormat] = useState<'csv' | 'pdf'>('csv');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const run = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const blob = await api.org.export({ month, format, ...(teamId ? { teamId } : {}) });
      download(blob, `arbeitszeit_${month}.${format}`);
      notify(L(`Export ${month} erstellt.`, `Export ${month} created.`));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        Export
      </h1>
      <p className="muted">
        {L(
          'Je Person und Tag: Beginn, Ende, Pause, davon aufgefüllt, Netto, Abwesenheit, Status, korrigiert, Hinweise und Freigabestatus. Jeder Export wird im Audit-Log vermerkt.',
          'Per person and day: start, end, break, of which topped up, net, absence, status, corrected, notes and approval status. Every export is recorded in the audit log.',
        )}
      </p>
      <form onSubmit={(e) => void run(e)} className="card">
        <label>
          {L('Monat', 'Month')}
          <input
            type="month"
            required
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
            }}
          />
        </label>
        <label>
          Team
          <select
            value={teamId}
            onChange={(e) => {
              setTeamId(e.target.value);
            }}
          >
            <option value="">{L('alle Mitglieder', 'all members')}</option>
            {(teams.data?.teams ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Format</legend>
          <label className="inline">
            <input
              type="radio"
              name="format"
              checked={format === 'csv'}
              onChange={() => {
                setFormat('csv');
              }}
            />
            {L('CSV (Semikolon, UTF-8)', 'CSV (semicolon, UTF-8)')}
          </label>
          <label className="inline">
            <input
              type="radio"
              name="format"
              checked={format === 'pdf'}
              onChange={() => {
                setFormat('pdf');
              }}
            />
            PDF
          </label>
        </fieldset>
        <ErrorText text={error} />
        <button type="submit" className="primary" disabled={busy}>
          {L('Herunterladen', 'Download')}
        </button>
      </form>
    </section>
  );
}
