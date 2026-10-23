// Abwesenheit: ein Formular für Urlaub, Krankheit und Sonstiges. Firmenkonten stellen Urlaub und
// Überstundenabbau als Antrag und sehen Urlaubs- und Überstundenkonto; Privatkonten tragen direkt ein.
// Gerechnet wird im Backend (@timelog/rules); hier wird nur angezeigt.
import {
  type MessageKey,
  type Profile,
  absencesFor,
  formatBalance,
  formatDate,
  formatMinutes,
  periodDays,
} from '@timelog/app-core';
import { type Absence as AbsenceEntry, addDays } from '@timelog/rules';
import {
  ApiError,
  type LeaveOverview,
  type LeaveRequest,
  type OvertimeView,
} from '@timelog/shared';
import { type SyntheticEvent, useCallback, useEffect, useId, useState } from 'react';
import { useBackend, useT } from '../context.js';
import { refreshProfile } from '../profile.js';

const ERRORS = ['overlapping_request', 'month_locked', 'no_workdays', 'already_started'] as const;
const DAY_MS = 86_400_000;

type Kind = 'vacation' | 'overtime' | 'sick' | 'other';
/** Urlaub und Überstundenabbau laufen bei Firmenkonten über einen Antrag. */
const REQUEST_KINDS: readonly Kind[] = ['vacation', 'overtime'];

function days(n: number, locale: string): string {
  return n.toLocaleString(locale, { maximumFractionDigits: 1 });
}

export function Absence({
  today,
  profile,
  onChanged,
}: {
  today: string;
  profile: Profile | undefined;
  onChanged: () => void;
}) {
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
  const [kind, setKind] = useState<Kind>('vacation');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [halfStart, setHalfStart] = useState(false);
  const [halfEnd, setHalfEnd] = useState(false);
  const [note, setNote] = useState('');
  const managed = overview?.managed === true;
  const kinds: readonly Kind[] = managed
    ? ['vacation', 'overtime', 'sick', 'other']
    : ['vacation', 'sick', 'other'];
  const request = managed && REQUEST_KINDS.includes(kind);

  const load = useCallback(() => {
    backend.api.leave.get(year).then(setOverview, () => {
      setOverview(undefined);
    });
    backend.api.overtime.get(year).then(setOvertime, () => {
      setOvertime(undefined);
    });
  }, [backend, year]);

  useEffect(load, [load]);

  const ok = (text: string) => {
    setError(undefined);
    setMessage(text);
  };
  const fail = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : '';
    setMessage(undefined);
    setError(
      (ERRORS as readonly string[]).includes(code)
        ? t(`leave.error.${code}` as MessageKey)
        : t('error.generic'),
    );
  };

  /** Frei erfasste Abwesenheiten im Zeitraum ersetzen; Einträge anderer Tage bleiben. */
  const putAbsences = async (start: string, end: string, entries: AbsenceEntry[]) => {
    await backend.api.absences.put({ from: start, to: end, absences: entries });
    await refreshProfile(backend);
    onChanged();
  };

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (request) {
      backend.api.leave
        .request({
          kind: kind === 'overtime' ? 'overtime' : 'vacation',
          from,
          to,
          halfDayStart: halfStart,
          halfDayEnd: halfEnd,
          ...(note.trim() ? { note: note.trim() } : {}),
        })
        .then((r) => {
          ok(r.status === 'pending' ? t('leave.submitted') : t('leave.approvedNow'));
          setNote('');
          load();
        }, fail);
      return;
    }
    const span = (Date.parse(to) - Date.parse(from)) / DAY_MS;
    if (Number.isNaN(span) || span < 0 || span > 366) {
      setMessage(undefined);
      setError(t('absence.invalid'));
      return;
    }
    const p: Profile = profile ?? { state: 'BE', timezone: 'Europe/Berlin' };
    const fresh = absencesFor(periodDays([], p, from, to, to).days, kind);
    if (fresh.length === 0) {
      setMessage(undefined);
      setError(t('leave.error.no_workdays'));
      return;
    }
    const freshDates = new Set(fresh.map((a) => a.date));
    const kept = (profile?.absences ?? []).filter(
      (a) => a.date >= from && a.date <= to && !freshDates.has(a.date),
    );
    putAbsences(from, to, [...kept, ...fresh]).then(() => {
      ok(t('absence.saved'));
      setNote('');
    }, fail);
  };

  const remove = (entry: AbsenceEntry) => {
    const others = (profile?.absences ?? []).filter(
      (a) => a.date === entry.date && a.kind !== entry.kind,
    );
    putAbsences(entry.date, entry.date, others).then(() => {
      ok(t('absence.removed'));
    }, fail);
  };

  const cancel = (r: LeaveRequest) => {
    backend.api.leave.cancel(r.id).then(() => {
      ok(t('leave.cancelled'));
      load();
    }, fail);
  };

  const a = overview?.account;
  const range = (r: { from: string; to: string }) =>
    t('leave.range', { from: formatDate(r.from, locale), to: formatDate(r.to, locale) });
  // Firmenkonten sehen Urlaub und Überstundenabbau unter „Anträge“
  const recorded = (profile?.absences ?? [])
    .filter((x) => x.date >= addDays(today, -60) && x.kind !== 'holiday')
    .filter((x) => !(managed && REQUEST_KINDS.includes(x.kind as Kind)))
    .sort((x, y) => x.date.localeCompare(y.date));

  return (
    <main className="screen">
      <h1>{t('absence.title')}</h1>

      <section className="card" aria-labelledby={`${id}-req`}>
        <h2 id={`${id}-req`}>{t('absence.add')}</h2>
        <form className="stack" onSubmit={submit}>
          <label>
            {t('absence.kind')}{' '}
            <select
              value={kind}
              onChange={(e) => {
                setKind(kinds.find((k) => k === e.target.value) ?? 'vacation');
              }}
            >
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {t(`absence.kind.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <div className="actions">
            <label>
              {t('leave.from')}{' '}
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
              {t('leave.to')}{' '}
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
          {request ? (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={halfStart}
                  onChange={(e) => {
                    setHalfStart(e.target.checked);
                  }}
                />{' '}
                {t('leave.halfDayStart')}
              </label>
              <label className="check">
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
              <p className="muted">{t('absence.requestHint')}</p>
            </>
          ) : (
            <p className="muted">{t('absence.dayHint')}</p>
          )}
          <div className="actions">
            <button type="submit" className="primary">
              {request ? t('leave.submit') : t('absence.save')}
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

      <section className="card" aria-labelledby={`${id}-recorded`}>
        <h2 id={`${id}-recorded`}>{t('absence.list')}</h2>
        {recorded.length === 0 ? (
          <p>{t('absence.none')}</p>
        ) : (
          <ul className="list">
            {recorded.map((x) => {
              const label = `${formatDate(x.date, locale)} · ${t(`absence.kind.${x.kind}`)}`;
              return (
                <li key={`${x.date}-${x.kind}`}>
                  <span>{label}</span>
                  <button
                    type="button"
                    aria-label={`${t('absence.remove')}: ${label}`}
                    onClick={() => {
                      remove(x);
                    }}
                  >
                    {t('absence.remove')}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {managed && (
        <section className="card" aria-labelledby={`${id}-list`}>
          <h2 id={`${id}-list`}>{t('leave.requests')}</h2>
          {overview.requests.length === 0 ? (
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
      )}

      {managed && a && (
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
          <p className="muted">{t('leave.managed')}</p>
          {overview.settings.carryOverExpires && <p className="muted">{t('leave.bagHint')}</p>}
        </section>
      )}

      {managed && overtime && (
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
