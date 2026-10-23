import { ROLES, type Member, type Role } from '@timelog/shared';
import { type SyntheticEvent, useState } from 'react';
import { ROLE_LABELS, dateTime, errorText } from '../texts.js';
import { ErrorText, Loading, isAdmin, useAdmin, useLoad } from '../ui.js';

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

export function Members() {
  const { api, me } = useAdmin();
  const admin = isAdmin(me);
  const members = useLoad(() => api.org.members.list(), [api]);
  const teams = useLoad(() => api.org.teams.list(), [api]);
  const teamName = (id: string | undefined) =>
    teams.data?.teams.find((t) => t.id === id)?.name ?? 'kein Team';

  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        Mitglieder
      </h1>
      {!admin && (
        <p className="muted">
          Du siehst die Mitglieder deiner Teams. Rollen und Teams verwaltet ein Admin.
        </p>
      )}
      <ErrorText text={members.error} />
      {!members.data && !members.error && <Loading what="Mitglieder" />}
      {members.data && (
        <table>
          <caption>Mitglieder ({members.data.members.length})</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              {admin && <th scope="col">E-Mail</th>}
              <th scope="col">Team</th>
              {admin && <th scope="col">Rolle</th>}
              {admin && <th scope="col">Zwei-Faktor</th>}
              {admin && (
                <th scope="col">
                  <span className="visually-hidden">Aktionen</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {members.data.members.map((m) =>
              admin ? (
                <AdminRow
                  key={m.id}
                  member={m}
                  teams={teams.data?.teams ?? []}
                  self={m.id === me.user.id}
                  onChanged={members.reload}
                />
              ) : (
                <tr key={m.id}>
                  <th scope="row">{m.name}</th>
                  <td>{teamName(m.teamId)}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
      {admin && <Invitations teams={teams.data?.teams ?? []} />}
    </section>
  );
}

function AdminRow({
  member,
  teams,
  self,
  onChanged,
}: {
  member: Member;
  teams: { id: string; name: string }[];
  self: boolean;
  onChanged: () => void;
}) {
  const { api, notify } = useAdmin();
  const [error, setError] = useState<string>();
  const [hoursOpen, setHoursOpen] = useState(false);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setError(undefined);
    try {
      await fn();
      notify(done);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const inactive = member.active === false;
  return (
    <>
      <tr>
        <th scope="row">
          {member.name}
          {inactive && <span className="pill">deaktiviert</span>}
        </th>
        <td>{member.email}</td>
        <td>
          <label>
            <span className="visually-hidden">Team von {member.name}</span>
            <select
              value={member.teamId ?? ''}
              disabled={inactive}
              onChange={(e) => {
                const teamId = e.target.value || null;
                void run(
                  () => api.org.members.update(member.id, { teamId }),
                  `Team von ${member.name} geändert.`,
                );
              }}
            >
              <option value="">kein Team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </td>
        <td>
          <label>
            <span className="visually-hidden">Rolle von {member.name}</span>
            <select
              value={member.role ?? 'user'}
              disabled={inactive}
              onChange={(e) => {
                const role = e.target.value as Role;
                void run(
                  () => api.org.members.update(member.id, { role }),
                  `Rolle von ${member.name} geändert.`,
                );
              }}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
        </td>
        <td>{member.totpEnabled ? 'eingerichtet' : 'nein'}</td>
        <td>
          <div className="actions">
            <button
              type="button"
              aria-expanded={hoursOpen}
              onClick={() => {
                setHoursOpen((o) => !o);
              }}
            >
              Sollzeiten<span className="visually-hidden"> von {member.name}</span>
            </button>
            {!self && !inactive && (
              <button
                type="button"
                className="danger"
                onClick={() => {
                  if (
                    window.confirm(
                      `${member.name} deaktivieren? Anmeldung und Geräte werden gesperrt.`,
                    )
                  ) {
                    void run(
                      () => api.org.members.deactivate(member.id),
                      `${member.name} deaktiviert.`,
                    );
                  }
                }}
              >
                Deaktivieren<span className="visually-hidden">: {member.name}</span>
              </button>
            )}
          </div>
          <ErrorText text={error} />
        </td>
      </tr>
      {hoursOpen && (
        <tr>
          <td colSpan={6}>
            <TargetHours memberId={member.id} name={member.name} />
          </td>
        </tr>
      )}
    </>
  );
}

function TargetHours({ memberId, name }: { memberId: string; name: string }) {
  const { api, notify } = useAdmin();
  const current = useLoad(() => api.org.members.targetHours(memberId), [api, memberId]);
  const [validFrom, setValidFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [minutes, setMinutes] = useState<number[] | undefined>();
  const [error, setError] = useState<string>();
  const latest = current.data?.schedule.at(-1)?.minutesByWeekday;
  const values = minutes ?? latest ?? [0, 480, 480, 480, 480, 480, 0];

  const save = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    const [so, mo, di, mi, don, fr, sa] = values;
    try {
      await api.org.members.setTargetHours(memberId, {
        validFrom,
        minutesByWeekday: [so ?? 0, mo ?? 0, di ?? 0, mi ?? 0, don ?? 0, fr ?? 0, sa ?? 0],
      });
      notify(`Sollzeiten von ${name} gespeichert.`);
      current.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <form onSubmit={(e) => void save(e)}>
      <fieldset>
        <legend>Sollzeiten von {name} (Minuten je Wochentag)</legend>
        <div className="grid7">
          {WEEKDAYS.map((day, i) => (
            <label key={day}>
              {day}
              <input
                type="number"
                min={0}
                max={1440}
                value={values[i] ?? 0}
                onChange={(e) => {
                  const next = [...values];
                  next[i] = Number(e.target.value);
                  setMinutes(next);
                }}
              />
            </label>
          ))}
        </div>
        <label className="inline">
          Gültig ab
          <input
            type="date"
            required
            value={validFrom}
            onChange={(e) => {
              setValidFrom(e.target.value);
            }}
          />
        </label>
        <ErrorText text={error ?? current.error} />
        <button type="submit">Sollzeiten speichern</button>
      </fieldset>
    </form>
  );
}

function Invitations({ teams }: { teams: { id: string; name: string }[] }) {
  const { api, notify } = useAdmin();
  const list = useLoad(() => api.org.invitations.list(), [api]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [teamId, setTeamId] = useState('');
  const [error, setError] = useState<string>();

  const invite = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.org.invite({ email: email.trim(), role, ...(teamId ? { teamId } : {}) });
      notify(`Einladung an ${email.trim()} verschickt.`);
      setEmail('');
      list.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section aria-labelledby="invite-title" className="card">
      <h2 id="invite-title">Person einladen</h2>
      <form onSubmit={(e) => void invite(e)}>
        <label>
          E-Mail
          <input
            type="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
        </label>
        <label>
          Rolle
          <select
            value={role}
            onChange={(e) => {
              setRole(e.target.value as Role);
            }}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Team
          <select
            value={teamId}
            onChange={(e) => {
              setTeamId(e.target.value);
            }}
          >
            <option value="">kein Team</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <ErrorText text={error} />
        <button type="submit" className="primary">
          Einladen
        </button>
      </form>
      {list.data && list.data.invitations.length > 0 && (
        <>
          <h3>Offene Einladungen</h3>
          <ul className="plain">
            {list.data.invitations.map((i) => (
              <li key={i.id} className="row">
                <span>
                  {i.email} · {ROLE_LABELS[i.role]} · gültig bis {dateTime(i.expiresAt)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void api.org.invitations.revoke(i.id).then(
                      () => {
                        notify(`Einladung an ${i.email} widerrufen.`);
                        list.reload();
                      },
                      (err: unknown) => {
                        setError(errorText(err));
                      },
                    );
                  }}
                >
                  Widerrufen<span className="visually-hidden">: {i.email}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
