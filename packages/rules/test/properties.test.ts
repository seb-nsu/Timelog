import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES_CONFIG,
  EVENT_TYPES,
  type PresenceSpan,
  type TimeEvent,
  type WorkDay,
  computeDays,
} from '../src/index.js';
import { type Input, loadScenarios, toInput } from './scenario.js';

const run = (i: Input): WorkDay[] => computeDays(i.events, i.spans, i.absences, i.config, i.now);

function checkInvariants(days: WorkDay[]): void {
  for (const d of days) {
    expect(d.netMinutes).toBeGreaterThanOrEqual(0);
    expect(d.netMinutes).toBeLessThanOrEqual(d.workMinutes);
    for (const s of d.sessions) {
      expect(s.workMinutes).toBeLessThanOrEqual(16 * 60);
      if (s.end !== undefined) {
        expect(Date.parse(s.end) - Date.parse(s.start)).toBeLessThanOrEqual(16 * 3_600_000);
      }
    }
  }
}

function shuffled<T>(items: readonly T[]): fc.Arbitrary<T[]> {
  return fc.shuffledSubarray([...items], { minLength: items.length, maxLength: items.length });
}

const scenarios = loadScenarios().map(({ file, scenario }) => ({ file, input: toInput(scenario) }));

describe('Property-Tests über alle Fixtures', () => {
  for (const { file, input } of scenarios) {
    it(`${file}: Reihenfolge egal, Netto ≥ 0, Netto ≤ Arbeit, keine Sitzung > 16 h`, () => {
      const expected = run(input);
      checkInvariants(expected);
      fc.assert(
        fc.property(shuffled(input.events), shuffled(input.spans), (events, spans) => {
          expect(run({ ...input, events, spans })).toEqual(expected);
        }),
        { numRuns: 25 },
      );
    });
  }
});

// Zufällige Ereignisströme über drei Tage
const BASE = Date.parse('2026-10-13T22:00:00Z');
const minute = fc.integer({ min: 0, max: 3 * 24 * 60 });
const iso = (m: number): string => new Date(BASE + m * 60_000).toISOString();

const eventArb = fc.record({
  type: fc.constantFrom(...EVENT_TYPES),
  device: fc.constantFrom('L', 'H', 'L2'),
  at: minute,
  len: fc.integer({ min: 1, max: 240 }),
  late: fc.integer({ min: 0, max: 3 * 24 * 60 }),
  ref: fc.integer({ min: 0, max: 30 }),
  update: fc.boolean(),
});

const spanArb = fc.record({
  device: fc.constantFrom('L', 'H', 'L2'),
  at: minute,
  len: fc.integer({ min: 0, max: 600 }),
});

const streamArb = fc
  .tuple(fc.array(eventArb, { maxLength: 30 }), fc.array(spanArb, { maxLength: 15 }), minute)
  .map(([evs, sps, nowMin]): Input => {
    const events: TimeEvent[] = evs.map((x, i) => {
      const e: TimeEvent = {
        id: `r${String(i)}`,
        deviceId: x.device,
        userId: 'u',
        type: x.type,
        source: x.type.startsWith('manual') || x.type.startsWith('session') ? 'user' : 'system',
        ts: iso(x.at),
        tz: 'Europe/Berlin',
        createdAt: iso(x.at + (x.late % 5 === 0 ? x.late : 0)),
      };
      if (x.type === 'manual_break' || x.type === 'manual_work') e.endTs = iso(x.at + x.len);
      if (x.type === 'session_confirm' || x.type === 'session_reject')
        e.refEventId = `r${String(x.ref)}`;
      if (x.type === 'shutdown' && x.update) e.flags = ['update_restart'];
      return e;
    });
    const spans: PresenceSpan[] = sps.map((s) => ({
      deviceId: s.device,
      deviceKind: s.device === 'H' ? 'mobile' : 'desktop',
      start: iso(s.at),
      end: iso(s.at + s.len),
      open: false,
    }));
    return { events, spans, absences: [], config: DEFAULT_RULES_CONFIG, now: iso(nowMin) };
  });

describe('Property-Tests mit zufälligen Ereignisströmen', () => {
  it('Invarianten gelten und Reihenfolge ist egal', () => {
    fc.assert(
      fc.property(streamArb, fc.integer(), (input, seed) => {
        const expected = run(input);
        checkInvariants(expected);
        const rot = (xs: readonly unknown[]): number =>
          xs.length === 0 ? 0 : Math.abs(seed) % xs.length;
        const events = [
          ...input.events.slice(rot(input.events)),
          ...input.events.slice(0, rot(input.events)),
        ].reverse();
        const spans = [...input.spans].reverse();
        expect(run({ ...input, events, spans })).toEqual(expected);
      }),
      { numRuns: 400 },
    );
  });
});
