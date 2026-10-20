import { STATE_NAMES } from '@timelog/app-core';
import { GERMAN_STATES, type GermanState } from '@timelog/rules';
import type { ApiClient } from '@timelog/shared';
import { type SyntheticEvent, useState } from 'react';
import { ROLE_LABELS, errorText } from '../texts.js';
import { ErrorText, Loading, useLoad } from '../ui.js';

/** Öffentliche Seite hinter dem Einladungslink: Konto für die Firma anlegen. */
export function InviteAccept({ api, token }: { api: ApiClient; token: string }) {
  const info = useLoad(() => api.invitations.info(token), [api, token]);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [state, setState] = useState<GermanState>('BE');
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.invitations.accept({
        token,
        name: name.trim(),
        password,
        state,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <main id="main" className="narrow">
      <h1>Einladung annehmen</h1>
      <ErrorText text={info.error ?? error} />
      {!info.data && !info.error && <Loading what="Einladung" />}
      {info.data && !done && (
        <>
          <p>
            <strong>{info.data.orgName}</strong> lädt <strong>{info.data.email}</strong> als{' '}
            {ROLE_LABELS[info.data.role]} ein.
          </p>
          <form onSubmit={(e) => void submit(e)}>
            <label>
              Dein Name
              <input
                required
                autoComplete="name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            </label>
            <label>
              Passwort (mindestens 10 Zeichen)
              <input
                type="password"
                required
                minLength={10}
                autoComplete="new-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                }}
              />
            </label>
            <label>
              Bundesland (für Feiertage)
              <select
                value={state}
                onChange={(e) => {
                  setState(e.target.value as GermanState);
                }}
              >
                {GERMAN_STATES.map((s) => (
                  <option key={s} value={s}>
                    {STATE_NAMES[s]}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="primary">
              Konto anlegen
            </button>
          </form>
        </>
      )}
      {done && (
        <p role="status">
          Konto angelegt. Melde dich jetzt in der TimeLog-App auf Laptop oder Handy mit deiner
          E-Mail-Adresse an.
        </p>
      )}
    </main>
  );
}
