import { type LocalData, computeLocalDays } from '@timelog/app-core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { SENT_KEY } from '../src/useReminders.js';
import { clock, fakeBackend } from './fake.js';

afterEach(cleanup);

const tz = 'Europe/Berlin';
const ev = (id: string, type: 'boot' | 'shutdown', ts: string) => ({
  id,
  type,
  source: 'system' as const,
  ts,
  tz,
  createdAt: ts,
});

/** Montag 08:00–17:05 mit 30 min Pause (unproblematisch) und Samstag 10:00–12:05 (zu prüfen). */
const weekData: LocalData = {
  events: [
    ev('mon', 'boot', '2026-10-12T06:00:00Z'),
    ev('mon-x', 'shutdown', '2026-10-12T15:00:00Z'),
    ev('sat', 'boot', '2026-10-17T08:00:00Z'),
    ev('sat-x', 'shutdown', '2026-10-17T10:00:00Z'),
  ],
  spans: [
    { id: 'p1', start: '2026-10-12T06:00:00Z', end: '2026-10-12T10:00:00Z', open: false },
    { id: 'p2', start: '2026-10-12T10:30:00Z', end: '2026-10-12T15:00:00Z', open: false },
    { id: 'p3', start: '2026-10-17T08:00:00Z', end: '2026-10-17T10:00:00Z', open: false },
  ],
};
const sunday = '2026-10-18T10:00:00Z';

describe('Zeiten: Woche', () => {
  it('ohne Verbindung: Summen aus den Gerätedaten, bestätigt nur unproblematische Tage', async () => {
    const backend = fakeBackend({}, weekData);
    render(<App locale="de" backend={backend} clock={clock(sunday)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Zeiten' }));
    expect(
      await screen.findByRole('heading', { name: 'KW 42: Mo., 12.10.2026 – So., 18.10.2026' }),
    ).toBeTruthy();
    expect(
      screen.getByText('Ohne Verbindung: berechnet aus den Daten dieses Geräts.'),
    ).toBeTruthy();
    // Der Samstag zählt erst nach Bestätigung
    expect(screen.getByText('8:35 h')).toBeTruthy();
    expect(screen.getByText('+0:35 h')).toBeTruthy();
    // Tagesliste mit Prüfhinweis am Samstag
    const list = screen.getByRole('region', { name: 'Tage' });
    const saturday = within(list).getByRole('button', { name: 'Sa., 17.10.2026' });
    expect(saturday.closest('li')?.textContent).toContain('bitte bestätigen');
    expect(screen.queryByRole('region', { name: 'Hinweise zum Arbeitszeitgesetz' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Woche bestätigen' }));
    expect(backend.calls.decisions).toEqual([['mon', true]]);
    expect(await screen.findByText('Bestätigte Tage: 1.')).toBeTruthy();

    // Ein Tag der Liste führt ins Tagesprotokoll
    await userEvent.click(within(list).getByRole('button', { name: 'Sa., 17.10.2026' }));
    expect(screen.getByRole('heading', { name: 'Sa., 17.10.2026' })).toBeTruthy();
  });

  it('mit Verbindung: Tage vom Server, „Woche bestätigen“ per Tagesbestätigung', async () => {
    const backend = fakeBackend();
    backend.responses['GET /api/v1/days'] = {
      days: computeLocalDays(weekData, { state: 'BE', timezone: tz }, sunday),
      balanceMinutes: 0,
    };
    backend.responses['POST /api/v1/days/2026-10-12/confirm'] = { confirmed: 1 };
    render(<App locale="en" backend={backend} clock={clock(sunday)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Times' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm week' }));
    await waitFor(() => {
      expect(backend.calls.requests).toContain('POST /api/v1/days/2026-10-12/confirm {}');
    });
    expect(backend.calls.requests.filter((r) => r.includes('/confirm'))).toHaveLength(1);
    expect(screen.queryByText(/Offline/)).toBeNull();
    // Vorherige Woche: nichts erfasst
    await userEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(await screen.findByRole('heading', { name: /^Week 41/ })).toBeTruthy();
  });
});

const createdAt = '2026-10-15T15:40:00Z';

describe('Rückfragen', () => {
  it('meldet „Feierabend erkannt“ einmal, „Stimmt“ bestätigt die Sitzung', async () => {
    const backend = fakeBackend();
    backend.responses['GET /api/v1/prompts'] = {
      prompts: [
        {
          kind: 'end_confirm',
          ref: 's1',
          createdAt,
          payload: {
            sessionId: 's1',
            date: '2026-10-15',
            end: '2026-10-15T15:12:00Z',
            tz,
            endSource: 'net_lost',
          },
        },
      ],
    };
    backend.responses['POST /api/v1/sessions/s1/confirm'] = { confirmed: 1 };
    const { unmount } = render(
      <App locale="de" backend={backend} clock={clock('2026-10-15T16:00:00Z')} />,
    );
    const card = await screen.findByRole('article', { name: 'Feierabend um 17:12 erkannt' });
    await waitFor(() => {
      expect(backend.notifications).toEqual([['Feierabend um 17:12 erkannt', 'Stimmt das?']]);
    });
    await userEvent.click(within(card).getByRole('button', { name: 'Stimmt' }));
    await waitFor(() => {
      expect(backend.calls.requests).toContain('POST /api/v1/sessions/s1/confirm {}');
    });
    unmount();
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T16:05:00Z')} />);
    await screen.findByRole('article', { name: 'Feierabend um 17:12 erkannt' });
    expect(backend.notifications).toHaveLength(1);
  });

  it('Ende durch Herunterfahren nur als Karte; „Später“ blendet aus, „Korrigieren“ öffnet den Tag', async () => {
    const backend = fakeBackend();
    backend.responses['GET /api/v1/prompts'] = {
      prompts: [
        {
          kind: 'end_confirm',
          ref: 's2',
          createdAt,
          payload: {
            sessionId: 's2',
            date: '2026-10-14',
            end: '2026-10-14T15:00:00Z',
            tz,
            endSource: 'shutdown',
          },
        },
      ],
    };
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    const card = await screen.findByRole('article', { name: 'Feierabend um 17:00 erkannt' });
    expect(within(card).getByText('Mi., 14.10.2026: Stimmt das?')).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Später' }));
    await waitFor(() => {
      expect(backend.calls.requests).toContain(
        'POST /api/v1/prompts/dismiss {"kind":"end_confirm","ref":"s2"}',
      );
    });
    await userEvent.click(within(card).getByRole('button', { name: 'Korrigieren' }));
    expect(screen.getByRole('heading', { name: 'Mi., 14.10.2026' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zeiten' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(backend.notifications).toEqual([]);
  });

  it('„Arbeitsende fehlt“: „Stimmt“ trägt das Ende nach, keine zweite lokale Erinnerung', async () => {
    const backend = fakeBackend();
    backend.responses['GET /api/v1/prompts'] = {
      prompts: [
        {
          kind: 'end_missing',
          ref: 's3',
          createdAt,
          payload: { sessionId: 's3', date: '2026-10-14', end: '2026-10-14T16:00:00Z', tz },
        },
      ],
    };
    backend.responses['PATCH /api/v1/days/2026-10-14'] = {
      eventId: '22222222-2222-4222-8222-222222222222',
    };
    render(<App locale="de" backend={backend} clock={clock('2026-10-15T09:00:00Z')} />);
    const card = await screen.findByRole('article', { name: 'Arbeitsende fehlt' });
    await waitFor(() => {
      expect(backend.stored.get(SENT_KEY)).toContain('2026-10-14:end_forgotten');
    });
    await userEvent.click(within(card).getByRole('button', { name: 'Stimmt' }));
    await waitFor(() => {
      expect(backend.calls.requests).toContain(
        'PATCH /api/v1/days/2026-10-14 {"field":"end","time":"2026-10-14T16:00:00Z","reason":"Ende per Rückfrage bestätigt"}',
      );
    });
  });

  it('Wochenrückblick-Rückfrage öffnet die Woche', async () => {
    const backend = fakeBackend({}, weekData);
    backend.responses['GET /api/v1/prompts'] = {
      prompts: [
        {
          kind: 'week_review',
          ref: '2026-W42',
          createdAt: '2026-10-16T13:05:00Z',
          payload: {
            week: '2026-W42',
            from: '2026-10-12',
            to: '2026-10-18',
            netMinutes: 515,
            balanceMinutes: 0,
            openDays: 0,
            legalHints: 0,
          },
        },
      ],
    };
    render(<App locale="en" backend={backend} clock={clock('2026-10-20T09:00:00Z')} />);
    const card = await screen.findByRole('article', { name: 'Your week 42' });
    await waitFor(() => {
      expect(backend.notifications.map(([title]) => title)).toContain('Your week 42');
    });
    await userEvent.click(within(card).getByRole('button', { name: 'View' }));
    expect(await screen.findByRole('heading', { name: /^Week 42/ })).toBeTruthy();
  });
});

describe('Barrierefreiheit', () => {
  it('Zeiten und Rückfragen ohne kritische axe-Befunde', async () => {
    const axe = (await import('axe-core')).default;
    const backend = fakeBackend({}, weekData);
    backend.responses['GET /api/v1/prompts'] = {
      prompts: [
        {
          kind: 'end_missing',
          ref: 's3',
          createdAt,
          payload: { sessionId: 's3', date: '2026-10-17', tz },
        },
      ],
    };
    const { container } = render(<App locale="de" backend={backend} clock={clock(sunday)} />);
    await screen.findByRole('article', { name: 'Arbeitsende fehlt' });
    await userEvent.click(screen.getByRole('button', { name: 'Zeiten' }));
    await screen.findByRole('button', { name: 'Woche bestätigen' });
    // Farbkontrast lässt sich in jsdom nicht messen; dafür gilt styles.css (AA geprüft).
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    const serious = result.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(serious.map((v) => v.id)).toEqual([]);
  });
});
