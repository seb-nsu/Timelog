// Urlaubs- und Überstundenkonto eines Mitglieds. Manager sehen, Admins pflegen
// (Anspruch, Übertrag, Korrektur, Überstunden-Buchung, Stornierung – jeweils mit Audit).
import { formatDate } from '@timelog/app-core';
import { type SyntheticEvent, useState } from 'react';
import {
  BOOKING_KIND_LABELS,
  LEAVE_KIND_LABELS,
  LEAVE_STATUS_LABELS,
  errorText,
  hours,
} from '../texts.js';
import { ErrorText, Loading, isAdmin, useAdmin, useLoad } from '../ui.js';

const day = (d: string) => formatDate(d, 'de-DE');
const num = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 1 });
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
      notify('Antrag storniert.');
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
        Urlaub: {leave.data?.name ?? '…'}
      </h1>
      <div className="row">
        <button type="button" onClick={onBack}>
          Zurück
        </button>
        <label className="inline">
          Jahr
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
      {!leave.data && !leave.error && <Loading what="Konten" />}
      {a && leave.data && (
        <section className="card" aria-labelledby="acc-title">
          <h2 id="acc-title">Urlaubskonto {a.year}</h2>
          <dl className="facts">
            <dt>Anspruch</dt>
            <dd>{num(a.entitlement)} Tage</dd>
            <dt>Übertrag{a.carryOverManual ? ' (manuell)' : ''}</dt>
            <dd>
              {num(a.carryOver)} Tage, Verfall {day(a.carryOverExpiry)}
              {a.carryOverForfeited > 0 && `, verfallen ${num(a.carryOverForfeited)}`}
            </dd>
            <dt>Korrektur</dt>
            <dd>{num(a.correction)} Tage</dd>
            <dt>Genommen / geplant / beantragt</dt>
            <dd>
              {num(a.taken)} / {num(a.planned)} / {num(a.pending)}
            </dd>
            <dt>Rest</dt>
            <dd>
              <strong>{num(a.remaining)} Tage</strong>
            </dd>
          </dl>
          <h3>Anträge</h3>
          {leave.data.requests.length === 0 ? (
            <p>Keine Anträge.</p>
          ) : (
            <ul>
              {leave.data.requests.map((r) => (
                <li key={r.id}>
                  {LEAVE_KIND_LABELS[r.kind]} {day(r.from)} – {day(r.to)} ({num(r.days)} Tage):{' '}
                  {LEAVE_STATUS_LABELS[r.status]}
                  {admin && (r.status === 'approved' || r.status === 'pending') && (
                    <>
                      {' '}
                      <button
                        type="button"
                        onClick={() => {
                          setCancelling(r.id);
                        }}
                      >
                        Stornieren
                        <span className="visually-hidden">
                          : {day(r.from)} – {day(r.to)}
                        </span>
                      </button>
                    </>
                  )}
                  {r.from <= today && r.status === 'approved' && admin && (
                    <span className="muted"> (bereits begonnen – nur Admin)</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {cancelling && (
            <div className="stack" role="group" aria-labelledby="cancel-title">
              <h3 id="cancel-title">Antrag stornieren</h3>
              <label>
                Begründung
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
                  Stornierung bestätigen
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCancelling(undefined);
                  }}
                >
                  Abbrechen
                </button>
              </div>
            </div>
          )}
          {leave.data.adjustments.length > 0 && (
            <>
              <h3>Buchungen am Urlaubskonto</h3>
              <ul>
                {leave.data.adjustments.map((b) => (
                  <li key={b.id}>
                    {b.year}: {b.kind === 'carry_over' ? 'Übertrag gesetzt' : 'Korrektur'}{' '}
                    {num(b.days)} Tage – {b.comment}
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
        <h2 id="ot-title">Überstundenkonto {year}</h2>
        <ErrorText text={overtime.error} />
        {overtime.data && (
          <>
            <p>
              Saldo: <strong>{signed(overtime.data.balanceMinutes)}</strong>
              {overtime.data.maxBalanceMinutes !== undefined &&
                ` (Höchstsaldo ${hours(overtime.data.maxBalanceMinutes)})`}
            </p>
            {overtime.data.overMax && (
              <p role="alert" className="error">
                Der Saldo liegt über dem Höchstsaldo.
              </p>
            )}
            <table>
              <caption>
                Saldo-Verlauf je Monat (Vortrag {signed(overtime.data.startBalanceMinutes)})
              </caption>
              <thead>
                <tr>
                  <th scope="col">Monat</th>
                  <th scope="col">Arbeit</th>
                  <th scope="col">davon Abbau</th>
                  <th scope="col">Buchungen</th>
                  <th scope="col">Stand</th>
                </tr>
              </thead>
              <tbody>
                {overtime.data.months.map((m) => (
                  <tr key={m.month}>
                    <th scope="row">
                      {m.month}
                      {m.approved && ' (freigegeben)'}
                    </th>
                    <td>{signed(m.workMinutes)}</td>
                    <td>{hours(m.reducedMinutes)}</td>
                    <td>{signed(m.bookedMinutes)}</td>
                    <td>
                      {signed(m.balanceMinutes)}
                      {m.overMax && ' ⚠ über Höchstsaldo'}
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
      notify('Urlaubsanspruch gespeichert.');
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="card" aria-labelledby="profile-title">
      <h2 id="profile-title">Anspruch</h2>
      <p className="muted">
        Leer = Standard der Organisation. Teilzeit und Ein-/Austritt im Jahr werden anteilig
        berechnet (1/12 je vollem Monat).
      </p>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <label>
          Jahresanspruch (Tage)
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
          Arbeitstage je Woche
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
            Eintritt
            <input
              type="date"
              value={entry}
              onChange={(e) => {
                setEntry(e.target.value);
              }}
            />
          </label>
          <label>
            Austritt
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
          Anspruch speichern
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
      notify('Buchung am Urlaubskonto gespeichert.');
      setDays('');
      setComment('');
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="card" aria-labelledby="adj-title">
      <h2 id="adj-title">Übertrag oder Korrektur {year}</h2>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <label>
          Art
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value === 'correction' ? 'correction' : 'carry_over');
            }}
          >
            <option value="carry_over">
              Übertrag aus dem Vorjahr setzen (ersetzt die Automatik)
            </option>
            <option value="correction">Korrektur (+/− Tage)</option>
          </select>
        </label>
        <label>
          Tage
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
          Kommentar
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
          Buchen
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
      notify('Überstunden gebucht.');
      setAmount('');
      setComment('');
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} aria-labelledby="book-title">
      <h3 id="book-title">Manuelle Buchung</h3>
      <div className="row">
        <label>
          Monat
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
          Art
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
          Stunden
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
        Kommentar
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
        Buchen
      </button>
    </form>
  );
}
