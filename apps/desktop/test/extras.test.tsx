// Projekte, Arbeitsort, Kalender-Vorschläge und Auswertung in der Desktop-Oberfläche.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { type Fake, clock, fakeBackend } from './fake.js';

afterEach(cleanup);

const P1 = '22222222-2222-4222-8222-222222222222';
const NET = '11111111-1111-4111-8111-111111111111';
const tz = 'Europe/Berlin';

const dayView = (projectId: string | null) => ({
  day: {
    date: '2026-10-14',
    items: [
      { projectId: P1, workMinutes: 240, topUpMinutes: 0, netMinutes: 240, manual: false },
      { projectId: null, workMinutes: 275, topUpMinutes: 15, netMinutes: 260, manual: false },
    ],
  },
  segments: [
    {
      from: '2026-10-14T06:00:00.000Z',
      to: '2026-10-14T10:00:00.000Z',
      projectId: P1,
      manual: false,
    },
    {
      from: '2026-10-14T10:30:00.000Z',
      to: '2026-10-14T15:05:00.000Z',
      projectId,
      manual: projectId !== null,
    },
  ],
  assignments: [],
  locked: false,
});

const location = (loc: 'home' | 'office', source: 'auto' | 'manual') => ({
  date: '2026-10-14',
  location: loc,
  source,
  officeMinutes: 0,
  homeMinutes: 500,
});

function withExtras(): Fake {
  const backend = fakeBackend(
    {},
    {
      events: [
        {
          id: 'b',
          type: 'boot',
          source: 'system',
          ts: '2026-10-14T06:00:00Z',
          tz,
          createdAt: '2026-10-14T06:00:00Z',
        },
        {
          id: 'x',
          type: 'shutdown',
          source: 'system',
          ts: '2026-10-14T15:00:00Z',
          tz,
          createdAt: '2026-10-14T15:00:00Z',
        },
      ],
      spans: [
        { id: 's1', start: '2026-10-14T06:00:00Z', end: '2026-10-14T10:00:00Z', open: false },
        { id: 's2', start: '2026-10-14T10:30:00Z', end: '2026-10-14T15:00:00Z', open: false },
      ],
    },
  );
  const r = backend.responses;
  r['GET /api/v1/projects'] = {
    enabled: true,
    canManage: true,
    projects: [
      {
        id: P1,
        scope: 'user',
        name: 'Alpha',
        customer: 'ACME',
        color: '#1d4ed8',
        keywords: ['alpha'],
        archived: false,
      },
    ],
  };
  r['POST /api/v1/projects'] = {
    id: '33333333-3333-4333-8333-333333333333',
    scope: 'user',
    name: 'Beta',
    color: '#1d4ed8',
    keywords: ['beta', 'b2'],
    archived: false,
  };
  r['GET /api/v1/days/2026-10-14/projects'] = dayView(null);
  r['POST /api/v1/days/2026-10-14/projects'] = dayView(P1);
  r['GET /api/v1/days/2026-10-15/projects'] = {
    ...dayView(null),
    day: { date: '2026-10-15', items: [] },
    segments: [],
  };
  r['GET /api/v1/locations'] = {
    year: 2026,
    days: [location('home', 'auto')],
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
  r['PUT /api/v1/days/2026-10-14/location'] = location('office', 'manual');
  r['GET /api/v1/calendar'] = {
    allowed: true,
    providers: [
      { provider: 'google', configured: true },
      { provider: 'microsoft', configured: true },
    ],
    connections: [
      { provider: 'google', status: 'active', lastSyncAt: '2026-10-15T06:00:00Z', entries: 3 },
    ],
  };
  r['POST /api/v1/calendar/google/sync'] = { entries: 4 };
  r['DELETE /api/v1/calendar/google'] = { ok: true };
  r['POST /api/v1/calendar/microsoft/connect'] = {
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=abc',
  };
  r['GET /api/v1/calendar/suggestions'] = {
    gaps: [
      {
        date: '2026-10-14',
        sessionId: 's',
        from: '2026-10-14T10:00:00.000Z',
        to: '2026-10-14T10:30:00.000Z',
        kind: 'break',
      },
    ],
    absences: [{ date: '2026-10-16', kind: 'vacation' }],
  };
  r['PUT /api/v1/absences'] = { ok: true };
  r['GET /api/v1/projects/report'] = {
    from: '2026-10-01',
    to: '2026-10-15',
    days: [],
    totals: [
      {
        projectId: P1,
        name: 'Alpha',
        customer: 'ACME',
        workMinutes: 240,
        topUpMinutes: 0,
        netMinutes: 240,
      },
      { projectId: null, workMinutes: 275, topUpMinutes: 15, netMinutes: 260 },
    ],
    customers: [{ customer: 'ACME', netMinutes: 240 }, { netMinutes: 260 }],
  };
  r['GET /api/v1/networks'] = {
    networks: [{ id: NET, scope: 'user', kind: 'fingerprint', label: 'Zuhause', location: 'home' }],
    keys: { user: 'a2V5' },
  };
  r['PATCH /api/v1/networks/' + NET] = {
    id: NET,
    scope: 'user',
    kind: 'fingerprint',
    label: 'Zuhause',
    location: 'office',
  };
  return backend;
}

const sent = (b: Fake, prefix: string) => b.calls.requests.filter((r) => r.startsWith(prefix));

describe('Tagesprotokoll: Projekte und Arbeitsort', () => {
  it('zeigt die Aufteilung, ordnet einen Abschnitt zu und setzt den Ort von Hand', async () => {
    const backend = withExtras();
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tagesprotokoll' }));
    await userEvent.click(screen.getByRole('button', { name: 'Vorheriger Tag' }));
    expect(await screen.findByText('Alpha: 4:00 h')).toBeTruthy();
    expect(screen.getByText(/davon 15 min Pausenauffüllung abgezogen/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Projekt für 12:30–17:05'), 'Alpha');
    await waitFor(() => {
      expect(sent(backend, 'POST /api/v1/days/2026-10-14/projects')).toEqual([
        `POST /api/v1/days/2026-10-14/projects {"from":"2026-10-14T10:30:00.000Z","to":"2026-10-14T15:05:00.000Z","projectId":"${P1}"}`,
      ]);
    });
    const select = screen.getByLabelText<HTMLSelectElement>('Arbeitsort');
    expect(select.options[0]?.textContent).toBe('automatisch: Homeoffice');
    await userEvent.selectOptions(select, 'Büro');
    await waitFor(() => {
      expect(sent(backend, 'PUT /api/v1/days/2026-10-14/location')).toEqual([
        'PUT /api/v1/days/2026-10-14/location {"location":"office"}',
      ]);
    });
  });

  it('ohne Projekte (403) bleibt das Protokoll wie bisher', async () => {
    const backend = fakeBackend();
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tagesprotokoll' }));
    expect(screen.queryByText('Projekte an diesem Tag')).toBeNull();
    expect(screen.queryByLabelText('Arbeitsort')).toBeNull();
  });
});

describe('Zu prüfen: Kalender-Vorschläge', () => {
  it('„War Arbeit (Termin)“ erzeugt manual_work, Abwesenheit wird erst nach Klick eingetragen', async () => {
    const backend = withExtras();
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await userEvent.click(await screen.findByRole('button', { name: /^Zu prüfen/ }));
    const meeting = await screen.findByRole('button', {
      name: 'War Arbeit (Termin): Mi., 14.10.2026 · Termin während der Pause 12:00–12:30',
    });
    expect(sent(backend, 'PUT /api/v1/absences')).toEqual([]);
    await userEvent.click(meeting);
    expect(backend.calls.ranges).toEqual([
      ['manual_work', '2026-10-14T10:00:00.000Z', '2026-10-14T10:30:00.000Z'],
    ]);
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Als Urlaub eintragen: Fr., 16.10.2026 · Laut Kalender ganztägig abwesend',
      }),
    );
    await waitFor(() => {
      expect(sent(backend, 'PUT /api/v1/absences')[0]).toContain('"kind":"vacation"');
    });
    expect(screen.queryByText(/Laut Kalender ganztägig abwesend/)).toBeNull();
    expect(backend.stored.get('calendar.hidden')).toContain('2026-10-16');
  });
});

describe('Einstellungen: Projekte, Kalender, Netz-Ort', () => {
  it('legt ein Projekt mit Stichwörtern an und archiviert', async () => {
    const backend = withExtras();
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Einstellungen' }));
    await userEvent.type(await screen.findByLabelText('Name'), 'Beta');
    await userEvent.type(
      screen.getByLabelText('Kalender-Stichwörter (durch Komma getrennt)'),
      'beta, b2, beta',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Projekt anlegen' }));
    await waitFor(() => {
      expect(sent(backend, 'POST /api/v1/projects')[0]).toContain('"keywords":["beta","b2"]');
    });
    backend.responses['PATCH /api/v1/projects/' + P1] = {
      id: P1,
      scope: 'user',
      name: 'Alpha',
      color: '#1d4ed8',
      keywords: [],
      archived: true,
    };
    await userEvent.click(screen.getByRole('button', { name: 'Archivieren: Alpha' }));
    await waitFor(() => {
      expect(sent(backend, `PATCH /api/v1/projects/${P1}`)).toEqual([
        `PATCH /api/v1/projects/${P1} {"archived":true}`,
      ]);
    });
  });

  it('Kalender: abrufen, trennen, Microsoft verbinden (Adresse zum Kopieren)', async () => {
    const backend = withExtras();
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Einstellungen' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Jetzt abrufen: Google Kalender' }),
    );
    expect(await screen.findByText('4 Termine abgerufen.')).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: 'Microsoft 365 / Outlook verbinden' }),
    );
    const url = await screen.findByLabelText<HTMLInputElement>(/Öffne diese Adresse im Browser/);
    expect(url.value).toContain('login.microsoftonline.com');
    expect(url.readOnly).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Trennen: Google Kalender' }));
    expect(await screen.findByText(/Verbindung getrennt/)).toBeTruthy();
  });

  it('Ort und Standardprojekt eines eigenen Netzes', async () => {
    const backend = withExtras();
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Einstellungen' }));
    await userEvent.selectOptions(await screen.findByLabelText('Ort von „Zuhause“'), 'Büro');
    await userEvent.selectOptions(
      await screen.findByLabelText('Standardprojekt in diesem Netz (Zuhause)'),
      'Alpha',
    );
    await waitFor(() => {
      expect(sent(backend, `PATCH /api/v1/networks/${NET}`)).toEqual([
        `PATCH /api/v1/networks/${NET} {"location":"office"}`,
        `PATCH /api/v1/networks/${NET} {"defaultProjectId":"${P1}"}`,
      ]);
    });
  });
});

describe('Auswertung', () => {
  it('Projektzeiten je Projekt und Kunde, Homeoffice-Jahr mit Tagespauschale', async () => {
    const backend = withExtras();
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Auswertung' }));
    expect(await screen.findByRole('rowheader', { name: 'Alpha' })).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'ohne Projekt' })).toBeTruthy();
    expect(screen.getByText('ACME: 4:00 h')).toBeTruthy();
    expect(screen.getByText('Homeoffice-Tage: 1')).toBeTruthy();
    expect(screen.getByText(/Tagespauschale rechnerisch: 6,00/)).toBeTruthy();
    expect(screen.getByText(/Nr\. 6c EStG/)).toBeTruthy();
    expect(sent(backend, 'GET /api/v1/projects/report')).toHaveLength(1);
  });
});

describe('Barrierefreiheit (neue Bereiche)', () => {
  it('Protokoll, Prüfliste, Auswertung und Einstellungen mit Projekten und Kalender', async () => {
    const axe = (await import('axe-core')).default;
    const backend = withExtras();
    const { container } = render(
      <App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />,
    );
    await screen.findByRole('button', { name: 'Tagesprotokoll' });
    const pages: [string, string | RegExp][] = [
      ['Tagesprotokoll', 'Projekte an diesem Tag'],
      ['Zu prüfen', 'Vorschläge aus dem Kalender'],
      ['Auswertung', 'Projektzeiten'],
      ['Einstellungen', 'Kalender'],
    ];
    for (const [page, heading] of pages) {
      await userEvent.click(screen.getByRole('button', { name: new RegExp(`^${page}`) }));
      if (page === 'Tagesprotokoll') {
        await userEvent.click(screen.getByRole('button', { name: 'Vorheriger Tag' }));
      }
      await screen.findByRole('heading', { name: heading });
      const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
      const serious = result.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      );
      expect(serious.map((v) => `${page}: ${v.id}`)).toEqual([]);
    }
  });
});
