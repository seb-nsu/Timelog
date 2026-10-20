import type { ApiClient, SsoInfoResponse } from '@timelog/shared';
import { ApiError } from '@timelog/shared';
import { type SyntheticEvent, useState } from 'react';
import type { Session } from '../session.js';
import { errorText } from '../texts.js';
import { ErrorText } from '../ui.js';

const METHOD_LABELS = { oidc: 'OpenID Connect', saml: 'SAML' } as const;
const PROVIDER_LABELS = { entra: 'Microsoft Entra ID', google: 'Google', oidc: 'OpenID Connect' };

export function Login({
  session,
  initialError,
  onLoggedIn,
  redirectTo,
  ssoReturnUrl,
}: {
  session: Session;
  initialError?: string;
  onLoggedIn: () => void;
  redirectTo: (url: string) => void;
  ssoReturnUrl: string;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [slug, setSlug] = useState('');
  const [sso, setSso] = useState<SsoInfoResponse>();

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await session.login(email.trim(), password, needTotp ? totp.trim() : undefined);
      onLoggedIn();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'totp_required') setNeedTotp(true);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const findSso = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    setSso(undefined);
    try {
      const info = await session.anon.sso.info(slug.trim().toLowerCase());
      if (info.methods.length === 0) setError(errorText('not_configured'));
      else setSso(info);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'Organisation nicht gefunden.'
          : errorText(err),
      );
    }
  };

  return (
    <main id="main" className="narrow">
      <h1>TimeLog Admin</h1>
      <p className="muted">Firmenversion: Freigaben, Mitglieder, Teams und Einstellungen.</p>
      <ErrorText text={error} />
      <section aria-labelledby="pw-login" className="card">
        <h2 id="pw-login">Mit E-Mail anmelden</h2>
        <form onSubmit={(e) => void submit(e)}>
          <label>
            E-Mail
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
            />
          </label>
          <label>
            Passwort
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          </label>
          {needTotp && (
            <label>
              Code aus der Authenticator-App
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                required
                value={totp}
                onChange={(e) => {
                  setTotp(e.target.value);
                }}
              />
            </label>
          )}
          <button type="submit" className="primary" disabled={busy}>
            Anmelden
          </button>
        </form>
      </section>
      <section aria-labelledby="sso-login" className="card">
        <h2 id="sso-login">Mit SSO anmelden</h2>
        <form onSubmit={(e) => void findSso(e)}>
          <label>
            Kurzname der Organisation
            <input
              required
              autoComplete="organization"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
              }}
            />
          </label>
          <button type="submit">Weiter</button>
        </form>
        {sso && (
          <div className="actions">
            {sso.methods.map((m) => (
              <button
                key={m}
                type="button"
                className="primary"
                onClick={() => {
                  redirectTo(session.anon.sso.startUrl(slug.trim().toLowerCase(), m, ssoReturnUrl));
                }}
              >
                {sso.orgName}:{' '}
                {m === 'oidc' && sso.provider ? PROVIDER_LABELS[sso.provider] : METHOD_LABELS[m]}
              </button>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

/** Zwei-Faktor einrichten (Pflicht für Manager und Admins ohne SSO). */
export function TotpSetup({
  api,
  onDone,
  onLogout,
}: {
  api: ApiClient;
  onDone: () => void;
  onLogout: () => void;
}) {
  const [secret, setSecret] = useState<{ secret: string; otpauthUrl: string }>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();

  const start = async () => {
    setError(undefined);
    try {
      setSecret(await api.auth.totpSetup());
    } catch (err) {
      setError(errorText(err));
    }
  };
  const verify = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.auth.totpVerify(code.trim());
      onDone();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <main id="main" className="narrow">
      <h1>Zwei-Faktor-Anmeldung einrichten</h1>
      <p>
        Für Manager und Admins ist ein zweiter Faktor Pflicht. Richte in einer Authenticator-App (z.
        B. Microsoft Authenticator, Google Authenticator, 1Password) ein neues Konto ein.
      </p>
      <ErrorText text={error} />
      {!secret ? (
        <button type="button" className="primary" onClick={() => void start()}>
          Schlüssel erzeugen
        </button>
      ) : (
        <form onSubmit={(e) => void verify(e)}>
          <p>
            Schlüssel zum Eintippen: <code className="secret">{secret.secret}</code>
          </p>
          <p className="muted">
            Oder diese Adresse in der App öffnen bzw. einfügen:{' '}
            <code className="wrap">{secret.otpauthUrl}</code>
          </p>
          <label>
            Sechsstelliger Code aus der App
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              required
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
              }}
            />
          </label>
          <button type="submit" className="primary">
            Bestätigen
          </button>
        </form>
      )}
      <button type="button" className="link" onClick={onLogout}>
        Abmelden
      </button>
    </main>
  );
}

/** Ohne Organisation: neue Firmen-Organisation anlegen (das eigene Konto wird Admin). */
export function CreateOrg({
  api,
  onDone,
  onLogout,
}: {
  api: ApiClient;
  onDone: () => void;
  onLogout: () => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string>();
  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.org.create(name.trim(), slug.trim().toLowerCase());
      onDone();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <main id="main" className="narrow">
      <h1>Organisation anlegen</h1>
      <p>
        Dein Konto gehört noch zu keiner Firma. Lege eine Organisation an – du wirst ihr Admin. Ab
        dann gelten für deine Daten die Aufbewahrungsfristen der Firmenversion.
      </p>
      <ErrorText text={error} />
      <form onSubmit={(e) => void submit(e)}>
        <label>
          Name der Firma
          <input
            required
            autoComplete="organization"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </label>
        <label>
          Kurzname für die SSO-Anmeldung (Kleinbuchstaben, Ziffern, Bindestrich)
          <input
            required
            pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
            }}
          />
        </label>
        <button type="submit" className="primary">
          Anlegen
        </button>
      </form>
      <button type="button" className="link" onClick={onLogout}>
        Abmelden
      </button>
    </main>
  );
}
