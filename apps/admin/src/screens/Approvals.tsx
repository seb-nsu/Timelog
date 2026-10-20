import { formatDate } from '@timelog/app-core';
import type { Approval } from '@timelog/shared';
import { type SyntheticEvent, useState } from 'react';
import { APPROVAL_LABELS, clock, dateTime, errorText, hours, previousMonth, tr } from '../texts.js';
import { ErrorText, Loading, useAdmin, useLoad } from '../ui.js';

/** Monatsfreigaben: Liste je Monat, Detail mit eingeschränkter Tagesansicht, Freigeben/Zurückweisen. */
export function Approvals() {
  const { api, now } = useAdmin();
  const [month, setMonth] = useState(() => previousMonth(now()));
  const [selected, setSelected] = useState<Approval>();
  const list = useLoad(() => api.org.approvals.list(month), [api, month]);

  if (selected) {
    return (
      <ApprovalDetail
        approval={selected}
        onBack={() => {
          setSelected(undefined);
          list.reload();
        }}
      />
    );
  }

  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        Freigaben
      </h1>
      <label className="inline">
        Monat
        <input
          type="month"
          value={month}
          onChange={(e) => {
            if (e.target.value) setMonth(e.target.value);
          }}
        />
      </label>
      <ErrorText text={list.error} />
      {!list.data && !list.error && <Loading what="Freigaben" />}
      {list.data && list.data.approvals.length === 0 && <p>Keine Mitglieder in deinen Teams.</p>}
      {list.data && list.data.approvals.length > 0 && (
        <table>
          <caption>Freigabestatus {month}</caption>
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Status</th>
              <th scope="col">Eingereicht</th>
              <th scope="col">Kommentar</th>
              <th scope="col">
                <span className="visually-hidden">Aktion</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.data.approvals.map((a) => (
              <tr key={a.userId}>
                <th scope="row">{a.name}</th>
                <td>
                  <span className={`pill pill-${a.status}`}>{APPROVAL_LABELS[a.status]}</span>
                </td>
                <td>{a.submittedAt ? dateTime(a.submittedAt) : '–'}</td>
                <td>{a.comment ?? ''}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(a);
                    }}
                  >
                    Ansehen<span className="visually-hidden">: {a.name}</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ApprovalDetail({ approval, onBack }: { approval: Approval; onBack: () => void }) {
  const { api, notify } = useAdmin();
  const detail = useLoad(
    () => api.org.approvals.get(approval.userId, approval.month),
    [api, approval],
  );
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string>();

  const decide = async (action: 'approve' | 'reject', e?: SyntheticEvent) => {
    e?.preventDefault();
    setError(undefined);
    if (action === 'reject' && !comment.trim()) {
      setError('Zum Zurückweisen bitte einen Kommentar angeben.');
      return;
    }
    try {
      if (action === 'approve') {
        await api.org.approvals.approve(
          approval.userId,
          approval.month,
          comment.trim() || undefined,
        );
        notify(`Monat ${approval.month} für ${approval.name} freigegeben.`);
      } else {
        await api.org.approvals.reject(approval.userId, approval.month, comment.trim());
        notify(`Monat ${approval.month} für ${approval.name} zurückgewiesen.`);
      }
      onBack();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const d = detail.data;
  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        {approval.name}: {approval.month}
      </h1>
      <button type="button" className="link" onClick={onBack}>
        Zurück zur Übersicht
      </button>
      <ErrorText text={detail.error ?? error} />
      {!d && !detail.error && <Loading what="Arbeitstage" />}
      {d && (
        <>
          <p>
            Status: <strong>{APPROVAL_LABELS[d.approval.status]}</strong>
            {d.snapshot && ' · gespeicherter Stand der Freigabe (wird nicht neu berechnet)'}
            {d.approval.comment && ` · Kommentar: ${d.approval.comment}`}
          </p>
          <dl className="totals">
            <div>
              <dt>Netto</dt>
              <dd>{hours(d.totals.netMinutes)}</dd>
            </div>
            <div>
              <dt>Pausen-Auffüllung</dt>
              <dd>{hours(d.totals.breakTopUpMin)}</dd>
            </div>
            <div>
              <dt>Ungeprüfte Tage</dt>
              <dd>{d.totals.uncheckedDays}</dd>
            </div>
            <div>
              <dt>Offene Tage</dt>
              <dd>{d.totals.openDays}</dd>
            </div>
          </dl>
          {d.days.length === 0 ? (
            <p>Keine Arbeitstage in diesem Monat.</p>
          ) : (
            <table>
              <caption>Arbeitstage (Beginn und Ende in deiner Zeitzone)</caption>
              <thead>
                <tr>
                  <th scope="col">Datum</th>
                  <th scope="col">Beginn</th>
                  <th scope="col">Ende</th>
                  <th scope="col">Pausen</th>
                  <th scope="col">Auffüllung</th>
                  <th scope="col">Netto</th>
                  <th scope="col">Status</th>
                  <th scope="col">Hinweise</th>
                </tr>
              </thead>
              <tbody>
                {d.days.map((day) => (
                  <tr key={day.date}>
                    <th scope="row">{formatDate(day.date)}</th>
                    <td>{clock(day.start)}</td>
                    <td>{clock(day.end)}</td>
                    <td>{hours(day.breakMinutes)}</td>
                    <td>{day.breakTopUpMin > 0 ? hours(day.breakTopUpMin) : '–'}</td>
                    <td>{hours(day.netMinutes)}</td>
                    <td>{tr.status(day.status)}</td>
                    <td>
                      {day.warnings.length > 0 && (
                        <ul className="warnings">
                          {day.warnings.map((w) => (
                            <li key={w}>{tr.warning(w)}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {d.approval.status === 'submitted' && (
            <form className="card" onSubmit={(e) => void decide('approve', e)}>
              <label>
                Kommentar (zum Zurückweisen Pflicht)
                <textarea
                  rows={3}
                  value={comment}
                  onChange={(e) => {
                    setComment(e.target.value);
                  }}
                />
              </label>
              <div className="actions">
                <button type="submit" className="primary">
                  Freigeben
                </button>
                <button type="button" onClick={() => void decide('reject')}>
                  Zurückweisen
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
