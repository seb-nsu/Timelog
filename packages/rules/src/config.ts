import type { RulesConfig } from './types.js';

export const DEFAULT_RULES_CONFIG: RulesConfig = {
  bootConfirmMin: 5,
  shutdownBonusMin: 5,
  restartWindowMin: 15,
  updateRestartWindowMin: 60,
  netGraceMin: 10,
  standbyBreakMin: 15,
  maxStandbyMin: 180,
  maxBreakMin: 120,
  maxSessionH: 16,
  legalBreakPieceMin: 15,
  breakRules: [
    { overMin: 6 * 60, breakMin: 30 },
    { overMin: 9 * 60, breakMin: 45 },
  ],
  maxContinuousH: 6,
  maxDayH: 10,
  minRestH: 11,
  avgDayH: 8,
  avgWeeks: 24,
  backdateH: 24,
  futureToleranceMin: 5,
  correctionThresholdMin: 5,
  state: 'BE',
  targetSchedule: [{ validFrom: '1970-01-01', minutesByWeekday: [0, 480, 480, 480, 480, 480, 0] }],
};

/** Ergänzt fehlende Werte mit den Standardwerten. */
export function resolveConfig(partial: Partial<RulesConfig> = {}): RulesConfig {
  return { ...DEFAULT_RULES_CONFIG, ...partial };
}
