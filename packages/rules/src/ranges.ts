// Operationen auf Zeiträumen [Beginn, Ende) in UTC-Millisekunden.

export type Range = readonly [number, number];

const byStart = (a: Range, b: Range): number => a[0] - b[0] || a[1] - b[1];

/** Vereinigt überlappende oder sich berührende Zeiträume; leere werden verworfen. */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const out: [number, number][] = [];
  for (const r of [...ranges].filter((x) => x[1] > x[0]).sort(byStart)) {
    const last = out.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Schneidet Zeiträume auf [from, to] zu. */
export function clipRanges(ranges: readonly Range[], from: number, to: number): Range[] {
  const out: Range[] = [];
  for (const r of ranges) {
    const a = Math.max(r[0], from);
    const b = Math.min(r[1], to);
    if (b > a) out.push([a, b]);
  }
  return out;
}

/** Entfernt `cut` aus `ranges`. */
export function subtractRanges(ranges: readonly Range[], cut: readonly Range[]): Range[] {
  const cuts = mergeRanges(cut);
  const out: Range[] = [];
  for (const r of ranges) {
    let a = r[0];
    for (const c of cuts) {
      if (c[1] <= a || c[0] >= r[1]) continue;
      if (c[0] > a) out.push([a, c[0]]);
      a = Math.max(a, c[1]);
    }
    if (r[1] > a) out.push([a, r[1]]);
  }
  return out;
}

/** Lücken der vereinigten Zeiträume innerhalb von [from, to]. */
export function gapsWithin(ranges: readonly Range[], from: number, to: number): Range[] {
  return subtractRanges([[from, to]], ranges);
}

export function totalLength(ranges: readonly Range[]): number {
  return ranges.reduce((sum, r) => sum + (r[1] - r[0]), 0);
}
