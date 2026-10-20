// Gezählte Arbeitszeiträume eines Arbeitstags und Netz-Zeiträume aus Ereignissen.
// Grundlage für Projektaufteilung, Tagesort und Kalender-Vorschläge.
import { type Range, clipRanges, mergeRanges, subtractRanges } from './ranges.js';
import { addDays, startOfLocalDay } from './time.js';
import type { PresenceSpan, Session, TimeEvent, WorkDay } from './types.js';

/** Zählt die Sitzung zur Arbeitszeit (nicht verworfen, automatisch oder bestätigt)? */
export function isCounted(s: Session): boolean {
  if (s.confirmed === false) return false;
  return !s.needsConfirmation || s.confirmed === true;
}

/** Ende einer Sitzung für Berechnungen: Ende, bei offener Sitzung `now`, sonst Beginn (unbekannt). */
function sessionEnd(s: Session, nowMs: number | undefined): number {
  const start = Date.parse(s.start);
  if (s.end !== undefined) return Date.parse(s.end);
  if (s.open && nowMs !== undefined) return Math.max(start, nowMs);
  return start;
}

/**
 * Gezählte Arbeitszeiträume (UTC-Millisekunden) eines Tages: Sitzung minus Pausen, zugeschnitten
 * auf den Kalendertag in der Zeitzone der Sitzung. Unbestätigte und verworfene Sitzungen fehlen.
 */
export function workRanges(day: WorkDay, now?: string): Range[] {
  const nowMs = now === undefined ? undefined : Date.parse(now);
  const out: Range[] = [];
  for (const s of day.sessions) {
    if (!isCounted(s)) continue;
    const from = startOfLocalDay(day.date, s.tz);
    const to = startOfLocalDay(addDays(day.date, 1), s.tz);
    const whole: Range[] = [[Date.parse(s.start), sessionEnd(s, nowMs)]];
    const breaks = s.breaks.map((b): Range => [Date.parse(b.from), Date.parse(b.to)]);
    out.push(...clipRanges(subtractRanges(whole, breaks), from, to));
  }
  return mergeRanges(out);
}

/** Zeitraum, in dem ein Gerät mit einem hinterlegten Arbeitsnetz verbunden war. */
export interface NetworkRange {
  networkId: string;
  from: string;
  to: string;
}

/**
 * Netz-Zeiträume je Netz aus `net_connected`/`net_lost` (je Gerät). Fehlt `net_lost`, endet der
 * Zeitraum mit der letzten Aktiv-Spanne des Geräts, sonst beim Verbinden selbst. Ereignisse ohne
 * `networkId` (z. B. Geofence ohne Netz) zählen nicht.
 */
export function networkRanges(
  events: readonly TimeEvent[],
  spans: readonly PresenceSpan[] = [],
): NetworkRange[] {
  const byDevice = new Map<string, TimeEvent[]>();
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type !== 'net_connected' && e.type !== 'net_lost') continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const list = byDevice.get(e.deviceId) ?? [];
    list.push(e);
    byDevice.set(e.deviceId, list);
  }
  const out: { networkId: string; r: Range }[] = [];
  for (const [device, list] of byDevice) {
    list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id.localeCompare(b.id));
    const devSpans = spans.filter((s) => s.deviceId === device);
    let open: { networkId: string; t: number } | undefined;
    const close = (end: number) => {
      if (open && end > open.t) out.push({ networkId: open.networkId, r: [open.t, end] });
      open = undefined;
    };
    for (const e of list) {
      const t = Date.parse(e.ts);
      if (e.type === 'net_connected') {
        if (open && open.networkId === e.networkId) continue;
        close(t);
        if (e.networkId !== undefined) open = { networkId: e.networkId, t };
      } else if (open && (e.networkId === undefined || e.networkId === open.networkId)) {
        close(t);
      }
    }
    if (open) {
      const start = open.t;
      let last = start;
      for (const s of devSpans) {
        const end = Date.parse(s.end);
        if (end > start) last = Math.max(last, end);
      }
      close(last);
    }
  }
  const byNet = new Map<string, Range[]>();
  for (const { networkId, r } of out) byNet.set(networkId, [...(byNet.get(networkId) ?? []), r]);
  const result: NetworkRange[] = [];
  for (const [networkId, ranges] of [...byNet].sort(([a], [b]) => a.localeCompare(b))) {
    for (const r of mergeRanges(ranges)) {
      result.push({
        networkId,
        from: new Date(r[0]).toISOString(),
        to: new Date(r[1]).toISOString(),
      });
    }
  }
  return result;
}

/** Wert einer Zählung oder 0. */
export function countOf(map: ReadonlyMap<string, number>, key: string): number {
  return map.get(key) ?? 0;
}

/** Verteilt `total` ganzzahlig nach Gewichten (größte Reste, bei Gleichstand nach Schlüssel). */
export function largestRemainder(
  weights: ReadonlyMap<string, number>,
  total: number,
): Map<string, number> {
  const sum = [...weights.values()].reduce((a, b) => a + b, 0);
  const share = sum > 0 && total > 0 ? total / sum : 0;
  const rest = [...weights].map(([k, w]) => {
    const exact = w * share;
    const base = Math.floor(exact);
    return { k, base, r: exact - base };
  });
  const extra = share > 0 ? total - rest.reduce((a, x) => a + x.base, 0) : 0;
  rest.sort((a, b) => b.r - a.r || a.k.localeCompare(b.k));
  return new Map(rest.map((x, i) => [x.k, x.base + (i < extra ? 1 : 0)]));
}
