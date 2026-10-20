# Rückfragen per Push und Wochenrückblick

Der Server fragt nach, wenn er ein Arbeitsende selbst erkannt hat („Feierabend um 17:12 erkannt,
stimmt das?“) oder ein Ende fehlt, und schickt einmal pro Woche einen Rückblick. Die Zahlen
berechnet nur `packages/rules` (`summarizeWeek`, `computeDays`). Der Server erzeugt keine
Arbeitszeit: „Stimmt“ schreibt die schon vorhandenen Ereignisse `session_confirm` bzw. eine
Korrektur (`PATCH /days/:date`, Feld `end`, mit Begründung).

## Ablauf

| Schritt          | Wo                                     | Was                                                                                                                                                                                                                                                                                         |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job alle 5 min   | `apps/backend/src/push/prompts.ts`     | Prüft Nutzer mit Ereignissen der letzten 8 Tage (nicht gelöscht, nicht deaktiviert, nicht „nur lokal“). Freigegebene Monate werden übersprungen.                                                                                                                                             |
| Arbeitsende      | `endCandidates`                        | Sitzung mit Ende durch `shutdown` oder `net_lost`, noch nicht entschieden: nach 20 min Karenz → `end_confirm`. Höchstens 24 h alt.                                                                                                                                                           |
| Ende fehlt       | `endCandidates`                        | Sitzung mit `no_end` oder `gap_end` (z. B. Desktop ≥ 180 min inaktiv): `end_missing` mit der letzten Aktivität als Vorschlag.                                                                                                                                                              |
| Wochenrückblick  | `weekReviewDue`                        | Ab Wochentag und Uhrzeit aus `settings.notifications.weekReview` (Standard Freitag 15:00, Ortszeit des Kontos) 24 h lang fällig. Fällt die Uhrzeit in eine Zeitumstellungslücke, gilt die Stunde danach.                                                                                    |
| Einmaligkeit     | Tabelle `push_prompts`                 | Primärschlüssel (Nutzer, Art, Bezug): Sitzungs-ID bzw. ISO-Woche (`2026-W42`). Ein zweiter Lauf fügt nichts ein und sendet nichts.                                                                                                                                                         |
| Ruhezeit         | `inQuietHours`                         | In der Ruhezeit (`quietHours`) entsteht keine Rückfrage; sie kommt im ersten Lauf danach.                                                                                                                                                                                                  |
| Abschalten       | `settings.notifications`               | `confirmEnd` (Arbeitsende und fehlendes Ende) und `weekReview.enabled`.                                                                                                                                                                                                                     |
| Versand          | `PushSender`                           | An alle Handys des Nutzers mit Push-Token, Text in der Sprache des Geräts (`devices.locale`). Ungültige Tokens (FCM `UNREGISTERED`/404, APNs 410) werden gelöscht.                                                                                                                        |
| Desktop          | `GET /prompts`, `apps/desktop`         | Der Desktop hat kein Push. Er fragt alle 5 min nach, zeigt jede Rückfrage einmal als Systembenachrichtigung und als Karte mit „Stimmt“, „Korrigieren“, „Später“. Ein Ende durch Herunterfahren meldet er nicht noch einmal, denn das hat der Laptop selbst erkannt (und war dabei aus). |
| Erledigt         | `GET /prompts`                         | Rückfragen verschwinden, sobald die Sitzung entschieden bzw. das Ende ergänzt ist, oder nach „Später“ (`POST /prompts/dismiss`, auf allen Geräten).                                                                                                                                       |

Die Push-Nachricht enthält nur Titel, Text (Datum, Uhrzeit, Summen) und Kennungen
(`pushData` in `packages/shared`): keine Namen, keine E-Mail-Adressen. Logs enthalten weder
Tokens noch Inhalte, nur Anzahlen.

## Aktionen am Handy

| Kategorie              | Aktionen                                                                     |
| ---------------------- | ---------------------------------------------------------------------------- |
| `timelog.end_confirm`  | „Stimmt“ (öffnet die App nicht), „Korrigieren“ (öffnet das Tagesprotokoll) |
| `timelog.end_missing`  | „Stimmt“ (Ende = letzte Aktivität), „Korrigieren“                           |
| `timelog.week_review`  | „Ansehen“ (öffnet den Wochenrückblick)                                      |

- **Android:** Der Server sendet eine reine Datennachricht (`title`, `message`, `body` als JSON,
  `categoryId`, `channelId: prompts`). expo-notifications zeigt sie mit den Aktionen der
  Kategorie an. „Stimmt“ läuft über `Notifications.registerTaskAsync` auch bei beendeter App
  (laut expo-Doku nur Android) und schreibt das Ereignis in die Warteschlange.
- **iOS:** Die App hat keinen Hintergrundmodus `remote-notification`, deshalb läuft dort kein JS
  für die Aktion. Ein nativer Handler (`TimelogPromptDelegate.swift`, angemeldet bei
  `NotificationCenterManager` von expo-notifications) schreibt `session_confirm` bzw. `manual_end`
  in die App Group. Die App überträgt das beim nächsten Öffnen. Ohne Verbindung ist auch auf
  Android ein `manual_end` ohne Begründung in der Warteschlange; online geht es mit Begründung
  über `PATCH /days`.
- **Desktop:** Das Tauri-Notification-Plugin hat Aktionen und `onAction` nur auf Mobilgeräten.
  Ein Klick auf die Benachrichtigung ist am Desktop nicht dokumentiert. Deshalb gibt es die Karte
  in der App, und die Benachrichtigung ist nur der Hinweis.

## Wochenrückblick

Desktop („Wochenrückblick“ in der Navigation) und Handy (Übersicht → „Wochenrückblick“) zeigen
tatsächliche Arbeitszeit, Netto, Soll, Abwesenheit, Saldo bis heute, offene Tage und Hinweise zum
ArbZG (`summarizeWeek`). „Woche bestätigen“ bestätigt jeden unproblematischen Tag (Status `auto`,
nicht offen, noch nicht bestätigt) über `POST /days/:date/confirm`. Ohne Konto oder ohne
Verbindung wird je Sitzung ein `session_confirm` gespeichert. Tage mit Prüfhinweisen (`unchecked`)
bleiben offen und stehen mit Link zum Tag in der Liste. Der Desktop nimmt mit Verbindung die Tage
des Servers (alle Geräte), sonst seine eigenen.

## Einrichtung

Ohne Konfiguration ist der Versand aus. Der Server meldet beim Start
`push: nicht konfiguriert – Rückfragen nur in den Apps, kein Push-Versand`; Rückfragen entstehen
trotzdem und erscheinen am Desktop. Secrets nur über Umgebungsvariablen (`.env.example`).

### FCM (Android)

1. Firebase-Projekt anlegen, Android-App mit dem Paketnamen (`TIMELOG_BUNDLE_ID`) hinzufügen,
   `google-services.json` herunterladen und über `TIMELOG_GOOGLE_SERVICES_FILE` in den Build geben.
2. Projekteinstellungen → Dienstkonten → „Neuen privaten Schlüssel generieren“. Die JSON-Datei
   ist ein Secret.
3. `FCM_SERVICE_ACCOUNT` = Inhalt der JSON-Datei **oder** `FCM_SERVICE_ACCOUNT_FILE` = Pfad
   (z. B. als Docker-Secret eingebunden).

Der Server holt sich mit dem Dienstkonto ein OAuth2-Access-Token (JWT RS256,
Scope `https://www.googleapis.com/auth/firebase.messaging`, höchstens 1 h gültig, wird bis kurz
vor Ablauf wiederverwendet) und sendet an
`POST https://fcm.googleapis.com/v1/projects/<project_id>/messages:send`.

### APNs (iOS)

1. Apple Developer → Certificates, Identifiers & Profiles → Keys → neuen Schlüssel mit „Apple
   Push Notifications service (APNs)“ anlegen. Die `.p8`-Datei gibt es nur einmal; sie ist ein
   Secret.
2. `APNS_KEY` = Inhalt der `.p8` (Zeilenumbrüche als `\n` erlaubt) **oder** `APNS_KEY_FILE` = Pfad.
3. `APNS_KEY_ID` (10 Zeichen, Key-ID), `APNS_TEAM_ID` (10 Zeichen), `APNS_BUNDLE_ID` (= `apns-topic`,
   die Bundle-ID der App).
4. `APNS_ENV=sandbox` für Entwicklungs-Builds (`TIMELOG_APNS_MODE=development`), sonst
   `production` (TestFlight und App Store).

Der Server signiert ein Provider-Token (JWT ES256, `kid` = Key-ID, `iss` = Team-ID), nutzt es
40 min lang (Apple: frühestens nach 20, spätestens nach 60 min erneuern) und sendet per HTTP/2 an
`https://api.push.apple.com/3/device/<token>` bzw. `api.sandbox.push.apple.com`. Header:
`apns-push-type: alert`, `apns-topic`, `apns-priority` (10 für Arbeitsende, 5 für den
Rückblick), `apns-expiration` (24 h), `apns-collapse-id` (Tag bzw. Woche). Nutzlast höchstens
4096 Byte.

Fehler: Nur 410 (`Unregistered`, `ExpiredToken`) löscht das Token. `BadDeviceToken` kann auch die
falsche Umgebung bedeuten (Sandbox-Token an Produktion); dann gibt es nur einen Log-Hinweis ohne
Token, damit nicht alle Tokens nach einer Fehlkonfiguration verschwinden.

### Weitere Variablen

- `PROMPTS_JOB=false` schaltet den Job ab (z. B. bei mehreren Server-Instanzen auf allen außer
  einer; der Job ist zwar idempotent, sendet aber sonst unter Umständen doppelt, wenn zwei
  Instanzen genau gleichzeitig laufen).

## Quellen (geprüft am 20.10.2026)

- FCM HTTP v1: https://firebase.google.com/docs/cloud-messaging/migrate-v1
- FCM Fehlercodes (`UNREGISTERED` → Token löschen):
  https://firebase.google.com/docs/cloud-messaging/error-codes
- OAuth2 für Dienstkonten (JWT-Grant):
  https://developers.google.com/identity/protocols/oauth2/service-account
- APNs Anfragen und Header:
  https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
- APNs Provider-Token:
  https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
- APNs Antworten und Fehler:
  https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns
- expo-notifications 58 (Kategorien, `registerTaskAsync`, Datennachrichten auf Android):
  https://docs.expo.dev/versions/latest/sdk/notifications/ und der Quelltext des Pakets
  (`node_modules/expo-notifications`, Version 58.1.5)
- Tauri Notification-Plugin (Aktionen nur mobil): https://v2.tauri.app/plugin/notification/

## Ungeprüft

- Echte Zustellung über FCM und APNs (getestet nur gegen gefälschte HTTP-Antworten und einen
  lokalen HTTP/2-Server).
- Swift-Handler und Podspec-Abhängigkeit `ExpoNotifications` (kein Xcode in der
  Entwicklungsumgebung).
- Android-Hintergrund-Task bei beendeter App.

## 👤 Prüfanleitung (echte Geräte, echte Schlüssel)

1. Server mit FCM- und APNs-Variablen starten. Erwartung im Log:
   `push: aktiv für android, ios`.
2. Android- und iOS-Build installieren, anmelden, Benachrichtigungen erlauben. Erwartung: In der
   Geräteliste hat jedes Handy ein Push-Token.
3. **Arbeitsende:** Am Laptop arbeiten, herunterfahren. Nach 20–25 min Erwartung: Auf beiden
   Handys „Feierabend um HH:MM erkannt“; am Desktop nach dem nächsten Start nur die Karte, keine
   zweite Benachrichtigung.
4. **„Stimmt“ ohne App:** App vorher beenden (aus „Zuletzt verwendet“ wischen). In der
   Benachrichtigung „Stimmt“ tippen. Erwartung: Die App öffnet sich nicht; nach dem nächsten
   Öffnen ist die Sitzung bestätigt (Android sofort, iOS nach dem Öffnen übertragen), und die
   Rückfrage ist auf allen Geräten weg.
5. **„Korrigieren“:** Erwartung: Die App öffnet das Tagesprotokoll des Tages.
6. **Netzverlust:** Handy verlässt das Arbeitsnetz. Erwartung: nach 20 min die Rückfrage, auch
   am Desktop als Benachrichtigung.
7. **Ende fehlt:** Manuell starten, nicht beenden, über Nacht warten. Erwartung: „Arbeitsende
   fehlt“ mit der letzten Aktivität; „Stimmt“ setzt das Ende dorthin.
8. **Ruhezeit:** Ruhezeit auf die nächste Stunde legen und Schritt 3 wiederholen. Erwartung:
   Die Rückfrage kommt erst nach Ende der Ruhezeit.
9. **Wochenrückblick:** Wochentag und Uhrzeit auf in 10 min stellen. Erwartung: genau eine
   Nachricht „Dein Wochenrückblick KW n“ mit Netto, Saldo, offenen Tagen, Hinweisen; „Ansehen“
   öffnet den Rückblick, „Woche bestätigen“ bestätigt nur die unproblematischen Tage.
10. **Token ungültig:** App deinstallieren, nächste Rückfrage auslösen. Erwartung: Das Token ist
    danach aus der Geräteliste entfernt.
11. **Sprache:** Handy auf Englisch stellen, App öffnen. Erwartung: Nächste Nachricht auf
    Englisch.
