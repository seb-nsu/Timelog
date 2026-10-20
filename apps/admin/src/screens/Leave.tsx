// Urlaub: offene Anträge entscheiden (nie die eigenen), Teamkalender, eigener Antrag,
// für Admins Konten der Mitglieder und Organisations-Einstellungen.
import { formatDate } from '@timelog/app-core';
import type { OrgLeaveRequest } from '@timelog/shared';
import { type SyntheticEvent, useState } from 'react';
import {
  CALENDAR_KIND_LABELS,
  LEAVE_KIND_LABELS,
  LEAVE_STATUS_LABELS,
  errorText,
} from '../texts.js';
import { ErrorText, Loading, isAdmin, useAdmin, useLoad } from '../ui.js';
import { LeaveMember } from './LeaveMember.js';

const day = (d: string) => formatDate(d, 'de-DE');
const range = (r: { from: string; to: string }) =>
  r.from === r.to ? day(r.from) : `${day(r.from)} – ${day(r.to)}`;
const num = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 1 });

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
        Urlaub
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
        `Antrag von ${deciding.name ?? ''} ${action === 'approve' ? 'genehmigt' : 'abgelehnt'}.`,
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
      <h2 id="leave-pending">Offene Anträge</h2>
      <ErrorText text={list.error} />
      {!list.data && !list.error && <Loading what="Anträge" />}
      {list.data && list.data.requests.length === 0 && <p>Keine offenen Anträge.</p>}
      {list.data && list.data.requests.length > 0 && (
        <table>
          <caption className="visually-hidden">Offene Anträge</caption>
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Art</th>
              <th scope="col">Zeitraum</th>
              <th scope="col">Arbeitstage</th>
              <th scope="col">Gleichzeitig abwesend</th>
              <th scope="col">
                <span className="visually-hidden">Aktion</span>
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
                    Entscheiden<span className="visually-hidden">: {r.name}</span>
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
            {LEAVE_KIND_LABELS[deciding.kind]} von {deciding.name}: {range(deciding)}
          </h3>
          <label>
            Kommentar (beim Ablehnen Pflicht)
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
              Genehmigen
            </button>
            <button
              type="button"
              disabled={comment.trim() === ''}
              onClick={() => void decide('reject')}
            >
              Ablehnen
            </button>
            <button
              type="button"
              onClick={() => {
                setDeciding(undefined);
              }}
            >
              Abbrechen
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
      <h2 id="leave-cal">Teamkalender</h2>
      <p className="muted">
        Nur Name und Zeitraum. Krankheit und sonstige Abwesenheiten erscheinen ohne Grund als
        „abwesend“.
      </p>
      <div className="row">
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
        <label className="inline">
          Team
          <select
            value={teamId}
            onChange={(e) => {
              setTeamId(e.target.value);
            }}
          >
            <option value="">alle sichtbaren</option>
            {(teams.data?.teams ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorText text={cal.error} />
      {cal.data && cal.data.entries.length === 0 && <p>Niemand abwesend.</p>}
      {cal.data && cal.data.entries.length > 0 && (
        <table>
          <caption className="visually-hidden">Abwesenheiten {month}</caption>
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Zeitraum</th>
              <th scope="col">Art</th>
            </tr>
          </thead>
          <tbody>
            {cal.data.entries.map((e) => (
              <tr key={`${e.userId}-${e.from}-${e.kind}-${String(e.pending)}`}>
                <th scope="row">{e.name}</th>
                <td>{range(e)}</td>
                <td>
                  {CALENDAR_KIND_LABELS[e.kind]}
                  {e.pending && ' (beantragt)'}
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
      notify('Antrag gestellt. Entscheiden darf nur eine andere Person.');
      own.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const a = own.data?.account;
  return (
    <section className="card" aria-labelledby="leave-own">
      <h2 id="leave-own">Eigener Antrag</h2>
      {a && (
        <p>
          Resturlaub {a.year}: <strong>{num(a.remaining)} Tage</strong> (Anspruch{' '}
          {num(a.entitlement)}, genommen {num(a.taken)}, geplant {num(a.planned)}, beantragt{' '}
          {num(a.pending)})
        </p>
      )}
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <label>
          Art
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
            Von
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
            Bis
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
          Erster Tag nur halb
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={halfEnd}
            onChange={(e) => {
              setHalfEnd(e.target.checked);
            }}
          />
          Letzter Tag nur halb
        </label>
        <ErrorText text={error} />
        <button type="submit" className="primary">
          Beantragen
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
      <h2 id="leave-members">Konten der Mitglieder</h2>
      <p className="muted">
        Urlaubs- und Überstundenkonto ansehen.
        {isAdmin(me) && ' Admins pflegen hier Anspruch, Übertrag, Korrekturen und Buchungen.'}
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
            <option value="">bitte wählen</option>
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
          Konto öffnen
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
        notify('Urlaubseinstellungen gespeichert.');
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
      <h2 id="leave-settings">Urlaubseinstellungen der Organisation</h2>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <label>
          Standard-Jahresanspruch (Tage, bei voller Woche)
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
          Arbeitstage je Woche bei Vollzeit
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
          Übertrag aus dem Vorjahr verfällt
        </label>
        <label>
          Verfall zum (MM-TT)
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
          Hinweis (keine Rechtsberatung): Nach der Rechtsprechung des Bundesarbeitsgerichts verfällt
          Resturlaub nur, wenn der Arbeitgeber rechtzeitig auf den Resturlaub und den drohenden
          Verfall hingewiesen hat. Ohne diesen Hinweis „Verfall“ besser ausschalten.
        </p>
        <label>
          Höchstsaldo Überstunden (Stunden, leer = keiner)
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
          Speichern
        </button>
      </form>
    </section>
  );
}
