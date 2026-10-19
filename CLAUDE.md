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
