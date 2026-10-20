import { describe, expect, it, jest } from '@jest/globals';
import { PUSH_ACTIONS, PUSH_CATEGORIES } from '@timelog/shared';
import { fireEvent, render, screen, userEvent, waitFor } from '@testing-library/react-native';
import { App } from '../src/App';
import { DEFAULT_ACTION, answerFor, parsePushData, promptCategories } from '../src/push';
import type { PlatformActions, Route } from '../src/ui/context';
import { type Harness, harness, loggedIn } from './helpers';

const tz = 'Europe/Berlin';
const actions: PlatformActions = {
  shareFile: () => Promise.resolve(),
  requestNotifications: () => Promise.resolve(true),
};

/** Montag 4 h am Arbeitsnetz (unproblematisch), Samstag 2 h (Tag ohne Soll: zu prüfen). */
function week(h: Harness) {
  const ev = (id: string, type: 'net_connected' | 'net_lost', ts: string) => ({
    id,
    type,
    source: 'wifi' as const,
    ts,
    tz,
    createdAt: ts,
  });
  h.native.queue.events.push(
    ev('m1', 'net_connected', '2026-10-12T06:00:00Z'),
    ev('m2', 'net_lost', '2026-10-12T10:00:00Z'),
    ev('s1', 'net_connected', '2026-10-17T08:00:00Z'),
    ev('s2', 'net_lost', '2026-10-17T10:00:00Z'),
  );
  return h.core.ingestNative();
}

describe('Push-Daten', () => {
  it('liest Daten als Objekt oder JSON und verwirft Fremdes', () => {
    const data = { kind: 'end_confirm', sessionId: 's1', date: '2026-10-15' };
    expect(parsePushData(data)).toEqual(data);
    expect(parsePushData(JSON.stringify(data))).toEqual(data);
    expect(parsePushData('{kaputt')).toBeUndefined();
    expect(parsePushData({ kind: 'end_confirm', email: 'a@b.de' })).toBeUndefined();
  });

  it('„Stimmt“ bestätigt, „Korrigieren“ und Antippen öffnen den Tag bzw. die Woche', () => {
    const end = { kind: 'end_confirm', sessionId: 's1', date: '2026-10-15' };
    expect(answerFor(PUSH_ACTIONS.confirm, end, 'n1')).toEqual({
      kind: 'confirm',
      data: end,
      key: 'end_confirm:s1:n1',
    });
    expect(answerFor(PUSH_ACTIONS.correct, end, 'n1')).toEqual({
      kind: 'open',
      route: { name: 'log', date: '2026-10-15' },
    });
    const missing = { kind: 'end_missing', sessionId: 's2', date: '2026-10-14' };
    expect(answerFor(PUSH_ACTIONS.confirm, missing, 'n2')).toEqual({
      kind: 'open',
      route: { name: 'log', date: '2026-10-14' },
    });
    const review = { kind: 'week_review', week: '2026-W42', date: '2026-10-12' };
    expect(answerFor(DEFAULT_ACTION, review, 'n3')).toEqual({
      kind: 'open',
      route: { name: 'week', date: '2026-10-12' },
    });
    expect(answerFor('unbekannt', review, 'n3')).toEqual({ kind: 'none' });
    expect(answerFor(PUSH_ACTIONS.confirm, { foo: 1 }, 'n4')).toEqual({ kind: 'none' });
  });

  it('Kategorien: „Stimmt“ ohne App-Start, „Korrigieren“ öffnet die App', () => {
    const cats = promptCategories({ yes: 'Stimmt', correct: 'Korrigieren', open: 'Ansehen' });
    expect(cats.map((c) => c.identifier)).toEqual(Object.values(PUSH_CATEGORIES));
    const end = cats[0];
    expect(end?.actions).toEqual([
      { identifier: 'confirm', buttonTitle: 'Stimmt', options: { opensAppToForeground: false } },
      {
        identifier: 'correct',
        buttonTitle: 'Korrigieren',
        options: { opensAppToForeground: true },
      },
    ]);
  });
});

describe('Antworten im Kern', () => {
  it('„Stimmt“ beim Arbeitsende: session_confirm, je Benachrichtigung nur einmal', async () => {
    const h = await harness();
    await h.core.useLocalOnly();
    const data = { kind: 'end_confirm' as const, sessionId: 'abc', date: '2026-10-15' };
    expect(await h.core.answerPrompt(data, 'k1', 'Grund')).toBe(true);
    expect(await h.core.answerPrompt(data, 'k1', 'Grund')).toBe(false);
    const events = await h.core.events('2026-10-15T00:00:00Z', '2026-10-16T00:00:00Z');
    expect(events.map((e) => [e.type, e.refEventId])).toEqual([['session_confirm', 'abc']]);
  });

  it('„Stimmt“ bei fehlendem Ende: Korrektur mit Begründung über den Server', async () => {
    const h = await loggedIn();
    const data = {
      kind: 'end_missing' as const,
      sessionId: 'abc',
      date: '2026-10-14',
      end: '2026-10-14T16:00:00Z',
    };
    expect(await h.core.answerPrompt(data, 'k2', 'Ende per Rückfrage bestätigt')).toBe(true);
    expect(h.server.corrections).toEqual([
      expect.objectContaining({
        date: '2026-10-14',
        field: 'end',
        time: '2026-10-14T16:00:00Z',
        reason: 'Ende per Rückfrage bestätigt',
      }),
    ]);
  });

  it('übernimmt eine native Bestätigung (iOS-Aktion) mit Sitzungs-ID', async () => {
    const h = await harness();
    h.native.queue.events.push({
      id: 'N1',
      type: 'session_confirm',
      source: 'user',
      ts: '2026-10-15T07:00:00Z',
      tz,
      createdAt: '2026-10-15T07:00:00Z',
      refEventId: 'sess',
    });
    await h.core.ingestNative();
    const events = await h.core.events('2026-10-15T00:00:00Z', '2026-10-16T00:00:00Z');
    expect(events).toEqual([expect.objectContaining({ id: 'n1', refEventId: 'sess' })]);
  });

  it('meldet die Sprache der Push-Texte mit dem Token', async () => {
    const h = await loggedIn();
    await h.core.registerPushToken('tok', 'en');
    expect(h.server.pushLocales).toEqual(['en']);
  });

  it('Woche bestätigen: mit Konto per Tagesbestätigung, ohne Konto je Sitzung', async () => {
    const online = await loggedIn({ now: '2026-10-18T10:00:00Z' });
    await week(online);
    const days = await online.core.days();
    expect(await online.core.confirmDays(days, ['2026-10-12'])).toBe(1);
    expect(online.server.requests).toContain('POST /days/2026-10-12/confirm');

    const local = await harness({ now: '2026-10-18T10:00:00Z' });
    await local.core.useLocalOnly();
    await week(local);
    await local.core.confirmDays(await local.core.days(), ['2026-10-12']);
    const events = await local.core.events('2026-10-18T00:00:00Z', '2026-10-19T00:00:00Z');
    expect(events.map((e) => [e.type, e.refEventId])).toEqual([['session_confirm', 'm1']]);
  });
});

describe('Wochenrückblick', () => {
  async function show(h: Harness, externalRoutes?: (go: (r: Route) => void) => () => void) {
    await h.core.finishSetup();
    await render(
      <App
        core={h.core}
        locale="de"
        actions={actions}
        clock={h.clock}
        {...(externalRoutes ? { externalRoutes } : {})}
      />,
    );
  }

  it('aus der Übersicht: Summen, offene Tage, Woche bestätigen', async () => {
    const h = await harness({ now: '2026-10-18T10:00:00Z' });
    await h.core.useLocalOnly();
    await week(h);
    await show(h);
    const user = userEvent.setup();
    await user.press(await screen.findByRole('tab', { name: /Übersicht/ }));
    await user.press(await screen.findByRole('button', { name: 'Wochenrückblick' }));
    expect(await screen.findByRole('header', { name: 'Wochenrückblick' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Netto: 4:00 h')).toBeOnTheScreen();
    expect(screen.getByText('Keine Hinweise.')).toBeOnTheScreen();
    for (const el of screen.getAllByRole('button')) expect(el).toHaveAccessibleName();
    const open = screen.getByRole('button', { name: /^Sa\., 17\.10\.2026 öffnen/ });
    await user.press(screen.getByRole('button', { name: 'Woche bestätigen' }));
    expect(await screen.findByText('Bestätigte Tage: 1.')).toBeOnTheScreen();
    expect(
      await screen.findByText('Alle unproblematischen Tage sind bestätigt.'),
    ).toBeOnTheScreen();
    await user.press(open);
    expect(await screen.findByRole('tab', { name: 'Protokoll' })).toBeSelected();
  });

  it('Antippen einer Benachrichtigung öffnet die Woche', async () => {
    const h = await harness({ now: '2026-10-20T10:00:00Z' });
    await h.core.useLocalOnly();
    let go: ((r: Route) => void) | undefined;
    await show(h, (g) => {
      go = g;
      return () => undefined;
    });
    await screen.findByRole('tab', { name: 'Heute' });
    go?.({ name: 'week', date: '2026-10-12' });
    expect(await screen.findByText('KW 42: Mo., 12.10.2026 – So., 18.10.2026')).toBeOnTheScreen();
  });

  it('Einstellungen: Rückfrage und Wochenrückblick', async () => {
    const h = await harness();
    await h.core.useLocalOnly();
    await show(h);
    const user = userEvent.setup();
    await user.press(await screen.findByRole('tab', { name: 'Einstellungen' }));
    const ask = { name: 'Nach erkanntem Feierabend fragen („Stimmt das?“)' };
    await fireEvent(await screen.findByRole('switch', ask), 'valueChange', false);
    await waitFor(() => {
      expect(screen.getByRole('switch', ask)).not.toBeChecked();
    });
    await user.press(await screen.findByRole('radio', { name: 'Montag' }));
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Montag' })).toBeChecked();
    });
    const time = screen.getByLabelText('Uhrzeit');
    await user.clear(time);
    await user.type(time, '08:30');
    await user.press(screen.getByRole('button', { name: 'Benachrichtigungen speichern' }));
    expect(await screen.findByText('Gespeichert.')).toBeOnTheScreen();
    const n = (await h.core.settings()).notifications;
    expect(n.confirmEnd).toBe(false);
    expect(n.weekReview).toEqual({ enabled: true, weekday: 1, time: '08:30' });
  });
});

jest.setTimeout(20_000);
