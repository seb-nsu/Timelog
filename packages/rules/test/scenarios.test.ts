import { describe, expect, it } from 'vitest';
import { computeBalance, computeDays } from '../src/index.js';
import { loadScenarios, normalize, project, toInput } from './scenario.js';

const scenarios = loadScenarios();

describe('Testfälle Regelwerk (Fixtures)', () => {
  it('enthält alle Fälle aus docs/IMPLEMENTATION.md', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(35);
  });

  for (const { file, scenario } of scenarios) {
    it(`${file}: ${scenario.name}`, () => {
      const input = toInput(scenario);
      const days = computeDays(input.events, input.spans, input.absences, input.config, input.now);
      const actual = days.map((d, i) => project(d, scenario.expect[i] ?? {}));
      expect(actual).toEqual(scenario.expect.map(normalize));
      if (scenario.balanceMin !== undefined) expect(computeBalance(days)).toBe(scenario.balanceMin);
    });
  }
});
