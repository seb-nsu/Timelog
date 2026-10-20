# TimeLog

Automatische Arbeitszeiterfassung für Laptop (Windows, macOS) und Handy (Android, iOS). Die Zeit wird über Arbeitsnetz, Hochfahren/Herunterfahren des Laptops und manuelle Eingabe erfasst; ein gemeinsames Regelwerk berechnet daraus Arbeitstage, Pausen und Warnungen nach Arbeitszeitgesetz.

## Dokumente

| Datei                                            | Inhalt                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [docs/PRODUKTKONZEPT.md](docs/PRODUKTKONZEPT.md) | Produktkonzept: Erfassungslogik, Sonderfälle, Funktionsumfang, Datenschutz, Markt, Entscheidungen      |
| [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) | Implementierungskonzept: Tech-Stack, Regelwerk, Testfälle, API, Clients, Phasen mit Akzeptanzkriterien |
| [docs/PLATFORM.md](docs/PLATFORM.md)             | Desktop: Systemereignisse je Plattform, Prüfanleitung                                                  |
| [docs/MOBILE.md](docs/MOBILE.md)                 | Handy-App: Herstellerdoku-Prüfung, Netzwerk-Kennung, Entscheidungen, Prüfanleitungen, Store-Unterlagen |
| [CLAUDE.md](CLAUDE.md)                           | Regeln für Claude Code                                                                                 |

## Stand

| Phase              | Status                                                 |
| ------------------ | ------------------------------------------------------ |
| 0 – Grundgerüst    | erledigt                                               |
| 1 – Regelwerk      | erledigt                                               |
| 2a – Backend-Kern  | erledigt                                               |
| 2b – Backend-Fach  | erledigt                                               |
| 3a – Desktop-Kern  | erledigt                                               |
| 3b/3c – Win, macOS | gebaut, Gerätetest, Signierung und Updater offen       |
| 4/5 – Android, iOS | gebaut, Gerätetest, Store-Tests und Push-Versand offen |
| 6 – Firmenversion  | offen                                                  |

## Repo-Struktur

```
packages/
  rules/      Regelwerk: Ereignisse → Arbeitstage (ohne Laufzeit-Abhängigkeiten)
  shared/     Typen, Zod-Schemas, API-Client
  app-core/   geteilte Logik für Desktop- und Mobile-UI
apps/
  backend/    REST-API (Fastify, PostgreSQL, Drizzle)
  desktop/    Tauri 2: React-Oberfläche (src/), Rust-App (src-tauri/), Rust-Kern (src-tauri/core/)
  mobile/     Expo (Android, iOS): Oberfläche (src/), natives Modul (modules/timelog-native), iOS-Widget (targets/)
docs/         Konzepte
```

## Entwicklung

Voraussetzungen: Node.js 22 (≥ 22.12, siehe `.nvmrc`) und pnpm 10 (am einfachsten über `corepack enable`).

```sh
corepack enable
pnpm install
cp .env.example .env   # JWT_SECRET, TOTP_ENCRYPTION_KEY und NETWORK_HMAC_SECRET eintragen
docker compose up -d   # PostgreSQL 16
pnpm build
pnpm --filter @timelog/backend dev   # API auf http://localhost:3000, Migrationen laufen beim Start
```

Der nächtliche Lösch-Job (Aufbewahrungsfristen, abgelaufene Tokens) läuft im Server täglich um 03:00 UTC; einmalig von Hand: `pnpm --filter @timelog/backend purge`.

Ohne SMTP_URL gibt das Backend Mails (Bestätigungslink) in der Konsole aus – nur in der Entwicklung.

| Befehl           | Wirkung                                           |
| ---------------- | ------------------------------------------------- |
| `pnpm build`     | alle Pakete bauen (`dist/`)                       |
| `pnpm test`      | Vitest in allen Paketen, Jest in der Handy-App    |
| `pnpm lint`      | ESLint (typgeprüft, strikt)                       |
| `pnpm typecheck` | TypeScript ohne Ausgabe                           |
| `pnpm format`    | Prettier schreibt Formatierung                    |
| `pnpm check`     | Formatierung, Lint, Typecheck und Tests wie in CI |

Einzelnes Paket: `pnpm --filter @timelog/rules test`.

Die Backend-Tests laufen gegen eine echte PostgreSQL: per Testcontainers (Docker nötig) oder gegen eine vorhandene Instanz über `TEST_DATABASE_URL`. Schemaänderungen: `src/db/schema.ts` anpassen, dann `pnpm --filter @timelog/backend db:generate`. Die OpenAPI-Spezifikation liegt in `packages/shared/openapi.json` und wird mit `pnpm --filter @timelog/backend openapi` neu erzeugt; ein Test prüft, dass sie aktuell ist.

Die GitHub Action `.github/workflows/ci.yml` prüft bei jedem Push und Pull Request Formatierung, Lint, Typecheck und Tests, dazu `cargo fmt`, `clippy` und `cargo test` für die Desktop-App.

### Desktop-App

Zusätzlich nötig: Rust (stable) und die [Tauri-Voraussetzungen](https://v2.tauri.app/start/prerequisites/) des Systems (unter Linux u. a. `libwebkit2gtk-4.1-dev`).

```sh
pnpm build
pnpm --filter @timelog/desktop tauri dev     # App mit Tray starten
cd apps/desktop/src-tauri && cargo test --workspace
```

Der Rust-Kern (`src-tauri/core`) schreibt Ereignisse und Aktiv-Spannen sofort in SQLite und synchronisiert sie mit dem Backend; Tokens bleiben im Rust-Teil. Die Oberfläche berechnet Arbeitstage lokal mit `@timelog/rules`. Systemereignisse laufen über die Schnittstelle `SystemEvents` mit eigenen Modulen für Windows und macOS (Details und Prüfanleitung in [docs/PLATFORM.md](docs/PLATFORM.md)); für Tests gibt es die Attrappe `FakeSystem`. Optional setzt `VITE_DEFAULT_SERVER` beim Bauen die vorbelegte Server-Adresse.

### Handy-App

Expo SDK 58 mit eigenen nativen Modulen (Kotlin/Swift), daher ein Development-Build statt Expo Go. Expo verlangt Node.js ≥ 22.13. Für Android ist das Android SDK nötig, für iOS macOS mit Xcode.

```sh
pnpm build
cd apps/mobile
pnpm test              # Jest, ohne Gerät
pnpm prebuild          # erzeugt android/ und ios/ (nicht eingecheckt)
pnpm android           # bzw. pnpm ios
```

Android erkennt das Arbeitsnetz ohne Standortberechtigung über eine Netzwerk-Kennung aus `LinkProperties`, auch bei beendeter App. iOS bekommt den Beginn über den Kurzbefehl „Arbeitsnetz verbunden“ (Automation „WLAN“) und das Ende optional über einen Geofence. Die App läuft auch ohne Konto („Nur lokal“). Einstellungen beim Bauen stehen in `.env.example` (Abschnitt Handy-App). Details, ungeprüfte Punkte und 👤-Prüfanleitungen stehen in [docs/MOBILE.md](docs/MOBILE.md).

## Weiter mit Claude Code

```
Lies docs/IMPLEMENTATION.md. Setze Phase 6 um. Halte dich an CLAUDE.md.
Stoppe, wenn alle Akzeptanzkriterien von Phase 6 erfüllt und die Tests grün sind.
```

Jede Phase einzeln beauftragen. Punkte mit 👤 prüfst du selbst auf echter Hardware.
