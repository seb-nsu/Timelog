// Urlaub: offene Anträge entscheiden (nie die eigenen), Teamkalender, eigener Antrag,
// für Admins Konten der Mitglieder und Organisations-Einstellungen.
import { formatDate } from '@timelog/app-core';
import type { OrgLeaveRequest } from '@timelog/shared';
import { type SyntheticEvent, useState } from 'react';
import {
  CALENDAR_KIND_LABELS,
  L,
  LEAVE_KIND_LABELS,
  LEAVE_STATUS_LABELS,
  errorText,
  intlLocale,
} from '../texts.js';
import { ErrorText, Loading, isAdmin, useAdmin, useLoad } from '../ui.js';
import { LeaveMember } from './LeaveMember.js';

const day = (d: string) => formatDate(d, intlLocale);
const range = (r: { from: string; to: string }) =>
  r.from === r.to ? day(r.from) : `${day(r.from)} – ${day(r.to)}`;
const num = (n: number) => n.toLocaleString(intlLocale, { maximumFractionDigits: 1 });

function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y ?? 2000, m ?? 1, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export function Leave() {
  const { me, now } = useAdmin();
  const [memberId, setMemberId] = useState<string>();
  const thisMonth = new Date(now()).toISOString().slice(0, 7);

  if (memberId) {
    return (
      <LeaveMember
        memberId={memberId}
        onBack={() => {
          setMemberId(undefined);
        }}
      />
    );
  }

  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        {L('Urlaub', 'Leave')}
      </h1>
      <PendingRequests />
      <TeamCalendar initialMonth={thisMonth} />
      <OwnRequest />
      <MemberPicker onPick={setMemberId} />
      {isAdmin(me) && <LeaveSettingsForm />}
    </section>
  );
}

function PendingRequests() {
  const { api, notify } = useAdmin();
  const list = useLoad(() => api.org.leave.requests({ status: 'pending' }), [api]);
  const [deciding, setDeciding] = useState<OrgLeaveRequest>();
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string>();

  const decide = async (action: 'approve' | 'reject') => {
    if (!deciding) return;
    setError(undefined);
    try {
      if (action === 'approve')
        await api.org.leave.approve(deciding.id, comment.trim() || undefined);
      else await api.org.leave.reject(deciding.id, comment.trim());
      notify(
        action === 'approve'
          ? L(
              `Antrag von ${deciding.name ?? ''} genehmigt.`,
              `Request from ${deciding.name ?? ''} approved.`,
            )
          : L(
              `Antrag von ${deciding.name ?? ''} abgelehnt.`,
              `Request from ${deciding.name ?? ''} rejected.`,
            ),
      );
      setDeciding(undefined);
      setComment('');
      list.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="card" aria-labelledby="leave-pending">
      <h2 id="leave-pending">{L('Offene Anträge', 'Pending requests')}</h2>
      <ErrorText text={list.error} />
      {!list.data && !list.error && <Loading what={L('Anträge', 'requests')} />}
      {list.data && list.data.requests.length === 0 && (
        <p>{L('Keine offenen Anträge.', 'No pending requests.')}</p>
      )}
      {list.data && list.data.requests.length > 0 && (
        <table>
          <caption className="visually-hidden">{L('Offene Anträge', 'Pending requests')}</caption>
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">{L('Art', 'Type')}</th>
              <th scope="col">{L('Zeitraum', 'Period')}</th>
              <th scope="col">{L('Arbeitstage', 'Working days')}</th>
              <th scope="col">{L('Gleichzeitig abwesend', 'Absent at the same time')}</th>
              <th scope="col">
                <span className="visually-hidden">{L('Aktion', 'Action')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.data.requests.map((r) => (
              <tr key={r.id}>
                <th scope="row">{r.name}</th>
                <td>{LEAVE_KIND_LABELS[r.kind]}</td>
                <td>
                  {range(r)}
                  {r.note && <span className="muted"> · {r.note}</span>}
                </td>
                <td>{num(r.days)}</td>
                <td>
                  {r.overlaps.length === 0
                    ? '–'
                    : r.overlaps.map((o) => `${o.name} (${range(o)})`).join(', ')}
                </td>
                <td>
                  <button
                    type="button"
                    onClick={() => {
                      setDeciding(r);
                      setComment('');
                      setError(undefined);
                    }}
                  >
                    {L('Entscheiden', 'Decide')}
                    <span className="visually-hidden">: {r.name}</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {deciding && (
        <div className="stack" role="group" aria-labelledby="leave-decide">
          <h3 id="leave-decide">
            {LEAVE_KIND_LABELS[deciding.kind]} {L('von', 'for')} {deciding.name}: {range(deciding)}
          </h3>
          <label>
            {L('Kommentar (beim Ablehnen Pflicht)', 'Comment (required to reject)')}
            <textarea
              value={comment}
              maxLength={1000}
              onChange={(e) => {
                setComment(e.target.value);
              }}
            />
          </label>
          <ErrorText text={error} />
          <div className="actions">
            <button type="button" className="primary" onClick={() => void decide('approve')}>
              {L('Genehmigen', 'Approve')}
            </button>
            <button
              type="button"
              disabled={comment.trim() === ''}
              onClick={() => void decide('reject')}
            >
              {L('Ablehnen', 'Reject')}
            </button>
            <button
              type="button"
              onClick={() => {
                setDeciding(undefined);
              }}
            >
              {L('Abbrechen', 'Cancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function TeamCalendar({ initialMonth }: { initialMonth: string }) {
  const { api } = useAdmin();
  const [month, setMonth] = useState(initialMonth);
  const teams = useLoad(() => api.org.teams.list(), [api]);
  const [teamId, setTeamId] = useState('');
  const cal = useLoad(
    () => api.org.leave.calendar({ ...monthBounds(month), ...(teamId ? { teamId } : {}) }),
    [api, month, teamId],
  );
  return (
    <section className="card" aria-labelledby="leave-cal">
      <h2 id="leave-cal">{L('Teamkalender', 'Team calendar')}</h2>
      <p className="muted">
        {L(
          'Nur Name und Zeitraum. Krankheit und sonstige Abwesenheiten erscheinen ohne Grund als „abwesend“.',
          'Name and period only. Sickness and other absences appear as “absent” without a reason.',
        )}
      </p>
      <div className="row">
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
        <label className="inline">
          Team
          <select
            value={teamId}
            onChange={(e) => {
              setTeamId(e.target.value);
            }}
          >
            <option value="">{L('alle sichtbaren', 'all visible')}</option>
            {(teams.data?.teams ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorText text={cal.error} />
      {cal.data && cal.data.entries.length === 0 && (
        <p>{L('Niemand abwesend.', 'Nobody absent.')}</p>
      )}
      {cal.data && cal.data.entries.length > 0 && (
        <table>
          <caption className="visually-hidden">
            {L('Abwesenheiten', 'Absences')} {month}
          </caption>
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">{L('Zeitraum', 'Period')}</th>
              <th scope="col">{L('Art', 'Type')}</th>
            </tr>
          </thead>
          <tbody>
            {cal.data.entries.map((e) => (
              <tr key={`${e.userId}-${e.from}-${e.kind}-${String(e.pending)}`}>
                <th scope="row">{e.name}</th>
                <td>{range(e)}</td>
                <td>
                  {CALENDAR_KIND_LABELS[e.kind]}
                  {e.pending && L(' (beantragt)', ' (requested)')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function OwnRequest() {
  const { api, now, notify } = useAdmin();
  const today = new Date(now()).toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const own = useLoad(() => api.leave.get(year), [api, year]);
  const [kind, setKind] = useState<'vacation' | 'overtime'>('vacation');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [halfStart, setHalfStart] = useState(false);
  const [halfEnd, setHalfEnd] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.leave.request({ kind, from, to, halfDayStart: halfStart, halfDayEnd: halfEnd });
      notify(
        L(
          'Antrag gestellt. Entscheiden darf nur eine andere Person.',
          'Request submitted. Only another person may decide on it.',
        ),
      );
      own.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const a = own.data?.account;
  return (
    <section className="card" aria-labelledby="leave-own">
      <h2 id="leave-own">{L('Eigener Antrag', 'My request')}</h2>
      {a && (
        <p>
          {L('Resturlaub', 'Remaining leave')} {a.year}:{' '}
          <strong>
            {num(a.remaining)} {L('Tage', 'days')}
          </strong>{' '}
          {L(
            `(Anspruch ${num(a.entitlement)}, genommen ${num(a.taken)}, geplant ${num(a.planned)}, beantragt ${num(a.pending)})`,
            `(entitlement ${num(a.entitlement)}, taken ${num(a.taken)}, planned ${num(a.planned)}, requested ${num(a.pending)})`,
          )}
        </p>
      )}
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <label>
          {L('Art', 'Type')}
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value === 'overtime' ? 'overtime' : 'vacation');
            }}
          >
            <option value="vacation">{LEAVE_KIND_LABELS.vacation}</option>
            <option value="overtime">{LEAVE_KIND_LABELS.overtime}</option>
          </select>
        </label>
        <div className="row">
          <label>
            {L('Von', 'From')}
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
            {L('Bis', 'To')}
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
        <label className="inline">
          <input
            type="checkbox"
            checked={halfStart}
            onChange={(e) => {
              setHalfStart(e.target.checked);
            }}
          />
          {L('Erster Tag nur halb', 'First day half only')}
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={halfEnd}
            onChange={(e) => {
              setHalfEnd(e.target.checked);
            }}
          />
          {L('Letzter Tag nur halb', 'Last day half only')}
        </label>
        <ErrorText text={error} />
        <button type="submit" className="primary">
          {L('Beantragen', 'Request')}
        </button>
      </form>
      {own.data && own.data.requests.length > 0 && (
        <ul>
          {own.data.requests.map((r) => (
            <li key={r.id}>
              {LEAVE_KIND_LABELS[r.kind]} {range(r)}: {LEAVE_STATUS_LABELS[r.status]}
              {r.decisionComment && ` – ${r.decisionComment}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MemberPicker({ onPick }: { onPick: (id: string) => void }) {
  const { api, me } = useAdmin();
  const members = useLoad(() => api.org.members.list(), [api]);
  const [id, setId] = useState('');
  const list = (members.data?.members ?? []).filter((m) => m.id !== me.user.id);
  return (
    <section className="card" aria-labelledby="leave-members">
      <h2 id="leave-members">{L('Konten der Mitglieder', 'Member accounts')}</h2>
      <p className="muted">
        {L('Urlaubs- und Überstundenkonto ansehen.', 'View leave and overtime accounts.')}
        {isAdmin(me) &&
          L(
            ' Admins pflegen hier Anspruch, Übertrag, Korrekturen und Buchungen.',
            ' Admins manage entitlement, carry-over, corrections and bookings here.',
          )}
      </p>
      <ErrorText text={members.error} />
      <div className="row">
        <label className="inline">
          Person
          <select
            value={id}
            onChange={(e) => {
              setId(e.target.value);
            }}
          >
            <option value="">{L('bitte wählen', 'please choose')}</option>
            {list.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!id}
          onClick={() => {
            onPick(id);
          }}
        >
          {L('Konto öffnen', 'Open account')}
        </button>
      </div>
    </section>
  );
}

function LeaveSettingsForm() {
  const { api, notify } = useAdmin();
  const current = useLoad(() => api.org.leave.settings(), [api]);
  if (!current.data) return <ErrorText text={current.error} />;
  return (
    <LeaveSettingsFields
      key={JSON.stringify(current.data)}
      initial={current.data}
      save={async (body) => {
        await api.org.leave.setSettings(body);
        notify(L('Urlaubseinstellungen gespeichert.', 'Leave settings saved.'));
        current.reload();
      }}
    />
  );
}

function LeaveSettingsFields({
  initial,
  save,
}: {
  initial: {
    defaultAnnualDays: number;
    standardWorkdaysPerWeek: number;
    carryOverExpiry: string;
    carryOverExpires: boolean;
    maxOvertimeMinutes?: number | undefined;
  };
  save: (body: {
    defaultAnnualDays: number;
    standardWorkdaysPerWeek: number;
    carryOverExpiry: string;
    carryOverExpires: boolean;
    maxOvertimeMinutes: number | null;
  }) => Promise<void>;
}) {
  const [annual, setAnnual] = useState(String(initial.defaultAnnualDays));
  const [perWeek, setPerWeek] = useState(String(initial.standardWorkdaysPerWeek));
  const [expiry, setExpiry] = useState(initial.carryOverExpiry);
  const [expires, setExpires] = useState(initial.carryOverExpires);
  const [maxHours, setMaxHours] = useState(
    initial.maxOvertimeMinutes === undefined ? '' : String(initial.maxOvertimeMinutes / 60),
  );
  const [error, setError] = useState<string>();

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await save({
        defaultAnnualDays: Number(annual),
        standardWorkdaysPerWeek: Number(perWeek),
        carryOverExpiry: expiry,
        carryOverExpires: expires,
        maxOvertimeMinutes: maxHours.trim() === '' ? null : Math.round(Number(maxHours) * 60),
      });
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="card" aria-labelledby="leave-settings">
      <h2 id="leave-settings">
        {L('Urlaubseinstellungen der Organisation', 'Organisation leave settings')}
      </h2>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <label>
          {L(
            'Standard-Jahresanspruch (Tage, bei voller Woche)',
            'Default annual entitlement (days, full week)',
          )}
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
          {L('Arbeitstage je Woche bei Vollzeit', 'Working days per week at full time')}
          <input
            type="number"
            min={1}
            max={7}
            step={0.5}
            value={perWeek}
            onChange={(e) => {
              setPerWeek(e.target.value);
            }}
          />
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={expires}
            onChange={(e) => {
              setExpires(e.target.checked);
            }}
          />
          {L('Übertrag aus dem Vorjahr verfällt', 'Carry-over from the previous year expires')}
        </label>
        <label>
          {L('Verfall zum (MM-TT)', 'Expires on (MM-DD)')}
          <input
            type="text"
            pattern="(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])"
            value={expiry}
            onChange={(e) => {
              setExpiry(e.target.value);
            }}
          />
        </label>
        <p className="muted">
          {L(
            'Hinweis (keine Rechtsberatung): Nach der Rechtsprechung des Bundesarbeitsgerichts verfällt Resturlaub nur, wenn der Arbeitgeber rechtzeitig auf den Resturlaub und den drohenden Verfall hingewiesen hat. Ohne diesen Hinweis „Verfall“ besser ausschalten.',
            'Note (not legal advice): under German Federal Labour Court case law, remaining leave only expires if the employer pointed out the remaining leave and the impending expiry in good time. Without such a notice, better turn “expires” off.',
          )}
        </p>
        <label>
          {L(
            'Höchstsaldo Überstunden (Stunden, leer = keiner)',
            'Maximum overtime balance (hours, empty = none)',
          )}
          <input
            type="number"
            min={0}
            step={0.5}
            value={maxHours}
            onChange={(e) => {
              setMaxHours(e.target.value);
            }}
          />
        </label>
        <ErrorText text={error} />
        <button type="submit" className="primary">
          {L('Speichern', 'Save')}
        </button>
      </form>
    </section>
  );
}
