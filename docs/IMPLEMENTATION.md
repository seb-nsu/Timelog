# Implementierungskonzept: Zeiterfassungs-App

Stand: 19.10.2026

## Nutzung mit Claude Code

Dieses Dokument ist die technische Spezifikation zum Produktkonzept; Claude Code setzt es in Phasen (0 bis 6) um, jede mit prüfbaren Akzeptanzkriterien.

1. Dokument als Markdown exportieren und im neuen Repo als `docs/IMPLEMENTATION.md` ablegen.
2. Abschnitt „Vorgaben für Claude Code“ zusätzlich als `CLAUDE.md` ins Repo-Root kopieren.
3. Start-Prompt: *„Lies docs/IMPLEMENTATION.md. Setze Phase 0 um. Halte dich an CLAUDE.md. Stoppe, wenn alle Akzeptanzkriterien von Phase 0 erfüllt und die Tests grün sind.“*
4. Nach jeder Phase prüfen, committen, dann die nächste Phase anstoßen.

Punkte mit 👤 in den Phasen prüfst du selbst auf echter Hardware. Das Regelwerk (Phase 1) ist das Herzstück: Es wird zuerst und vollständig getestet gebaut, alle Clients nutzen es.

## Tech-Stack & Repo-Struktur

Alles außer der Systemanbindung ist TypeScript, damit das Regelwerk als ein Paket in Backend, Desktop und Mobile läuft.

| Baustein | Technologie | Begründung |
| --- | --- | --- |
| Monorepo | pnpm Workspaces + Turborepo | Ein Repo, geteilte Pakete |
| Regelwerk | TypeScript-Paket ohne Abhängigkeiten, Vitest | Überall identisch, gut testbar |
| Backend | Node.js 22, Fastify, PostgreSQL 16, Drizzle ORM, Zod | Schlank, typsicher |
| Auth | E-Mail + Passwort mit Argon2id, JWT (Access 15 min, Refresh 30 Tage, rotierend, gerätegebunden); SSO in Phase 6 | Kein externer Dienst nötig |
| Desktop | Tauri 2: Rust-Kern für Systemereignisse, React-UI im Tray | Klein, läuft auf Windows und macOS |
| Mobile | React Native mit Expo (Dev-Client), eigene native Module für WLAN | Teilt Regelwerk und UI-Logik |
| Web-Admin | React + Vite | Firmenversion |
| Lokale Speicherung | SQLite (Desktop und Mobile) | Offline-first |

```
zeiterfassung/
├─ packages/
│  ├─ rules/        # Regelwerk: Ereignisse → Arbeitstage
│  ├─ shared/       # Typen, Zod-Schemas, API-Client
│  └─ app-core/     # geteilte Logik für Desktop- und Mobile-UI (Hooks, Formatierung, i18n) – keine UI-Komponenten, da Tauri (Web) und React Native nicht dieselben Komponenten nutzen
├─ apps/
│  ├─ backend/
│  ├─ desktop/      # Tauri (src-tauri = Rust)
│  ├─ mobile/       # Expo
│  └─ admin/        # Web-Admin Firmenversion
├─ docs/IMPLEMENTATION.md
└─ CLAUDE.md
```

## Regelwerk (`packages/rules`)

Das Regelwerk ist eine reine Funktion ohne Seiteneffekte: `computeDays(events, spans, absences, config, now) → WorkDay[]`. Clients speichern nur Ereignisse und Aktiv-Spannen; Arbeitstage werden immer neu berechnet. Laufzeit-Abhängigkeiten: keine (Vitest und fast-check nur als devDependencies).

**Typen**

```ts
type EventType =
  | 'boot'            // Rechner läuft seit ≥ 5 min; ts = echte Einschaltzeit (nicht bei Aufwachen aus Ruhezustand)
  | 'shutdown'        // echtes Herunterfahren (kein Neustart, kein Logout)
  | 'restart'         // Neustart erkannt → wird ignoriert
  | 'net_connected' | 'net_lost'   // nur für hinterlegte Arbeitsnetze
  | 'manual_start' | 'manual_end'  // Start/Stopp-Knopf oder nachträgliche Korrektur
  | 'manual_break'    // mit endTs: Pause nachtragen
  | 'manual_work'     // mit endTs: Zeitraum als Arbeit werten (z. B. Meeting ohne Laptop)
  | 'session_confirm' | 'session_reject'  // refEventId = Start-Ereignis der Sitzung

type EventSource = 'system' | 'wifi' | 'lan' | 'geofence' | 'shortcut' | 'user'

interface TimeEvent {
  id: string; deviceId: string; userId: string;  // userId/deviceId setzt der Server aus dem Token
  type: EventType; source: EventSource;
  ts: string; endTs?: string;     // ISO 8601 UTC
  tz: string;                     // IANA-Zeitzone des Geräts zum Ereigniszeitpunkt
  networkId?: string; refEventId?: string;
  createdAt: string;              // Gerätezeit der Erzeugung
  receivedAt?: string;            // vom Server gesetzt, nur Info
}

// Aktiv-Spanne: Gerät wach und entsperrt (Desktop) bzw. im Arbeitsnetz (Mobile).
// Ersetzt einzelne Heartbeats; der Client verlängert die offene Spanne laufend.
interface PresenceSpan { deviceId: string; deviceKind: 'desktop' | 'mobile'; start: string; end: string; open: boolean }

interface Absence { date: string; kind: 'vacation' | 'sick' | 'holiday' | 'other'; minutes: number }

interface Session {
  id: string;                     // = id des Start-Ereignisses (stabil, Ziel von session_confirm)
  start: string; end?: string; tz: string;     // tz = Zeitzone des Start-Ereignisses
  startSource: EventType | 'resume'; endSource?: EventType | 'last_presence' | 'capped';
  breaks: { from: string; to: string; source: 'standby' | 'net_gap' | 'manual'; countsLegally: boolean }[];
  workMinutes: number;            // tatsächlich: Ende − Start − echte Pausen
  breakTopUpMin: number;          // ausgewiesener Abzug bis zur Mindestpause
  needsConfirmation: boolean; confirmed?: boolean;
}

interface WorkDay {
  date: string;                   // YYYY-MM-DD in Zeitzone der Sitzung
  sessions: Session[];
  workMinutes: number;            // tatsächliche Arbeitszeit des Tages (gezählte Sitzungen)
  netMinutes: number;             // workMinutes − Auffüllung; nie negativ
  pendingMinutes: number;         // unbestätigte Sitzungen
  absenceMinutes: number; targetMinutes: number;
  status: 'open' | 'unchecked' | 'auto' | 'confirmed';
  corrected: boolean;
  warnings: Warning[];
}

type Warning =
  // verlangen Prüfung (Status unchecked):
  | 'break_violation' | 'break_placement' | 'gap_end' | 'no_end' | 'session_capped'
  | 'late_event' | 'future_event' | 'second_session' | 'non_workday'
  // nur Hinweis:
  | 'over_10h' | 'rest_under_11h' | 'sunday_or_holiday' | 'avg_over_8h' | 'crash_restart'
```

**Konstanten (`config`, Standardwerte, pro Organisation überschreibbar)**

| Name | Wert | Bedeutung |
| --- | --- | --- |
| `bootConfirmMin` | 5 | Client meldet `boot` erst nach 5 min Laufzeit, mit Einschaltzeit als `ts` |
| `shutdownBonusMin` | 5 | Ende = Shutdown + 5 min; Firmen dürfen 0 setzen |
| `restartWindowMin` | 15 | `boot` innerhalb 15 min nach `shutdown`/letzter Aktivität desselben Geräts = Neustart |
| `updateRestartWindowMin` | 60 | dasselbe, wenn der Client einen Update-Neustart gemeldet hat |
| `netGraceMin` | 10 | Netz-Lücken bis 10 min werden überbrückt |
| `standbyBreakMin` | 15 | Desktop inaktiv (Standby, Deckel zu, Bildschirm gesperrt) ab 15 min = Pause |
| `maxStandbyMin` | 180 | Desktop länger inaktiv → Sitzung endet bei letzter Aktivität |
| `maxBreakMin` | 120 | längere Lücke ohne jede Aktivität trennt zwei Sitzungen |
| `maxSessionH` | 16 | längere Sitzungen werden abgeschnitten (`session_capped`) |
| `legalBreakPieceMin` | 15 | nur Pausenstücke ab 15 min zählen zur Mindestpause (§ 4 ArbZG) |
| `breakRules` | > 6 h → 30 min, > 9 h → 45 min | gemessen an der tatsächlichen Arbeitszeit |
| `maxContinuousH` | 6 | länger ohne anrechenbare Pause → `break_placement` |
| `maxDayH` / `minRestH` / `avgDayH` | 10 / 11 / 8 | Hinweisschwellen (§ 3, § 5 ArbZG; Durchschnitt über 24 Wochen) |
| `backdateH` | 24 | automatisches Ereignis mit `createdAt − ts` > 24 h → `late_event` |

**Algorithmus**

1. **Bereinigen**: Ereignisse nach `ts` sortieren, Duplikate per `id` entfernen. `future_event`: `ts` > `now` + 5 min. `late_event`: automatisches Ereignis (Quelle ≠ `user`) mit `createdAt − ts` > `backdateH` – also auf dem Gerät rückdatiert. Spät *übertragene* Ereignisse (z. B. Shutdown vom Freitag, gesendet am Montag) sind normal und werden nicht markiert.
2. **Neustarts verschmelzen**: `restart` verwerfen. Folgt auf ein `shutdown` (oder ohne `shutdown` auf die letzte Aktivität – Absturz) innerhalb `restartWindowMin` bzw. `updateRestartWindowMin` ein `boot` desselben Geräts, werden **beide** Ereignisse entfernt; das Laptop-Intervall läuft durch. Bei Absturz Hinweis `crash_restart`.
3. **Waisen verwerfen**: `shutdown` ohne vorheriges `boot` desselben Geräts, `net_lost` ohne offenes Netz-Intervall, Aktiv-Spannen eines Desktops ohne `boot`.
4. **Laptop-Intervalle**: `boot` → `shutdown + shutdownBonusMin`. Ohne `shutdown` (Absturz ohne Neustart, Stromausfall, läuft noch): Ende = Ende der letzten Aktiv-Spanne, ohne Bonus; Warnung `no_end`, sobald die Sitzung nicht mehr `open` ist.
5. **Desktop-Aktivität**: Innerhalb eines Laptop-Intervalls sind Lücken zwischen Aktiv-Spannen ≥ `standbyBreakMin` Pausen (`standby`). Lücken ≥ `maxStandbyMin` beenden das Intervall bei der letzten Aktivität (ohne Bonus, Warnung `gap_end`) und öffnen ein neues bei der nächsten Aktivität (`startSource: 'resume'`).
6. **Netz-Intervalle**: `net_connected` → `net_lost`, über alle Geräte; Lücken ≤ `netGraceMin` zusammenführen. Fehlt `net_lost`, endet das Intervall am Ende der letzten Aktiv-Spanne desselben Geräts (Warnung `no_end`, wenn danach nichts mehr kommt).
7. **Manuelle Intervalle**: `manual_start → manual_end` bildet ein eigenes Intervall (Quelle `user`). Bei mehreren `manual_start` bzw. `manual_end` für dieselbe Sitzung gewinnt das mit dem jüngsten `createdAt`. Ein offenes `manual_start` ohne Ende und ohne andere Aktivität → `no_end`, Arbeitszeit 0. `manual_work` (mit `endTs`) zählt als Arbeit und hebt Pausen in diesem Zeitraum auf.
8. **Sitzungen bilden**: Anwesenheit = Vereinigung aller Intervalle aus 4–7. Lücken > `maxBreakMin` trennen Sitzungen. `manual_start`/`manual_end` gehören zur Sitzung, deren Zeitraum sie berühren oder die ihnen am nächsten liegt; dort überschreiben und sperren sie Beginn bzw. Ende, Intervalle werden darauf zugeschnitten.
9. **Pausen**: Enthält eine Sitzung ein Desktop-Intervall, bestimmen **dessen** Aktivitätslücken die Pausen zwischen erster und letzter Desktop-Aktivität; Handy-Netz zählt dann nur für Beginn und Ende. Sonst sind Netz-Lücken > `netGraceMin` Pausen (`net_gap`). Dazu kommen `manual_break`; `manual_work` hebt Pausen auf. `countsLegally` = Dauer ≥ `legalBreakPieceMin`.
10. **Höchstdauer**: Sitzung länger als `maxSessionH` → bei Start + 16 h abschneiden, `session_capped`.
11. **Pausenprüfung pro Sitzung**: `workMinutes` = Ende − Start − alle Pausen. Ist sie > 6 h (bzw. > 9 h) und die Summe anrechenbarer Pausen < 30 (bzw. 45) min, wird die Differenz als `breakTopUpMin` ausgewiesen, Warnung `break_violation`. Liegen mehr als `maxContinuousH` Arbeitszeit ohne anrechenbare Pause am Stück, zusätzlich `break_placement`. Tatsächliche Zeiten bleiben unverändert. Warnungen einer Sitzung stehen an jedem Tag, den sie berührt.
12. **Bestätigung**: Die erste Sitzung eines Tages mit Sollzeit zählt automatisch. Jede weitere Sitzung (`second_session`) und jede Sitzung an einem Tag mit Sollzeit 0 (`non_workday`) braucht `session_confirm` mit `refEventId` = `Session.id`; bis dahin zählt sie in `pendingMinutes`, nach `session_reject` gar nicht. Eine Sitzung über Mitternacht braucht nur eine Bestätigung; als „erste Sitzung eines Tages“ zählen nur Sitzungen, die an diesem Tag beginnen.
13. **Auf Tage aufteilen**: Über Mitternacht in der Zeitzone der Sitzung (`tz` des Start-Ereignisses) aufteilen; Dauern immer aus UTC-Differenzen (23-h- und 25-h-Tage). Die Auffüllung wird vom Sitzungsende **rückwärts** von der Arbeitszeit abgezogen, ggf. über die Tagesgrenze; `netMinutes` ist nie negativ.
14. **Status**: `open`, solange die letzte Sitzung kein Ende hat und ihre letzte Aktivität jünger als `maxStandbyMin` ist. Tage mit einer Warnung aus der Prüf-Gruppe sind `unchecked`; nach Bestätigung durch den Nutzer `confirmed`; sonst `auto`. `corrected = true`, wenn ein `manual_*`-Ereignis mit `createdAt − ts` > 5 min (nachträglich) den Tag beeinflusst – Live-Klicks auf Start/Stopp sind keine Korrektur.
15. **Hinweise**: `over_10h` (tatsächliche Arbeitszeit des Tages > 10 h, vor Auffüllung), `rest_under_11h` (Abstand zum Ende der vorherigen Sitzung), `sunday_or_holiday` (§ 9 ArbZG, Feiertage nach Bundesland), `avg_over_8h` (Durchschnitt über 24 Wochen).
16. **Abwesenheiten**: `absenceMinutes` aus `absences`; Saldo = Σ(netMinutes + absenceMinutes) − Σ targetMinutes. Feiertage setzen `targetMinutes` = 0.

## Testfälle Regelwerk

Jeder Fall wird ein Vitest-Test; die Fixtures liegen als JSON in `packages/rules/test/fixtures/` und enthalten **alle** Felder der Erwartung. Claude Code ändert Erwartungen nie ohne Rückfrage.

**Standard, wenn nicht anders angegeben**: Zeitzone Europe/Berlin, Bundesland Berlin, Datum Mi 14.10.2026 (Soll 8 h), ein Laptop `L`, Handy `H`, Standard-`config`, `now` = Folgetag 09:00. Der Laptop ist zwischen `boot` und `shutdown` durchgehend aktiv (eine Aktiv-Spanne), automatische Ereignisse haben `createdAt` = `ts` (bei `boot` + 5 min), manuelle mit „nachtr.“ sind nachträglich erfasst.

**Fixture-Format**

```ts
interface Scenario {
  name: string;
  now?: string;                       // Standard: Folgetag 09:00 lokal
  config?: Partial<RulesConfig>;
  state?: string;                     // Bundesland, Standard 'BE'
  absences?: Absence[];
  events: Array<[localTime: string, type: EventType, opts?: { device?: 'L' | 'H' | string; date?: string; endTs?: string; createdAt?: string; refEventId?: string }]>;
  spans?: Array<[device: string, from: string, to: string]>;   // fehlt → Standard-Spanne boot..shutdown
  expect: Array<{ date: string; start?: string; end?: string; breaksMin?: number; workMin: number; topUpMin: number; netMin: number; pendingMin?: number; status: WorkDay['status']; corrected?: boolean; warnings: Warning[] }>;
}
// Lokale Zeiten werden mit `tz` nach UTC umgerechnet; nicht existierende Zeiten (Zeitumstellung) sind ein Fixture-Fehler.
```

„BV“ = `break_violation`, „BP“ = `break_placement`. Zeiten als h:mm.

| # | Ereignisse | Beginn–Ende | Pause | Arbeit | Auff. | Netto | Status / Warnungen |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | boot 08:00, shutdown 17:00 | 08:00–17:05 | 0 | 9:05 | 0:45 | 8:20 | `unchecked`; BV, BP |
| 2 | Laptop lief < 5 min: shutdown 08:03 (kein `boot`) | – | – | – | – | – | kein Arbeitstag |
| 3 | boot 08:00, shutdown 12:00, boot 12:02, shutdown 17:00 | 08:00–17:05 | 0 | 9:05 | 0:45 | 8:20 | Neustart verschmolzen; `unchecked`; BV, BP |
| 4 | H net\_connected 07:50; boot 08:10; shutdown 16:30; H net\_lost 16:32 | 07:50–16:35 | 0 | 8:45 | 0:30 | 8:15 | `unchecked`; BV, BP |
| 5 | nur H: net 08:00–12:00, 12:07–16:00 | 08:00–16:00 | 0 (7 min überbrückt) | 8:00 | 0:30 | 7:30 | `unchecked`; BV, BP |
| 6 | nur H: net 08:00–12:00, 12:40–17:00 | 08:00–17:00 | 0:40 | 8:20 | 0 | 8:20 | `auto` |
| 7 | boot 08:00; L net 08:01–12:00, 12:40–17:00; shutdown 17:00 | 08:00–17:05 | 0 (Laptop durchgehend aktiv) | 9:05 | 0:45 | 8:20 | wie Fall 1 |
| 8 | boot 08:00, manual\_start 07:30 (nachtr.), shutdown 17:00 | 07:30–17:05 | 0 | 9:35 | 0:45 | 8:50 | `unchecked`, corrected; BV, BP |
| 9 | H net\_connected 08:00, manual\_end 16:00 (nachtr.), H net\_lost 17:00 | 08:00–16:00 | 0 | 8:00 | 0:30 | 7:30 | `unchecked`, corrected; BV, BP |
| 10 | boot 08:00, Aktiv bis 18:12, kein shutdown | 08:00–18:12 | 0 | 10:12 | 0:45 | 9:27 | `unchecked`; `no_end`, BV, BP, `over_10h` |
| 10b | wie 10, `now` = selber Tag 18:30 | 08:00–offen | – | – | – | – | `open` |
| 11 | boot 22:00, shutdown Do 01:00 | Mi 22:00–24:00 / Do 00:00–01:05 | 0 | 2:00 / 1:05 | 0 | 2:00 / 1:05 | beide `auto` |
| 12 | boot 08:00, shutdown 14:10 | 08:00–14:15 | 0 | 6:15 | 0:30 | 5:45 | `unchecked`; BV, BP |
| 13 | Di 13.10.: boot 13:00, shutdown 21:55; Mi: boot 07:30, shutdown 16:00 | Di 13:00–22:00 / Mi 07:30–16:05 | 0 / 0 | 9:00 / 8:35 | 0:30 / 0:30 | 8:30 / 8:05 | beide `unchecked`; BV, BP; Mi zusätzlich `rest_under_11h` |
| 14 | boot 08:00; Aktiv 08:00–12:00, 13:00–17:00 (Deckel zu); shutdown 17:00 | 08:00–17:05 | 1:00 (standby) | 8:05 | 0 | 8:05 | `auto` |
| 15 | Sa 24.10. boot 22:00; So 25.10. shutdown 05:00 (Winterzeit); session\_confirm | Sa 22:00–24:00 / So 00:00–05:05 | 0 | 2:00 / 6:05 | 0 / 0:30 | 2:00 / 5:35 | beide `unchecked`; BV, BP; So `sunday_or_holiday` |
| 16 | Sa 28.03. boot 22:00; So 29.03. shutdown 05:00 (Sommerzeit); session\_confirm | Sa 22:00–24:00 / So 00:00–05:05 | 0 | 2:00 / 4:05 | 0 / 0:30 | 2:00 / 3:35 | beide `unchecked`; BV, BP; So `sunday_or_holiday` |
| 17 | boot 08:00, Aktiv bis 18:00; Do Aktiv ab 08:00 (Aufwachen, kein `boot`), shutdown Do 17:00 | Mi 08:00–18:00 / Do 08:00–17:05 | 0 / 0 | 10:00 / 9:05 | 0:45 / 0:45 | 9:15 / 8:20 | beide `unchecked`; Mi `gap_end`, BV, BP; Do BV, BP |
| 18 | boot 08:00, shutdown 17:00, boot 21:00, shutdown 23:00 | S1 08:00–17:05, S2 21:00–23:05 | 0 | 9:05 (+2:05 offen) | 0:45 | 8:20, pending 2:05 | `unchecked`; BV, BP, `second_session` |
| 18b | wie 18 + session\_confirm für S2 | wie 18 | 0 | 11:10 | 0:45 | 10:25 | `unchecked`; BV, BP, `over_10h` |
| 19 | nur H: net 08:00–12:00, 12:12–17:00 | 08:00–17:00 | 0:12 (nicht anrechenbar) | 8:48 | 0:30 | 8:18 | `unchecked`; BV, BP |
| 20 | H net\_lost 09:00 (allein) | – | – | – | – | – | kein Arbeitstag |
| 21 | L: boot 08:00, shutdown 12:00, boot 12:03, shutdown 17:00; H net 08:30–16:00 | 08:00–17:05 | 0 | 9:05 | 0:45 | 8:20 | `unchecked`; BV, BP |
| 22 | So 18.10.: boot 10:00, shutdown 12:00 | 10:00–12:05 | 0 | 0 (+2:05 offen) | 0 | 0, pending 2:05 | `unchecked`; `non_workday`, `sunday_or_holiday` |
| 23 | Sa 31.10. boot 22:00; So 01.11. shutdown 01:00; session\_confirm | Sa 22:00–24:00 / So 00:00–01:05 | 0 | 2:00 / 1:05 | 0 | 2:00 / 1:05 | beide `confirmed`; So `sunday_or_holiday`; Monatsgrenze |
| 24 | boot 08:00 mit `createdAt` Do 14:00 (rückdatiert), shutdown 17:00 | 08:00–17:05 | 0 | 9:05 | 0:45 | 8:20 | `unchecked`; `late_event`, BV, BP |
| 24b | Fr 16.10.: boot 08:00, shutdown 17:00 (`receivedAt` Mo 08:05) | 08:00–17:05 | 0 | 9:05 | 0:45 | 8:20 | wie Fall 1, **kein** `late_event` |
| 25 | keine Ereignisse; Abwesenheit `vacation` 480 min | – | – | 0 | 0 | 0 | `auto`; absence 480, Saldo 0 |
| 26 | manual\_start 09:00, manual\_end 13:00 (live) | 09:00–13:00 | 0 | 4:00 | 0 | 4:00 | `auto`, nicht corrected |
| 27 | manual\_start 09:00 (live), sonst nichts | 09:00–? | – | 0 | 0 | 0 | `unchecked`; `no_end` |
| 28 | boot 15:00, shutdown Do 00:00 | Mi 15:00–24:00 / Do 00:00–00:05 | 0 | 9:00 / 0:05 | 0:40 / 0:05 | 8:20 / 0:00 | beide `unchecked`; BV, BP (Auffüllung rückwärts, Netto nie negativ) |
| 29 | boot 08:00, Aktiv bis 12:00; Absturz; boot 12:03, shutdown 17:00 | 08:00–17:05 | 0 (3 min) | 9:05 | 0:45 | 8:20 | `unchecked`; BV, BP, `crash_restart` |
| 30 | nur H: net\_connected 08:00, H aktiv bis 15:45, kein net\_lost | 08:00–15:45 | 0 | 7:45 | 0:30 | 7:15 | `unchecked`; `no_end`, BV, BP |
| 31 | wie 14 + manual\_work 12:00–13:00 (nachtr., Meeting ohne Laptop) | 08:00–17:05 | 0 | 9:05 | 0:45 | 8:20 | `unchecked`, corrected; BV, BP |
| 32 | boot 06:00, shutdown 23:00 | 06:00–22:00 (gekappt) | 0 | 16:00 | 0:45 | 15:15 | `unchecked`; `session_capped`, BV, BP, `over_10h` |
| 33 | Property-Tests (fast-check) über alle Fälle | – | – | – | – | – | Reihenfolge der Eingabe egal; `netMin` ≥ 0 je Tag; Netto ≤ Arbeit; keine Sitzung > 16 h |

## Datenbank & API (`apps/backend`)

Der Server speichert Rohereignisse unveränderlich und berechnet Arbeitstage mit demselben Regelwerk wie die Clients. Online ist `/days` maßgeblich; Clients rechnen lokal nur für die Offline-Anzeige.

**Tabellen (PostgreSQL)**

| Tabelle | Spalten |
| --- | --- |
| `organizations` | id, name, plan (`private` / `company`), rules\_config (jsonb), rules\_config\_version, retention\_years, fingerprint\_salt, created\_at |
| `users` | id, org\_id (nullable), email, email\_verified\_at, password\_hash, totp\_secret (Pflicht für `manager`/`admin`), name, timezone, state (Bundesland), role (`user` / `manager` / `admin`), team\_id, settings (jsonb), deleted\_at |
| `teams` | id, org\_id, name, manager\_id |
| `target_hours` | user\_id, weekday 0–6, minutes, valid\_from (Teilzeit-Wechsel) |
| `absences` | id, user\_id, date, kind (`vacation` / `sick` / `holiday` / `other`), minutes, note |
| `holidays` | state, date, name (Feiertagskalender je Bundesland) |
| `devices` | id, user\_id, kind (`desktop` / `mobile`), os, name, push\_token, last\_seen\_at, revoked\_at |
| `work_networks` | id, user\_id oder org\_id, label, kind (`ssid` / `fingerprint` / `geofence`), ssid, bssid\_hmac, fingerprint\_hmac, lat/lng/radius nur bei `geofence` |
| `events` | **PK (user\_id, id)**; id (UUID vom Client), device\_id, type, source, ts, end\_ts, tz, network\_id, ref\_event\_id, created\_at, received\_at, flags — nur Insert |
| `presence_spans` | id, user\_id, device\_id, start, end, open — der Client verlängert die offene Spanne per Upsert (statt \~250 Heartbeat-Ereignissen pro Tag) |
| `work_days` | user\_id, date, sessions (jsonb), work\_min, net\_min, pending\_min, absence\_min, target\_min, status, corrected, warnings (jsonb), rules\_config\_version, computed\_at — Cache, jederzeit neu berechenbar |
| `corrections` | id, user\_id, date, event\_id (das erzeugte `manual_*`-Ereignis), field, old\_value, new\_value, reason, author\_id, created\_at |
| `approvals` | user\_id, month, status (`submitted` / `approved` / `rejected`), snapshot (jsonb der `work_days`), rules\_config\_version, approver\_id, comment, decided\_at |
| `refresh_tokens` | id, device\_id, token\_hash, family\_id, expires\_at, used\_at, revoked\_at |
| `audit_log` | id, org\_id, actor\_id, action, target, payload (jsonb), created\_at |

**Regeln für Daten**

- Der Server setzt `user_id` und `device_id` **immer aus dem Token** und ignoriert Werte im Request. Fremde UUIDs können dadurch keine Daten anderer Nutzer berühren.
- Korrekturen sind Ereignisse: `PATCH /days/:date` legt das passende `manual_*`-Ereignis **und** eine `corrections`-Zeile mit Begründung an. Offline-Korrekturen kommen als normale Ereignisse; es gibt keine Schreibkonflikte.
- `received_at` ist nur Information. Rückdatierung erkennt das Regelwerk über `created_at − ts`. Vollständiger Manipulationsschutz ist ohne Geräte-Attestierung nicht möglich – die App macht Nachträge sichtbar, verhindert sie aber nicht.
- Netzwerk-Kennungen werden nur als HMAC mit organisations- bzw. nutzerspezifischem Salt gespeichert; ein einfacher Hash einer MAC-Adresse wäre per Durchprobieren umkehrbar.
- Freigegebene Monate werden nicht neu berechnet: Angezeigt wird der `snapshot`. Änderungen an `rules_config` erhöhen `rules_config_version` und wirken nur auf nicht freigegebene Tage.
- **Löschkonzept nach Plan**: `private` – Kontolöschung löscht sofort alles (keine Aufbewahrungspflicht). `company` – sofortige Anonymisierung, Löschung nach `retention_years` (Standard 2 Jahre nach § 16 Abs. 2 ArbZG, für Lohnunterlagen bis 6 Jahre einstellbar). Automatische Löschung abgelaufener Daten per nächtlichem Job.
- Manager-Ansicht liefert pro Tag nur Beginn, Ende, Pausensumme, Auffüllung, Netto, Status und Warnungen – keine `sessions`-Details, Quellen, Ereignisse oder Geräte.

**Endpunkte (REST, JSON, `/api/v1`)**

| Methode | Pfad | Zweck |
| --- | --- | --- |
| POST | `/auth/register`, `/auth/verify`, `/auth/login`, `/auth/refresh`, `/auth/logout` | Konto, E-Mail-Bestätigung, Tokens |
| POST | `/auth/password-reset`, `/auth/password-reset/confirm`, `/auth/totp/setup`, `/auth/totp/verify` | Passwort zurücksetzen, Zwei-Faktor |
| POST / DELETE | `/devices`, `/devices/:id` | Gerät registrieren, sperren (setzt `revoked_at`) |
| POST | `/events/batch` | bis 500 Ereignisse, max. 256 KB; idempotent über (user\_id, id) |
| PUT | `/presence` | offene Aktiv-Spanne anlegen bzw. verlängern, abgeschlossene Spannen nachreichen |
| GET | `/events?since=<cursor>`, `/presence?since=` | eigene Daten aller Geräte, für lokale Offline-Berechnung |
| GET | `/days?from=&to=` | berechnete Arbeitstage (bei freigegebenen Monaten der Snapshot) |
| PATCH | `/days/:date` | Korrektur (erzeugt Ereignis + `corrections`); `reason` Pflicht bei Firmenkonten |
| POST | `/days/:date/confirm`, `/sessions/:id/confirm`, `/sessions/:id/reject` | Tag bzw. Sitzung (per Start-Ereignis-ID) bestätigen oder verwerfen |
| GET / PUT | `/settings`, `/networks`, `/target-hours`, `/absences` | Einstellungen, Arbeitsnetze, Sollzeiten, Abwesenheiten |
| GET | `/export?from=&to=&format=csv\|pdf` | Export |
| GET | `/me/export`, DELETE `/me` | Datenauskunft (Art. 15/20 DSGVO), Kontolöschung (Art. 17) |
| GET | `/status` | aktueller Zustand für Tray und Widget |
| — | `/org/*` | Firmenversion, siehe unten |

**`settings` (jsonb, per Zod validiert)**: `triggers` { boot, shutdown, network, geofence, standbyBreaks: boolean }, `notifications` { forgotEnd, over10h, breakViolation, confirmDay: boolean, quietHours: { from, to } }, `workdays` (abweichend von Soll), `localOnly` (Privatversion ohne Sync).

**CSV-Export** (DATEV-tauglich vorbereitet): Personalnummer, Datum, Beginn, Ende, Pause (min), davon aufgefüllt (min), Netto (min), Abwesenheit, Status, korrigiert (ja/nein), Warnungen.

**Sicherheit**

- Passwort-Hashing mit Argon2id; Access-Token 15 min; Refresh-Token 30 Tage, gerätegebunden, bei jeder Nutzung rotiert; Wiederverwendung eines alten Tokens sperrt die ganze Token-Familie.
- Zwei-Faktor (TOTP) Pflicht für `manager` und `admin`, bis SSO eingerichtet ist.
- Rate-Limits: `/auth/*` 10/min je IP und Konto; `/events/batch` und `/presence` 60/min je Gerät; Payload-Limit 256 KB.
- Mandantentrennung doppelt: `org_id`-Prüfung im Fastify-Hook **und** PostgreSQL Row-Level-Security; Tests für beides.
- Alle Admin-Aktionen ins `audit_log`. SSO (OIDC/SAML) für Firmenkunden in Phase 6.

## Desktop-Client (`apps/desktop`)

Der Rust-Kern erzeugt Ereignisse und Aktiv-Spannen und schreibt sie sofort in SQLite; die React-Oberfläche im Tray zeigt nur an und sendet manuelle Ereignisse. Der Client läuft als normale Tray-App im Nutzerkontext, **nicht** als Windows-Dienst – nur so erscheinen Berechtigungsdialoge, Benachrichtigungen und Sperr-Ereignisse.

**Gemeinsam für beide Systeme**

- Autostart bei Anmeldung (Tauri-Plugin `autostart`), läuft nur als Tray-Icon.
- Nach 5 min Laufzeit `boot` mit der echten Einschaltzeit als `ts`. Aufwachen aus Standby **oder Ruhezustand** erzeugt kein `boot`, sondern setzt nur die Aktiv-Spanne fort.
- **Aktiv-Spanne**: Gerät wach und Bildschirm entsperrt. Sie endet bei Standby, Deckel zu und Bildschirmsperre und beginnt neu beim Aufwachen bzw. Entsperren. Die offene Spanne wird alle 2 min lokal verlängert und beim Sync per `PUT /presence` übertragen. Lücken ≥ 15 min wertet das Regelwerk als Pause, ≥ 180 min als Sitzungsende.
- Beim Herunterfahren `shutdown` **synchron** in SQLite schreiben, danach einen Sende-Versuch mit 2 s Timeout (Fire-and-forget); klappt er nicht, geht das Ereignis beim nächsten Start raus.
- Logout ist kein Herunterfahren und erzeugt kein Ereignis.
- **Arbeitsnetz** erkennen über Netzwerk-Kennung (DNS-Suffix, Gateway-MAC, Subnetz – als HMAC) **oder** SSID/BSSID. Die Kennung braucht keine Standortberechtigung und deckt LAN und Dockingstation ab; sie ist der Standard. Hinweis: Sie ist mit einem eigenen Router fälschbar – für Firmen bewusst offen benannt.
- Ereignisse tragen `tz` (aktuelle Systemzeitzone) und `source`.
- Sync alle 2 min und bei Netzwerkwechsel; Warteschlange mit exponentiellem Backoff.
- Automatische Updates über den Tauri-Updater mit signierten Paketen.

| Thema | Windows | macOS |
| --- | --- | --- |
| Echte Startzeit | Kernel-Boot-Ereignis 27, `BootType`: 0 = Kaltstart/Neustart → `boot`; 1 = Schnellstart → `boot` mit Zeitpunkt dieses Ereignisses (nicht Kernel-Uptime); 2 = Aufwachen aus Ruhezustand → **kein** `boot`, nur Aktiv-Spanne fortsetzen (Windows wechselt nach langem Standby oft automatisch in den Ruhezustand) | `sysctl kern.boottime` |
| Herunterfahren erkennen | Verstecktes Fenster, `WM_QUERYENDSESSION` / `WM_ENDSESSION`. Ist `lParam & ENDSESSION_LOGOFF` gesetzt → Logout → **kein** Ereignis | `applicationShouldTerminate` mit Grund aus dem Quit-AppleEvent (`kEventParamReason`): `kAEShutDown` → `shutdown`, `kAERestart` → `restart`, `kAEReallyLogOut` → nichts. Undokumentierte, aber bewährte Technik; Fallback: `NSWorkspace.willPowerOffNotification` + Abgleich der Boot-Zeit beim nächsten Start. Tauri kapselt den App-Delegate → Override über `objc2` |
| Neustart / Absturz unterscheiden | Beim nächsten Start: Ereignis 1074 (User32) → Neustart, lokales `shutdown` in `restart` umwandeln; Grund „Betriebssystem: Upgrade“ → Update-Neustart (Fenster 60 min). Ereignis 6008 → unerwartetes Herunterfahren (Absturz). Ohne Eintrag greift `restartWindowMin` | direkt über `kAERestart`; Absturz = kein `shutdown` vor neuem `boot` |
| Sperre / Standby | `WTSRegisterSessionNotification` (Sperren/Entsperren), `PBT_APMSUSPEND` / `PBT_APMRESUMEAUTOMATIC` | `com.apple.screenIsLocked` / `screenIsUnlocked`, `NSWorkspace.willSleepNotification` / `didWakeNotification` |
| Netzwechsel | `NotifyIpInterfaceChange` (immer, ohne Berechtigung). WLAN-Name: Microsoft empfiehlt `WlanConnectionProfileDetails.GetConnectedSsid`; `WlanRegisterNotification` ist seit 24H2 nur mit Quelle `WLAN_NOTIFICATION_SOURCE_MSM` standortgebunden. In Phase 3b prüfen, was ohne Freigabe geht | `NWPathMonitor` (immer) + CoreWLAN (SSID und BSSID nur mit Ortungsdiensten, seit macOS 14) |
| Rust-Anbindung | Crate `windows` | Crate `objc2` + passende Framework-Crates |

Berechtigungen und API-Verhalten ändern sich mit OS-Updates; Claude Code prüft sie bei der Umsetzung gegen die aktuelle Herstellerdokumentation.

**Einrichtung (Onboarding)**: Konto anmelden → Arbeitsnetz hinterlegen per Knopf „aktuelles Netz übernehmen“ (Netzwerk-Kennung sofort; optional WLAN-Name mit Standort-Dialog aus der Nutzeraktion heraus) → Sollzeiten und Bundesland → Erklärung „Deckel zu / Sperre ab 15 min = Pause“ → Testlauf mit Anzeige der erkannten Signale.

**Tray-Oberfläche**: Status mit laufender Zeit, Start/Stopp, Tagesprotokoll mit Quelle je Ereignis, erkannte Pausen mit „war Arbeit“ (erzeugt `manual_work`), „Zu prüfen“-Liste, Einstellungen, Benachrichtigungen („Ende vergessen?“, „über 10 h“, „Pause fehlt“) mit Ruhezeiten. Tastaturbedienbar, Screenreader-Labels, Kontrast nach WCAG 2.1 AA.

## Mobile-App (`apps/mobile`)

Die Handy-App liefert Netz-, Geofence- und manuelle Ereignisse sowie Aktiv-Spannen, solange das Handy im Arbeitsnetz ist; die Hintergrund-Erkennung wird pro System als eigenes natives Modul (Expo Modules API, Kotlin/Swift) gebaut. Das Handy ist ein Zusatzsignal – wer einen Laptop nutzt, braucht es für korrekte Zeiten nicht. Ohne Laptop ist das Arbeitsende auf iOS unschärfer; das wird in der App offen gesagt.

| Thema | Android | iOS |
| --- | --- | --- |
| Arbeitsnetz erkennen (Standard) | `registerNetworkCallback` mit `PendingIntent` weckt die App auch, wenn sie beendet ist. Erkennung über **Netzwerk-Kennung aus `LinkProperties`** (DNS-Suffix, DNS-Server, Gateway, Subnetz) – **ohne Standortberechtigung** | App Intent „Arbeitsnetz verbunden“, ausgelöst durch Kurzbefehle-Automation „WLAN“ (läuft seit iOS 17 ohne Rückfrage). Ob sich Gateway/DNS über `NWPath` ohne Standort lesen lassen, in Phase 5 prüfen |
| WLAN-Name (optional) | nur wenn der Nutzer es aktiviert: `ACCESS_FINE_LOCATION`; im Hintergrund zusätzlich `ACCESS_BACKGROUND_LOCATION` – dann Play-Deklaration nötig. Standard: aus | `NEHotspotNetwork.fetchCurrent` (Standortberechtigung + Entitlement) |
| Trennen erkennen | Netzwerk-Callback; zusätzlich prüft WorkManager alle 15 min und erzeugt `net_lost`, wenn das Netz weg ist | Kurzbefehle haben **keinen** Trennen-Auslöser (Apple-Doku: nur „beim Verbinden“). Ende über Geofence-Verlassen (opt-in, Region \~150 m) oder den Laptop. Geofence mit `CLMonitor`; da dieser laut Entwicklerberichten seltener weckt, Fallback `CLCircularRegion` |
| Aktiv-Spanne | WorkManager-Check verlängert die Spanne, solange das Arbeitsnetz verbunden ist | bei App-Start, Widget-Refresh und Geofence-Ereignissen |
| Akku | Hinweis auf Hersteller-Akkusparmodi (Samsung, Xiaomi u. a.) mit Link zur Einstellung | – |
| Store-Review | Ohne WLAN-Name kein Hintergrund-Standort → keine Standort-Deklaration. Neue private Entwicklerkonten brauchen vor der Veröffentlichung einen geschlossenen Test mit mind. 12 Testern über 14 Tage | Geofence braucht „Immer“-Standort mit klarer Zweckangabe; relevant sind Review-Richtlinien 5.1.1, 5.1.2, 5.1.5 und 2.5.4 – vor Phase 5 gegen die aktuelle Fassung prüfen |
| Widget | Jetpack Glance | WidgetKit |
| Push | Firebase Cloud Messaging | APNs (direkt oder über FCM) |

Geofence-Ereignisse werden als `net_connected` / `net_lost` mit `source: 'geofence'` gespeichert; die Quelle bleibt im Protokoll sichtbar. Gespeichert wird nur „betreten/verlassen“, nie Koordinaten.

**Einrichtungsassistent**: Zweck erklären → Arbeitsnetz übernehmen (Netzwerk-Kennung, keine Berechtigung nötig) → optional WLAN-Name bzw. Geofence mit Begründung vor der Abfrage → iOS: Kurzbefehl-Automation Schritt für Schritt; Android: Akkuoptimierung → Testsignal anzeigen. Ohne jede Berechtigung funktioniert die App mit manuellem Start/Stopp.

**Screens**: Heute (Status, Start/Stopp), Tagesprotokoll mit Korrektur und „war Arbeit“ für erkannte Pausen, „Zu prüfen“, Übersicht Woche/Monat mit Saldo, Abwesenheiten, Einstellungen, Einrichtungsassistent. Barrierefrei nach WCAG 2.1 AA (Screenreader, dynamische Schriftgröße, Kontrast).

## Firmenversion (`apps/admin`)

Privat- und Firmenversion sind dieselbe App; ein Konto mit `org_id` schaltet die Firmenfunktionen frei.

| Rolle | Darf |
| --- | --- |
| `user` | eigene Zeiten sehen, korrigieren (mit Begründung), Abwesenheiten eintragen, Monat einreichen |
| `manager` | je Tag des eigenen Teams nur Beginn, Ende, Pausensumme, Auffüllung, Netto, Status und Warnungen; Monate freigeben oder zurückweisen mit Kommentar |
| `admin` | Nutzer einladen, Teams und Rollen, Firmen-Arbeitsnetze, Sollzeiten, Regelwerk-Parameter (z. B. `shutdownBonusMin`, `standbyBreakMin`), Aufbewahrungsfrist, Export, SSO |

- Firmen-Arbeitsnetze (`work_networks.org_id`) gelten automatisch für alle Mitglieder; Standard ist die Netzwerk-Kennung.
- Nach Freigabe ist der Monat gesperrt und als Snapshot gespeichert; Korrekturen nur noch durch Admin, im `audit_log` protokolliert.
- Manager sehen nie Sitzungsdetails, Quellen, Rohereignisse oder Gerätedaten (Datensparsamkeit).
- Endpunkte unter `/api/v1/org`: `invite`, `members`, `teams`, `networks`, `config`, `approvals`, `export`, `audit`.
- Zugriffsprüfung zentral als Fastify-Hook plus Row-Level-Security, mit Tests je Rolle und für Mandantentrennung.
- Zwei-Faktor (TOTP) Pflicht für Manager und Admins; SSO über OIDC (Microsoft Entra ID, Google) und SAML.

## Betrieb, Recht & Kosten

Diese Punkte gehören vor den ersten echten Nutzer, nicht ans Ende.

**Betrieb**

| Thema | Festlegung |
| --- | --- |
| Hosting | EU-Rechenzentrum. Verwaltete PostgreSQL mit Point-in-Time-Recovery z. B. bei AWS RDS (Frankfurt), Scaleway oder Ubicloud; Hetzner selbst bietet keine verwaltete PostgreSQL. Tägliches Backup, 30 Tage Aufbewahrung, Restore monatlich testen |
| CI/CD | GitHub Actions: Lint, Typecheck, Tests bei jedem Push; Backend als Container; Desktop-Builds für Windows und macOS als Release-Artefakte |
| Monitoring | strukturierte Logs ohne personenbezogene Inhalte, Fehler- und Absturzmeldungen (z. B. Sentry, EU-Region), Uptime-Check auf `/health` |
| Hintergrund-Jobs | nächtliche Löschung abgelaufener Daten, Erinnerungs-Push, Neuberechnung nach Regelwerk-Änderung |
| Updates | Tauri-Updater mit signierten Paketen; Mobile über die Stores |
| Push | FCM (Android) und APNs (iOS) |

**Recht & Datenschutz** (fachliche Einordnung, keine Rechtsberatung)

- Aufzeichnungspflicht nach BAG-Beschluss vom 13.09.2022 (1 ABR 22/21) aus § 3 Abs. 2 Nr. 1 ArbSchG. Der Referentenentwurf zum ArbZG (Juni 2026, interne Arbeitsfassung, nicht beschlossen) sieht elektronische, taggleiche Erfassung von Beginn, Ende und Dauer vor, mit Übergangsfristen und Ausnahme für Betriebe bis 10 Beschäftigte. Die App erfüllt das; Stand vor Release erneut prüfen.
- Tatsächliche Zeiten werden immer unverändert gespeichert; Pausenauffüllung ist nur ein ausgewiesener Abzug mit Warnung.
- Löschkonzept nach Plan: Privatkonten sofort vollständig löschbar; Firmenkonten mind. 2 Jahre (§ 16 Abs. 2 ArbZG), Lohnunterlagen bis 6 Jahre, danach automatisch.
- Firmenkunden: Auftragsverarbeitungsvertrag (Art. 28 DSGVO), Vorlage für Datenschutz-Folgenabschätzung (Art. 35), Hinweis auf Mitbestimmung des Betriebsrats (§ 87 Abs. 1 Nr. 6 und 7 BetrVG), Muster-Betriebsvereinbarung.
- Netzwerk-Kennungen sind mit Nutzerbezug personenbezogen → nur als HMAC speichern.
- Betroffenenrechte: Auskunft, Datenexport, Löschung, Berichtigung über die App.
- Barrierefreiheit: Das BFSG gilt für Apps im Verbrauchergeschäft, Kleinstunternehmen (unter 10 Beschäftigte, max. 2 Mio. € Umsatz) sind bei Dienstleistungen ausgenommen. Die App wird trotzdem nach WCAG 2.1 AA gebaut, um beim Wachstum nicht nachrüsten zu müssen.

**Laufende Kosten (Richtwerte)**

| Posten | Kosten |
| --- | --- |
| Apple Developer Program (Signierung, Notarisierung, App Store) | ca. 99 €/Jahr |
| Windows-Code-Signing: Azure Trusted Signing (alternativ OV-Zertifikat mit Hardware-Token, ca. 200–500 €/Jahr) | ca. 10 $/Monat |
| Google Play Entwicklerkonto | einmalig 25 $ |
| Hosting, Datenbank, Backups, Monitoring (Start) | ca. 50–150 €/Monat |

## Phasen & Akzeptanzkriterien

Jede Phase endet lauffähig und getestet; Claude Code bekommt immer genau eine Phase. Punkte mit 👤 kann Claude Code nicht selbst erfüllen (echte Hardware, Zertifikate, Store-Konten) – Claude Code bereitet sie als Checkliste vor, du prüfst sie.

**Phase 0 – Grundgerüst**

- [ ] Monorepo mit pnpm, Turborepo, TypeScript strict, ESLint, Prettier, Vitest
- [ ] GitHub Actions: Lint, Typecheck, Tests bei jedem Push
- [ ] `CLAUDE.md`, `.env.example`, README mit Startanleitung

**Phase 1 – Regelwerk**

- [ ] `packages/rules` implementiert `computeDays` nach Algorithmus oben, ohne Laufzeit-Abhängigkeiten
- [ ] Alle Testfälle 1–33 als JSON-Fixtures mit vollständigen Erwartungen; alle grün; Testabdeckung des Pakets ≥ 95 %
- [ ] Property-Tests mit fast-check: Reihenfolge egal; Netto ≥ 0 je Tag; Netto ≤ Arbeit; keine Sitzung > 16 h

**Phase 2a – Backend-Kern**

- [ ] Schema per Drizzle-Migration inkl. Row-Level-Security, `docker-compose.yml` für PostgreSQL
- [ ] Auth: Registrierung, E-Mail-Bestätigung, Login, Token-Rotation mit Familien-Sperre, Passwort-Reset, TOTP, Rate-Limits
- [ ] Geräte, `/events/batch` (idempotent, `user_id`/`device_id` aus Token), `/presence`, `GET /events`, `/days`, `/status`
- [ ] Integrationstests gegen echte Datenbank (Testcontainers), inkl. Token-Wiederverwendung, fremde Event-IDs, Mandantentrennung
- [ ] OpenAPI-Spezifikation automatisch erzeugt; API-Client in `packages/shared`

**Phase 2b – Backend-Fachfunktionen**

- [ ] Korrekturen als Ereignisse, Sitzungs- und Tagesbestätigung, Einstellungen, Arbeitsnetze (HMAC), Sollzeiten, Abwesenheiten, Feiertage je Bundesland
- [ ] CSV- und PDF-Export, Datenauskunft, Kontolöschung nach Plan, nächtlicher Lösch-Job
- [ ] Integrationstests für jede Funktion

**Phase 3a – Desktop-Grundgerüst**

- [ ] `packages/app-core` (geteilte Hooks, Formatierung, i18n)
- [ ] Tauri-App mit Tray, Autostart, SQLite, Sync-Warteschlange, Aktiv-Spannen, manuellem Start/Stopp, Tagesprotokoll mit „war Arbeit“, „Zu prüfen“, Einrichtungsassistent
- [ ] Plattform-Erkennung hinter einer Rust-Schnittstelle (`trait SystemEvents`) mit Test-Attrappe; automatisierte Tests laufen ohne echte Betriebssystem-Ereignisse

**Phase 3b – Windows**

- [ ] Startzeit über Ereignis 27 (alle drei `BootType`-Werte), Shutdown über `WM_ENDSESSION` mit Logout-Filter, Neustart/Absturz über 1074/6008, Sperre/Standby, Netzwechsel und Netzwerk-Kennung
- [ ] Prüfung dokumentiert, welche WLAN-Abfragen unter 24H2 ohne Standortfreigabe funktionieren
- [ ] MSI-Installer, Tauri-Updater
- [ ] 👤 Auf echtem Gerät geprüft: Neustart, Windows-Update und Logout erzeugen kein Arbeitsende; Deckel zu 1 h = Pause; Deckel zu über Nacht (inkl. automatischem Ruhezustand) = Sitzungsende am Abend; Shutdown 17:00 → Ende 17:05; Schnellstart liefert korrekte Einschaltzeit; LAN am Dock wird erkannt
- [ ] 👤 Code-Signing (Azure Trusted Signing oder Zertifikat) eingebunden

**Phase 3c – macOS**

- [ ] Startzeit, Shutdown/Neustart/Logout über `kEventParamReason` mit Fallback, Sperre/Standby, Netzwechsel, Netzwerk-Kennung, CoreWLAN mit Ortung (optional)
- [ ] DMG, Tauri-Updater
- [ ] 👤 Auf echtem Gerät geprüft (wie 3b); Signierung und Notarisierung mit Apple-Developer-Konto

**Phase 4 – Android**

- [ ] Expo-App mit allen Screens, natives Netz-Modul mit Netzwerk-Kennung aus `LinkProperties` (ohne Standort), WorkManager-Check, Widget, Push (FCM), Einrichtungsassistent
- [ ] WLAN-Name nur optional und standardmäßig aus; falls aktiviert, Store-Unterlagen für Hintergrund-Standort vorbereitet
- [ ] 👤 Auf echtem Gerät geprüft: Netz-Ereignis wird bei beendeter App erfasst, auch auf einem Samsung-Gerät
- [ ] 👤 Geschlossener Test mit mind. 12 Testern über 14 Tage (bei neuem privatem Entwicklerkonto)

**Phase 5 – iOS**

- [ ] Vorab: aktuelle Apple-Doku zu Kurzbefehle-Auslösern, `NWPath`, `CLMonitor`/`CLCircularRegion` und Review-Richtlinien 5.1.1, 5.1.2, 5.1.5, 2.5.4 geprüft und dokumentiert
- [ ] App Intents für Kurzbefehle, Geofence für Arbeitsende (opt-in) mit `CLCircularRegion`-Fallback, Widget, Push (APNs)
- [ ] 👤 Auf echtem Gerät geprüft: Geofence-Verlassen weckt die App im Hintergrund und erzeugt `net_lost`
- [ ] 👤 App-Review-Begründung für „Immer“-Standort eingereicht

**Phase 6 – Firmenversion + Feinschliff**

- [ ] Rollen, Teams, Einladungen, Firmen-Arbeitsnetze, Regelwerk-Parameter je Organisation, Monatsfreigabe mit Snapshot, Audit-Log, Web-Admin
- [ ] SSO (OIDC, SAML)
- [ ] Alle ArbZG-Hinweise in allen Clients
- [ ] Rollentests: Manager sieht keine fremden Teams und keine Sitzungsdetails, Quellen oder Rohereignisse; Admin-Aktionen landen im Audit-Log
- [ ] Barrierefreiheit: automatisierte Prüfung (z. B. axe) in Web-Admin und Tray-UI ohne kritische Befunde

## Vorgaben für Claude Code (`CLAUDE.md`)

Diesen Abschnitt unverändert als `CLAUDE.md` ins Repo-Root legen.

```markdown
# Zeiterfassung – Regeln für Claude Code

## Arbeitsweise
- Spezifikation: docs/IMPLEMENTATION.md. Immer nur die beauftragte Phase umsetzen.
- Vor dem Coden kurzen Plan zeigen; bei Unklarheiten fragen statt raten.
- Testerwartungen in packages/rules/test/fixtures nie ohne Rückfrage ändern.
  Schlägt ein Test fehl, ist zuerst der Code falsch.
- Nach jeder Phase: Tests, Lint und Typecheck grün; Akzeptanzkriterien abhaken.
- 👤-Punkte nicht als erledigt markieren, sondern als Prüfanleitung für den Menschen ausgeben.
- Kleine, thematische Commits (Conventional Commits).

## Fachliche Regeln (nie ändern ohne Rückfrage)
- Arbeitszeitlogik NUR in packages/rules. Clients erzeugen nur Ereignisse und Aktiv-Spannen.
- Ereignisse sind unveränderlich (nur Insert). Korrekturen = manual_*-Ereignis + corrections-Zeile.
- Standby/Deckel zu, Logout und Neustart sind KEIN Arbeitsende.
- Desktop inaktiv ≥ 15 min = Pause; ≥ 180 min = Sitzungsende; Lücke > 120 min trennt Sitzungen.
- Neustart: shutdown UND folgendes boot entfernen, Intervall läuft durch.
- Startpuffer: boot erst nach 5 min melden, ts = echte Einschaltzeit; Aufwachen ist kein boot.
- Ende bei Shutdown = Shutdown + shutdownBonusMin (Standard 5). Netz-Karenz 10 min.
- Schwellen (6 h / 9 h / 10 h) gelten für die tatsächliche Arbeitszeit vor Auffüllung.
- Pausenauffüllung nur als ausgewiesener Abzug mit Warnung; tatsächliche Zeiten nie verändern; Netto nie negativ.
- Manuelle Werte überschreiben Automatik und sind gesperrt.
- Freigegebene Monate nie neu berechnen (Snapshot).

## Technik
- TypeScript strict, keine any. Zeiten intern als UTC-ISO; jedes Ereignis trägt seine IANA-Zeitzone.
- Dauern immer aus UTC-Differenzen (Zeitumstellung!).
- Validierung an jeder Grenze mit Zod. user_id/device_id immer aus dem Token.
- Keine fremden SSIDs, keine Koordinaten speichern oder senden; Netzwerk-Kennungen nur als HMAC.
- Logs ohne personenbezogene Inhalte. Secrets nur über Umgebungsvariablen; .env.example pflegen.
- Plattform-APIs und Store-Regeln vor Nutzung gegen aktuelle Herstellerdoku prüfen.
- UI barrierefrei nach WCAG 2.1 AA.
```
