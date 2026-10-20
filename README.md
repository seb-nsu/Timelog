# TimeLog

Automatische Arbeitszeiterfassung für Laptop (Windows, macOS) und Handy (Android, iOS). Die Zeit wird über Arbeitsnetz, Hochfahren/Herunterfahren des Laptops und manuelle Eingabe erfasst; ein gemeinsames Regelwerk berechnet daraus Arbeitstage, Pausen und Warnungen nach Arbeitszeitgesetz.

## Dokumente

| Datei                                            | Inhalt                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [docs/PRODUKTKONZEPT.md](docs/PRODUKTKONZEPT.md) | Produktkonzept: Erfassungslogik, Sonderfälle, Funktionsumfang, Datenschutz, Markt, Entscheidungen      |
| [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) | Implementierungskonzept: Tech-Stack, Regelwerk, Testfälle, API, Clients, Phasen mit Akzeptanzkriterien |
| [CLAUDE.md](CLAUDE.md)                           | Regeln für Claude Code                                                                                 |

## Stand

| Phase              | Status   |
| ------------------ | -------- |
| 0 – Grundgerüst    | erledigt |
| 1 – Regelwerk      | offen    |
| 2a/2b – Backend    | offen    |
| 3a–3c – Desktop    | offen    |
| 4/5 – Android, iOS | offen    |
| 6 – Firmenversion  | offen    |

## Repo-Struktur

```
packages/
  rules/      Regelwerk: Ereignisse → Arbeitstage (ohne Laufzeit-Abhängigkeiten)
  shared/     Typen, Zod-Schemas, API-Client
  app-core/   geteilte Logik für Desktop- und Mobile-UI
apps/         Backend, Desktop, Mobile, Admin (ab Phase 2)
docs/         Konzepte
```

## Entwicklung

Voraussetzungen: Node.js 22 (≥ 22.12, siehe `.nvmrc`) und pnpm 10 (am einfachsten über `corepack enable`).

```sh
corepack enable
pnpm install
cp .env.example .env   # erst ab Phase 2a nötig
```

| Befehl           | Wirkung                                           |
| ---------------- | ------------------------------------------------- |
| `pnpm build`     | alle Pakete bauen (`dist/`)                       |
| `pnpm test`      | Vitest in allen Paketen                           |
| `pnpm lint`      | ESLint (typgeprüft, strikt)                       |
| `pnpm typecheck` | TypeScript ohne Ausgabe                           |
| `pnpm format`    | Prettier schreibt Formatierung                    |
| `pnpm check`     | Formatierung, Lint, Typecheck und Tests wie in CI |

Einzelnes Paket: `pnpm --filter @timelog/rules test`.

Die GitHub Action `.github/workflows/ci.yml` prüft bei jedem Push und Pull Request Formatierung, Lint, Typecheck und Tests.

## Weiter mit Claude Code

```
Lies docs/IMPLEMENTATION.md. Setze Phase 1 um. Halte dich an CLAUDE.md.
Stoppe, wenn alle Akzeptanzkriterien von Phase 1 erfüllt und die Tests grün sind.
```

Jede Phase einzeln beauftragen. Punkte mit 👤 prüfst du selbst auf echter Hardware.
