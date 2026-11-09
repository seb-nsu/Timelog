import { ROLES, type Member, type Role } from '@timelog/shared';
import { type SyntheticEvent, useState } from 'react';
import { L, locale, ROLE_LABELS, dateTime, errorText } from '../texts.js';
import { ErrorText, Loading, isAdmin, useAdmin, useLoad } from '../ui.js';

const WEEKDAYS =
  locale === 'en'
    ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    : ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

export function Members() {
  const { api, me } = useAdmin();
  const admin = isAdmin(me);
  const members = useLoad(() => api.org.members.list(), [api]);
  const teams = useLoad(() => api.org.teams.list(), [api]);
  const teamName = (id: string | undefined) =>
    teams.data?.teams.find((t) => t.id === id)?.name ?? L('kein Team', 'no team');

  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        {L('Mitglieder', 'Members')}
      </h1>
      {!admin && (
        <p className="muted">
          {L(
            'Du siehst die Mitglieder deiner Teams. Rollen und Teams verwaltet ein Admin.',
            'You see the members of your teams. Roles and teams are managed by an admin.',
          )}
        </p>
      )}
      <ErrorText text={members.error} />
      {!members.data && !members.error && <Loading what={L('Mitglieder', 'members')} />}
      {members.data && (
        <table>
          <caption>
            {L('Mitglieder', 'Members')} ({members.data.members.length})
          </caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              {admin && <th scope="col">{L('E-Mail', 'Email')}</th>}
              <th scope="col">Team</th>
              {admin && <th scope="col">{L('Rolle', 'Role')}</th>}
              {admin && <th scope="col">{L('Zwei-Faktor', 'Two-factor')}</th>}
              {admin && (
                <th scope="col">
                  <span className="visually-hidden">{L('Aktionen', 'Actions')}</span>
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
          {inactive && <span className="pill">{L('deaktiviert', 'deactivated')}</span>}
        </th>
        <td>{member.email}</td>
        <td>
          <label>
            <span className="visually-hidden">
              {L(`Team von ${member.name}`, `Team of ${member.name}`)}
            </span>
            <select
              value={member.teamId ?? ''}
              disabled={inactive}
              onChange={(e) => {
                const teamId = e.target.value || null;
                void run(
                  () => api.org.members.update(member.id, { teamId }),
                  L(`Team von ${member.name} geändert.`, `Team of ${member.name} changed.`),
                );
              }}
            >
              <option value="">{L('kein Team', 'no team')}</option>
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
            <span className="visually-hidden">
              {L(`Rolle von ${member.name}`, `Role of ${member.name}`)}
            </span>
            <select
              value={member.role ?? 'user'}
              disabled={inactive}
              onChange={(e) => {
                const role = e.target.value as Role;
                void run(
                  () => api.org.members.update(member.id, { role }),
                  L(`Rolle von ${member.name} geändert.`, `Role of ${member.name} changed.`),
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
        <td>{member.totpEnabled ? L('eingerichtet', 'set up') : L('nein', 'no')}</td>
        <td>
          <div className="actions">
            <button
              type="button"
              aria-expanded={hoursOpen}
              onClick={() => {
                setHoursOpen((o) => !o);
              }}
            >
              {L('Sollzeiten', 'Target hours')}
              <span className="visually-hidden">
                {L(` von ${member.name}`, ` of ${member.name}`)}
              </span>
            </button>
            {!self && !inactive && (
              <button
                type="button"
                className="danger"
                onClick={() => {
                  if (
                    window.confirm(
                      L(
                        `${member.name} deaktivieren? Anmeldung und Geräte werden gesperrt.`,
                        `Deactivate ${member.name}? Sign-in and devices will be blocked.`,
                      ),
                    )
                  ) {
                    void run(
                      () => api.org.members.deactivate(member.id),
                      L(`${member.name} deaktiviert.`, `${member.name} deactivated.`),
                    );
                  }
                }}
              >
                {L('Deaktivieren', 'Deactivate')}
                <span className="visually-hidden">: {member.name}</span>
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
      notify(L(`Sollzeiten von ${name} gespeichert.`, `Target hours of ${name} saved.`));
      current.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <form onSubmit={(e) => void save(e)}>
      <fieldset>
        <legend>
          {L(
            `Sollzeiten von ${name} (Minuten je Wochentag)`,
            `Target hours of ${name} (minutes per weekday)`,
          )}
        </legend>
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
          {L('Gültig ab', 'Valid from')}
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
        <button type="submit">{L('Sollzeiten speichern', 'Save target hours')}</button>
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
      notify(L(`Einladung an ${email.trim()} verschickt.`, `Invitation sent to ${email.trim()}.`));
      setEmail('');
      list.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section aria-labelledby="invite-title" className="card">
      <h2 id="invite-title">{L('Person einladen', 'Invite person')}</h2>
      <form onSubmit={(e) => void invite(e)}>
        <label>
          {L('E-Mail', 'Email')}
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
          {L('Rolle', 'Role')}
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
            <option value="">{L('kein Team', 'no team')}</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <ErrorText text={error} />
        <button type="submit" className="primary">
          {L('Einladen', 'Invite')}
        </button>
      </form>
      {list.data && list.data.invitations.length > 0 && (
        <>
          <h3>{L('Offene Einladungen', 'Pending invitations')}</h3>
          <ul className="plain">
            {list.data.invitations.map((i) => (
              <li key={i.id} className="row">
                <span>
                  {i.email} · {ROLE_LABELS[i.role]} · {L('gültig bis', 'valid until')}{' '}
                  {dateTime(i.expiresAt)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void api.org.invitations.revoke(i.id).then(
                      () => {
                        notify(
                          L(
                            `Einladung an ${i.email} widerrufen.`,
                            `Invitation to ${i.email} revoked.`,
                          ),
                        );
                        list.reload();
                      },
                      (err: unknown) => {
                        setError(errorText(err));
                      },
                    );
                  }}
                >
                  {L('Widerrufen', 'Revoke')}
                  <span className="visually-hidden">: {i.email}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
