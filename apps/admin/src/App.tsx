// Web-Admin: Anmeldung, Zwei-Faktor-Pflicht, rollenabhängige Navigation.
import { ApiError, type OrgMeResponse } from '@timelog/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Approvals } from './screens/Approvals.js';
import { Audit } from './screens/Audit.js';
import { Calendar } from './screens/Calendar.js';
import { Export } from './screens/Export.js';
import { HomeOffice } from './screens/HomeOffice.js';
import { InviteAccept } from './screens/InviteAccept.js';
import { Leave } from './screens/Leave.js';
import { CreateOrg, Login, TotpSetup } from './screens/Login.js';
import { Members } from './screens/Members.js';
import { Networks } from './screens/Networks.js';
import { Payroll } from './screens/Payroll.js';
import { Projects } from './screens/Projects.js';
import { Settings } from './screens/Settings.js';
import { Teams } from './screens/Teams.js';
import type { Session } from './session.js';
import { L, ROLE_LABELS, errorText } from './texts.js';
import { AdminContext, type AdminContextValue, isAdmin } from './ui.js';

type Page =
  | 'approvals'
  | 'leave'
  | 'members'
  | 'teams'
  | 'projects'
  | 'networks'
  | 'homeOffice'
  | 'settings'
  | 'export'
  | 'payroll'
  | 'audit'
  | 'calendar';

// Navigation in Gruppen: Tagesgeschäft im Team zuerst, Firmen-Einrichtung, dann Auswertung und Lohn.
const GROUPS = ['team', 'company', 'reports', 'account'] as const;
type Group = (typeof GROUPS)[number];
const GROUP_LABELS: Record<Group, string> = {
  team: 'Team',
  company: L('Firma', 'Company'),
  reports: L('Auswertung & Lohn', 'Reports & payroll'),
  account: L('Mein Konto', 'My account'),
};

const PAGES: { id: Page; label: string; adminOnly: boolean; group: Group }[] = [
  { id: 'approvals', label: L('Freigaben', 'Approvals'), adminOnly: false, group: 'team' },
  { id: 'leave', label: L('Urlaub', 'Leave'), adminOnly: false, group: 'team' },
  { id: 'members', label: L('Mitglieder', 'Members'), adminOnly: false, group: 'team' },
  { id: 'teams', label: 'Teams', adminOnly: false, group: 'team' },
  { id: 'settings', label: L('Einstellungen', 'Settings'), adminOnly: true, group: 'company' },
  { id: 'projects', label: L('Projekte', 'Projects'), adminOnly: true, group: 'company' },
  {
    id: 'networks',
    label: L('Firmen-Netze', 'Company networks'),
    adminOnly: true,
    group: 'company',
  },
  { id: 'export', label: 'Export', adminOnly: true, group: 'reports' },
  { id: 'payroll', label: L('Lohn', 'Payroll'), adminOnly: true, group: 'reports' },
  { id: 'homeOffice', label: L('Homeoffice', 'Home office'), adminOnly: true, group: 'reports' },
  { id: 'audit', label: L('Audit-Log', 'Audit log'), adminOnly: true, group: 'reports' },
  { id: 'calendar', label: L('Mein Kalender', 'My calendar'), adminOnly: false, group: 'account' },
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
          <p role="status">{L('Wird geladen …', 'Loading …')}</p>
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
          <h1>{L('Kein Zugriff auf den Web-Admin', 'No access to the web admin')}</h1>
          <p>
            {L('Du bist Mitglied von ', 'You are a member of ')}
            <strong>{state.me.org.name}</strong>
            {L(
              '. Der Web-Admin ist für Manager und Admins. Deine Arbeitszeiten siehst und reichst du in der TimeLog-App ein.',
              '. The web admin is for managers and admins. You can view and submit your working hours in the TimeLog app.',
            )}
          </p>
          <button type="button" onClick={logout}>
            {L('Abmelden', 'Sign out')}
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
        {L('Zum Inhalt springen', 'Skip to content')}
      </a>
      <header className="top">
        <p className="brand">
          TimeLog Admin · <strong>{me.org.name}</strong>
        </p>
        <p className="who">
          {me.user.name} ({ROLE_LABELS[me.user.role]})
          <button type="button" onClick={onLogout}>
            {L('Abmelden', 'Sign out')}
          </button>
        </p>
      </header>
      <nav aria-label={L('Bereiche', 'Sections')}>
        {GROUPS.map((g, i) => {
          const items = pages.filter((p) => p.group === g);
          if (items.length === 0) return null;
          const id = `nav-${String(i)}`;
          return (
            <div key={g} className="nav-group">
              <h2 id={id}>{GROUP_LABELS[g]}</h2>
              <ul aria-labelledby={id}>
                {items.map((p) => (
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
            </div>
          );
        })}
      </nav>
      <main id="main" tabIndex={-1}>
        {page === 'approvals' && <Approvals />}
        {page === 'leave' && <Leave />}
        {page === 'members' && <Members />}
        {page === 'teams' && <Teams />}
        {page === 'projects' && admin && <Projects />}
        {page === 'networks' && admin && <Networks />}
        {page === 'homeOffice' && admin && <HomeOffice />}
        {page === 'settings' && admin && <Settings />}
        {page === 'export' && admin && <Export download={download} />}
        {page === 'payroll' && admin && <Payroll download={download} />}
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
