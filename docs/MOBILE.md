# Handy-App (Android und iOS)

Wie die Handy-App (`apps/mobile`, Expo SDK 58 mit React Native 0.88) Arbeitszeit-Signale
erfasst, was davon in der Herstellerdoku steht und was am Gerät noch geprüft werden muss.
Die Herstellerdoku wurde am **20.10.2026** geprüft.

Die Arbeitszeit berechnet weiterhin nur `packages/rules`, über `computeDeviceDays` und
`periodDays` aus `packages/app-core`. Die nativen Module erzeugen nur Ereignisse
(`net_connected`, `net_lost`, `manual_start`, `manual_end`) und Aktiv-Spannen.

## Aufbau

| Teil | Ort | Aufgabe |
| --- | --- | --- |
| Kern | `src/core/core.ts`, `store.ts`, `sync.ts` | SQLite-Warteschlange (`expo-sqlite`), Tokens in `expo-secure-store`, Sync mit Backoff (30 s bis 30 min, Batch-Teilung bei abgelehnten Ereignissen), Laden der Ereignisse und Spannen aller Geräte (`GET /events`, `GET /presence` mit Cursor), Korrekturen, Netze, Abwesenheiten, Export |
| Oberfläche | `src/App.tsx`, `src/screens/*`, `src/ui/*` | Heute, Tagesprotokoll, Zu prüfen, Übersicht (Woche/Monat), Abwesenheiten, Einstellungen, Einrichtungsassistent |
| Erinnerungen | `src/core/reminders.ts`, `src/notifications.ts` | Lokale Hinweise kurz vor 6 h, 9 h und 10 h tatsächlicher Arbeitszeit, bei abends noch laufender Arbeitszeit und bei offenen Prüfungen. Ruhezeiten werden beachtet |
| Natives Modul | `modules/timelog-native` | Android in Kotlin, iOS in Swift, beide über die Expo Modules API. Schnittstelle in `src/types.ts` |
| iOS App Intents | `modules/timelog-native/ios-app` | Kurzbefehle „Arbeitsnetz verbunden“, „Arbeit beginnen“ und „Arbeit beenden“. `plugins/withTimelog.js` kopiert sie beim Prebuild ins App-Target |
| iOS-Widget | `targets/widget` | WidgetKit-Erweiterung, erzeugt mit `@bacons/apple-targets`, mit interaktivem Start/Stopp-Knopf (ab iOS 17) |
| Konfiguration | `app.config.ts`, `plugins/withTimelog.js` | Bundle-ID, App Group, Berechtigungen, Push und Build-Optionen |

Datenfluss: Das native Modul schreibt auch bei beendeter App in den eigenen Speicher.
- Android: SharedPreferences.
- iOS: App Group (`UserDefaults(suiteName: group.<Bundle-ID>)`).

Die App holt diese Einträge mit `drain()` ab, legt sie in SQLite und bestätigt sie mit
`acknowledge()`. Dann sendet sie die Einträge. Offene Spannen bleiben im Modul, bis sie
abgeschlossen sind.

## Prüfung der Herstellerdoku (Stand 20.10.2026)

| Thema | Ergebnis | Folge für die App | Quelle |
| --- | --- | --- | --- |
| Android `registerNetworkCallback(NetworkRequest, PendingIntent)` | Weckt die App auch, wenn sie beendet ist. Der Callback kommt aber **nur bei „verfügbar“**, nicht beim Trennen. Nötig sind `ACCESS_NETWORK_STATE`, ein expliziter Intent und `FLAG_MUTABLE`, weil das System Extras ergänzt. Höchstens 100 Anfragen je App. Die Registrierung überlebt keinen Neustart | Neu registrieren nach `BOOT_COMPLETED`, `MY_PACKAGE_REPLACED` und App-Start, immer mit demselben `requestCode`. Trennen erkennen der WorkManager-Takt und der Live-Callback (`onLost`, nur solange der Prozess läuft) | developer.android.com/reference/android/net/ConnectivityManager |
| Android `LinkProperties` | Gateway (Routen), Adressen und Präfix, DNS-Server und Suchdomänen sind ohne Standortberechtigung lesbar. Die MAC des Gateways gibt es seit Android 10 nicht mehr (`/proc/net` ist gesperrt). `WifiManager.getConnectionInfo` liefert SSID und BSSID nur mit `ACCESS_FINE_LOCATION` | Die Kennung kommt aus LinkProperties (siehe unten). WLAN-Name ist optional | developer.android.com/reference/android/net/LinkProperties; …/wifi/WifiInfo |
| Android WorkManager | Periodische Arbeit läuft frühestens alle 15 min (`PeriodicWorkRequest`). Doze und Hersteller-Akkusparmodi können sie verzögern | Eindeutige Arbeit `timelog-network-check`, 15 min, `KEEP`. Hinweis auf Akku-Optimierung mit Samsung-Text | developer.android.com/develop/background-work/background-tasks/persistent |
| Jetpack Glance | Version 1.2.0, `GlanceAppWidget` mit `ActionCallback` | Widget mit Start/Stopp | developer.android.com/develop/ui/compose/glance |
| Kurzbefehle-Auslöser (iOS 27) | Der Auslöser „WLAN“ feuert **nur beim Verbinden**; „Trennen“ gibt es nicht. WLAN gehört zu den Auslösern, die ohne Rückfrage laufen können („Sofort ausführen“) | Beginn kommt über den App Intent „Arbeitsnetz verbunden“. Ende kommt über Geofence, Laptop oder „Arbeit beenden“. Die App sagt offen, dass das Ende auf iOS ohne Laptop ungenauer ist | support.apple.com/guide/shortcuts (Personal automation triggers) |
| `NWPath.gateways` | Liefert die Gateways des aktuellen Pfads (iOS 13+), **ohne** Standortberechtigung. DNS-Server und Suchdomänen gibt es nicht | Keine Netzwerk-Kennung auf iOS. Das Gateway der Kurzbefehl-Meldung wird nur **lokal** gemerkt, damit beim App-Start geprüft werden kann, ob man noch im selben Netz ist (Spanne verlängern, sonst Ende bei der letzten Bestätigung) | developer.apple.com/documentation/network/nwpath |
| `CLMonitor` (iOS 17+) | Bedingungen werden nach Namen gespeichert. Nach einem Neustart der App muss der Monitor **mit demselben Namen** neu angelegt werden und `events` erneut gelesen werden. Höchstens 20 Bedingungen je App. Ereignisse kommen erst nach dem ersten Entsperren | Monitor „TimelogWork“ mit einer Bedingung, beim Start über `ExpoAppDelegateSubscriber` neu angelegt | developer.apple.com/documentation/corelocation/clmonitor |
| `CLCircularRegion` / `startMonitoring(for:)` | Höchstens 20 Regionen. Das System startet die App bei Betreten und Verlassen neu. Laut Doku kommen Ereignisse erst nach Überschreiten der Grenze plus Puffer und bis zu 3–5 min verzögert | Rückfall für iOS 16 und als Schalter „Kompatibilitätsmodus“, weil Entwickler berichten, dass `CLMonitor` seltener weckt. Radius mindestens 100 m, Standard 150 m | developer.apple.com/documentation/corelocation/monitoring-the-user-s-proximity-to-geographic-regions |
| App Review 5.1.1 (Datenerhebung) | (i) Datenschutzerklärung. (v) Konto muss in der App löschbar sein. Funktionen ohne Kontobezug müssen ohne Anmeldung nutzbar sein | „Nur lokal“ ohne Konto. „Konto löschen“ in den Einstellungen. Datenauskunft als JSON | developer.apple.com/app-store/review/guidelines/ (Stand 16.10.2026) |
| App Review 5.1.2 (Datennutzung) | Funktionen dürfen nicht von einer Freigabe abhängen, die für den Kern unnötig ist | Standort nur für den opt-in-Geofence. Die App funktioniert ohne jede Berechtigung (manueller Start/Stopp, Kurzbefehl) | wie oben |
| App Review 5.1.5 (Standortdienste) | Standort nur, wenn er direkt für Funktionen nötig ist. Zweck muss erklärt werden | Zwecktexte in `NSLocation…UsageDescription`. Erklärung in der App vor der Abfrage („Hier einrichten“) | wie oben |
| App Review 2.5.4 (Hintergrunddienste) | Hintergrundmodi nur für ihren Zweck | **Kein** `UIBackgroundModes: location`; Bereichsüberwachung braucht ihn nicht. `processing`/`fetch` nur für den Sync (`expo-background-task`), `remote-notification` aus | wie oben |
| Google Play: Standort im Hintergrund | Deklaration im Permissions Declaration Form. Gut sichtbarer Hinweis in der App vor der Abfrage, der „Standort“ und „auch wenn die App geschlossen ist oder nicht verwendet wird“ nennt. Video ≤ 30 s. Nur **eine** Funktion je Deklaration | Gilt nur mit `TIMELOG_ANDROID_WIFI_NAME=1`. Ohne diesen Schalter entfernt `blockedPermissions` alle Standortberechtigungen aus dem Manifest. Unterlagen siehe unten | support.google.com/googleplay/android-developer/answer/9799150 |
| Google Play: Testpflicht | Private Entwicklerkonten, die nach dem 13.11.2023 angelegt wurden, brauchen vor der Produktion einen geschlossenen Test mit **mind. 12 Testern, die 14 Tage am Stück** eingeschrieben sind | 👤 siehe Prüfanleitung | support.google.com/googleplay/android-developer/answer/14151465 |

Weitere Entscheidungen beim Prüfen:

- **Kein `NEHotspotNetwork` auf iOS.** Der WLAN-Name käme nur mit Standort und Entitlement, und
  die Kurzbefehl-Automation erledigt das ohne beides. Die Spec nennt `fetchCurrent`; bewusst
  weggelassen.
- **Kein Expo-Push-Dienst.** Hinterlegt wird das native Token (FCM bzw. APNs) über
  `POST /devices` (`pushToken`, dazu `locale` für die Sprache der Texte). Der Server sendet
  Rückfragen und den Wochenrückblick selbst über FCM HTTP v1 und APNs (siehe
  [PUSH.md](PUSH.md)), mit Aktionen „Stimmt“ und „Korrigieren“.
- **`expo-app-intents` und `expo-widgets` noch Alpha.** Die Intents liegen deshalb als Swift
  im App-Target, und das Widget kommt über `@bacons/apple-targets`.
- **`androidx.security:security-crypto` ist abgekündigt.** Die HMAC-Schlüssel liegen in privaten
  SharedPreferences (App-Sandbox, nicht im Backup). Die Tokens liegen im Keystore/Keychain
  (`expo-secure-store`, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`).

## Netzwerk-Kennung

Die Kennung wird nativ berechnet, damit sie auch bei beendeter App verfügbar ist (Android:
`NetworkFingerprint.kt`). `src/fingerprint.ts` ist die Referenz. Beide werden gegen dieselben
Testfälle geprüft (`fingerprint-vectors.json`, Jest und JUnit).

1. Gateway-MAC bekannt: `gw=aa:bb:cc:dd:ee:ff`. Das ist identisch zum Desktop, damit ein
   hinterlegtes Netz auf allen Geräten passt. Auf aktuellen Android-Versionen kommt das nicht vor.
2. Sonst: `v4;gw=<IPs>;net=<Netz>/<Präfix>;dns=<IPs>;dom=<Domänen>`.
   - Nur IPv4.
   - Jedes Feld sortiert und ohne Dubletten; leere Felder entfallen.
   - Link-lokale Adressen, Loopback und 0.0.0.0 werden ignoriert.
   - Beispiel: `v4;gw=10.1.0.1;net=10.1.0.0/16;dns=10.1.0.10,10.1.0.11;dom=corp.example.com`.
3. Ohne IPv4-Gateway gibt es keine Kennung.

Vor dem HMAC wird normalisiert wie im Backend: `trim`, Kleinbuchstaben, `-` wird zu `:`. An den
Server geht der Klartext nur einmal beim „Aktuelles Netz übernehmen“; gespeichert wird dort nur
der HMAC. Im Modus „Nur lokal“ rechnet die App den HMAC selbst (`src/core/hmac.ts`, eigener
32-Byte-Schlüssel im Keystore/Keychain).

**Schwache Kennung:** Ohne eigene Domäne und mit dem Router als DNS-Server (z. B. `fritz.box`,
`speedport.ip`) sehen viele Heimnetze gleich aus. Die App warnt dann beim Übernehmen und
speichert trotzdem; ein Büro mit Werkseinstellungen bliebe sonst ganz ohne Erkennung.
**Grenze:** Zwei Netze mit gleichem Adressplan und gleicher Domäne sind nicht unterscheidbar.
Das ist für Firmennetze akzeptiert (eigener DNS, eigene Domäne).

## Erkennung je System

**Android**
- Callback `NETWORK_AVAILABLE`:
  - Kennung bilden und mit den HMACs vergleichen.
  - Treffer ergibt `net_connected` mit Quelle `wifi`/`lan` und Netz-ID, und eine Aktiv-Spanne
    öffnet sich.
  - Fehlen direkt nach dem Verbinden noch DNS oder Adressen, wird nach 1 min erneut geprüft.
- WorkManager alle 15 min:
  - Netz noch da: Spanne verlängern.
  - Netz weg: `net_lost` zum Ende der letzten bestätigten Spanne.
  - So wird die Zeit zwischen zwei Prüfungen nicht als Arbeit gezählt, wenn das Netz in dieser
    Zeit weg war.
  - Ein Live-`onLost` (während der Prozess läuft) setzt die genaue Zeit.
- Optionaler WLAN-Name: Nur mit Build-Schalter und Standortfreigabe. Erst nach den HMACs wird
  SSID/BSSID geprüft; fremde SSIDs werden nie gespeichert.

**iOS**
- Kurzbefehl-Automation „WLAN verbunden“ → App Intent „Arbeitsnetz verbunden“:
  - Weniger als 120 min nach der letzten Bestätigung: Die Spanne wird verlängert.
  - Sonst: Erst `net_lost` zum alten Spannenende, dann ein neues `net_connected` (Quelle
    `shortcut`).
- Beim Öffnen der App und bei jedem Widget-Refresh wird über `NWPath.gateways` geprüft, ob das
  gemerkte Gateway noch da ist.
- Geofence (opt-in, „Immer“-Standort):
  - Gespeichert wird nur Betreten bzw. Verlassen als `net_connected`/`net_lost` mit Quelle
    `geofence`.
  - Den Mittelpunkt hält nur iOS (CLMonitor bzw. `monitoredRegions`). Die App speichert und sendet
    keine Koordinaten. Die Netz-Art `geofence` des Servers (mit `lat`/`lng`) wird deshalb nicht
    benutzt.

## Datenschutz

- Keine Koordinaten, keine fremden SSIDs, keine Netzwerk-Kennungen im Klartext auf dem Server.
- Die Logs enthalten keine personenbezogenen Inhalte. Die App loggt nichts außer
  Entwicklerwarnungen.
- `user_id` und `device_id` stammen beim Server immer aus dem Token. Die App sendet sie nicht.
- Konto löschen, Datenauskunft (JSON) und „Alle Daten auf diesem Gerät löschen“ (nur lokal) gibt
  es in den Einstellungen.
- Ohne Schalter hat das Android-Manifest keine Standortberechtigung. Speicherberechtigungen werden
  ausgeschlossen; Exporte laufen über das Teilen-Menü.

## Barrierefreiheit (WCAG 2.1 AA)

- Alle Bedienelemente haben Rolle, Beschriftung und Zustand: `button`, `switch`, `radio`, `tab`
  mit `selected` und `alert` für Fehler. Ein Test prüft, dass jeder Knopf und Reiter einen
  zugänglichen Namen hat.
- Schrift skaliert mit der Systemeinstellung. Es gibt keine festen Höhen, nur Mindestgrößen
  (Touch-Ziele ≥ 48).
- Kontraste hell und dunkel: Text ≥ 4,5:1, Rahmen ≥ 3:1. `test/theme.test.ts` rechnet sie nach.
- Status steht nie nur in der Farbe; Warnungen stehen immer als Text da.

## Was automatisch geprüft ist

- `apps/mobile` (Jest mit `jest-expo`, React Native Testing Library):
  - Kern gegen einen Fake-Server, der mit den Zod-Schemas aus `packages/shared` validiert:
    - Warteschlange, Backoff, Token-Rotation, Neuanmeldung, abgelehnte Ereignisse.
    - Nur-lokal-Modus, Laptop-Daten, Korrekturen online und offline, Firmenkonto mit
      Begründung.
    - Netze mit HMAC, Abwesenheiten, Datenauskunft, Löschen.
  - Erinnerungen und Ruhezeiten, Widget-Texte, Texte de/en, Kontraste.
  - Bildschirme: Assistent, Heute, Tagesprotokoll („War Arbeit“, Korrektur), Zu prüfen,
    Übersicht/Abwesenheiten, Einstellungen Android/iOS, Englisch.
  - Konfiguration (`app.config.ts`) und die Gleichheit beider `TimelogShared.swift`.
- `NetworkFingerprint.kt` mit JUnit gegen `fingerprint-vectors.json` auf der JVM (außerhalb
  dieses Repos ausgeführt; im Repo als `android/src/test`).
- `expo prebuild` erzeugt beide native Projekte: Intents im App-Target, Widget-Target mit App
  Group, Manifest ohne Standort.
- `expo export` bündelt für Android und iOS.

## Ungeprüft (kein Android-SDK, kein Xcode in der Entwicklungsumgebung)

- Ob der Kotlin-Code kompiliert (bis auf `NetworkFingerprint.kt`) und die Gradle-Konfiguration
  des Moduls (Compose/Glance-Plugin).
- Ob alle Swift-Dateien kompilieren: Modul, App Intents, Widget, `GeofenceManager`.
- Codesignierung, App-Group-Provisioning und `ios.appleTeamId`.
- Verhalten am Gerät: alle 👤-Punkte unten.
- Push-Versand an echte Geräte (FCM/APNs) und der Swift-Handler für „Stimmt“ ohne App-Start
  (`TimelogPromptDelegate.swift`); Prüfanleitung in [PUSH.md](PUSH.md). Erinnerungen laufen
  weiterhin lokal.
- Datei-Export über `expo-file-system`/`expo-sharing` am Gerät.

## 👤 Prüfanleitungen

### Android: Netz bei beendeter App (inkl. Samsung)

1. Debug-Build installieren (`pnpm --filter @timelog/mobile android` oder EAS). Anmelden, im
   Büro „Aktuelles Netz übernehmen“.
2. Die App aus „Zuletzt verwendet“ wischen. Zusätzlich einmal über Einstellungen → Apps →
   TimeLog → „Beenden erzwingen“ testen. Erwartung: Nach Beenden erzwingen weckt Android die App
   **nicht**, bis sie wieder geöffnet wird; das ist Systemverhalten.
3. WLAN aus- und wieder einschalten bzw. das Büro verlassen und zurückkommen. Erwartung: Ein
   `net_connected` mit der Uhrzeit des Verbindens erscheint im Tagesprotokoll, nachdem die App
   geöffnet wurde.
4. Netz verlassen, 20–30 min warten, App öffnen. Erwartung: `net_lost` liegt höchstens 15 min nach
   der letzten Verlängerung.
5. Gerät neu starten, ohne die App zu öffnen, und dann ins Netz gehen. Erwartung: wie Schritt 3
   (`BOOT_COMPLETED` registriert neu).
6. **Samsung** (One UI): Schritte 2–5 mit der Standard-Akkueinstellung. Danach mit „Nie im
   Standby“ wiederholen. Festhalten, ob Hinweis und Link „Akku-Einstellungen öffnen“ funktionieren.
7. Widget hinzufügen, Start/Stopp tippen. Erwartung: Die Anzeige wechselt sofort, und das
   Ereignis erscheint nach dem Öffnen.
8. Push: Benachrichtigungen erlauben. Erwartung: In der Geräteliste (Web) ist ein Push-Token
   hinterlegt. Rückfragen und Wochenrückblick: Prüfanleitung in [PUSH.md](PUSH.md).

### iOS: Kurzbefehl und Geofence

1. Build mit gültigem Team (`ios.appleTeamId` in `app.config.ts` ergänzen) und App Group
   `group.<Bundle-ID>` im Developer-Portal.
2. Kurzbefehle → Automation → WLAN → Büro-WLAN → „Verbunden“ → „Sofort ausführen“ → Aktion
   „Arbeitsnetz verbunden“. Danach WLAN aus/an. Erwartung: Das Protokoll zeigt `net_connected`
   (Kurzbefehl), ohne dass die App geöffnet war.
3. Geofence: Am Arbeitsplatz „Hier einrichten“ wählen, erst „Beim Verwenden“ erlauben, dann
   „Immer“. App schließen und den Bereich (≥ 150 m) verlassen, 10 min warten.
   - Erwartung: `net_lost` (Ort) mit der Zeit des Verlassens, auf ±5 min genau.
   - Einmal nach einem Neustart des iPhones wiederholen (Monitor wird neu angelegt).
4. Den Test mit „Kompatibilitätsmodus“ (CLCircularRegion) wiederholen und vergleichen, welcher
   Modus zuverlässiger weckt. Das Ergebnis hier eintragen und den Standard ggf. umstellen.
5. Widget (iOS 17+): Start/Stopp tippen, Anzeige und Protokoll prüfen.
6. In Instruments bzw. im Datenschutzbericht von iOS prüfen, dass ohne Geofence kein
   Standortzugriff stattfindet.

### iOS: App-Review-Begründung „Immer“-Standort (Entwurf)

> TimeLog records working time under the German Working Time Act. Location is optional and off by
> default. If the user turns on "geofence for the end of work", they stand at their workplace and
> tap "Set up here". The app then asks for "When In Use" and afterwards "Always" permission,
> determines the location once and registers it with region monitoring (CLMonitor or
> CLCircularRegion). "Always" is needed because the user leaves the workplace when the app is not
> open; iOS then wakes the app on the exit event and TimeLog records the end of the working day.
> The app does not store or transmit coordinates; only the events "entered" and "left" are
> recorded. Without location permission all features except this one work (manual start/stop,
> Shortcuts automation). The app does not use the location background mode.

In App Store Connect bei „App-Datenschutz“ angeben: Standort wird **nicht erhoben**, weil keine
Koordinaten das Gerät verlassen. Mit Apple klären, falls Review das anders sieht.

### Google Play: geschlossener Test

1. Neues privates Entwicklerkonto: Testtrack „Geschlossen“ anlegen und ≥ 12 Tester einladen.
   Alle müssen 14 Tage **am Stück** eingeschrieben bleiben.
2. Nach 14 Tagen in der Play Console den Zugang zur Produktion beantragen (Fragen zu Test und
   Feedback beantworten).
3. Datensicherheitsformular:
   - Erhoben werden Arbeitszeit-Ereignisse und Gerätename, verschlüsselt übertragen, löschbar.
   - Kein Standort (ohne WLAN-Name-Schalter).

### Google Play: nur bei `TIMELOG_ANDROID_WIFI_NAME=1` (Hintergrund-Standort)

- **Deklaration** (Permissions Declaration Form): Funktion „Arbeitsbeginn und -ende erkennen,
  wenn sich das Handy mit dem Arbeits-WLAN verbindet“. Android gibt den WLAN-Namen nur mit
  Standortberechtigung heraus, auch im Hintergrund.
- **Hinweis in der App vor der Abfrage** (steht als `settings.ssidHint` in der App, für Play
  ergänzen): „TimeLog erhebt Standortdaten, um den Namen deines Arbeits-WLANs zu erkennen und so
  Arbeitsbeginn und -ende zu erfassen – auch wenn die App geschlossen ist oder nicht verwendet
  wird. Es werden keine Koordinaten und keine fremden WLAN-Namen gespeichert.“
- **Video (≤ 30 s):** Einstellungen → „WLAN-Name zusätzlich verwenden“ → Hinweis → Systemdialog
  „Immer erlauben“ → App schließen → mit Büro-WLAN verbinden → Protokoll zeigt den Beginn.
- Ohne diesen Schalter ist keine Deklaration nötig. Das ist der Standard.

## Bauen

```bash
pnpm install
cd apps/mobile
pnpm prebuild          # erzeugt android/ und ios/ (nicht eingecheckt)
pnpm android           # bzw. pnpm ios (macOS mit Xcode)
pnpm test              # Jest
```

Umgebungsvariablen stehen in `.env.example`, Abschnitt „Handy-App“:
- `TIMELOG_BUNDLE_ID`
- `TIMELOG_DEFAULT_SERVER`
- `TIMELOG_ANDROID_WIFI_NAME`
- `TIMELOG_GOOGLE_SERVICES_FILE` (FCM)
- `TIMELOG_APNS_MODE`
- `EAS_PROJECT_ID`

## Akzeptanzkriterien

**Phase 4 – Android**

- [x] Expo-App mit allen Screens, natives Netz-Modul mit Netzwerk-Kennung aus `LinkProperties`
  (ohne Standort), WorkManager-Check, Widget, Push-Token (FCM), Einrichtungsassistent.
  Kompilieren am Gerät steht aus. Push-Versand vom Server gebaut ([PUSH.md](PUSH.md)), am Gerät
  ungeprüft.
- [x] WLAN-Name nur optional und standardmäßig aus; Store-Unterlagen für Hintergrund-Standort
  vorbereitet (oben).
- 👤 Auf echtem Gerät prüfen: Netz-Ereignis bei beendeter App, auch auf Samsung (Anleitung oben).
- 👤 Geschlossener Test mit mind. 12 Testern über 14 Tage (Anleitung oben).

**Phase 5 – iOS**

- [x] Apple-Doku zu Kurzbefehle-Auslösern, `NWPath`, `CLMonitor`/`CLCircularRegion` und
  Review-Richtlinien 5.1.1, 5.1.2, 5.1.5, 2.5.4 geprüft und dokumentiert (oben).
- [x] App Intents für Kurzbefehle, Geofence fürs Arbeitsende (opt-in) mit
  `CLCircularRegion`-Fallback, Widget, Push-Token (APNs). Kompilieren in Xcode steht aus.
  Push-Versand vom Server gebaut ([PUSH.md](PUSH.md)), am Gerät ungeprüft.
- 👤 Auf echtem Gerät prüfen: Geofence-Verlassen weckt die App im Hintergrund und erzeugt
  `net_lost`.
- 👤 App-Review-Begründung für „Immer“-Standort einreichen (Entwurf oben).
