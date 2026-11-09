// Urlaubs- und Überstundenkonto eines Mitglieds. Manager sehen, Admins pflegen
// (Anspruch, Übertrag, Korrektur, Überstunden-Buchung, Stornierung – jeweils mit Audit).
import { formatDate } from '@timelog/app-core';
import { type SyntheticEvent, useState } from 'react';
import {
  BOOKING_KIND_LABELS,
  L,
  LEAVE_KIND_LABELS,
  LEAVE_STATUS_LABELS,
  errorText,
  hours,
  intlLocale,
} from '../texts.js';
import { ErrorText, Loading, isAdmin, useAdmin, useLoad } from '../ui.js';

const day = (d: string) => formatDate(d, intlLocale);
const num = (n: number) => n.toLocaleString(intlLocale, { maximumFractionDigits: 1 });
const signed = (m: number) => (m > 0 ? `+${hours(m)}` : hours(m));

export function LeaveMember({ memberId, onBack }: { memberId: string; onBack: () => void }) {
  const { api, me, now, notify } = useAdmin();
  const admin = isAdmin(me);
  const [year, setYear] = useState(() => new Date(now()).getFullYear());
  const leave = useLoad(() => api.org.leave.member(memberId, year), [api, memberId, year]);
  const overtime = useLoad(() => api.org.leave.overtime(memberId, year), [api, memberId, year]);
  const today = new Date(now()).toISOString().slice(0, 10);
  const reload = () => {
    leave.reload();
    overtime.reload();
  };

  const [cancelling, setCancelling] = useState<string>();
  const [cancelComment, setCancelComment] = useState('');
  const cancel = async () => {
    if (!cancelling) return;
    try {
      await api.org.leave.cancel(cancelling, cancelComment.trim());
      notify(L('Antrag storniert.', 'Request cancelled.'));
      setCancelling(undefined);
      setCancelComment('');
      reload();
    } catch (err) {
      notify(errorText(err));
    }
  };

  const a = leave.data?.account;
  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        {L('Urlaub', 'Leave')}: {leave.data?.name ?? '…'}
      </h1>
      <div className="row">
        <button type="button" onClick={onBack}>
          {L('Zurück', 'Back')}
        </button>
        <label className="inline">
          {L('Jahr', 'Year')}
          <input
            type="number"
            min={2000}
            max={2100}
            value={year}
            onChange={(e) => {
              const y = Number(e.target.value);
              if (y >= 2000 && y <= 2100) setYear(y);
            }}
          />
        </label>
      </div>
      <ErrorText text={leave.error} />
      {!leave.data && !leave.error && <Loading what={L('Konten', 'accounts')} />}
      {a && leave.data && (
        <section className="card" aria-labelledby="acc-title">
          <h2 id="acc-title">
            {L('Urlaubskonto', 'Leave account')} {a.year}
          </h2>
          <dl className="facts">
            <dt>{L('Anspruch', 'Entitlement')}</dt>
            <dd>
              {num(a.entitlement)} {L('Tage', 'days')}
            </dd>
            <dt>
              {L('Übertrag', 'Carry-over')}
              {a.carryOverManual ? L(' (manuell)', ' (manual)') : ''}
            </dt>
            <dd>
              {L(
                `${num(a.carryOver)} Tage, Verfall ${day(a.carryOverExpiry)}`,
                `${num(a.carryOver)} days, expires ${day(a.carryOverExpiry)}`,
              )}
              {a.carryOverForfeited > 0 &&
                L(
                  `, verfallen ${num(a.carryOverForfeited)}`,
                  `, expired ${num(a.carryOverForfeited)}`,
                )}
            </dd>
            <dt>{L('Korrektur', 'Correction')}</dt>
            <dd>
              {num(a.correction)} {L('Tage', 'days')}
            </dd>
            <dt>{L('Genommen / geplant / beantragt', 'Taken / planned / requested')}</dt>
            <dd>
              {num(a.taken)} / {num(a.planned)} / {num(a.pending)}
            </dd>
            <dt>{L('Rest', 'Remaining')}</dt>
            <dd>
              <strong>
                {num(a.remaining)} {L('Tage', 'days')}
              </strong>
            </dd>
          </dl>
          <h3>{L('Anträge', 'Requests')}</h3>
          {leave.data.requests.length === 0 ? (
            <p>{L('Keine Anträge.', 'No requests.')}</p>
          ) : (
            <ul>
              {leave.data.requests.map((r) => (
                <li key={r.id}>
                  {LEAVE_KIND_LABELS[r.kind]} {day(r.from)} – {day(r.to)} ({num(r.days)}{' '}
                  {L('Tage', 'days')}): {LEAVE_STATUS_LABELS[r.status]}
                  {admin && (r.status === 'approved' || r.status === 'pending') && (
                    <>
                      {' '}
                      <button
                        type="button"
                        onClick={() => {
                          setCancelling(r.id);
                        }}
                      >
                        {L('Stornieren', 'Cancel')}
                        <span className="visually-hidden">
                          : {day(r.from)} – {day(r.to)}
                        </span>
                      </button>
                    </>
                  )}
                  {r.from <= today && r.status === 'approved' && admin && (
                    <span className="muted">
                      {L(' (bereits begonnen – nur Admin)', ' (already started – admin only)')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {cancelling && (
            <div className="stack" role="group" aria-labelledby="cancel-title">
              <h3 id="cancel-title">{L('Antrag stornieren', 'Cancel request')}</h3>
              <label>
                {L('Begründung', 'Reason')}
                <input
                  type="text"
                  maxLength={1000}
                  value={cancelComment}
                  onChange={(e) => {
                    setCancelComment(e.target.value);
                  }}
                />
              </label>
              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  disabled={cancelComment.trim() === ''}
                  onClick={() => void cancel()}
                >
                  {L('Stornierung bestätigen', 'Confirm cancellation')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCancelling(undefined);
                  }}
                >
                  {L('Abbrechen', 'Cancel')}
                </button>
              </div>
            </div>
          )}
          {leave.data.adjustments.length > 0 && (
            <>
              <h3>{L('Buchungen am Urlaubskonto', 'Leave account bookings')}</h3>
              <ul>
                {leave.data.adjustments.map((b) => (
                  <li key={b.id}>
                    {b.year}:{' '}
                    {b.kind === 'carry_over'
                      ? L('Übertrag gesetzt', 'Carry-over set')
                      : L('Korrektur', 'Correction')}{' '}
                    {num(b.days)} {L('Tage', 'days')} – {b.comment}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {admin && leave.data && (
        <ProfileForm
          key={JSON.stringify(leave.data.profile)}
          memberId={memberId}
          initial={leave.data.profile}
          onSaved={reload}
        />
      )}
      {admin && <AdjustmentForm memberId={memberId} year={year} onSaved={reload} />}

      <section className="card" aria-labelledby="ot-title">
        <h2 id="ot-title">
          {L('Überstundenkonto', 'Overtime account')} {year}
        </h2>
        <ErrorText text={overtime.error} />
        {overtime.data && (
          <>
            <p>
              {L('Saldo', 'Balance')}: <strong>{signed(overtime.data.balanceMinutes)}</strong>
              {overtime.data.maxBalanceMinutes !== undefined &&
                L(
                  ` (Höchstsaldo ${hours(overtime.data.maxBalanceMinutes)})`,
                  ` (maximum balance ${hours(overtime.data.maxBalanceMinutes)})`,
                )}
            </p>
            {overtime.data.overMax && (
              <p role="alert" className="error">
                {L(
                  'Der Saldo liegt über dem Höchstsaldo.',
                  'The balance is above the maximum balance.',
                )}
              </p>
            )}
            <table>
              <caption>
                {L(
                  `Saldo-Verlauf je Monat (Vortrag ${signed(overtime.data.startBalanceMinutes)})`,
                  `Balance by month (brought forward ${signed(overtime.data.startBalanceMinutes)})`,
                )}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{L('Monat', 'Month')}</th>
                  <th scope="col">{L('Arbeit', 'Work')}</th>
                  <th scope="col">{L('davon Abbau', 'of which reduced')}</th>
                  <th scope="col">{L('Buchungen', 'Bookings')}</th>
                  <th scope="col">{L('Stand', 'Balance')}</th>
                </tr>
              </thead>
              <tbody>
                {overtime.data.months.map((m) => (
                  <tr key={m.month}>
                    <th scope="row">
                      {m.month}
                      {m.approved && L(' (freigegeben)', ' (approved)')}
                    </th>
                    <td>{signed(m.workMinutes)}</td>
                    <td>{hours(m.reducedMinutes)}</td>
                    <td>{signed(m.bookedMinutes)}</td>
                    <td>
                      {signed(m.balanceMinutes)}
                      {m.overMax && L(' ⚠ über Höchstsaldo', ' ⚠ above maximum balance')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {overtime.data.bookings.length > 0 && (
              <ul>
                {overtime.data.bookings.map((b) => (
                  <li key={b.id}>
                    {b.month}: {BOOKING_KIND_LABELS[b.kind]} {signed(b.minutes)} – {b.comment}
                    {b.authorName && ` (${b.authorName})`}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {admin && <BookingForm memberId={memberId} onSaved={reload} />}
      </section>
    </section>
  );
}

function ProfileForm({
  memberId,
  initial,
  onSaved,
}: {
  memberId: string;
  initial: { annualDays?: number; workdaysPerWeek?: number; entryDate?: string; exitDate?: string };
  onSaved: () => void;
}) {
  const { api, notify } = useAdmin();
  const [annual, setAnnual] = useState(initial.annualDays?.toString() ?? '');
  const [perWeek, setPerWeek] = useState(initial.workdaysPerWeek?.toString() ?? '');
  const [entry, setEntry] = useState(initial.entryDate ?? '');
  const [exit, setExit] = useState(initial.exitDate ?? '');
  const [error, setError] = useState<string>();
  const val = (s: string) => (s.trim() === '' ? null : Number(s));

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.org.leave.setProfile(memberId, {
        annualDays: val(annual),
        workdaysPerWeek: val(perWeek),
        entryDate: entry || null,
        exitDate: exit || null,
      });
      notify(L('Urlaubsanspruch gespeichert.', 'Leave entitlement saved.'));
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="card" aria-labelledby="profile-title">
      <h2 id="profile-title">{L('Anspruch', 'Entitlement')}</h2>
      <p className="muted">
        {L(
          'Leer = Standard der Organisation. Teilzeit und Ein-/Austritt im Jahr werden anteilig berechnet (1/12 je vollem Monat).',
          'Empty = organisation default. Part-time and joining/leaving during the year are prorated (1/12 per full month).',
        )}
      </p>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <label>
          {L('Jahresanspruch (Tage)', 'Annual entitlement (days)')}
          <input
            type="number"
            min={0}
            max={60}
            step={0.5}
            value={annual}
            onChange={(e) => {
              setAnnual(e.target.value);
            }}
          />
        </label>
        <label>
          {L('Arbeitstage je Woche', 'Working days per week')}
          <input
            type="number"
            min={0}
            max={7}
            step={0.5}
            value={perWeek}
            onChange={(e) => {
              setPerWeek(e.target.value);
            }}
          />
        </label>
        <div className="row">
          <label>
            {L('Eintritt', 'Joining date')}
            <input
              type="date"
              value={entry}
              onChange={(e) => {
                setEntry(e.target.value);
              }}
            />
          </label>
          <label>
            {L('Austritt', 'Leaving date')}
            <input
              type="date"
              value={exit}
              onChange={(e) => {
                setExit(e.target.value);
              }}
            />
          </label>
        </div>
        <ErrorText text={error} />
        <button type="submit" className="primary">
          {L('Anspruch speichern', 'Save entitlement')}
        </button>
      </form>
    </section>
  );
}

function AdjustmentForm({
  memberId,
  year,
  onSaved,
}: {
  memberId: string;
  year: number;
  onSaved: () => void;
}) {
  const { api, notify } = useAdmin();
  const [kind, setKind] = useState<'carry_over' | 'correction'>('carry_over');
  const [days, setDays] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string>();

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.org.leave.adjust(memberId, { year, kind, days: Number(days), comment });
      notify(L('Buchung am Urlaubskonto gespeichert.', 'Leave account booking saved.'));
      setDays('');
      setComment('');
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="card" aria-labelledby="adj-title">
      <h2 id="adj-title">
        {L('Übertrag oder Korrektur', 'Carry-over or correction')} {year}
      </h2>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <label>
          {L('Art', 'Type')}
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value === 'correction' ? 'correction' : 'carry_over');
            }}
          >
            <option value="carry_over">
              {L(
                'Übertrag aus dem Vorjahr setzen (ersetzt die Automatik)',
                'Set carry-over from previous year (replaces automatic value)',
              )}
            </option>
            <option value="correction">{L('Korrektur (+/− Tage)', 'Correction (+/− days)')}</option>
          </select>
        </label>
        <label>
          {L('Tage', 'Days')}
          <input
            type="number"
            required
            step={0.5}
            min={-100}
            max={100}
            value={days}
            onChange={(e) => {
              setDays(e.target.value);
            }}
          />
        </label>
        <label>
          {L('Kommentar', 'Comment')}
          <input
            type="text"
            required
            maxLength={1000}
            value={comment}
            onChange={(e) => {
              setComment(e.target.value);
            }}
          />
        </label>
        <ErrorText text={error} />
        <button type="submit" className="primary">
          {L('Buchen', 'Book')}
        </button>
      </form>
    </section>
  );
}

function BookingForm({ memberId, onSaved }: { memberId: string; onSaved: () => void }) {
  const { api, now, notify } = useAdmin();
  const [month, setMonth] = useState(() => new Date(now()).toISOString().slice(0, 7));
  const [kind, setKind] = useState<'payout' | 'cap' | 'correction'>('payout');
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string>();

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    const minutes = Math.round(Number(amount) * 60);
    try {
      await api.org.leave.book(memberId, {
        month,
        kind,
        // Auszahlung und Kappung senken den Saldo
        minutes: kind === 'correction' ? minutes : -Math.abs(minutes),
        comment,
      });
      notify(L('Überstunden gebucht.', 'Overtime booked.'));
      setAmount('');
      setComment('');
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} aria-labelledby="book-title">
      <h3 id="book-title">{L('Manuelle Buchung', 'Manual booking')}</h3>
      <div className="row">
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
          {L('Art', 'Type')}
          <select
            value={kind}
            onChange={(e) => {
              const v = e.target.value;
              setKind(v === 'cap' ? 'cap' : v === 'correction' ? 'correction' : 'payout');
            }}
          >
            <option value="payout">{BOOKING_KIND_LABELS.payout}</option>
            <option value="cap">{BOOKING_KIND_LABELS.cap}</option>
            <option value="correction">{BOOKING_KIND_LABELS.correction}</option>
          </select>
        </label>
        <label>
          {L('Stunden', 'Hours')}
          <input
            type="number"
            required
            step={0.25}
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
            }}
          />
        </label>
      </div>
      <label>
        {L('Kommentar', 'Comment')}
        <input
          type="text"
          required
          maxLength={1000}
          value={comment}
          onChange={(e) => {
            setComment(e.target.value);
          }}
        />
      </label>
      <ErrorText text={error} />
      <button type="submit" className="primary">
        {L('Buchen', 'Book')}
      </button>
    </form>
  );
}
