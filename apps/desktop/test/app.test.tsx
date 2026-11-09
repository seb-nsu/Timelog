import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { invokeFetch } from '../src/backend.js';
import { clock, fakeBackend } from './fake.js';

afterEach(cleanup);

const tz = 'Europe/Berlin';
const boot = (id: string, ts: string) => ({
  id,
  type: 'boot' as const,
  source: 'system' as const,
  ts,
  tz,
  createdAt: ts,
});

describe('Status', () => {
  it('zeigt laufende Arbeitszeit, setzt den Tray-Text und startet/stoppt manuell', async () => {
    const backend = fakeBackend(
      {},
      {
        events: [boot('b1', '2026-10-15T06:00:00Z')],
        spans: [
          { id: 's1', start: '2026-10-15T06:00:00Z', end: '2026-10-15T09:00:00Z', open: true },
        ],
      },
    );
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    expect(await screen.findByText('Arbeitszeit läuft')).toBeTruthy();
    expect(screen.getByText('seit 08:00')).toBeTruthy();
    expect(screen.getByText('3:00 h')).toBeTruthy();
    await waitFor(() => {
      expect(backend.setTrayStatus).toHaveBeenCalledWith(
        'Arbeitszeit läuft seit 08:00 · netto 3:00 h',
      );
    });
    await userEvent.click(screen.getByRole('button', { name: 'Arbeit beenden' }));
    expect(backend.calls.manual).toEqual(['manual_end']);
  });

  it('beschriftet das Tray-Menü in der Sprache der Oberfläche', async () => {
    const backend = fakeBackend();
    render(<App locale="en" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await waitFor(() => {
      expect(backend.setTrayLabels).toHaveBeenCalledWith({
        open: 'Open TimeLog',
        start: 'Start work',
        stop: 'Stop work',
        quit: 'Quit TimeLog',
      });
    });
    await waitFor(() => {
      expect(backend.calls.requests).toContain('POST /api/v1/devices {"locale":"en"}');
    });
  });

  it('ohne Erfassung: Arbeit beginnen', async () => {
    const backend = fakeBackend({ pending: 3 });
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Arbeit beginnen' }));
    expect(backend.calls.manual).toEqual(['manual_start']);
    expect(screen.getByText('3 Einträge warten auf Übertragung')).toBeTruthy();
  });
});

describe('Tagesprotokoll', () => {
  it('listet Ereignisse mit Quelle und wertet eine Pause als Arbeit', async () => {
    const backend = fakeBackend(
      {},
      {
        events: [
          boot('b1', '2026-10-14T06:00:00Z'),
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
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Zeiten' }));
    expect(screen.getByRole('button', { name: 'Zeiten' }).getAttribute('aria-current')).toBe(
      'page',
    );
    // Tag aus der Tagesliste öffnen
    await userEvent.click(await screen.findByRole('button', { name: 'Mi., 14.10.2026' }));
    expect(screen.getByRole('heading', { name: 'Mi., 14.10.2026' })).toBeTruthy();
    expect(screen.getByText('08:00–17:05 · 8:35 h')).toBeTruthy();
    const details = screen.getByText(/Ereignisprotokoll/).closest('details');
    if (!details) throw new Error('Ereignisprotokoll fehlt');
    expect(within(details).getByText(/Hochgefahren/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'War Arbeit: Pause 12:00–12:30' }));
    expect(backend.calls.ranges).toEqual([
      ['manual_work', '2026-10-14T10:00:00.000Z', '2026-10-14T10:30:00.000Z'],
    ]);
    // In die Zukunft blättern geht nicht
    await userEvent.click(screen.getByRole('button', { name: 'Nächster Tag' }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Nächster Tag' }).disabled).toBe(
      true,
    );
  });
});

describe('Zeiten', () => {
  const workday = () =>
    fakeBackend(
      {},
      {
        events: [
          boot('b1', '2026-10-14T06:00:00Z'),
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
          { id: 's1', start: '2026-10-14T06:00:00Z', end: '2026-10-14T15:00:00Z', open: false },
        ],
      },
    );

  it('korrigiert das Ende eines Tages mit Begründung', async () => {
    const backend = workday();
    backend.responses['PATCH /api/v1/days/2026-10-14'] = {
      eventId: '44444444-4444-4444-8444-444444444444',
    };
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Zeiten' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mi., 14.10.2026' }));
    await userEvent.selectOptions(screen.getByLabelText('Was korrigieren?'), 'end');
    await userEvent.type(screen.getByLabelText('Uhrzeit'), '17:30');
    await userEvent.type(screen.getByLabelText('Begründung'), 'Meeting im Büro');
    await userEvent.click(screen.getByRole('button', { name: 'Korrektur speichern' }));
    expect(await screen.findByText(/^Korrektur gespeichert/)).toBeTruthy();
    expect(backend.calls.requests).toContain(
      'PATCH /api/v1/days/2026-10-14 {"field":"end","time":"2026-10-14T15:30:00.000Z","reason":"Meeting im Büro"}',
    );
    // Zurück in die Woche
    await userEvent.click(screen.getByRole('button', { name: /Zurück zur Übersicht/ }));
    expect(screen.getByRole('heading', { name: /^KW 42/ })).toBeTruthy();
  });

  it('exportiert den Zeitraum; Zusatzfunktionen bleiben ohne Einschalten unsichtbar', async () => {
    const backend = workday();
    backend.responses['GET /api/v1/export'] = 'Datum;Netto';
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Zeiten' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Monat' }));
    expect(screen.getByRole('heading', { name: 'Oktober 2026' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'CSV exportieren' }));
    expect(await screen.findByText('Export erstellt.')).toBeTruthy();
    expect(backend.calls.requests).toContainEqual(expect.stringMatching(/^GET \/api\/v1\/export/));
    expect(screen.queryByRole('button', { name: 'Auswertung' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Mi., 14.10.2026' }));
    expect(screen.queryByText('Arbeitsort')).toBeNull();
    expect(screen.queryByText('Projekte an diesem Tag')).toBeNull();
  });
});

describe('Zu prüfen', () => {
  it('bestätigt eine Sitzung am Samstag', async () => {
    const backend = fakeBackend(
      {},
      {
        events: [
          boot('sat', '2026-10-17T08:00:00Z'),
          {
            id: 'x',
            type: 'shutdown',
            source: 'system',
            ts: '2026-10-17T10:00:00Z',
            tz,
            createdAt: '2026-10-17T10:00:00Z',
          },
        ],
        spans: [
          { id: 's1', start: '2026-10-17T08:00:00Z', end: '2026-10-17T10:00:00Z', open: false },
        ],
      },
    );
    render(<App locale="de" backend={backend} clock={clock('2026-10-19T07:00:00Z')} />);
    // „Zu prüfen“ steht direkt auf Heute
    expect(await screen.findByText(/Arbeit an einem Tag ohne Sollzeit/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: 'Bestätigen: Arbeitszeit 10:00–12:05' }),
    );
    expect(backend.calls.decisions).toEqual([['sat', true]]);
  });
});

describe('Einrichtung', () => {
  it('führt durch Anmeldung, Netz, Sollzeiten, Erklärung und Testlauf', async () => {
    const backend = fakeBackend({ loggedIn: false, setupDone: false, baseUrl: null });
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    expect(await screen.findByRole('heading', { name: 'Konto anmelden' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Server-Adresse'), 'https://zeit.example');
    await userEvent.type(screen.getByLabelText('E-Mail'), 'a@b.de');
    await userEvent.type(screen.getByLabelText('Passwort'), 'geheim-geheim');
    await userEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
    expect(backend.login).toHaveBeenCalledWith({
      baseUrl: 'https://zeit.example',
      email: 'a@b.de',
      password: 'geheim-geheim',
    });

    expect(await screen.findByRole('heading', { name: 'Arbeitsnetz hinterlegen' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Aktuelles Netz übernehmen' }));
    expect(await screen.findByText('Netz „Arbeitsplatz“ hinterlegt.')).toBeTruthy();
    expect(backend.calls.requests).toContain(
      'POST /api/v1/networks {"kind":"fingerprint","label":"Arbeitsplatz","fingerprint":"gw=aa:bb:cc:dd:ee:ff"}',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Überspringen' }));

    expect(await screen.findByRole('heading', { name: 'Sollzeiten und Bundesland' })).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Bundesland'), 'BY');
    const friday = screen.getByLabelText('Freitag');
    await userEvent.clear(friday);
    await userEvent.type(friday, '6');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByRole('heading', { name: 'So wird erfasst' })).toBeTruthy();
    expect(backend.calls.requests).toContain('PUT /api/v1/settings {"state":"BY"}');
    expect(backend.calls.requests).toContainEqual(
      expect.stringMatching(
        /^PUT \/api\/v1\/target-hours \{"validFrom":"\d{4}-\d{2}-\d{2}","minutesByWeekday":\[0,480,480,480,480,360,0\]\}$/,
      ),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByRole('heading', { name: 'Testlauf' })).toBeTruthy();
    expect(screen.getByText('Rechner eingeschaltet um 08:00')).toBeTruthy();
    expect(screen.getByText('Kein Arbeitsnetz erkannt')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(backend.finishSetup).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Heute' })).toBeTruthy();
  });

  it('zeigt Anmeldefehler verständlich an', async () => {
    const backend = fakeBackend({ loggedIn: false, setupDone: false, baseUrl: null });
    // Tauri liefert Fehler der Befehle als Text
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    backend.login = vi.fn(() => Promise.reject('totp_required'));
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await userEvent.type(await screen.findByLabelText('Server-Adresse'), 'https://zeit.example');
    await userEvent.type(screen.getByLabelText('E-Mail'), 'a@b.de');
    await userEvent.type(screen.getByLabelText('Passwort'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Bitte den Code aus der Authenticator-App eingeben.',
    );
  });
});

describe('Einstellungen', () => {
  it('Autostart umschalten und abmelden', async () => {
    const backend = fakeBackend();
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Einstellungen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Erkennung' }));
    expect(await screen.findByText('Noch kein Arbeitsnetz hinterlegt.')).toBeTruthy();
    const box = screen.getByLabelText('Beim Anmelden am Computer starten');
    await waitFor(() => {
      expect((box as HTMLInputElement).checked).toBe(true);
    });
    await userEvent.click(box);
    expect(backend.autostart.set).toHaveBeenCalledWith(false);
    await userEvent.click(screen.getByRole('button', { name: 'Konto' }));
    await userEvent.click(screen.getByRole('button', { name: 'Abmelden' }));
    expect(backend.logout).toHaveBeenCalled();
  });
});

describe('invokeFetch', () => {
  it('leitet Anfragen des API-Clients an den Rust-Kern', async () => {
    const invoke = vi.fn(() => Promise.resolve({ status: 200, body: '{"ok":true}' }));
    const f = invokeFetch(invoke as never);
    const res = await f(new URL('https://server.invalid/api/v1/absences?from=2026-01-01'), {
      method: 'PUT',
      body: '{"a":1}',
    });
    expect(invoke).toHaveBeenCalledWith('api_fetch', {
      method: 'PUT',
      path: '/api/v1/absences?from=2026-01-01',
      body: '{"a":1}',
    });
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('Erinnerungen', () => {
  it('meldet „Pause fehlt“ einmal und zeigt den Hinweis im Status', async () => {
    const start = '2026-10-15T05:00:00Z';
    const now = '2026-10-15T12:30:00Z'; // 14:30, seit 07:00 ohne Pause
    const backend = fakeBackend(
      {},
      {
        events: [boot('b1', start)],
        spans: [{ id: 's1', start, end: now, open: true }],
      },
    );
    const { unmount } = render(<App locale="de" backend={backend} clock={clock(now)} />);
    expect(
      await screen.findByRole('heading', { name: 'Hinweise zum Arbeitszeitgesetz' }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(backend.notifications.map(([title]) => title)).toContain('Pause fehlt');
    });
    unmount();
    // Zweiter Start am selben Tag: keine Wiederholung
    const count = backend.notifications.length;
    render(<App locale="de" backend={backend} clock={clock(now)} />);
    await screen.findByText('Arbeitszeit läuft');
    expect(backend.notifications).toHaveLength(count);
  });

  it('speichert Erinnerungen und Ruhezeit in den Kontoeinstellungen', async () => {
    const backend = fakeBackend();
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Einstellungen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Benachrichtigungen' }));
    await userEvent.click(screen.getByLabelText('„Über 10 Stunden“'));
    const from = screen.getByLabelText('Ruhezeit von');
    await userEvent.clear(from);
    await userEvent.type(from, '21:00');
    await userEvent.click(
      screen.getByLabelText('Nach erkanntem Feierabend fragen („Stimmt das?“)'),
    );
    await userEvent.selectOptions(screen.getByLabelText('Wochentag'), 'Montag');
    const time = screen.getByLabelText('Uhrzeit');
    await userEvent.clear(time);
    await userEvent.type(time, '08:30');
    const form = screen.getByRole('group', { name: 'Erinnerungen' }).closest('form');
    if (!form) throw new Error('Formular fehlt');
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => {
      expect(backend.calls.requests).toContainEqual(
        expect.stringContaining(
          '"notifications":{"forgotEnd":true,"over10h":false,"breakViolation":true,"confirmDay":true,"confirmEnd":false,"weekReview":{"enabled":true,"weekday":1,"time":"08:30"},"quietHours":{"from":"21:00","to":"07:00"}}',
        ),
      );
    });
  });
});

describe('Abwesenheit', () => {
  it('Firmenkonto: Konto und Überstunden, Antrag mit halbem Tag, stornieren', async () => {
    const backend = fakeBackend();
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Abwesenheit' }));
    expect(await screen.findByText('Urlaubskonto 2026')).toBeTruthy();
    expect(screen.getByText('14,5 Tage')).toBeTruthy();
    expect(screen.getByText(/Rechtsprechung des BAG/)).toBeTruthy();
    expect(screen.getByText('Anspruch und Buchungen pflegt deine Firma.')).toBeTruthy();
    expect(screen.getByText(/Kommentar: Viel Erholung/)).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText('Art'), 'overtime');
    const from = screen.getByLabelText('Von');
    await userEvent.clear(from);
    await userEvent.type(from, '2026-11-09');
    await userEvent.click(screen.getByLabelText('Letzter Tag nur halb'));
    await userEvent.click(screen.getByRole('button', { name: 'Beantragen' }));
    expect(await screen.findByText(/Antrag gestellt/)).toBeTruthy();
    const sent = backend.calls.requests.find((r) => r.startsWith('POST /api/v1/leave/requests '));
    expect(sent).toContain('"kind":"overtime"');
    expect(sent).toContain('"from":"2026-11-09"');
    expect(sent).toContain('"halfDayEnd":true');

    await userEvent.click(screen.getByRole('button', { name: /^Stornieren: Urlaub/ }));
    expect(await screen.findByText('Antrag storniert.')).toBeTruthy();
  });

  it('Privatkonto: Krankheit direkt eintragen, ohne Urlaubs- und Überstundenkonto', async () => {
    const backend = fakeBackend();
    const leave = backend.responses['GET /api/v1/leave'] as Record<string, unknown>;
    backend.responses['GET /api/v1/leave'] = { ...leave, managed: false };
    backend.responses['GET /api/v1/settings'] = backend.responses['PUT /api/v1/settings'];
    backend.responses['PUT /api/v1/absences'] = { ok: true };
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Abwesenheit' }));
    expect(await screen.findByText('Keine Abwesenheiten eingetragen.')).toBeTruthy();
    expect(screen.queryByText('Urlaubskonto 2026')).toBeNull();
    expect(screen.queryByRole('option', { name: 'Überstundenabbau' })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Art'), 'sick');
    const from = screen.getByLabelText('Von');
    await userEvent.clear(from);
    await userEvent.type(from, '2026-10-12');
    await userEvent.click(screen.getByRole('button', { name: 'Eintragen' }));
    expect(await screen.findByText('Eingetragen.')).toBeTruthy();
    expect(backend.calls.requests).toContain(
      'PUT /api/v1/absences {"from":"2026-10-12","to":"2026-10-15","absences":[{"date":"2026-10-12","kind":"sick","minutes":480},{"date":"2026-10-13","kind":"sick","minutes":480},{"date":"2026-10-14","kind":"sick","minutes":480},{"date":"2026-10-15","kind":"sick","minutes":480}]}',
    );
  });

  it('englische Texte', async () => {
    const backend = fakeBackend();
    render(<App locale="en" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Absence' }));
    expect(await screen.findByText('Leave account 2026')).toBeTruthy();
    expect(screen.getByText('14.5 days')).toBeTruthy();
  });
});

describe('Barrierefreiheit', () => {
  it('Heute, Zeiten, Abwesenheit und Einstellungen ohne kritische axe-Befunde', async () => {
    const axe = (await import('axe-core')).default;
    const backend = fakeBackend(
      {},
      {
        events: [boot('b1', '2026-10-15T06:00:00Z')],
        spans: [
          { id: 's1', start: '2026-10-15T06:00:00Z', end: '2026-10-15T09:00:00Z', open: true },
        ],
      },
    );
    const { container } = render(
      <App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />,
    );
    await screen.findByText('Arbeitszeit läuft');
    for (const page of ['Heute', 'Zeiten', 'Abwesenheit', 'Einstellungen']) {
      await userEvent.click(screen.getByRole('button', { name: new RegExp(`^${page}`) }));
      // Farbkontrast lässt sich in jsdom nicht messen; dafür gilt styles.css (AA geprüft).
      const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
      const serious = result.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      );
      expect(serious.map((v) => `${page}: ${v.id}`)).toEqual([]);
    }
  });
});
