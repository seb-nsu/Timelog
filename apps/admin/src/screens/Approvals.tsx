import { formatDate } from '@timelog/app-core';
import type { Approval } from '@timelog/shared';
import { type SyntheticEvent, useState } from 'react';
import {
  APPROVAL_LABELS,
  L,
  clock,
  dateTime,
  errorText,
  hours,
  intlLocale,
  previousMonth,
  tr,
} from '../texts.js';
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
        {L('Freigaben', 'Approvals')}
      </h1>
      <label className="inline">
        {L('Monat', 'Month')}
        <input
          type="month"
          value={month}
          onChange={(e) => {
            if (e.target.value) setMonth(e.target.value);
          }}
        />
      </label>
      <ErrorText text={list.error} />
      {!list.data && !list.error && <Loading what={L('Freigaben', 'approvals')} />}
      {list.data && list.data.approvals.length === 0 && (
        <p>{L('Keine Mitglieder in deinen Teams.', 'No members in your teams.')}</p>
      )}
      {list.data && list.data.approvals.length > 0 && (
        <table>
          <caption>
            {L('Freigabestatus', 'Approval status')} {month}
          </caption>
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Status</th>
              <th scope="col">{L('Eingereicht', 'Submitted')}</th>
              <th scope="col">{L('Kommentar', 'Comment')}</th>
              <th scope="col">
                <span className="visually-hidden">{L('Aktion', 'Action')}</span>
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
                    {L('Ansehen', 'View')}
                    <span className="visually-hidden">: {a.name}</span>
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
      setError(
        L('Zum Zurückweisen bitte einen Kommentar angeben.', 'Please enter a comment to reject.'),
      );
      return;
    }
    try {
      if (action === 'approve') {
        await api.org.approvals.approve(
          approval.userId,
          approval.month,
          comment.trim() || undefined,
        );
        notify(
          L(
            `Monat ${approval.month} für ${approval.name} freigegeben.`,
            `Month ${approval.month} approved for ${approval.name}.`,
          ),
        );
      } else {
        await api.org.approvals.reject(approval.userId, approval.month, comment.trim());
        notify(
          L(
            `Monat ${approval.month} für ${approval.name} zurückgewiesen.`,
            `Month ${approval.month} rejected for ${approval.name}.`,
          ),
        );
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
        {L('Zurück zur Übersicht', 'Back to overview')}
      </button>
      <ErrorText text={detail.error ?? error} />
      {!d && !detail.error && <Loading what={L('Arbeitstage', 'working days')} />}
      {d && (
        <>
          <p>
            Status: <strong>{APPROVAL_LABELS[d.approval.status]}</strong>
            {d.snapshot &&
              L(
                ' · gespeicherter Stand der Freigabe (wird nicht neu berechnet)',
                ' · saved state of the approval (not recalculated)',
              )}
            {d.approval.comment && ` · ${L('Kommentar', 'Comment')}: ${d.approval.comment}`}
          </p>
          <dl className="totals">
            <div>
              <dt>{L('Netto', 'Net')}</dt>
              <dd>{hours(d.totals.netMinutes)}</dd>
            </div>
            <div>
              <dt>{L('Pausen-Auffüllung', 'Break top-up')}</dt>
              <dd>{hours(d.totals.breakTopUpMin)}</dd>
            </div>
            <div>
              <dt>{L('Ungeprüfte Tage', 'Unchecked days')}</dt>
              <dd>{d.totals.uncheckedDays}</dd>
            </div>
            <div>
              <dt>{L('Offene Tage', 'Open days')}</dt>
              <dd>{d.totals.openDays}</dd>
            </div>
          </dl>
          {d.days.length === 0 ? (
            <p>{L('Keine Arbeitstage in diesem Monat.', 'No working days in this month.')}</p>
          ) : (
            <table>
              <caption>
                {L(
                  'Arbeitstage (Beginn und Ende in deiner Zeitzone)',
                  'Working days (start and end in your time zone)',
                )}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{L('Datum', 'Date')}</th>
                  <th scope="col">{L('Beginn', 'Start')}</th>
                  <th scope="col">{L('Ende', 'End')}</th>
                  <th scope="col">{L('Pausen', 'Breaks')}</th>
                  <th scope="col">{L('Auffüllung', 'Top-up')}</th>
                  <th scope="col">{L('Netto', 'Net')}</th>
                  <th scope="col">Status</th>
                  <th scope="col">{L('Hinweise', 'Notes')}</th>
                </tr>
              </thead>
              <tbody>
                {d.days.map((day) => (
                  <tr key={day.date}>
                    <th scope="row">{formatDate(day.date, intlLocale)}</th>
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
                {L('Kommentar (zum Zurückweisen Pflicht)', 'Comment (required to reject)')}
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
                  {L('Freigeben', 'Approve')}
                </button>
                <button type="button" onClick={() => void decide('reject')}>
                  {L('Zurückweisen', 'Reject')}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
