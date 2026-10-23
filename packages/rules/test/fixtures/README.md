# Fixtures Regelwerk

Ein JSON je Testfall aus `docs/IMPLEMENTATION.md` (Fälle 1–32 sowie 10b, 18b, 24b; Fall 33 sind die Property-Tests in `../properties.test.ts`).
Erwartungen nur nach Rückfrage ändern (siehe `CLAUDE.md`).

Format wie im Implementierungskonzept, mit diesen Ergänzungen:

- Zeiten: `"HH:MM"` (Datum aus `opts.date`, Standard `2026-10-14`) oder `"YYYY-MM-DD HH:MM"`, lokal in `Europe/Berlin`.
- Ereignis-IDs werden in Reihenfolge vergeben: `e1`, `e2`, … (Ziel für `refEventId`).
- `opts.receivedAt`, `opts.source`, `opts.flags`, `opts.tz` sind optional.
- `spans` fehlt → je Laptop eine Spanne von `boot` bis `shutdown`, je Handy von `net_connected` bis `net_lost`.
- `now` fehlt → Folgetag des letzten Ereignisdatums, 09:00.
- Erwartung je Tag zusätzlich: `absenceMin`, `targetMin`; `end` = `"24:00"`, wenn der Tag um Mitternacht endet; `end` fehlt bei offenem oder unbekanntem Ende.
- `balanceMin`: erwarteter Saldo über alle berechneten Tage.

Werte, die die Tabelle offen lässt („–“), wurden so festgelegt:

- **10b** (Sitzung offen): Werte bis zur letzten Aktivität 18:12 – Arbeit 10:12, Auffüllung 0:45, Netto 9:27; Warnungen `break_violation`, `break_placement`, `over_10h`; kein `no_end`, solange offen.
- **27** (nur `manual_start`): Beginn 09:00, kein Ende, Arbeit 0.
