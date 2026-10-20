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
    await userEvent.click(await screen.findByRole('button', { name: 'Tagesprotokoll' }));
    expect(
      screen.getByRole('button', { name: 'Tagesprotokoll' }).getAttribute('aria-current'),
    ).toBe('page');
    await userEvent.click(screen.getByRole('button', { name: 'Vorheriger Tag' }));
    expect(screen.getByText('Mi., 14.10.2026')).toBeTruthy();
    const log = screen.getAllByRole('list')[0];
    expect(log && within(log).getByText(/Hochgefahren/)).toBeTruthy();
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
    await userEvent.click(await screen.findByRole('button', { name: /Zu prüfen/ }));
    expect(screen.getByText(/Arbeit an einem Tag ohne Sollzeit/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Bestätigen: Sitzung 10:00–12:05' }));
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
    expect(await screen.findByRole('button', { name: 'Status' })).toBeTruthy();
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
    expect(await screen.findByText('Noch kein Arbeitsnetz hinterlegt.')).toBeTruthy();
    const box = screen.getByLabelText('Beim Anmelden am Computer starten');
    await waitFor(() => {
      expect((box as HTMLInputElement).checked).toBe(true);
    });
    await userEvent.click(box);
    expect(backend.autostart.set).toHaveBeenCalledWith(false);
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

describe('Barrierefreiheit', () => {
  it('Status, Protokoll, Prüfliste und Einstellungen ohne kritische axe-Befunde', async () => {
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
    for (const page of [
      'Status',
      'Tagesprotokoll',
      'Zu prüfen',
      'Wochenrückblick',
      'Einstellungen',
    ]) {
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
