// Web-Admin: Anmeldung, Zwei-Faktor-Pflicht, rollenabhängige Navigation.
import { ApiError, type OrgMeResponse } from '@timelog/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Approvals } from './screens/Approvals.js';
import { Audit } from './screens/Audit.js';
import { Calendar } from './screens/Calendar.js';
import { Export } from './screens/Export.js';
import { HomeOffice } from './screens/HomeOffice.js';
import { InviteAccept } from './screens/InviteAccept.js';
import { CreateOrg, Login, TotpSetup } from './screens/Login.js';
import { Members } from './screens/Members.js';
import { Networks } from './screens/Networks.js';
import { Projects } from './screens/Projects.js';
import { Settings } from './screens/Settings.js';
import { Teams } from './screens/Teams.js';
import type { Session } from './session.js';
import { ROLE_LABELS, errorText } from './texts.js';
import { AdminContext, type AdminContextValue, isAdmin } from './ui.js';

type Page =
  | 'approvals'
  | 'members'
  | 'teams'
  | 'projects'
  | 'networks'
  | 'homeOffice'
  | 'settings'
  | 'export'
  | 'audit'
  | 'calendar';

const PAGES: { id: Page; label: string; adminOnly: boolean }[] = [
  { id: 'approvals', label: 'Freigaben', adminOnly: false },
  { id: 'members', label: 'Mitglieder', adminOnly: false },
  { id: 'teams', label: 'Teams', adminOnly: false },
  { id: 'projects', label: 'Projekte', adminOnly: true },
  { id: 'networks', label: 'Firmen-Netze', adminOnly: true },
  { id: 'homeOffice', label: 'Homeoffice', adminOnly: true },
  { id: 'settings', label: 'Einstellungen', adminOnly: true },
  { id: 'export', label: 'Export', adminOnly: true },
  { id: 'audit', label: 'Audit-Log', adminOnly: true },
  { id: 'calendar', label: 'Mein Kalender', adminOnly: false },
];

type State =
  | { kind: 'loading' }
  | { kind: 'login'; error?: string }
  | { kind: 'totp' }
  | { kind: 'createOrg' }
  | { kind: 'noAccess'; me: OrgMeResponse }
  | { kind: 'ready'; me: OrgMeResponse };

export interface AppProps {
  session: Session;
  /** Aktuelle Adresse (Einladungs- und SSO-Rücksprung werden daraus gelesen). */
  initialUrl: string;
  redirectTo: (url: string) => void;
  download: (blob: Blob, filename: string) => void;
  /** Entfernt Einmal-Codes aus der Adresszeile. */
  replaceUrl?: (path: string) => void;
  now?: () => number;
}

export function App({
  session,
  initialUrl,
  redirectTo,
  download,
  replaceUrl,
  now = Date.now,
}: AppProps) {
  const url = useMemo(() => new URL(initialUrl), [initialUrl]);
  const inviteToken = url.pathname === '/invite' ? url.searchParams.get('token') : null;
  // Rücksprung von der Kalender-Anmeldung: ?calendar=connected bzw. Fehlercode
  const [calendarResult] = useState(() => url.searchParams.get('calendar') ?? undefined);
  const [state, setState] = useState<State>({ kind: 'loading' });
  // Einmal-Code nur einmal einlösen (StrictMode ruft Effekte doppelt auf).
  const started = useRef(false);

  const load = useCallback(async () => {
    if (!session.hasRefreshToken()) {
      setState({ kind: 'login' });
      return;
    }
    try {
      const me = await session.client.org.me();
      setState(me.user.role === 'user' ? { kind: 'noAccess', me } : { kind: 'ready', me });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'totp_setup_required') setState({ kind: 'totp' });
      else if (err instanceof ApiError && err.code === 'no_organization')
        setState({ kind: 'createOrg' });
      else if (err instanceof ApiError && err.status === 401) setState({ kind: 'login' });
      else setState({ kind: 'login', error: errorText(err) });
    }
  }, [session]);

  useEffect(() => {
    if (inviteToken || started.current) return;
    started.current = true;
    const code = url.pathname === '/sso' ? url.searchParams.get('code') : null;
    const ssoError = url.pathname === '/sso' ? url.searchParams.get('sso_error') : null;
    if (code || ssoError || calendarResult) replaceUrl?.('/');
    if (ssoError) {
      setState({ kind: 'login', error: errorText(ssoError) });
    } else if (code) {
      session.exchange(code).then(
        () => void load(),
        (err: unknown) => {
          setState({ kind: 'login', error: errorText(err) });
        },
      );
    } else {
      void load();
    }
  }, [session, url, inviteToken, load, replaceUrl, calendarResult]);

  const afterChange = () => {
    setState({ kind: 'loading' });
    session.refresh().then(
      () => void load(),
      () => {
        setState({ kind: 'login' });
      },
    );
  };
  const logout = () => {
    void session.logout().then(() => {
      setState({ kind: 'login' });
    });
  };

  if (inviteToken) return <InviteAccept api={session.anon} token={inviteToken} />;

  switch (state.kind) {
    case 'loading':
      return (
        <main id="main" className="narrow">
          <h1>TimeLog Admin</h1>
          <p role="status">Wird geladen …</p>
        </main>
      );
    case 'login':
      return (
        <Login
          session={session}
          {...(state.error ? { initialError: state.error } : {})}
          onLoggedIn={() => void load()}
          redirectTo={redirectTo}
          ssoReturnUrl={new URL('/sso', url).toString()}
        />
      );
    case 'totp':
      return <TotpSetup api={session.client} onDone={afterChange} onLogout={logout} />;
    case 'createOrg':
      return <CreateOrg api={session.client} onDone={afterChange} onLogout={logout} />;
    case 'noAccess':
      return (
        <main id="main" className="narrow">
          <h1>Kein Zugriff auf den Web-Admin</h1>
          <p>
            Du bist Mitglied von <strong>{state.me.org.name}</strong>. Der Web-Admin ist für Manager
            und Admins. Deine Arbeitszeiten siehst und reichst du in der TimeLog-App ein.
          </p>
          <button type="button" onClick={logout}>
            Abmelden
          </button>
        </main>
      );
    case 'ready':
      return (
        <Shell
          me={state.me}
          session={session}
          download={download}
          now={now}
          onLogout={logout}
          redirectTo={redirectTo}
          calendarReturnUrl={new URL('/', url).toString()}
          {...(calendarResult ? { calendarResult } : {})}
        />
      );
  }
}

function Shell({
  me,
  session,
  download,
  now,
  onLogout,
  redirectTo,
  calendarReturnUrl,
  calendarResult,
}: {
  me: OrgMeResponse;
  session: Session;
  download: (blob: Blob, filename: string) => void;
  now: () => number;
  onLogout: () => void;
  redirectTo: (url: string) => void;
  calendarReturnUrl: string;
  calendarResult?: string;
}) {
  const [page, setPage] = useState<Page>(calendarResult ? 'calendar' : 'approvals');
  const [message, setMessage] = useState('');
  const first = useRef(true);
  const admin = isAdmin(me);
  const pages = PAGES.filter((p) => admin || !p.adminOnly);

  const ctx = useMemo<AdminContextValue>(
    () => ({
      api: session.client,
      me,
      baseUrl: session.baseUrl,
      now,
      notify: setMessage,
    }),
    [session, me, now],
  );

  // Nach einem Seitenwechsel Fokus auf die Überschrift (nicht beim ersten Laden).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    document.getElementById('page-title')?.focus();
  }, [page]);

  return (
    <AdminContext.Provider value={ctx}>
      <a href="#main" className="skip">
        Zum Inhalt springen
      </a>
      <header className="top">
        <p className="brand">
          TimeLog Admin · <strong>{me.org.name}</strong>
        </p>
        <p className="who">
          {me.user.name} ({ROLE_LABELS[me.user.role]})
          <button type="button" onClick={onLogout}>
            Abmelden
          </button>
        </p>
      </header>
      <nav aria-label="Bereiche">
        <ul>
          {pages.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                aria-current={page === p.id ? 'page' : undefined}
                onClick={() => {
                  setMessage('');
                  setPage(p.id);
                }}
              >
                {p.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" tabIndex={-1}>
        {page === 'approvals' && <Approvals />}
        {page === 'members' && <Members />}
        {page === 'teams' && <Teams />}
        {page === 'projects' && admin && <Projects />}
        {page === 'networks' && admin && <Networks />}
        {page === 'homeOffice' && admin && <HomeOffice />}
        {page === 'settings' && admin && <Settings />}
        {page === 'export' && admin && <Export download={download} />}
        {page === 'audit' && admin && <Audit />}
        {page === 'calendar' && (
          <Calendar
            redirectTo={redirectTo}
            returnUrl={calendarReturnUrl}
            {...(calendarResult ? { result: calendarResult } : {})}
          />
        )}
      </main>
      <p role="status" className="live">
        {message}
      </p>
    </AdminContext.Provider>
  );
}
