// Fester Zeitfenster-Zähler im Speicher. Für mehrere Instanzen später durch Redis ersetzen.
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number) {}

  /** Zählt einen Treffer; liefert die Wartezeit in Sekunden, wenn das Limit überschritten ist. */
  hit(key: string, max: number, windowMs: number): number | undefined {
    const now = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    if (this.hits.size > 50_000) this.sweep(now);
    return entry.count > max ? Math.ceil((entry.resetAt - now) / 1000) : undefined;
  }

  private sweep(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
