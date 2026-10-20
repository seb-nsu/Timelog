import type { Team } from '@timelog/shared';
import { type SyntheticEvent, useState } from 'react';
import { errorText } from '../texts.js';
import { ErrorText, Loading, isAdmin, useAdmin, useLoad } from '../ui.js';

export function Teams() {
  const { api, me, notify } = useAdmin();
  const admin = isAdmin(me);
  const teams = useLoad(() => api.org.teams.list(), [api]);
  const members = useLoad(() => api.org.members.list(), [api]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const leaders = (members.data?.members ?? []).filter(
    (m) => m.role === 'manager' || m.role === 'admin',
  );
  const nameOf = (id: string | undefined) =>
    members.data?.members.find((m) => m.id === id)?.name ?? '–';

  const create = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.org.teams.create({ name: name.trim() });
      notify(`Team ${name.trim()} angelegt.`);
      setName('');
      teams.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        Teams
      </h1>
      <ErrorText text={teams.error ?? error} />
      {!teams.data && !teams.error && <Loading what="Teams" />}
      {teams.data && (
        <table>
          <caption>Teams ({teams.data.teams.length})</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Leitung</th>
              <th scope="col">Mitglieder</th>
              {admin && (
                <th scope="col">
                  <span className="visually-hidden">Aktionen</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {teams.data.teams.map((t) =>
              admin ? (
                <TeamRow key={t.id} team={t} leaders={leaders} onChanged={teams.reload} />
              ) : (
                <tr key={t.id}>
                  <th scope="row">{t.name}</th>
                  <td>{nameOf(t.managerId)}</td>
                  <td>{t.memberCount}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
      {admin && (
        <form className="card" onSubmit={(e) => void create(e)}>
          <h2>Neues Team</h2>
          <label>
            Name
            <input
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          </label>
          <button type="submit" className="primary">
            Team anlegen
          </button>
        </form>
      )}
    </section>
  );
}

function TeamRow({
  team,
  leaders,
  onChanged,
}: {
  team: Team;
  leaders: { id: string; name: string }[];
  onChanged: () => void;
}) {
  const { api, notify } = useAdmin();
  const [error, setError] = useState<string>();
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
  return (
    <tr>
      <th scope="row">{team.name}</th>
      <td>
        <label>
          <span className="visually-hidden">Leitung von {team.name}</span>
          <select
            value={team.managerId ?? ''}
            onChange={(e) => {
              const managerId = e.target.value || null;
              void run(
                () => api.org.teams.update(team.id, { managerId }),
                `Leitung von ${team.name} geändert.`,
              );
            }}
          >
            <option value="">keine</option>
            {leaders.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </td>
      <td>{team.memberCount}</td>
      <td>
        <button
          type="button"
          className="danger"
          onClick={() => {
            if (
              window.confirm(
                `Team ${team.name} löschen? Die Mitglieder bleiben, sind dann aber keinem Team zugeordnet.`,
              )
            ) {
              void run(() => api.org.teams.remove(team.id), `Team ${team.name} gelöscht.`);
            }
          }}
        >
          Löschen<span className="visually-hidden">: {team.name}</span>
        </button>
        <ErrorText text={error} />
      </td>
    </tr>
  );
}
