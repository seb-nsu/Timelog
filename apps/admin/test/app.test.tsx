import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { ID, NOW, fakeServer, memoryStore, signedIn } from './fake.js';
import { Session } from '../src/session.js';

afterEach(cleanup);

const BASE = 'http://admin.test/';

function renderApp(session: Session, url = BASE) {
  const redirectTo = vi.fn<(url: string) => void>();
  const download = vi.fn<(blob: Blob, filename: string) => void>();
  const replaceUrl = vi.fn<(path: string) => void>();
  render(
    <App
      session={session}
      initialUrl={url}
      redirectTo={redirectTo}
      download={download}
      replaceUrl={replaceUrl}
      now={() => NOW}
    />,
  );
  return { redirectTo, download, replaceUrl };
}

/** axe-core in jsdom; Farbkontraste kann jsdom nicht berechnen (in styles.css nach AA gewählt). */
async function expectAccessible() {
  const result = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  const found = result.violations.map((v) => `${v.impact ?? '?'} ${v.id}: ${v.help}`);
  expect(found).toEqual([]);
  // axe hat tatsächlich geprüft (u. a. Namen von Bedienelementen, Landmarken, ARIA).
  expect(result.passes.map((p) => p.id)).toContain('button-name');
  expect(result.passes.length).toBeGreaterThan(10);
}

const nav = () => within(screen.getByRole('navigation', { name: 'Bereiche' }));

describe('Anmeldung', () => {
  it('Passwort, dann TOTP-Code; danach Freigaben', async () => {
    const server = fakeServer({ loginNeedsTotp: true });
    renderApp(signedIn(server, false));
    await userEvent.type(await screen.findByLabelText('E-Mail'), 'alex@firma.de');
    await userEvent.type(screen.getByLabelText('Passwort'), 'geheim-genug');
    await expectAccessible();
    await userEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Bitte den Code aus der Authenticator-App eingeben.',
    );
    await userEvent.type(screen.getByLabelText('Code aus der Authenticator-App'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Freigaben' })).toBeTruthy();
    const login = server.calls.filter((c) => c.path === '/auth/login');
    expect(login.at(-1)?.body).toMatchObject({
      email: 'alex@firma.de',
      totp: '123456',
      device: { os: 'web' },
    });
  });

  it('Manager ohne Zwei-Faktor muss ihn zuerst einrichten', async () => {
    const server = fakeServer({ role: 'manager', totpEnabled: false });
    renderApp(signedIn(server));
    await userEvent.click(await screen.findByRole('button', { name: 'Schlüssel erzeugen' }));
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeTruthy();
    await expectAccessible();
    await userEvent.type(screen.getByLabelText('Sechsstelliger Code aus der App'), '654321');
    await userEvent.click(screen.getByRole('button', { name: 'Bestätigen' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Freigaben' })).toBeTruthy();
    expect(server.calls.some((c) => c.path === '/auth/totp/verify')).toBe(true);
  });

  it('SSO: Kurzname eingeben, Weiterleitung zum IdP; Rücksprung löst den Code ein', async () => {
    const server = fakeServer();
    const session = signedIn(server, false);
    const { redirectTo } = renderApp(session);
    // Info-Abfrage beantwortet der Fake nicht: Organisation unbekannt.
    await userEvent.type(await screen.findByLabelText('Kurzname der Organisation'), 'firma');
    await userEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByText('Organisation nicht gefunden.')).toBeTruthy();
    expect(redirectTo).not.toHaveBeenCalled();
    cleanup();

    const back = renderApp(session, `${BASE}sso?code=${'c'.repeat(32)}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Freigaben' })).toBeTruthy();
    expect(back.replaceUrl).toHaveBeenCalledWith('/');
    const exchange = server.calls.find((c) => c.path === '/auth/sso/exchange');
    expect(exchange?.body).toMatchObject({ code: 'c'.repeat(32) });
  });

  it('SSO-Fehler vom Rücksprung wird verständlich angezeigt', async () => {
    renderApp(signedIn(fakeServer(), false), `${BASE}sso?sso_error=domain_not_allowed`);
    expect(
      await screen.findByText('Die E-Mail-Domain ist für SSO nicht freigegeben.'),
    ).toBeTruthy();
  });

  it('ohne Organisation: Firma anlegen, dann Zwei-Faktor einrichten', async () => {
    const server = fakeServer({ hasOrg: false });
    renderApp(signedIn(server));
    await userEvent.type(await screen.findByLabelText('Name der Firma'), 'Neu GmbH');
    await userEvent.type(screen.getByLabelText(/Kurzname für die SSO-Anmeldung/), 'neu-gmbh');
    await expectAccessible();
    await userEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    expect(
      await screen.findByRole('heading', { name: 'Zwei-Faktor-Anmeldung einrichten' }),
    ).toBeTruthy();
    expect(server.calls.find((c) => c.path === '/orgs')?.body).toEqual({
      name: 'Neu GmbH',
      slug: 'neu-gmbh',
    });
  });

  it('Mitglied ohne Leitungsrolle hat keinen Zugriff', async () => {
    renderApp(signedIn(fakeServer({ role: 'user' })));
    expect(
      await screen.findByRole('heading', { name: 'Kein Zugriff auf den Web-Admin' }),
    ).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});

describe('Freigaben', () => {
  it('zeigt die eingeschränkte Tagesansicht und gibt frei', async () => {
    const server = fakeServer();
    renderApp(signedIn(server));
    const row = await screen.findByRole('row', { name: /Anna Arbeit/ });
    expect(within(row).getByText('eingereicht')).toBeTruthy();
    await expectAccessible();
    await userEvent.click(within(row).getByRole('button', { name: 'Ansehen: Anna Arbeit' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Anna Arbeit: 2026-09' }),
    ).toBeTruthy();
    const table = await screen.findByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual([
      'Datum',
      'Beginn',
      'Ende',
      'Pausen',
      'Auffüllung',
      'Netto',
      'Status',
      'Hinweise',
    ]);
    expect(
      within(table).getByText('Pause zu kurz (§ 4 ArbZG); die fehlende Zeit wird abgezogen'),
    ).toBeTruthy();
    await expectAccessible();
    await userEvent.click(screen.getByRole('button', { name: 'Freigeben' }));
    expect(await screen.findByText('Monat 2026-09 für Anna Arbeit freigegeben.')).toBeTruthy();
    expect(
      server.calls.some(
        (c) => c.method === 'POST' && c.path === `/org/approvals/${ID.anna}/2026-09/approve`,
      ),
    ).toBe(true);
    expect(await screen.findByText('freigegeben')).toBeTruthy();
  });

  it('Zurückweisen verlangt einen Kommentar', async () => {
    const server = fakeServer();
    renderApp(signedIn(server));
    await userEvent.click(await screen.findByRole('button', { name: 'Ansehen: Anna Arbeit' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Zurückweisen' }));
    expect(await screen.findByText('Zum Zurückweisen bitte einen Kommentar angeben.')).toBeTruthy();
    expect(server.calls.some((c) => c.path.endsWith('/reject'))).toBe(false);
    await userEvent.type(screen.getByLabelText(/Kommentar/), 'Bitte 03.09. prüfen');
    await userEvent.click(screen.getByRole('button', { name: 'Zurückweisen' }));
    await screen.findByText('Monat 2026-09 für Anna Arbeit zurückgewiesen.');
    expect(server.calls.find((c) => c.path.endsWith('/reject'))?.body).toEqual({
      comment: 'Bitte 03.09. prüfen',
    });
  });
});

describe('Rollen', () => {
  it('Manager sieht nur Freigaben, Urlaub, Mitglieder und Teams, ohne E-Mail und Rollen', async () => {
    renderApp(signedIn(fakeServer({ role: 'manager' })));
    await screen.findByRole('heading', { level: 1, name: 'Freigaben' });
    expect(
      nav()
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Freigaben', 'Urlaub', 'Mitglieder', 'Teams', 'Mein Kalender']);
    expect(
      nav()
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(['Team', 'Mein Konto']);
    await userEvent.click(nav().getByRole('button', { name: 'Mitglieder' }));
    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Name', 'Team']);
    expect(screen.queryByText('anna@firma.de')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Person einladen' })).toBeNull();
    await expectAccessible();
  });

  it('Admin sieht alle Bereiche; Seitenwechsel setzt den Fokus auf die Überschrift', async () => {
    renderApp(signedIn(fakeServer()));
    await screen.findByRole('heading', { level: 1, name: 'Freigaben' });
    expect(
      nav()
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      'Freigaben',
      'Urlaub',
      'Mitglieder',
      'Teams',
      'Einstellungen',
      'Projekte',
      'Firmen-Netze',
      'Export',
      'Lohn',
      'Homeoffice',
      'Audit-Log',
      'Mein Kalender',
    ]);
    expect(
      nav()
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(['Team', 'Firma', 'Auswertung & Lohn', 'Mein Konto']);
    expect(nav().getByRole('list', { name: 'Firma' })).toBeTruthy();
    await userEvent.click(nav().getByRole('button', { name: 'Teams' }));
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Teams' });
    await waitFor(() => {
      expect(document.activeElement).toBe(h1);
    });
    expect(nav().getByRole('button', { name: 'Teams' }).getAttribute('aria-current')).toBe('page');
    await expectAccessible();
  });
});

describe('Verwaltung (Admin)', () => {
  it('lädt eine Person ein', async () => {
    const server = fakeServer();
    renderApp(signedIn(server));
    await userEvent.click(await screen.findByRole('button', { name: 'Mitglieder' }));
    await screen.findByText('anna@firma.de');
    const form = within(screen.getByRole('region', { name: 'Person einladen' }));
    await userEvent.type(form.getByLabelText('E-Mail'), 'neu@firma.de');
    await userEvent.selectOptions(form.getByLabelText('Rolle'), 'manager');
    await userEvent.selectOptions(form.getByLabelText('Team'), ID.team);
    await expectAccessible();
    await userEvent.click(form.getByRole('button', { name: 'Einladen' }));
    expect(await screen.findByText('Einladung an neu@firma.de verschickt.')).toBeTruthy();
    expect(server.calls.find((c) => c.path === '/org/invite')?.body).toEqual({
      email: 'neu@firma.de',
      role: 'manager',
      teamId: ID.team,
    });
    expect(await screen.findByText(/neu@firma\.de · Manager/)).toBeTruthy();
  });

  it('speichert Regelwerk-Parameter und zeigt die SSO-Adressen', async () => {
    const server = fakeServer();
    renderApp(signedIn(server));
    await userEvent.click(await screen.findByRole('button', { name: 'Einstellungen' }));
    const bonus = await screen.findByLabelText(/Aufschlag beim Herunterfahren/);
    await userEvent.type(bonus, '10');
    await userEvent.click(screen.getByLabelText(/SAML 2.0/));
    expect(screen.getByText('http://admin.test/api/v1/auth/sso/firma/saml/acs')).toBeTruthy();
    await userEvent.click(screen.getByLabelText(/SAML 2.0/));
    await expectAccessible();
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Einstellungen gespeichert.')).toBeTruthy();
    expect(
      server.calls.find((c) => c.method === 'PUT' && c.path === '/org/config')?.body,
    ).toMatchObject({
      name: 'Firma GmbH',
      slug: 'firma',
      retentionYears: 2,
      rules: { shutdownBonusMin: 10 },
      sso: { enforced: false, autoProvision: false, allowedDomains: [] },
    });
  });

  it('Audit-Log, Firmen-Netze und Export sind barrierefrei', async () => {
    const server = fakeServer();
    const { download } = renderApp(signedIn(server));
    await userEvent.click(await screen.findByRole('button', { name: 'Audit-Log' }));
    expect(await screen.findByText('Monat freigegeben')).toBeTruthy();
    await expectAccessible();
    await userEvent.click(nav().getByRole('button', { name: 'Firmen-Netze' }));
    expect(await screen.findByText('Noch keine Firmen-Netze hinterlegt.')).toBeTruthy();
    await expectAccessible();
    await userEvent.click(nav().getByRole('button', { name: 'Export' }));
    await screen.findByRole('heading', { level: 1, name: 'Export' });
    await expectAccessible();
    await userEvent.click(screen.getByRole('button', { name: 'Herunterladen' }));
    await waitFor(() => {
      expect(download).toHaveBeenCalled();
    });
    expect(download.mock.calls[0]?.[1]).toBe('arbeitszeit_2026-09.csv');
    expect(server.calls.find((c) => c.path === '/org/export')?.query).toEqual({
      month: '2026-09',
      format: 'csv',
    });
  });
});

describe('Urlaub', () => {
  it('Manager entscheidet offene Anträge mit Kommentar und sieht Überschneidungen', async () => {
    const server = fakeServer({ role: 'manager' });
    renderApp(signedIn(server));
    await userEvent.click(await screen.findByRole('button', { name: 'Urlaub' }));
    const pending = within(await screen.findByRole('region', { name: 'Offene Anträge' }));
    expect(await pending.findByText('Anna Arbeit')).toBeTruthy();
    expect(pending.getByText(/Ben Büro/)).toBeTruthy();
    expect(pending.getByText(/Familienbesuch/)).toBeTruthy();
    // Teamkalender ohne Grund der Abwesenheit
    const cal = within(screen.getByRole('region', { name: 'Teamkalender' }));
    expect(await cal.findByText('abwesend')).toBeTruthy();
    expect(nav().queryByRole('button', { name: 'Lohn' })).toBeNull();
    await expectAccessible();

    await userEvent.click(pending.getByRole('button', { name: 'Entscheiden: Anna Arbeit' }));
    expect(pending.getByRole('button', { name: 'Ablehnen' })).toHaveProperty('disabled', true);
    await userEvent.type(pending.getByLabelText(/Kommentar/), 'Viel Erholung');
    await expectAccessible();
    await userEvent.click(pending.getByRole('button', { name: 'Genehmigen' }));
    expect(await screen.findByText('Antrag von Anna Arbeit genehmigt.')).toBeTruthy();
    const call = server.calls.find((c) => c.path === `/org/leave/requests/${ID.request}/approve`);
    expect(call?.body).toEqual({ comment: 'Viel Erholung' });
    expect(await screen.findByText('Keine offenen Anträge.')).toBeTruthy();
  });

  it('Admin pflegt Konten: Überstunden-Auszahlung wird als Abzug gebucht', async () => {
    const server = fakeServer();
    renderApp(signedIn(server));
    await userEvent.click(await screen.findByRole('button', { name: 'Urlaub' }));
    const picker = within(await screen.findByRole('region', { name: 'Konten der Mitglieder' }));
    await userEvent.selectOptions(await picker.findByLabelText('Person'), ID.anna);
    await userEvent.click(picker.getByRole('button', { name: 'Konto öffnen' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Urlaub: Anna Arbeit' }),
    ).toBeTruthy();
    expect(screen.getByText('13 Tage')).toBeTruthy();
    await expectAccessible();
    const form = within(screen.getByRole('form', { name: 'Manuelle Buchung' }));
    await userEvent.type(form.getByLabelText('Stunden'), '2');
    await userEvent.type(form.getByLabelText('Kommentar'), 'Auszahlung Oktober');
    await userEvent.click(form.getByRole('button', { name: 'Buchen' }));
    expect(await screen.findByText('Überstunden gebucht.')).toBeTruthy();
    expect(
      server.calls.find((c) => c.path === `/org/members/${ID.anna}/overtime-bookings`)?.body,
    ).toEqual({ month: '2026-10', kind: 'payout', minutes: -120, comment: 'Auszahlung Oktober' });
  });
});

describe('Lohn (Admin)', () => {
  it('Export, Personalnummer, Personio-Zugang und Übertragung', async () => {
    const server = fakeServer();
    const { download } = renderApp(signedIn(server));
    await userEvent.click(await screen.findByRole('button', { name: 'Lohn' }));
    await screen.findByRole('heading', { level: 1, name: 'Lohn' });
    await screen.findByLabelText('Personalnummer Anna Arbeit');
    await expectAccessible();

    await userEvent.click(screen.getByLabelText('Lexware lohn+gehalt (Import-ASCII)'));
    await userEvent.click(screen.getByRole('button', { name: 'Lohndatei herunterladen' }));
    await waitFor(() => {
      expect(download).toHaveBeenCalled();
    });
    expect(download.mock.calls[0]?.[1]).toBe('lohn_lexware_2026-09.csv');
    expect(server.calls.find((c) => c.path === '/org/payroll/export')?.query).toEqual({
      month: '2026-09',
      format: 'lexware',
    });

    await userEvent.type(screen.getByLabelText('Personalnummer Anna Arbeit'), '00042');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern: Anna Arbeit' }));
    expect(await screen.findByText('Zuordnung gespeichert.')).toBeTruthy();
    expect(server.calls.find((c) => c.path === `/org/payroll/members/${ID.anna}`)?.body).toEqual({
      personnelNumber: '00042',
      personioId: null,
    });

    expect(screen.getByRole('button', { name: 'Übertragen' })).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByLabelText('Client-ID'), 'papi-1');
    await userEvent.type(screen.getByLabelText('Client-Secret'), 'geheim');
    await userEvent.click(screen.getByRole('button', { name: 'Zugang speichern' }));
    expect(await screen.findByText(/Zugang hinterlegt \(Client-ID papi-1/)).toBeTruthy();
    expect(screen.getByLabelText('Client-Secret')).toHaveProperty('value', '');
    await userEvent.click(screen.getByRole('button', { name: 'Übertragen' }));
    expect(await screen.findByText('Übertragung 2026-09: teilweise erfolgreich.')).toBeTruthy();
    expect(
      await screen.findByText(/Alex Admin: übersprungen – Monat nicht freigegeben/),
    ).toBeTruthy();
    await expectAccessible();
  });
});

describe('Einladung annehmen', () => {
  it('legt das Konto über den Link an', async () => {
    const server = fakeServer();
    const session = new Session('http://admin.test', memoryStore(), server.fetch, () => NOW);
    renderApp(session, `${BASE}invite?token=${'t'.repeat(40)}`);
    expect(await screen.findByText('Firma GmbH')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Dein Name'), 'Neu Person');
    await userEvent.type(screen.getByLabelText(/Passwort/), 'sehr-geheim-1');
    await expectAccessible();
    await userEvent.click(screen.getByRole('button', { name: 'Konto anlegen' }));
    expect(await screen.findByText(/Konto angelegt/)).toBeTruthy();
    expect(server.calls.find((c) => c.path === '/auth/invite/accept')?.body).toMatchObject({
      token: 't'.repeat(40),
      name: 'Neu Person',
      password: 'sehr-geheim-1',
      state: 'BE',
    });
  });
});
