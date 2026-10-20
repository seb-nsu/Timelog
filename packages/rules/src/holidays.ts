import { addDays, weekday } from './time.js';
import type { GermanState } from './types.js';

// Gesetzliche Feiertage je Bundesland. Feiertage, die nur in einzelnen Gemeinden gelten
// (Mariä Himmelfahrt in Teilen Bayerns, Fronleichnam in Teilen Sachsens und Thüringens,
// Augsburger Friedensfest), sind nicht enthalten.

const ALL: readonly GermanState[] = [
  'BW',
  'BY',
  'BE',
  'BB',
  'HB',
  'HH',
  'HE',
  'MV',
  'NI',
  'NW',
  'RP',
  'SL',
  'SN',
  'ST',
  'SH',
  'TH',
];

/** Ostersonntag (gregorianisch, anonymer Algorithmus nach Meeus/Jones/Butcher). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

interface Holiday {
  date: string;
  name: string;
}

const cache = new Map<string, Holiday[]>();

export function holidaysOf(year: number, state: GermanState): Holiday[] {
  const key = `${String(year)}-${state}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const y = String(year);
  const easter = easterSunday(year);
  const list: Holiday[] = [];
  const add = (date: string, name: string, states: readonly GermanState[]): void => {
    if (states.includes(state)) list.push({ date, name });
  };

  add(`${y}-01-01`, 'Neujahr', ALL);
  add(`${y}-01-06`, 'Heilige Drei Könige', ['BW', 'BY', 'ST']);
  if (year >= 2019) add(`${y}-03-08`, 'Internationaler Frauentag', ['BE']);
  if (year >= 2023) add(`${y}-03-08`, 'Internationaler Frauentag', ['MV']);
  add(addDays(easter, -2), 'Karfreitag', ALL);
  add(easter, 'Ostersonntag', ['BB']);
  add(addDays(easter, 1), 'Ostermontag', ALL);
  add(`${y}-05-01`, 'Tag der Arbeit', ALL);
  if (year === 2020 || year === 2025) add(`${y}-05-08`, 'Tag der Befreiung', ['BE']);
  add(addDays(easter, 39), 'Christi Himmelfahrt', ALL);
  add(addDays(easter, 49), 'Pfingstsonntag', ['BB']);
  add(addDays(easter, 50), 'Pfingstmontag', ALL);
  add(addDays(easter, 60), 'Fronleichnam', ['BW', 'BY', 'HE', 'NW', 'RP', 'SL']);
  add(`${y}-08-15`, 'Mariä Himmelfahrt', ['SL']);
  if (year >= 2019) add(`${y}-09-20`, 'Weltkindertag', ['TH']);
  add(`${y}-10-03`, 'Tag der Deutschen Einheit', ALL);
  if (year === 2017) add(`${y}-10-31`, 'Reformationstag', ALL);
  else {
    add(`${y}-10-31`, 'Reformationstag', ['BB', 'MV', 'SN', 'ST', 'TH']);
    if (year >= 2018) add(`${y}-10-31`, 'Reformationstag', ['HB', 'HH', 'NI', 'SH']);
  }
  add(`${y}-11-01`, 'Allerheiligen', ['BW', 'BY', 'NW', 'RP', 'SL']);
  // Buß- und Bettag: Mittwoch vor dem 23. November
  const nov22 = `${y}-11-22`;
  add(addDays(nov22, -((weekday(nov22) - 3 + 7) % 7)), 'Buß- und Bettag', ['SN']);
  add(`${y}-12-25`, '1. Weihnachtstag', ALL);
  add(`${y}-12-26`, '2. Weihnachtstag', ALL);

  list.sort((a, b) => a.date.localeCompare(b.date));
  cache.set(key, list);
  return list;
}

export function isHoliday(date: string, state: GermanState): boolean {
  return holidaysOf(Number(date.slice(0, 4)), state).some((h) => h.date === date);
}
