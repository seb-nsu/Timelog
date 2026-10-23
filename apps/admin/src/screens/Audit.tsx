import type { AuditEntry } from '@timelog/shared';
import { useEffect, useState } from 'react';
import { AUDIT_LABELS, dateTime, errorText } from '../texts.js';
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
        Audit-Log
      </h1>
      <p className="muted">Alle Admin- und Freigabe-Aktionen der Organisation, neueste zuerst.</p>
      <ErrorText text={error} />
      {!entries && !error && <Loading what="Einträge" />}
      {entries && (
        <table>
          <caption>Audit-Log ({entries.length} Einträge geladen)</caption>
          <thead>
            <tr>
              <th scope="col">Zeitpunkt</th>
              <th scope="col">Person</th>
              <th scope="col">Aktion</th>
              <th scope="col">Ziel</th>
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
          Ältere Einträge laden
        </button>
      )}
    </section>
  );
}
