import { describe, expect, it, jest } from '@jest/globals';
import { screen, userEvent } from '@testing-library/react-native';
import { render } from '@testing-library/react-native';
import { App } from '../src/App';
import type { PlatformActions } from '../src/ui/context';
import { IOS, fakeNative } from './fakeNative';
import { type Harness, harness, loggedIn } from './helpers';

function actions(): PlatformActions & { shared: string[]; opened: string[] } {
  const shared: string[] = [];
  const opened: string[] = [];
  return {
    shared,
    opened,
    openUrl: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    shareFile: (name) => {
      shared.push(name);
      return Promise.resolve();
    },
    requestNotifications: () => Promise.resolve(true),
  };
}

async function show(h: Harness, locale: 'de' | 'en' = 'de') {
  const a = actions();
  await render(<App core={h.core} locale={locale} actions={a} clock={h.clock} />);
  return a;
}

async function ready(h: Harness, opts: { local?: boolean } = {}) {
  if (opts.local) await h.core.useLocalOnly();
  await h.core.finishSetup();
}

const button = (name: string | RegExp) => screen.findByRole('button', { name });

describe('Einrichtungsassistent', () => {
  it('ohne Konto bis zur Heute-Ansicht', async () => {
    const h = await harness();
    await show(h);
    const user = userEvent.setup();
    expect(await screen.findByText('Willkommen bei TimeLog')).toBeOnTheScreen();
    await user.press(await button('Ohne Konto nutzen (nur lokal)'));
    expect(await screen.findByText('Schritt 2 von 5')).toBeOnTheScreen();
    await user.press(await button('Sollzeiten speichern'));
    expect(await screen.findByText('Schritt 3 von 5')).toBeOnTheScreen();
    await user.press(await button('Weiter'));
    await user.press(await button('Benachrichtigungen erlauben'));
    await user.press(await button('Weiter'));
    await user.press(await button('Fertig'));
    expect(await screen.findByRole('tab', { name: 'Heute' })).toBeSelected();
    expect((await h.core.getState()).setupDone).toBe(true);
  });

  it('meldet sich am Server an', async () => {
    const h = await harness();
    await show(h);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Server-Adresse'), 'https://zeit.example');
    await user.type(screen.getByLabelText('E-Mail'), 'a@b.de');
    await user.type(screen.getByLabelText('Passwort'), 'geheim-geheim');
    await user.press(await button('Anmelden'));
    expect(await screen.findByText('Schritt 2 von 5')).toBeOnTheScreen();
    expect((await h.core.getState()).account).toBe('loggedIn');
  });

  it('falsches Passwort zeigt einen Fehler', async () => {
    const h = await harness();
    await show(h);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Server-Adresse'), 'https://zeit.example');
    await user.type(screen.getByLabelText('E-Mail'), 'a@b.de');
    await user.type(screen.getByLabelText('Passwort'), 'falsch');
    await user.press(await button('Anmelden'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Anmeldung fehlgeschlagen/);
  });
});

describe('Heute', () => {
  it('Start und Stopp erzeugen nur Ereignisse; Status kommt aus dem Regelwerk', async () => {
    const h = await harness({ now: '2026-10-15T07:00:00Z' });
    await ready(h, { local: true });
    await show(h);
    const user = userEvent.setup();
    await user.press(await button('Arbeit beginnen'));
    expect(await screen.findByText('Arbeitszeit läuft')).toBeOnTheScreen();
    h.clock.advance(90);
    await user.press(await button('Arbeit beenden'));
    expect(await screen.findByLabelText('Netto heute: 1:30')).toBeOnTheScreen();
    const events = await h.core.events('2026-10-15T00:00:00Z', '2026-10-16T00:00:00Z');
    expect(events.map((e) => e.type)).toEqual(['manual_start', 'manual_end']);
  });

  it('zeigt Übertragungsstand und ArbZG-Hinweise', async () => {
    const h = await loggedIn({ now: '2026-10-15T18:00:00Z' });
    await h.core.manualRange('manual_work', '2026-10-15T05:00:00Z', '2026-10-15T16:00:00Z');
    await h.core.sync(true);
    await ready(h);
    await show(h);
    expect(await screen.findByText('Mehr als 10 Stunden gearbeitet (§ 3 ArbZG)')).toBeOnTheScreen();
    expect(await screen.findByText(/Davon \d+ min Pausenauffüllung/)).toBeOnTheScreen();
    expect(screen.getByText('Alles übertragen')).toBeOnTheScreen();
  });

  it('alle Knöpfe und Reiter haben eine Beschriftung', async () => {
    const h = await harness();
    await ready(h, { local: true });
    await show(h);
    await screen.findByRole('header', { name: 'Heute' });
    for (const el of [...screen.getAllByRole('button'), ...screen.getAllByRole('tab')]) {
      expect(el).toHaveAccessibleName();
    }
  });
});

describe('Tagesprotokoll', () => {
  it('„War Arbeit“ zählt eine erkannte Pause als Arbeitszeit', async () => {
    const h = await harness({ now: '2026-10-15T15:00:00Z' });
    await ready(h, { local: true });
    h.native.queue.events.push(
      {
        id: 'e1',
        type: 'net_connected',
        source: 'wifi',
        ts: '2026-10-15T06:00:00Z',
        tz: 'Europe/Berlin',
        createdAt: '2026-10-15T06:00:00Z',
      },
      {
        id: 'e3',
        type: 'net_lost',
        source: 'wifi',
        ts: '2026-10-15T10:00:00Z',
        tz: 'Europe/Berlin',
        createdAt: '2026-10-15T10:00:00Z',
      },
      {
        id: 'e4',
        type: 'net_connected',
        source: 'wifi',
        ts: '2026-10-15T10:40:00Z',
        tz: 'Europe/Berlin',
        createdAt: '2026-10-15T10:40:00Z',
      },
      {
        id: 'e2',
        type: 'net_lost',
        source: 'wifi',
        ts: '2026-10-15T14:00:00Z',
        tz: 'Europe/Berlin',
        createdAt: '2026-10-15T14:00:00Z',
      },
    );
    h.native.queue.spans.push(
      { id: 's1', start: '2026-10-15T06:00:00Z', end: '2026-10-15T10:00:00Z', open: false },
      { id: 's2', start: '2026-10-15T10:40:00Z', end: '2026-10-15T14:00:00Z', open: false },
    );
    await h.core.ingestNative();
    await show(h);
    const user = userEvent.setup();
    await user.press(await screen.findByRole('tab', { name: 'Protokoll' }));
    await user.press(await button(/^Pause 12:\d\d–12:40 – War Arbeit$/));
    expect(await screen.findByText('Pause als Arbeit eingetragen.')).toBeOnTheScreen();
    const events = await h.core.events('2026-10-15T00:00:00Z', '2026-10-16T00:00:00Z');
    const work = events.find((e) => e.type === 'manual_work');
    expect(work?.endTs).toBe('2026-10-15T10:40:00.000Z');
    expect(await screen.findByLabelText('Pausen: 0:00')).toBeOnTheScreen();
  });

  it('Korrektur online mit Begründung', async () => {
    const h = await loggedIn({ now: '2026-10-15T15:00:00Z' });
    await ready(h);
    await show(h);
    const user = userEvent.setup();
    await user.press(await screen.findByRole('tab', { name: 'Protokoll' }));
    await user.type(await screen.findByLabelText('Uhrzeit (HH:MM)'), '08:15');
    await user.type(screen.getByLabelText('Begründung'), 'Zug verspätet');
    await user.press(await button('Korrektur speichern'));
    expect(await screen.findByText('Korrektur gespeichert.')).toBeOnTheScreen();
    expect(h.server.corrections[0]).toMatchObject({
      date: '2026-10-15',
      field: 'start',
      time: '2026-10-15T06:15:00.000Z',
      reason: 'Zug verspätet',
    });
  });

  it('ungültige Uhrzeit wird abgewiesen', async () => {
    const h = await harness();
    await ready(h, { local: true });
    await show(h);
    const user = userEvent.setup();
    await user.press(await screen.findByRole('tab', { name: 'Protokoll' }));
    await user.type(await screen.findByLabelText('Uhrzeit (HH:MM)'), '25:00');
    await user.press(await button('Korrektur speichern'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bitte Uhrzeit als HH:MM eingeben.');
  });
});

describe('Zu prüfen', () => {
  it('Arbeit am Sonntag bestätigen', async () => {
    const h = await harness({ now: '2026-10-18T15:00:00Z' }); // Sonntag
    await ready(h, { local: true });
    await h.core.manualRange('manual_work', '2026-10-18T08:00:00Z', '2026-10-18T10:00:00Z');
    await show(h);
    const user = userEvent.setup();
    await user.press(await screen.findByRole('tab', { name: /Prüfen, 1 offen/ }));
    await user.press(await button('Bestätigen'));
    expect(await screen.findByText('Nichts zu prüfen.')).toBeOnTheScreen();
  });
});

describe('Übersicht und Abwesenheiten', () => {
  it('Woche mit Saldo, Monat umschaltbar, Urlaub eintragen', async () => {
    const h = await harness({ now: '2026-10-15T15:00:00Z' });
    await ready(h, { local: true });
    await show(h);
    const user = userEvent.setup();
    await user.press(await screen.findByRole('tab', { name: 'Übersicht' }));
    // Tage ohne Erfassung zählen nicht zum Saldo (wie am Desktop)
    expect(await screen.findByLabelText('Saldo: 0:00')).toBeOnTheScreen();
    await user.press(screen.getByRole('radio', { name: 'Monat' }));
    expect(await screen.findByLabelText(/Soll: 176:00/)).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Abwesenheiten' }));
    await user.type(await screen.findByLabelText('Von (JJJJ-MM-TT)'), '2026-10-12');
    await user.type(screen.getByLabelText('Bis (JJJJ-MM-TT)'), '2026-10-18');
    await user.press(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Gespeichert.')).toBeOnTheScreen();
    // Wochenende ohne Sollzeit wird übersprungen
    expect((await h.core.profile()).absences).toHaveLength(5);
  });

  it('Export nur mit Konto und über das Teilen-Menü', async () => {
    const h = await loggedIn({ now: '2026-10-15T15:00:00Z' });
    await ready(h);
    const a = await show(h);
    const user = userEvent.setup();
    await user.press(await screen.findByRole('tab', { name: 'Übersicht' }));
    await user.press(await button('CSV teilen'));
    await screen.findByRole('button', { name: 'CSV teilen' });
    expect(a.shared).toEqual(['timelog-2026-10-12-2026-10-18.csv']);
  });
});

describe('Einstellungen', () => {
  it('Android: aktuelles Netz übernehmen, Warnung bei Router-Standard', async () => {
    const h = await loggedIn();
    await ready(h);
    h.native.network = {
      ...h.native.network,
      fingerprint: 'v4;gw=192.168.178.1;net=192.168.178.0/24;dns=192.168.178.1;dom=fritz.box',
    };
    await show(h);
    const user = userEvent.setup();
    await user.press(await screen.findByRole('tab', { name: 'Einstellungen' }));
    await user.type(await screen.findByLabelText('Name des Netzes'), 'Büro');
    await user.press(await button('Aktuelles Netz übernehmen'));
    expect(await screen.findByText(/Router-Werkseinstellung/)).toBeOnTheScreen();
    expect(await button('Büro entfernen')).toBeOnTheScreen();
    expect(h.server.networks).toHaveLength(1);
  });

  it('iOS: Kurzbefehl-Anleitung und Geofence, kein „Netz übernehmen“', async () => {
    const native = fakeNative(IOS);
    const h = await harness({ native });
    await ready(h, { local: true });
    await show(h);
    const user = userEvent.setup();
    await user.press(await screen.findByRole('tab', { name: 'Einstellungen' }));
    expect(await screen.findByText('Kurzbefehl „Arbeitsnetz verbunden“')).toBeOnTheScreen();
    expect(
      screen.queryByRole('button', { name: 'Aktuelles Netz übernehmen' }),
    ).not.toBeOnTheScreen();
    await user.press(await button('Hier einrichten'));
    expect(await screen.findByText(/Geofence aktiv/)).toBeOnTheScreen();
    expect(native.calls).toContain('geofence:150:monitor');
  });

  it('Englische Oberfläche', async () => {
    const h = await harness();
    await ready(h, { local: true });
    await show(h, 'en');
    expect(await screen.findByRole('button', { name: 'Start work' })).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeOnTheScreen();
  });

  it('nur lokal: Daten löschen mit Rückfrage', async () => {
    const h = await harness();
    await ready(h, { local: true });
    await h.core.manual('manual_start');
    await show(h);
    const user = userEvent.setup();
    await user.press(await screen.findByRole('tab', { name: 'Einstellungen' }));
    await user.press(await button('Meine Daten exportieren (JSON)'));
    await user.press(await button('Alle Daten auf diesem Gerät löschen'));
    expect(await screen.findByText('Wirklich alle Daten löschen?')).toBeOnTheScreen();
    await user.press(await button('Alle Daten auf diesem Gerät löschen'));
    expect(await screen.findByText('Willkommen bei TimeLog')).toBeOnTheScreen();
  });
});

jest.setTimeout(20_000);
