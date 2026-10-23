// Urlaubs- und Überstundenkonto: Kontostand, Antrag stellen, eigene Anträge stornieren.
// Gerechnet wird im Backend (@timelog/rules); hier wird nur angezeigt.
import { type MessageKey, formatBalance, formatDate, formatMinutes } from '@timelog/app-core';
import {
  ApiError,
  type LeaveKindValue,
  type LeaveOverview,
  type LeaveRequest,
  type OvertimeView,
} from '@timelog/shared';
import { type SyntheticEvent, useCallback, useEffect, useId, useState } from 'react';
import { useBackend, useT } from '../context.js';

const ERRORS = ['overlapping_request', 'month_locked', 'no_workdays', 'already_started'] as const;

function days(n: number, locale: string): string {
  return n.toLocaleString(locale, { maximumFractionDigits: 1 });
}

export function Leave({ today }: { today: string }) {
  const backend = useBackend();
  const tr = useT();
  const { t } = tr;
  const id = useId();
  const locale = tr.locale === 'en' ? 'en-GB' : 'de-DE';
  const year = Number(today.slice(0, 4));
  const [overview, setOverview] = useState<LeaveOverview>();
  const [overtime, setOvertime] = useState<OvertimeView>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [kind, setKind] = useState<LeaveKindValue>('vacation');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [halfStart, setHalfStart] = useState(false);
  const [halfEnd, setHalfEnd] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(() => {
    backend.api.leave.get(year).then(setOverview, () => {
      setOverview(undefined);
    });
    backend.api.overtime.get(year).then(setOvertime, () => {
      setOvertime(undefined);
    });
  }, [backend, year]);

  useEffect(load, [load]);

  const fail = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : '';
    setMessage(undefined);
    setError(
      (ERRORS as readonly string[]).includes(code)
        ? t(`leave.error.${code}` as MessageKey)
        : t('error.generic'),
    );
  };

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    backend.api.leave
      .request({
        kind,
        from,
        to,
        halfDayStart: halfStart,
        halfDayEnd: halfEnd,
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      .then((r) => {
        setError(undefined);
        setMessage(r.status === 'pending' ? t('leave.submitted') : t('leave.approvedNow'));
        setNote('');
        load();
      }, fail);
  };

  const cancel = (r: LeaveRequest) => {
    backend.api.leave.cancel(r.id).then(() => {
      setError(undefined);
      setMessage(t('leave.cancelled'));
      load();
    }, fail);
  };

  const a = overview?.account;
  const range = (r: { from: string; to: string }) =>
    t('leave.range', { from: formatDate(r.from, locale), to: formatDate(r.to, locale) });

  return (
    <main className="screen">
      <h1>{t('leave.title')}</h1>

      {a && (
        <section className="card" aria-labelledby={`${id}-acc`}>
          <h2 id={`${id}-acc`}>{t('leave.account', { year: a.year })}</h2>
          <dl className="facts">
            <dt>{t('leave.entitlement')}</dt>
            <dd>{t('leave.days', { days: days(a.entitlement, locale) })}</dd>
            {a.carryOver !== 0 && (
              <>
                <dt>{t('leave.carryOver')}</dt>
                <dd>
                  {t('leave.days', { days: days(a.carryOver, locale) })}{' '}
                  <span className="muted">
                    {t('leave.carryOverExpiry', { date: formatDate(a.carryOverExpiry, locale) })}
                  </span>
                </dd>
              </>
            )}
            {a.carryOverForfeited > 0 && (
              <>
                <dt>{t('leave.carryOverForfeited')}</dt>
                <dd>{t('leave.days', { days: days(a.carryOverForfeited, locale) })}</dd>
              </>
            )}
            {a.correction !== 0 && (
              <>
                <dt>{t('leave.correction')}</dt>
                <dd>{t('leave.days', { days: days(a.correction, locale) })}</dd>
              </>
            )}
            <dt>{t('leave.taken')}</dt>
            <dd>{t('leave.days', { days: days(a.taken, locale) })}</dd>
            <dt>{t('leave.planned')}</dt>
            <dd>{t('leave.days', { days: days(a.planned, locale) })}</dd>
            <dt>{t('leave.pending')}</dt>
            <dd>{t('leave.days', { days: days(a.pending, locale) })}</dd>
            <dt>{t('leave.remaining')}</dt>
            <dd>
              <strong>{t('leave.days', { days: days(a.remaining, locale) })}</strong>
            </dd>
          </dl>
          {overview.managed && <p className="muted">{t('leave.managed')}</p>}
          {overview.settings.carryOverExpires && <p className="muted">{t('leave.bagHint')}</p>}
        </section>
      )}

      <section className="card" aria-labelledby={`${id}-req`}>
        <h2 id={`${id}-req`}>{t('leave.request')}</h2>
        <form className="stack" onSubmit={submit}>
          <label>
            {t('leave.kind')}
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value === 'overtime' ? 'overtime' : 'vacation');
              }}
            >
              <option value="vacation">{t('leave.kind.vacation')}</option>
              <option value="overtime">{t('leave.kind.overtime')}</option>
            </select>
          </label>
          <div className="row">
            <label>
              {t('leave.from')}
              <input
                type="date"
                required
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  if (e.target.value > to) setTo(e.target.value);
                }}
              />
            </label>
            <label>
              {t('leave.to')}
              <input
                type="date"
                required
                min={from}
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                }}
              />
            </label>
          </div>
          <label>
            <input
              type="checkbox"
              checked={halfStart}
              onChange={(e) => {
                setHalfStart(e.target.checked);
              }}
            />{' '}
            {t('leave.halfDayStart')}
          </label>
          <label>
            <input
              type="checkbox"
              checked={halfEnd}
              onChange={(e) => {
                setHalfEnd(e.target.checked);
              }}
            />{' '}
            {t('leave.halfDayEnd')}
          </label>
          <label>
            {t('leave.note')}
            <input
              type="text"
              maxLength={500}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
              }}
            />
          </label>
          <div className="actions">
            <button type="submit" className="primary">
              {t('leave.submit')}
            </button>
          </div>
        </form>
        <div aria-live="polite">
          {message && <p role="status">{message}</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      </section>

      <section className="card" aria-labelledby={`${id}-list`}>
        <h2 id={`${id}-list`}>{t('leave.requests')}</h2>
        {!overview || overview.requests.length === 0 ? (
          <p>{t('leave.noRequests')}</p>
        ) : (
          <ul className="list">
            {overview.requests.map((r) => {
              const label = `${t(`leave.kind.${r.kind}`)} ${range(r)}`;
              return (
                <li key={r.id}>
                  <span>
                    {label} · {t('leave.days', { days: days(r.days, locale) })} ·{' '}
                    {t(`leave.status.${r.status}`)}
                  </span>
                  {r.decisionComment && (
                    <span className="muted">
                      {' '}
                      {t('leave.decision', { comment: r.decisionComment })}
                    </span>
                  )}
                  {(r.status === 'pending' || r.status === 'approved') && r.from > today && (
                    <button
                      type="button"
                      aria-label={`${t('leave.cancel')}: ${label}`}
                      onClick={() => {
                        cancel(r);
                      }}
                    >
                      {t('leave.cancel')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {overtime && (
        <section className="card" aria-labelledby={`${id}-ot`}>
          <h2 id={`${id}-ot`}>{t('overtime.title', { year: overtime.year })}</h2>
          <p>
            {t('overtime.balance')}: <strong>{formatBalance(overtime.balanceMinutes)} h</strong>
          </p>
          {overtime.overMax && overtime.maxBalanceMinutes !== undefined && (
            <p className="error" role="alert">
              {t('overtime.overMax', { max: formatBalance(overtime.maxBalanceMinutes) })}
            </p>
          )}
          <table>
            <caption className="muted">
              {t('overtime.start')}: {formatBalance(overtime.startBalanceMinutes)} h
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('overtime.month')}</th>
                <th scope="col">{t('overtime.worked')}</th>
                <th scope="col">{t('overtime.reduced')}</th>
                <th scope="col">{t('overtime.booked')}</th>
                <th scope="col">{t('overtime.total')}</th>
              </tr>
            </thead>
            <tbody>
              {overtime.months.map((m) => (
                <tr key={m.month}>
                  <th scope="row">
                    {m.month}
                    {m.approved && <span className="muted"> ({t('overtime.approved')})</span>}
                  </th>
                  <td>{formatBalance(m.workMinutes)}</td>
                  <td>{formatMinutes(m.reducedMinutes)}</td>
                  <td>{formatBalance(m.bookedMinutes)}</td>
                  <td>{formatBalance(m.balanceMinutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
