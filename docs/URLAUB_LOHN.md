# Urlaubs- und Überstundenkonto, Lohn-Export

Dieses Dokument beschreibt Urlaubskonto, Anträge, Überstundenkonto und den Lohn-Export (DATEV LODAS, DATEV Lohn und Gehalt, Lexware lohn+gehalt, Personio). Es enthält die geprüften Quellen, die getroffenen Entscheidungen und eine 👤-Prüfanleitung. Die Hinweise zum Urlaubsrecht sind keine Rechtsberatung.

## Überblick

| Bereich            | Wo                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Rechenlogik        | `packages/rules/src/leave.ts` (reine Funktionen, Unit- und Property-Tests)                 |
| API                | `apps/backend/src/routes/leave.ts` (eigenes Konto), `routes/org/leave.ts`, `routes/org/payroll.ts` |
| Dateiformate       | `apps/backend/src/payroll/formats.ts`, Golden-Files in `apps/backend/test/golden/`          |
| Personio           | `apps/backend/src/payroll/personio.ts` (API v2)                                             |
| Datenbank          | Migration `drizzle/0006_leave_payroll.sql` mit RLS                                          |
| Oberflächen        | Desktop „Urlaub“, Handy „Übersicht → Urlaub und Überstunden“, Web-Admin „Urlaub“ und „Lohn“ |

## Urlaubskonto

- **Anspruch** je Jahr: Privat pflegt die Person ihn selbst (Desktop/Handy: `PUT /leave/profile`), in der Firma der Admin (Web-Admin „Urlaub → Konten der Mitglieder“). Ohne eigenen Wert gilt der Standard der Organisation (`defaultAnnualDays`, Standard 30 Tage bei 5 Tagen je Woche).
- **Teilzeit:** Anspruch × Arbeitstage je Woche ÷ Standard-Arbeitstage (z. B. 30 × 4/5 = 24).
- **Eintritt/Austritt im Jahr:** 1/12 je vollem Beschäftigungsmonat (§ 5 BUrlG; Monatsfristen nach § 188 BGB). Bruchteile ab einem halben Tag werden aufgerundet, kleinere bleiben stehen (§ 5 Abs. 2 BUrlG). Ergebnis auf zwei Nachkommastellen.
- **Halbe Tage:** erster und/oder letzter Tag eines Antrags können halb sein; Korrekturen in halben Schritten.
- **Arbeitstage:** Es zählen nur Tage mit Sollzeit laut Sollzeitplan, ohne Wochenenden und gesetzliche Feiertage des Bundeslands (gleiche Logik wie die Arbeitszeitberechnung, `targetMinutes`).
- **Kontostand:** Anspruch + Übertrag + Korrektur − genommen (vergangene Urlaubstage) − geplant (genehmigte künftige Tage) = Rest; zusätzlich „beantragt“ (offene Anträge) und „Rest nach offenen Anträgen“. Auch frei eingetragene Urlaubs-Abwesenheiten (Privatkonto) zählen; ein Tag mit weniger als ¾ der Sollzeit zählt als halber Tag.
- **Übertrag** ins Folgejahr: Rest des Vorjahres. Er wird zuerst verbraucht. Mit aktivem Verfall verfällt der bis zum Stichtag (Standard 31.03., `carryOverExpiry` als MM-TT, § 7 Abs. 3 BUrlG) nicht genommene Teil. Verfall abschaltbar (`carryOverExpires`). Ein manuell gesetzter Übertrag (Admin bzw. privat selbst, mit Kommentar) ersetzt die Automatik.
- **Hinweis BAG (Text in allen Oberflächen, keine Rechtsberatung):** Nach EuGH (6.11.2018, C-684/16 „Max-Planck“) und BAG (19.2.2019, 9 AZR 423/16) verfällt Urlaub nur, wenn der Arbeitgeber rechtzeitig auf den Resturlaub und den drohenden Verfall hingewiesen hat. TimeLog prüft das nicht; ohne Hinweis sollte der Verfall ausgeschaltet bleiben.
- Ein ausreichender Rest wird **nicht erzwungen**; das Konto zeigt den Stand an.

## Anträge

| Konto  | Ablauf                                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Privat | Antrag ist sofort genehmigt; es entstehen Abwesenheiten je Arbeitstag.                                                                    |
| Firma  | Antrag ist offen. E-Mail an die Teamleitung (sonst an alle Admins), nie an die Person selbst. Manager oder Admin genehmigen oder lehnen ab (Ablehnung mit Pflichtkommentar). Selbstgenehmigung ist verboten (API und RLS). |

- Arten: **Urlaub** und **Überstundenabbau**. Genehmigte Anträge erzeugen Abwesenheiten (`absences.request_id`); diese ändert nur der Antrag. Frei erfasste Abwesenheiten (Krank, Sonstiges) bleiben wie bisher; Firmenmitglieder können Urlaub und Überstundenabbau nur noch per Antrag eintragen (`409 leave_request_required`).
- **Stornierung:** die Person selbst bis vor Beginn; danach nur ein Admin mit Begründung. Jede Aktion (beantragt, genehmigt, abgelehnt, storniert) steht unveränderlich in `leave_request_events` und in der Firma im Audit-Log (`leave.*`).
- **Überschneidungen:** Ein Antrag darf weder einen eigenen offenen/genehmigten Antrag noch eine eigene Abwesenheit überlappen (`409 overlapping_request`). Manager sehen bei offenen Anträgen, wer im selben Team gleichzeitig abwesend ist (nur Name und Zeitraum).
- **Teamkalender** (Web-Admin): Name und Zeitraum; Krankheit, Feiertag und Sonstiges erscheinen nur als „abwesend“, offene Anträge als „beantragt“.
- **Freigegebene Monate:** Neue Anträge und Stornierungen, die einen freigegebenen Monat berühren, lehnt die API ab (`409 month_locked`). Ein Admin kann trotzdem genehmigen; die Monatsfreigabe wird dann zurückgesetzt (Audit `approval.reopen`) und muss neu erteilt werden – der Snapshot wird nie still überschrieben.
- **Push:** Für Push-Benachrichtigungen gibt es den Einhängepunkt `AppOptions.push` (`apps/backend/src/leave/notify.ts`, Standard: keine Aktion).

## Überstundenkonto

- Saldo-Verlauf je Monat des Jahres bis heute, mit Vortrag aus den Vorjahren. Freigegebene Monate kommen aus dem Snapshot.
- **Überstundenabbau** ist eine eigene Abwesenheitsart (`overtime`): 0 Minuten Gutschrift, die Sollzeit bleibt – der Saldo sinkt um die Sollzeit des Tages. Die abgebauten Minuten werden je Monat nur zur Information gezeigt.
- **Manuelle Buchungen** (Auszahlung, Kappung, Korrektur) bucht in der Firma nur der Admin mit Kommentar (Audit `overtime.book`), nie am eigenen Konto; privat die Person selbst. Buchungen sind nur anhängbar.
- **Höchstsaldo** (optional, `maxOvertimeMinutes`): darüber erscheint eine Warnung; es wird nichts automatisch gekappt.

## Lohn-Export (Firma, nur Admin)

Grundsätze:

- Exportiert werden **nur freigegebene Monate**. Die Arbeitstage stammen aus dem Snapshot der Freigabe, die Abwesenheiten aus dem bei der Freigabe mitgespeicherten Abwesenheits-Snapshot (`approvals.absences_snapshot`; ältere Freigaben ohne diesen: aus der Tabelle). Es wird nichts neu berechnet.
- Mitglieder ohne Freigabe oder ohne Personalnummer werden übersprungen; die Kopfzeilen `x-timelog-exported` / `x-timelog-skipped` nennen die Anzahl. Jeder Export steht im Audit-Log (`payroll.export`).
- Stunden = Netto-Arbeitszeit des Monats (nach ausgewiesener Pausenauffüllung). Urlaub, Krankheit und Überstundenabbau werden als Tage bzw. Stunden je Lohnart übergeben; Feiertage nicht (rechnet das Lohnprogramm).
- **Lohnarten** je Art, DATEV-Berater-/Mandantennummer, LODAS-Ausfallschlüssel und Lexware-Lohnartnummern sind Organisationseinstellungen (Web-Admin „Lohn“). Die **Personalnummer** pflegt der Admin je Mitglied (bis 19 Zeichen).
- Dateien: Windows-1252 („ANSI“), Zeilenende CR/LF, Semikolon, Dezimalkomma.

### DATEV LODAS (ASCII-Import, `datev_lodas`)

Aufbau nach dem LODAS-Schnittstellenhandbuch (ASCII-Import): Abschnitt `[Allgemein]` (`Ziel=LODAS`, `Version_SST=1.0`, `BeraterNr`, `MandantenNr`, `Datumsformat=TT/MM/JJJJ`, `Feldtrennzeichen=;`, `Zahlenkomma=,`, `Kommentarzeichen=*`), `[Satzbeschreibung]` und `[Bewegungsdaten]`:

```
[Satzbeschreibung]
1;u_lod_bwd_buchung_standard;abrechnung_zeitraum#bwd;bs_wert_butab#bwd;bs_nr#bwd;la_eigene#bwd;pnr#bwd;
2;u_lod_bwd_buchung_kalendarium;abrechnung_zeitraum#bwd;kalendertag#bwd;kalenderwoche#bwd;wochentag#kal;pnr#bwd;stunden_pro_tag#bwd;la_eigene#bwd;as_kal#bwd;

[Bewegungsdaten]
1;01/10/2026;164,50;01;100;00042;
2;01/10/2026;05;41;Mo;00042;8,00;300;U;
```

Satz 1: Stunden je Person als Standardbuchung mit Bearbeitungsschlüssel 01 (Stunden). Satz 2: je Abwesenheitstag eine Kalendariumsbuchung mit Stunden des Tages, Lohnart und Ausfallschlüssel (nur wenn beide konfiguriert sind). Golden-File: `apps/backend/test/golden/lohn_datev_lodas_2026-10.txt`.

### DATEV Lohn und Gehalt (`datev_lug`)

LuG importiert Bewegungsdaten über ein einmal im Programm angelegtes ASCII-Importformat (Formatverwaltung). TimeLog liefert eine Semikolon-Datei mit Kopfzeile `Personalnummer;Abrechnungsmonat;Lohnart;Stunden;Tage` (Monat als MM/JJJJ), je Person und Lohnart eine Zeile. Das Importformat muss diese Spalten zuordnen (👤). Golden-File: `lohn_datev_lug_2026-10.csv`.

### Lexware lohn+gehalt (`lexware`)

„Lohndaten importieren“ (Import-ASCII) mit den Pflichtfeldern `Jahr;Monat;Personalnummer;Lohnartnummer;Wert`, Semikolon, Dezimalkomma, ANSI, mit Kopfzeile. Stunden als Wert in Stunden, Abwesenheiten in Tagen. Golden-File: `lohn_lexware_2026-10.csv`.

### Personio (API v2)

- Zugang: Client-ID und Secret aus Personio (Einstellungen → API-Zugangsdaten, Recht „Attendances“ schreiben und „Persons“ lesen). Das Secret wird mit AES-256-GCM verschlüsselt gespeichert (Schlüssel `TOTP_ENCRYPTION_KEY`, wie bei TOTP) und nie ausgegeben. Keine neue Umgebungsvariable.
- Ablauf: `POST /v2/auth/token` (client_credentials) → Person je Mitglied über die hinterlegte Personio-ID oder per `GET /v2/persons?email=` → je Arbeitstag die tatsächlichen Arbeitsabschnitte (Sitzungen minus Pausen) aus dem Snapshot als `POST /v2/attendance-periods` mit `type: WORK` und lokaler Zeit ohne Offset (Zeitzone der Person). Optional `skip_approval=true` (Standard, da der Monat in TimeLog freigegeben ist).
- Eine erneute Übertragung desselben Monats entfernt zuvor angelegte Perioden (`DELETE /v2/attendance-periods/{id}`) und legt sie neu an.
- Ergebnisprotokoll je Übertragung und Person (übertragen, übersprungen, fehlgeschlagen mit Personio-Fehlercode) in `payroll_transfers` (nur anhängbar), Audit `payroll.transfer`.
- Die abgezogene Pausenauffüllung (§ 4 ArbZG) wird nicht als Periode übertragen; Personio sieht die tatsächlichen Zeiten.
- v1 (`/company/attendances`) ist abgekündigt (Abschaltung laut Personio-Changelog zum 31.01.2027) und wird nicht verwendet.

## Quellen (geprüft im Oktober 2026)

| Thema       | Quelle                                                                                                                                                 | Hinweis                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DATEV LODAS | DATEV, „Schnittstellenhandbuch LODAS – ASCII-Import“ (Musterdatei mit `[Allgemein]`, `[Satzbeschreibung]`, `[Bewegungsdaten]`, Tabellen `u_lod_bwd_buchung_standard`, `u_lod_bwd_buchung_kalendarium`) | Die aktuelle DATEV-Hilfe (help-center.apps.datev.de) war aus der Entwicklungsumgebung nicht abrufbar; geprüft wurde gegen eine ältere Ausgabe des Handbuchs. **👤 gegen die aktuelle Ausgabe prüfen.** |
| DATEV LuG   | DATEV-Hilfe „ASCII-Import von Bewegungsdaten in Lohn und Gehalt“ (Importassistent, Formatverwaltung)                                                   | Format ist benutzerdefiniert; Spaltenzuordnung 👤                                                                                                          |
| Lexware     | Lexware lohn+gehalt Hilfe „Lohndaten importieren“ (Import-ASCII; Pflichtfelder Jahr, Monat, Personalnummer, Lohnartnummer, Wert)                      | 👤 in der eingesetzten Programmversion prüfen                                                                                                              |
| Personio    | https://developer.personio.de/reference/post_v2-auth-token, https://developer.personio.de/reference/get_v2-persons, https://developer.personio.de/reference/post_v2-attendance-periods, https://developer.personio.de/reference/delete_v2-attendance-periods-id, Personio-Changelog (Abkündigung v1) | Tests laufen gegen eine nachgebildete API (`apps/backend/test/payroll.test.ts`)                                                                            |
| Urlaubsrecht | §§ 3, 5, 7 BUrlG; § 188 BGB; EuGH C-684/16; BAG 9 AZR 423/16                                                                                          | keine Rechtsberatung                                                                                                                                       |

## Entscheidungen

- Arbeitszeitlogik (Arbeitstage, Anspruch, Kontostand, Saldo-Verlauf, Lohn-Summen, Arbeitsabschnitte) liegt ausschließlich in `@timelog/rules`; Backend und Clients formatieren nur.
- Kein Erzwingen eines ausreichenden Rests; Anzeige genügt.
- Überstundenabbau speichert die abgebauten Minuten in der Abwesenheit (Information), gutgeschrieben werden 0 Minuten.
- Benachrichtigung an die Teamleitung, ohne Team an alle Admins; die Notiz des Antrags steht nicht in der E-Mail.
- LuG nutzt ein selbst definiertes Semikolon-Format, LODAS folgt der Handbuch-Musterdatei.
- Personio: nur v2, Arbeitsabschnitte statt Tagessummen, vorherige Perioden werden ersetzt.
- Der Web-Admin ist (wie bisher) deutsch; Desktop und Handy haben Deutsch und Englisch.

## 👤 Prüfanleitung

1. **DATEV LODAS:** Mit der Steuerberatung bzw. in einem LODAS-Testmandanten Berater-/Mandantennummer, Lohnart für Stunden (z. B. eigene Lohnart „Stundenlohn“), Lohnarten und Ausfallschlüssel für Urlaub/Krankheit/Abbau abstimmen und im Web-Admin „Lohn“ eintragen. Einen Monat freigeben, „DATEV LODAS“ herunterladen und in LODAS über „Mandant → Daten übernehmen → ASCII-Import“ einlesen. Prüfen: Import ohne Fehlerprotokoll, Stunden je Personalnummer richtig, Kalendarium zeigt die Ausfalltage. Abweichungen der Satzbeschreibung gegen die aktuelle Handbuchausgabe abgleichen und hier nachtragen.
2. **DATEV Lohn und Gehalt:** Im Testmandanten ein ASCII-Importformat mit den Spalten Personalnummer, Abrechnungsmonat (MM/JJJJ), Lohnart, Stunden, Tage anlegen (Trennzeichen Semikolon, Dezimalkomma, erste Zeile überspringen). Datei importieren und Bewegungsdaten prüfen.
3. **Lexware lohn+gehalt:** In einer Testfirma „Datei → Import → Lohndaten importieren“ wählen, die Datei „Lexware lohn+gehalt“ einlesen (Kopfzeile vorhanden, Semikolon). Prüfen: Lohnarten werden gefunden, Werte stimmen.
4. **Personio:** In einer Personio-Sandbox API-Zugangsdaten mit Schreibrecht für Anwesenheiten anlegen, im Web-Admin hinterlegen, Mitglieder per E-Mail oder Personio-ID zuordnen, einen freigegebenen Monat übertragen. Prüfen: Anwesenheiten mit richtigen Uhrzeiten (lokale Zeit), erneute Übertragung erzeugt keine Dubletten, Fehler (z. B. gesperrter Zeitraum) erscheinen im Ergebnisprotokoll.
5. **Urlaubsrecht:** Den BAG-Hinweistext und das Verfallsdatum mit der Personalabteilung abstimmen.
