# Projekte, Kalender und Homeoffice-Nachweis

Drei optionale Erweiterungen. Alle Rechenregeln liegen in `packages/rules`
(`projects.ts`, `location.ts`, `calendar.ts`). Die Clients erzeugen nur Ereignisse und Zuordnungen und
zeigen an, was der Server mit dem Regelwerk berechnet.

Stand der Herstellerdoku-Prüfung: 20.10.2026.

## 1. Projekte und Tätigkeiten

- Standardmäßig aus. Privatkonto: Einstellungen → „Projekte und Tätigkeiten erfassen“
  (`settings.projects`). Firmenkonto: Der Admin schaltet sie im Web-Admin unter Einstellungen →
  Funktionen ein und legt die Projekte an. Ein Projekt kann für alle Mitglieder oder nur für ein
  Team sichtbar sein. Mitglieder legen keine eigenen Projekte an (`403 org_managed`).
- Ein Projekt hat Name, optional Kunde, Farbe, Kalender-Stichwörter und den Status archiviert.
  Projekte werden nie gelöscht, nur archiviert, damit alte Auswertungen lesbar bleiben.
- Zuordnung (Priorität, `allocateProjects`):
  1. **Von Hand** im Tagesprotokoll, je Zeitabschnitt. Sie überschreibt die Automatik und ist
     gesperrt. Jede Zuordnung ist ein neuer, unveränderlicher Eintrag in `project_assignments`
     (die Datenbank lehnt UPDATE per Trigger ab, der App-Rolle fehlt das Recht). Dazu kommt eine
     Zeile in `corrections` (`field = 'project'`). Der jüngste Eintrag gewinnt. „Ohne Projekt“
     ist ebenfalls eine gültige Zuordnung von Hand.
  2. **Kalender**: Ein Termin, dessen Titel ein Stichwort enthält, ordnet die Arbeitszeit in
     diesem Termin dem Projekt zu. Es gewinnt das längste Stichwort; verglichen wird nach
     Unicode-Normalisierung (NFKC) und ohne Groß- und Kleinschreibung.
  3. **Netz**: das Standardprojekt eines Arbeitsnetzes.
- Summen: Die Projektanteile eines Tages ergeben zusammen genau die Netto-Arbeitszeit des Tages.
  Die Pausenauffüllung (§ 4 ArbZG) wird anteilig nach Arbeitszeit auf die Projekte verteilt
  (Rundung nach dem Verfahren der größten Reste), je Projekt ausgewiesen und ist nie negativ.
  Die tatsächlichen Zeiten bleiben unverändert. Property-Tests über alle Regelwerk-Fixtures
  sichern das ab (`packages/rules/test/extras.test.ts`).
- Freigegebene Monate: Der Snapshot einer Freigabe enthält jetzt auch Projektaufteilung und
  Tagesorte (`{ version: 2, days, projects, locations }`). Ältere Snapshots (nur Tage) werden
  weiter gelesen; für sie wird die Aufteilung aus den eingefrorenen Tagen abgeleitet.
- Auswertung je Projekt, Kunde und Zeitraum: in Desktop und Handy unter „Auswertung“, im
  Web-Admin unter „Projekte“. Export als CSV/PDF (`GET /projects/export`); der normale
  Arbeitszeit-Export (`GET /export`) bekommt bei eingeschalteten Projekten die Spalte „Projekte“.

**Entscheidung Datenschutz (Firma):** Admins sehen Projektzeiten nur als **Summe** über die
Organisation oder ein Team, nie je Person und Tag. Deshalb bekommt der Monatsexport des Admins
(`/org/export`) keine Projektspalte. Manager sehen keine Projektauswertung.

## 2. Kalender (Google, Microsoft 365), nur lesend

### Ablauf

1. Der Client ruft `POST /api/v1/calendar/{google|microsoft}/connect` auf. Der Server erzeugt
   `state` und PKCE-Verifier (S256) und liefert die Anmeldeadresse des Anbieters. Er speichert den
   state nur als SHA-256 und den Verifier verschlüsselt, beides 10 Minuten gültig.
2. Desktop: Die Adresse wird zum Öffnen bzw. Kopieren angezeigt (der Desktop-Kern bekommt dafür
   kein zusätzliches Plugin). Handy: `Linking.openURL`. Web-Admin: Weiterleitung mit Rücksprung
   auf den Web-Admin (`?calendar=connected`).
3. Der Anbieter leitet auf `GET <API_URL>/api/v1/calendar/{provider}/callback` zurück. Der Server
   tauscht den Code mit Verifier und Client-Secret gegen Tokens (vertraulicher Client). Das
   Refresh-Token wird mit AES-256-GCM und demselben Schlüssel wie die TOTP-Geheimnisse
   verschlüsselt (`TOTP_ENCRYPTION_KEY`). Danach folgt der erste Abruf.
4. Abruf: alle `CALENDAR_SYNC_INTERVAL_MIN` Minuten (Standard 60) und über „Jetzt abrufen“
   (höchstens 10-mal pro Minute). Zeitraum: 35 Tage zurück und 60 Tage voraus. Er ersetzt die
   Termine, die diesen Zeitraum überlappen.
5. Trennen (`DELETE /calendar/{provider}`) löscht Token, alle Termine und offene Anmeldungen.
   Google: Das Token wird zusätzlich beim Anbieter widerrufen. Microsoft bietet für vertrauliche
   Clients keinen Widerruf eines einzelnen Refresh-Tokens. Die Freigabe entfernt die Person unter
   <https://myapps.microsoft.com> (Geschäftskonto) bzw. <https://account.live.com/consent/Manage>
   (privates Konto).

### Was gespeichert wird

Nur `start_at`, `end_at`, `all_day`, `start_date`/`end_date` (ganztägig), `kind` (`busy` |
`absence`) und die per Stichwort gefundene `project_id`. Titel, Teilnehmer, Orte und
Beschreibungen werden nicht gespeichert und nicht protokolliert. Der Titel lebt nur im Speicher
des Abrufs, für den Stichwort-Abgleich. Bei Google fordert die Anfrage per `fields` nur
`status, summary, eventType, transparency, start, end` an; bei Microsoft per `$select` nur
`subject, start, end, isAllDay, showAs, isCancelled`. Fehler landen nur als Code
(`invalid_grant`, `list_failed` …) in `calendar_connections.last_error`.

- Google: `transparency = transparent` („frei“) und abgesagte Termine werden übersprungen;
  `eventType = outOfOffice` → Abwesenheit. Abgefragt werden `eventTypes` `default`,
  `outOfOffice` und `focusTime` (keine Geburtstage, Gmail- oder Arbeitsort-Einträge).
- Microsoft: `showAs = free` und `isCancelled` werden übersprungen, `showAs = oof` →
  Abwesenheit. Zeiten kommen per `Prefer: outlook.timezone="<Zeitzone der Person>"` in Ortszeit
  und werden in UTC umgerechnet.

**Sichtbarkeit:** Kalenderdaten sieht nur die Person selbst. Das ist als restriktive RLS-Regel
umgesetzt (`app_actor_id() = user_id`), auch für Admins im Auftrag.

**Warum Termine statt Frei/Gebucht:** Die Frei/Gebucht-Abfragen (Google `freebusy`, Graph
`getSchedule`) liefern weder Titel (kein Stichwort-Abgleich) noch die Unterscheidung
Abwesenheit/ganztägig. Deshalb werden die Termine selbst gelesen, mit der kleinsten Berechtigung.

### Verwendung

- **„War Arbeit (Termin)“:** Liegt eine erkannte Pause oder eine Lücke zwischen zwei Sitzungen
  mindestens 15 Minuten in einem Termin, erscheint ein Vorschlag in „Zu prüfen“. Erst ein Klick
  erzeugt ein `manual_work`-Ereignis. Nie automatisch gebucht. Ausgeblendete Vorschläge merkt
  sich das Gerät.
- **Abwesenheit:** Tage, die ein ganztägiger Abwesenheitstermin vollständig abdeckt und für die
  noch keine Abwesenheit eingetragen ist, werden als Urlaub vorgeschlagen. Erst nach Bestätigung
  wird die Abwesenheit eingetragen (Sollzeit des Tages).
- **Projekt per Stichwort** (siehe oben). Nur wenn Projekte eingeschaltet sind.
- Freigegebene Monate liefern keine Vorschläge.

### Einrichtung Google (Google Cloud Console)

1. <https://console.cloud.google.com/> → Projekt anlegen oder wählen.
2. „APIs & Dienste“ → „Bibliothek“ → **Google Calendar API** aktivieren.
3. „Google Auth Platform“ (früher „OAuth-Zustimmungsbildschirm“): App-Name, Support-Adresse und
   Datenschutzerklärung eintragen. Zielgruppe „Extern“, oder „Intern“ für reine Workspace-Nutzung.
4. „Datenzugriff“ → Bereich hinzufügen:
   `https://www.googleapis.com/auth/calendar.events.readonly`. Kalender-Bereiche stuft
   Google als „sensibel“ ein: Für externe Nutzer ist eine Verifizierung nötig, bis dahin nur
   Testnutzer (👤 Einstufung und Ablauf vor dem Livebetrieb in der Console prüfen).
5. „Clients“ → „Client erstellen“ → Typ **Webanwendung**. Autorisierte Weiterleitungs-URI:
   `<API_URL>/api/v1/calendar/google/callback`, z. B.
   `https://api.example.de/api/v1/calendar/google/callback` (lokal:
   `http://localhost:3000/api/v1/calendar/google/callback`).
6. Client-ID und Secret in `.env` eintragen: `GOOGLE_CALENDAR_CLIENT_ID`,
   `GOOGLE_CALENDAR_CLIENT_SECRET`.

### Einrichtung Microsoft 365 (Entra ID)

1. <https://entra.microsoft.com/> → „Identität“ → „Anwendungen“ → „App-Registrierungen“ →
   „Neue Registrierung“.
2. Unterstützte Kontotypen: für alle Firmen und privaten Konten „Konten in einem beliebigen
   Organisationsverzeichnis und persönliche Microsoft-Konten“ → `MICROSOFT_CALENDAR_TENANT=common`.
   Nur eigene Organisation: „Einzelner Mandant“ → Mandanten-ID eintragen.
3. Umleitungs-URI, Plattform **Web**: `<API_URL>/api/v1/calendar/microsoft/callback`.
4. „Zertifikate & Geheimnisse“ → neuer geheimer Clientschlüssel. Den **Wert** (nicht die ID)
   als `MICROSOFT_CALENDAR_CLIENT_SECRET` eintragen und das Ablaufdatum notieren.
5. „API-Berechtigungen“ → Microsoft Graph → Delegiert: `Calendars.ReadBasic` und
   `offline_access`. `Calendars.ReadBasic` braucht keine Administratorzustimmung. Je nach
   Mandanten-Richtlinie kann trotzdem eine Admin-Zustimmung verlangt werden.
6. Anwendungs-ID (Client) als `MICROSOFT_CALENDAR_CLIENT_ID` eintragen.

### Umgebungsvariablen

| Variable                          | Bedeutung                                                     |
| --------------------------------- | ------------------------------------------------------------- |
| `GOOGLE_CALENDAR_CLIENT_ID`       | OAuth-Client (Webanwendung) aus der Google Cloud Console      |
| `GOOGLE_CALENDAR_CLIENT_SECRET`   | zugehöriges Secret                                            |
| `MICROSOFT_CALENDAR_CLIENT_ID`    | Anwendungs-ID der Entra-App-Registrierung                     |
| `MICROSOFT_CALENDAR_CLIENT_SECRET`| geheimer Clientschlüssel (Wert)                               |
| `MICROSOFT_CALENDAR_TENANT`       | `common` (Standard), `organizations`, `consumers` oder Mandanten-ID |
| `CALENDAR_SYNC_INTERVAL_MIN`      | Abstand des automatischen Abrufs in Minuten (5–1440, Standard 60) |
| `API_URL`                         | öffentliche Adresse der API; daraus entsteht die Redirect-URI |

Fehlen Client-ID oder Secret eines Anbieters, ist er in den Apps als „nicht eingerichtet“
markiert. Rücksprünge nach der Anmeldung sind nur zu `ADMIN_URL`, `APP_URL` und
`SSO_REDIRECT_ORIGINS` erlaubt.

## 3. Homeoffice-Nachweis

- Jedes Arbeitsnetz hat einen Ort: `office` (Büro), `home` (Homeoffice) oder `other`. Bestehende
  Netze sind `office` (Migration `0005`).
- Tagesort (`dayLocation`):
  - `office`, wenn mindestens 15 Minuten (`minOfficeMin`) Arbeitszeit in einem Büro-Netz liegen;
  - sonst `home`, wenn mehr als die Hälfte der Arbeitszeit in einem Homeoffice-Netz liegt;
  - sonst `other` (unterwegs/unbekannt).

  Ein manueller Tagesort überschreibt die Automatik und ist gesperrt. Gespeichert wird er nur
  anhängend in `day_locations`; der jüngste Eintrag gewinnt, `null` heißt wieder automatisch.
- Jahresübersicht mit Homeoffice-Tagen je Monat und rechnerischer Tagespauschale. Export als
  CSV/PDF (`GET /locations/export?year=`).
- Tagespauschale nach **§ 4 Abs. 5 Satz 1 Nr. 6c EStG**: 6 € je Tag, höchstens 1.260 € im Jahr
  (210 Tage), seit 2023 und 2026 unverändert. Voraussetzung ist, dass an dem Tag überwiegend zu
  Hause gearbeitet und die erste Tätigkeitsstätte nicht aufgesucht wird (Ausnahme: Für die
  Tätigkeit steht dauerhaft kein anderer Arbeitsplatz zur Verfügung). Der Auftrag nannte Nr. 6b;
  das ist das häusliche Arbeitszimmer, die Tagespauschale steht in Nr. 6c. Die Beträge sind
  Konfiguration (`HOME_OFFICE_DAY_CENTS=600`, `HOME_OFFICE_MAX_CENTS=126000`). Die Regel „Büro ab
  15 Minuten“ bildet die Bedingung „erste Tätigkeitsstätte nicht aufgesucht“ vereinfacht ab. Der
  Nachweis ist ausdrücklich keine Steuerberatung.

**Entscheidung Firma:** Admins sehen **nur die Anzahl** der Homeoffice-Tage je Monat und Person
(z. B. für eine Bescheinigung). Sie sehen keine Tagesdetails und keine Orte. Auch das nur, wenn
die Organisation `homeOfficeReport` einschaltet (Standard aus). Jeder Abruf steht im Audit-Log
(`home_office.view`). Begründung: Der Arbeitsort einzelner Tage ist ein Bewegungsprofil und für
die Arbeitszeiterfassung nicht nötig (Datenminimierung, Art. 5 Abs. 1 lit. c DSGVO). Die
Monatszahl reicht für Bescheinigungen. Vor dem Einschalten sind die Mitglieder zu informieren;
ggf. ist der Betriebsrat zu beteiligen (§ 87 Abs. 1 Nr. 6 BetrVG).

## Datenschutz und Löschung

- Netzwerk-Kennungen bleiben HMAC; es werden keine Koordinaten oder fremden SSIDs gespeichert.
- Datenauskunft (`/me/export`): eigene Projekte, Zuordnungen, Tagesorte, Kalender-Verbindungen
  (ohne Token) und Termine (ohne Titel).
- Kontolöschung und Lösch-Job: Zuordnungen und Tagesorte folgen der Aufbewahrungsfrist der
  Organisation. Kalendertermine werden nach 13 Monaten gelöscht. Nicht abgeschlossene Anmeldungen
  werden nach Ablauf gelöscht.
- Ohne Konto („Nur lokal“ auf dem Handy) gibt es diese Funktionen nicht. Aufteilung und Kalender
  brauchen den Server.

## Quellen (geprüft am 20.10.2026)

- Google Calendar API, Events: list –
  <https://developers.google.com/workspace/calendar/api/v3/reference/events/list>
- Google Calendar API, Bereiche –
  <https://developers.google.com/workspace/calendar/api/auth>
- Google OAuth 2.0 für Webserver-Anwendungen (Code-Flow, `access_type=offline`, PKCE, Widerruf) –
  <https://developers.google.com/identity/protocols/oauth2/web-server>
- Microsoft Graph, List calendarView –
  <https://learn.microsoft.com/en-us/graph/api/user-list-calendarview>
- Microsoft Graph, event-Ressource (`showAs`, `isAllDay`, `isCancelled`) –
  <https://learn.microsoft.com/en-us/graph/api/resources/event>
- Microsoft Graph, Berechtigungen (`Calendars.ReadBasic`) –
  <https://learn.microsoft.com/en-us/graph/permissions-reference>
- Microsoft identity platform, Authorization Code Flow mit PKCE –
  <https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow>
- Microsoft identity platform, Bereiche und `offline_access` –
  <https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc>
- § 4 EStG – <https://www.gesetze-im-internet.de/estg/__4.html>
- Haufe, Homeoffice-Pauschale –
  <https://www.haufe.de/steuern/finanzverwaltung/betriebsausgabenwerbungskosten-homeoffice-pauschale_190_543844.html>
- lohnklar.de, Homeoffice-Pauschale 2026 – <https://lohnklar.de/homeoffice-pauschale-2026>

## 👤 Prüfanleitung

Diese Punkte sind nur mit echten Konten bzw. Geräten prüfbar und **nicht** automatisiert getestet.

1. **Google verbinden:** Google-OAuth-Client wie oben einrichten, Testnutzer eintragen, Server
   mit `GOOGLE_CALENDAR_*` starten. Desktop → Einstellungen → Kalender → „Google Kalender
   verbinden“ → Adresse im Browser öffnen → zustimmen. Erwartet: Bestätigungsseite „Kalender
   verbunden“, in der App „Verbunden · zuletzt abgerufen …“. In der Datenbank prüfen:
   `select * from calendar_entries` enthält keine Titel; `calendar_connections.refresh_token`
   ist kein Klartext.
2. **Microsoft verbinden:** wie 1 mit einem Geschäftskonto und einem privaten Outlook-Konto
   (`MICROSOFT_CALENDAR_TENANT=common`). Im Zustimmungsdialog steht nur „Allgemeine
   Kalenderinformationen lesen“ und „Zugriff behalten“.
3. **Handy:** Einstellungen → Kalender → verbinden. Erwartet: Browser öffnet sich; nach der
   Zustimmung zurück in die App wechseln, „Jetzt abrufen“.
4. **Web-Admin:** „Mein Kalender“ → verbinden. Erwartet: Rücksprung auf den Web-Admin mit
   „Kalender verbunden.“
5. **Vorschläge:** Termin über eine Mittagspause (Laptop ≥ 15 min gesperrt) anlegen, abrufen.
   Erwartet: „Zu prüfen“ zeigt „Termin während der Pause …“. Erst „War Arbeit (Termin)“ ändert
   die Arbeitszeit. Ganztägigen Abwesenheitstermin anlegen (Google: „Abwesend“, Outlook:
   „Abwesend“ ganztägig) → Vorschlag „Als Urlaub eintragen“.
6. **Stichwort:** Projekt mit Stichwort „ACME“ anlegen, Termin „Review ACME“ während der
   Arbeitszeit → Tagesprotokoll zeigt den Abschnitt beim Projekt. Manuell „ohne Projekt“ wählen →
   bleibt so, auch nach erneutem Abruf.
7. **Trennen:** Google trennen → Freigabe ist unter <https://myaccount.google.com/permissions>
   verschwunden. Microsoft trennen → Termine gelöscht; Freigabe von Hand unter myapps entfernen.
8. **Widerruf beim Anbieter:** Freigabe direkt beim Anbieter entziehen, „Jetzt abrufen“.
   Erwartet: „Abruf fehlgeschlagen (invalid_grant). Bitte neu verbinden.“
9. **Homeoffice:** Netz „Zuhause“ auf Ort Homeoffice stellen, einen Tag dort arbeiten.
   Erwartet: Auswertung → Homeoffice-Tage 1, rechnerisch 6,00 €. CSV und PDF exportieren und in
   Excel bzw. einem PDF-Betrachter öffnen (Umlaute, Spalten).
10. **Desktop-Download:** CSV-Export in der Desktop-App unter Windows (WebView2) und macOS
    (WKWebView) prüfen. Der Download über einen Blob-Link ist in Webviews nicht überall
    erlaubt; falls nichts gespeichert wird, als Fehler melden.
11. **Firma:** Admin schaltet „Homeoffice-Tage je Monat für Admins“ ein → Web-Admin →
    Homeoffice zeigt nur Monatszahlen, Audit-Log „Homeoffice-Zahlen abgerufen“.
12. **Google-Verifizierung** vor dem Livebetrieb mit externen Nutzern beantragen.
