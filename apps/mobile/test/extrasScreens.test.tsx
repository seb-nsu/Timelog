// Projekte, Arbeitsort, Kalender und Auswertung in der Handy-App (mit gefaktem Server).
import { describe, expect, it } from '@jest/globals';
import { render, screen, userEvent } from '@testing-library/react-native';
import { App } from '../src/App';
import type { PlatformActions } from '../src/ui/context';
import { type Harness, harness, loggedIn } from './helpers';

const P1 = '44444444-4444-4444-8444-444444444444';

function actions(): PlatformActions & { shared: string[]; opened: string[] } {
  const shared: string[] = [];
  const opened: string[] = [];
  return {
    shared,
    opened,
    shareFile: (name) => {
      shared.push(name);
      return Promise.resolve();
    },
    requestNotifications: () => Promise.resolve(true),
    openUrl: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
  };
}

async function show(h: Harness, locale: 'de' | 'en' = 'de') {
  const a = actions();
  await render(<App core={h.core} locale={locale} actions={a} clock={h.clock} />);
  return a;
}

const button = (name: string | RegExp) => screen.findByRole('button', { name });

interface Sent {
  assign: unknown[];
  location: unknown[];
  absences: unknown[];
  projects: unknown[];
  networks: unknown[];
}

/** Server mit eingeschalteten Projekten, Homeoffice-Tag und verbundenem Google-Kalender. */
function withExtras(h: Harness): Sent {
  const sent: Sent = { assign: [], location: [], absences: [], projects: [], networks: [] };
  const project = {
    id: P1,
    scope: 'user',
    name: 'Alpha',
    customer: 'ACME',
    color: '#1d4ed8',
    keywords: [],
    archived: false,
  };
  const day = (projectId: string | null) => ({
    day: {
      date: '2026-10-14',
      items: [
        {
          projectId,
          workMinutes: 545,
          topUpMinutes: 0,
          netMinutes: 500,
          manual: projectId !== null,
        },
      ],
    },
    segments: [
      {
        from: '2026-10-14T06:00:00.000Z',
        to: '2026-10-14T15:05:00.000Z',
        projectId,
        manual: false,
      },
    ],
    assignments: [],
    locked: false,
  });
  const e = h.server.extra;
  e['GET /projects'] = { enabled: true, canManage: true, projects: [project] };
  e['POST /projects'] = (b: unknown) => {
    sent.projects.push(b);
    return { ...project, id: '55555555-5555-4555-8555-555555555555', name: 'Beta' };
  };
  e['PATCH /projects/' + P1] = { ...project, archived: true };
  e['GET /days/2026-10-14/projects'] = day(null);
  e['GET /days/2026-10-15/projects'] = {
    ...day(null),
    day: { date: '2026-10-15', items: [] },
    segments: [],
  };
  e['POST /days/2026-10-14/projects'] = (b: unknown) => {
    sent.assign.push(b);
    return day(P1);
  };
  e['GET /locations'] = {
    year: 2026,
    days: [
      { date: '2026-10-14', location: 'home', source: 'auto', officeMinutes: 0, homeMinutes: 500 },
    ],
    summary: {
      homeDays: 1,
      officeDays: 0,
      otherDays: 0,
      homeDaysByMonth: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
      maxDays: 210,
      amountCents: 600,
    },
    allowance: {
      perDayCents: 600,
      maxPerYearCents: 126000,
      legalBasis: '§ 4 Abs. 5 Satz 1 Nr. 6c EStG (Tagespauschale)',
    },
  };
  e['PUT /days/2026-10-14/location'] = (b: unknown) => {
    sent.location.push(b);
    return {
      date: '2026-10-14',
      location: 'office',
      source: 'manual',
      officeMinutes: 0,
      homeMinutes: 0,
    };
  };
  e['GET /calendar'] = {
    allowed: true,
    providers: [
      { provider: 'google', configured: true },
      { provider: 'microsoft', configured: false },
    ],
    connections: [],
  };
  e['POST /calendar/google/connect'] = {
    url: 'https://accounts.google.com/o/oauth2/v2/auth?state=xyz',
  };
  e['GET /calendar/suggestions'] = {
    gaps: [],
    absences: [{ date: '2026-10-13', kind: 'vacation' }],
  };
  e['GET /locations/export'] = 'Datum;Ort';
  e['GET /projects/report'] = {
    from: '2026-10-01',
    to: '2026-10-15',
    days: [],
    totals: [
      {
        projectId: P1,
        name: 'Alpha',
        customer: 'ACME',
        workMinutes: 545,
        topUpMinutes: 0,
        netMinutes: 500,
      },
    ],
    customers: [{ customer: 'ACME', netMinutes: 500 }],
  };
  return sent;
}

/** Zusatzfunktionen Kalender und Homeoffice einschalten (Projekte schaltet der Server). */
async function enableExtras(h: Harness) {
  await h.core.saveSettings({ ...(await h.core.settings()), calendar: true, homeOffice: true });
}

async function openDay(user: ReturnType<typeof userEvent.setup>, day: RegExp) {
  await user.press(await screen.findByRole('tab', { name: /^Zeiten/ }));
  await user.press(await button(day));
}

describe('Projekte und Arbeitsort im Tagesprotokoll', () => {
  it('ordnet den Abschnitt einem Projekt zu und setzt den Ort von Hand', async () => {
    const h = await loggedIn();
    await h.core.finishSetup();
    const sent = withExtras(h);
    await enableExtras(h);
    await show(h);
    const user = userEvent.setup();
    await openDay(user, /^Mi\., 14\.10\.2026/);
    expect(await screen.findByText('Projekte an diesem Tag')).toBeOnTheScreen();
    await user.press(screen.getByRole('radio', { name: 'Alpha' }));
    expect(await screen.findByLabelText('Alpha: 8:20 (von Hand)')).toBeOnTheScreen();
    expect(sent.assign).toEqual([
      { from: '2026-10-14T06:00:00.000Z', to: '2026-10-14T15:05:00.000Z', projectId: P1 },
    ]);
    expect(screen.getByRole('radio', { name: 'automatisch: Homeoffice' })).toBeChecked();
    await user.press(screen.getByRole('radio', { name: 'Büro' }));
    expect(sent.location).toEqual([{ location: 'office' }]);
  });

  it('ohne Konto keine Projekt- oder Ortsbereiche', async () => {
    const h = await harness();
    await h.core.useLocalOnly();
    await h.core.finishSetup();
    await show(h);
    const user = userEvent.setup();
    await openDay(user, /^Do\., 15\.10\.2026/);
    expect(screen.queryByText('Projekte an diesem Tag')).not.toBeOnTheScreen();
    expect(screen.queryByText('Arbeitsort')).not.toBeOnTheScreen();
  });
});

describe('Kalender', () => {
  it('Verbinden öffnet den Browser; Abwesenheits-Vorschlag erst nach Bestätigung', async () => {
    const h = await loggedIn();
    await h.core.finishSetup();
    withExtras(h);
    await enableExtras(h);
    const a = await show(h);
    const user = userEvent.setup();
    await user.press(await screen.findByRole('tab', { name: 'Einstellungen' }));
    await user.press(await screen.findByRole('radio', { name: 'Zusatzfunktionen' }));
    await user.press(await button('Google Kalender verbinden'));
    expect(a.opened).toEqual(['https://accounts.google.com/o/oauth2/v2/auth?state=xyz']);

    h.server.extra['GET /calendar'] = {
      allowed: true,
      providers: [{ provider: 'google', configured: true }],
      connections: [{ provider: 'google', status: 'active', entries: 2 }],
    };
    await user.press(await screen.findByRole('tab', { name: /^Heute/ }));
    expect(await screen.findByText(/Laut Kalender ganztägig abwesend/)).toBeOnTheScreen();
    expect(h.server.absences).toHaveLength(0);
    await user.press(await button('Als Urlaub eintragen'));
    expect(await screen.findByText('Speichern')).toBeOnTheScreen();
    expect(h.server.absences).toEqual([
      expect.objectContaining({ date: '2026-10-13', kind: 'vacation' }),
    ]);
  });
});

describe('Einstellungen und Auswertung', () => {
  it('Projekt anlegen; Auswertung mit Kunden und Homeoffice, Export als PDF', async () => {
    const h = await loggedIn();
    await h.core.finishSetup();
    const sent = withExtras(h);
    await enableExtras(h);
    const a = await show(h);
    const user = userEvent.setup();
    await user.press(await screen.findByRole('tab', { name: 'Einstellungen' }));
    await user.press(await screen.findByRole('radio', { name: 'Zusatzfunktionen' }));
    await user.type(await screen.findByLabelText('Name'), 'Beta');
    await user.type(
      screen.getByLabelText('Kalender-Stichwörter (durch Komma getrennt)'),
      'beta, x',
    );
    await user.press(await button('Projekt anlegen'));
    expect(sent.projects).toEqual([{ name: 'Beta', keywords: ['beta'] }]);

    await user.press(await screen.findByRole('tab', { name: 'Zeiten' }));
    await user.press(await button('Auswertung'));
    expect(await screen.findByText('Projektzeiten')).toBeOnTheScreen();
    expect(screen.getByLabelText('Alpha: 8:20')).toBeOnTheScreen();
    expect(screen.getByLabelText('ACME: 8:20')).toBeOnTheScreen();
    expect(screen.getByText('Homeoffice-Tage: 1')).toBeOnTheScreen();
    expect(screen.getByText(/Nr\. 6c EStG/)).toBeOnTheScreen();
    await user.press(await button('PDF exportieren: Homeoffice-Nachweis 2026'));
    expect(await screen.findByText('Export erstellt.')).toBeOnTheScreen();
    expect(a.shared).toEqual(['homeoffice_2026.pdf']);
    for (const el of screen.getAllByRole('button')) expect(el).toHaveAccessibleName();
  });

  it('Englische Texte für die neuen Bereiche', async () => {
    const h = await loggedIn();
    await h.core.finishSetup();
    withExtras(h);
    await enableExtras(h);
    await show(h, 'en');
    const user = userEvent.setup();
    await user.press(await screen.findByRole('tab', { name: 'Settings' }));
    await user.press(await screen.findByRole('radio', { name: 'Extras' }));
    expect(await screen.findByText('Track projects and activities')).toBeOnTheScreen();
    expect(await button('Connect Google Calendar')).toBeOnTheScreen();
    for (const el of screen.getAllByRole('button')) expect(el).toHaveAccessibleName();
  });
});
