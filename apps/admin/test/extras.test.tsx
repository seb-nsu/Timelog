// Web-Admin: Funktionen, Firmenprojekte, Netz-Ort, Homeoffice-Zahlen und eigener Kalender.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import type { Session } from '../src/session.js';
import { type Call, ID, NOW, fakeServer, signedIn } from './fake.js';

afterEach(cleanup);

const P1 = '99999999-9999-4999-8999-999999999999';
const NET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function renderApp(session: Session, url = 'http://admin.test/') {
  const redirectTo = vi.fn<(url: string) => void>();
  const replaceUrl = vi.fn<(path: string) => void>();
  render(
    <App
      session={session}
      initialUrl={url}
      redirectTo={redirectTo}
      download={vi.fn()}
      replaceUrl={replaceUrl}
      now={() => NOW}
    />,
  );
  return { redirectTo, replaceUrl };
}

async function expectAccessible() {
  const result = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(result.violations.map((v) => `${v.impact ?? '?'} ${v.id}: ${v.help}`)).toEqual([]);
}

const nav = () => within(screen.getByRole('navigation', { name: 'Bereiche' }));

function server() {
  const s = fakeServer();
  let features = { projects: false, calendar: true, homeOfficeReport: false };
  const project = {
    id: P1,
    scope: 'org',
    name: 'Allgemein',
    customer: 'Intern',
    color: '#1d4ed8',
    keywords: ['jour fixe'],
    archived: false,
  };
  s.extra['GET /org/features'] = () => features;
  s.extra['PUT /org/features'] = (c: Call) => {
    features = { ...features, ...(c.body as object) };
    return features;
  };
  s.extra['GET /org/projects'] = () => ({
    enabled: features.projects,
    canManage: true,
    projects: [project],
  });
  s.extra['POST /org/projects'] = (c: Call) => ({
    ...project,
    ...(c.body as object),
    id: ID.audit,
  });
  s.extra[`PATCH /org/projects/${P1}`] = { ...project, archived: true };
  s.extra['GET /org/projects/report'] = {
    from: '2026-10-01',
    to: '2026-10-20',
    days: [],
    totals: [
      {
        projectId: P1,
        name: 'Allgemein',
        customer: 'Intern',
        workMinutes: 1000,
        topUpMinutes: 30,
        netMinutes: 970,
      },
      { projectId: null, workMinutes: 100, topUpMinutes: 0, netMinutes: 100 },
    ],
    customers: [{ customer: 'Intern', netMinutes: 970 }, { netMinutes: 100 }],
  };
  s.extra['GET /org/networks'] = {
    networks: [
      { id: NET, scope: 'org', kind: 'fingerprint', label: 'Büro-LAN', location: 'office' },
    ],
    keys: { user: 'dXNlcg==', org: 'b3Jn' },
  };
  s.extra[`PATCH /org/networks/${NET}`] = (c: Call) => ({
    id: NET,
    scope: 'org',
    kind: 'fingerprint',
    label: 'Büro-LAN',
    location: 'office',
    ...(c.body as object),
  });
  s.extra['GET /org/home-office'] = () =>
    features.homeOfficeReport
      ? {
          year: 2026,
          members: [
            {
              userId: ID.anna,
              name: 'Anna Arbeit',
              homeDaysByMonth: [2, 3, 0, 0, 0, 0, 0, 0, 4, 1, 0, 0],
            },
          ],
        }
      : [403, { error: 'feature_disabled' }];
  s.extra['GET /calendar'] = {
    allowed: true,
    providers: [
      { provider: 'google', configured: true },
      { provider: 'microsoft', configured: true },
    ],
    connections: [
      { provider: 'microsoft', status: 'active', lastSyncAt: '2026-10-20T06:00:00Z', entries: 7 },
    ],
  };
  s.extra['POST /calendar/google/connect'] = {
    url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s',
  };
  s.extra['POST /calendar/microsoft/sync'] = { entries: 8 };
  return s;
}

describe('Funktionen und Projekte', () => {
  it('Projekte einschalten, Teamprojekt mit Stichwörtern anlegen, Summen-Auswertung', async () => {
    const s = server();
    renderApp(signedIn(s));
    await screen.findByRole('heading', { level: 1, name: 'Freigaben' });
    await userEvent.click(nav().getByRole('button', { name: 'Projekte' }));
    expect(
      await screen.findByText(/Projekte sind für die Mitglieder noch ausgeschaltet/),
    ).toBeTruthy();

    await userEvent.click(nav().getByRole('button', { name: 'Einstellungen' }));
    await userEvent.click(
      await screen.findByRole('checkbox', { name: /Projekte und Tätigkeiten/ }),
    );
    await waitFor(() => {
      expect(s.calls.find((c) => c.method === 'PUT' && c.path === '/org/features')?.body).toEqual({
        projects: true,
      });
    });

    await userEvent.click(nav().getByRole('button', { name: 'Projekte' }));
    await screen.findByRole('button', { name: 'Archivieren: Allgemein' });
    expect(screen.queryByText(/noch ausgeschaltet/)).toBeNull();
    await userEvent.type(screen.getByLabelText('Name'), 'Kunde X');
    await userEvent.type(
      screen.getByLabelText('Kalender-Stichwörter (durch Komma getrennt)'),
      'x-projekt, xp',
    );
    await userEvent.selectOptions(screen.getByLabelText('Sichtbar für'), 'nur Team Vertrieb');
    await userEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    await waitFor(() => {
      expect(s.calls.find((c) => c.method === 'POST' && c.path === '/org/projects')?.body).toEqual({
        name: 'Kunde X',
        color: '#1d4ed8',
        keywords: ['x-projekt', 'xp'],
        teamId: ID.team,
      });
    });

    const table = screen.getByRole('table', { name: 'Je Projekt' });
    expect(within(table).getByRole('rowheader', { name: 'ohne Projekt' })).toBeTruthy();
    expect(within(table).getByText('16:10 h')).toBeTruthy();
    // keine Personen in der Auswertung
    expect(screen.queryByText('Anna Arbeit')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Archivieren: Allgemein' }));
    await waitFor(() => {
      expect(s.calls.some((c) => c.method === 'PATCH' && c.path === `/org/projects/${P1}`)).toBe(
        true,
      );
    });
    await expectAccessible();
  });

  it('Firmen-Netz: Ort und Standardprojekt', async () => {
    const s = server();
    await s.fetch('http://admin.test/api/v1/org/features', {
      method: 'PUT',
      body: JSON.stringify({ projects: true }),
    });
    renderApp(signedIn(s));
    await screen.findByRole('heading', { level: 1, name: 'Freigaben' });
    await userEvent.click(nav().getByRole('button', { name: 'Firmen-Netze' }));
    await userEvent.selectOptions(await screen.findByLabelText('Ort von Büro-LAN'), 'Homeoffice');
    await userEvent.selectOptions(
      await screen.findByLabelText('Standardprojekt von Büro-LAN'),
      'Allgemein',
    );
    await waitFor(() => {
      expect(s.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
        { location: 'home' },
        { defaultProjectId: P1 },
      ]);
    });
    await expectAccessible();
  });
});

describe('Homeoffice-Zahlen', () => {
  it('ohne Schalter nur ein Hinweis; eingeschaltet Anzahl je Monat', async () => {
    const s = server();
    renderApp(signedIn(s));
    await screen.findByRole('heading', { level: 1, name: 'Freigaben' });
    await userEvent.click(nav().getByRole('button', { name: 'Homeoffice' }));
    expect(await screen.findByText(/Ausgeschaltet\. Einschalten unter Einstellungen/)).toBeTruthy();
    await s.fetch('http://admin.test/api/v1/org/features', {
      method: 'PUT',
      body: JSON.stringify({ homeOfficeReport: true }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Vorjahr' }));
    await userEvent.click(screen.getByRole('button', { name: 'Folgejahr' }));
    const table = await screen.findByRole('table', { name: 'Homeoffice-Tage je Monat' });
    const row = within(table).getByRole('row', { name: /Anna Arbeit/ });
    expect(
      within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['2', '3', '0', '0', '0', '0', '0', '0', '4', '1', '0', '0', '10']);
    await expectAccessible();
  });
});

describe('Mein Kalender', () => {
  it('Verbinden leitet zum Anbieter mit Rücksprung; Abruf; Rückmeldung nach dem Rücksprung', async () => {
    const s = server();
    const { redirectTo } = renderApp(signedIn(s));
    await screen.findByRole('heading', { level: 1, name: 'Freigaben' });
    await userEvent.click(nav().getByRole('button', { name: 'Mein Kalender' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Google Kalender verbinden' }));
    await waitFor(() => {
      expect(redirectTo).toHaveBeenCalledWith(
        'https://accounts.google.com/o/oauth2/v2/auth?state=s',
      );
    });
    expect(s.calls.find((c) => c.path === '/calendar/google/connect')?.body).toEqual({
      redirect: 'http://admin.test/',
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Jetzt abrufen: Microsoft 365 / Outlook' }),
    );
    expect(await screen.findByText('8 Termine abgerufen.')).toBeTruthy();
    await expectAccessible();
    cleanup();

    const { replaceUrl } = renderApp(signedIn(s), 'http://admin.test/?calendar=connected');
    expect(await screen.findByText('Kalender verbunden.')).toBeTruthy();
    expect(replaceUrl).toHaveBeenCalledWith('/');
  });
});
