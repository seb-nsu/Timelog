import { STATE_NAMES } from '@timelog/app-core';
import { GERMAN_STATES, type GermanState } from '@timelog/rules';
import type { ApiClient } from '@timelog/shared';
import { type SyntheticEvent, useState } from 'react';
import { L, ROLE_LABELS, errorText } from '../texts.js';
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
      <h1>{L('Einladung annehmen', 'Accept invitation')}</h1>
      <ErrorText text={info.error ?? error} />
      {!info.data && !info.error && <Loading what={L('Einladung', 'invitation')} />}
      {info.data && !done && (
        <>
          <p>
            {L('', 'Invitation from ')}
            <strong>{info.data.orgName}</strong>
            {L(' lädt ', ' for ')}
            <strong>{info.data.email}</strong>
            {L(' als ', ' as ')}
            {ROLE_LABELS[info.data.role]}
            {L(' ein.', '.')}
          </p>
          <form onSubmit={(e) => void submit(e)}>
            <label>
              {L('Dein Name', 'Your name')}
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
              {L('Passwort (mindestens 10 Zeichen)', 'Password (at least 10 characters)')}
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
              {L('Bundesland (für Feiertage)', 'German state (for public holidays)')}
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
              {L('Konto anlegen', 'Create account')}
            </button>
          </form>
        </>
      )}
      {done && (
        <p role="status">
          {L(
            'Konto angelegt. Melde dich jetzt in der TimeLog-App auf Laptop oder Handy mit deiner E-Mail-Adresse an.',
            'Account created. Now sign in to the TimeLog app on your laptop or phone with your email address.',
          )}
        </p>
      )}
    </main>
  );
}
