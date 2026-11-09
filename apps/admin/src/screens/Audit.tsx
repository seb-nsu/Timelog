import type { AuditEntry } from '@timelog/shared';
import { useEffect, useState } from 'react';
import { L, AUDIT_LABELS, dateTime, errorText } from '../texts.js';
import { ErrorText, Loading, useAdmin } from '../ui.js';

const PAGE = 50;

export function Audit() {
  const { api } = useAdmin();
  const [entries, setEntries] = useState<AuditEntry[]>();
  const [next, setNext] = useState<string>();
  const [error, setError] = useState<string>();

  const load = async (before?: string) => {
    setError(undefined);
    try {
      const page = await api.org.audit({ limit: PAGE, ...(before ? { before } : {}) });
      setEntries((prev) => [...(before ? (prev ?? []) : []), ...page.entries]);
      setNext(page.nextBefore);
    } catch (err) {
      setError(errorText(err));
    }
  };

  useEffect(() => {
    void load();
  }, [api]);

  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        {L('Audit-Log', 'Audit log')}
      </h1>
      <p className="muted">
        {L(
          'Alle Admin- und Freigabe-Aktionen der Organisation, neueste zuerst.',
          'All admin and approval actions of the organisation, newest first.',
        )}
      </p>
      <ErrorText text={error} />
      {!entries && !error && <Loading what={L('Einträge', 'entries')} />}
      {entries && (
        <table>
          <caption>
            {L(
              `Audit-Log (${String(entries.length)} Einträge geladen)`,
              `Audit log (${String(entries.length)} entries loaded)`,
            )}
          </caption>
          <thead>
            <tr>
              <th scope="col">{L('Zeitpunkt', 'Time')}</th>
              <th scope="col">Person</th>
              <th scope="col">{L('Aktion', 'Action')}</th>
              <th scope="col">{L('Ziel', 'Target')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{dateTime(e.createdAt)}</td>
                <td>{e.actorName ?? '–'}</td>
                <th scope="row">{AUDIT_LABELS[e.action] ?? e.action}</th>
                <td>
                  <code className="wrap">{e.target ?? ''}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next && (
        <button type="button" onClick={() => void load(next)}>
          {L('Ältere Einträge laden', 'Load older entries')}
        </button>
      )}
    </section>
  );
}
