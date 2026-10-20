# Firmenversion: Web-Admin und SSO

Dieses Dokument beschreibt die Einrichtung der Firmenversion (Phase 6) und wie SSO mit einem echten Identity Provider (IdP) geprüft wird. Automatisch getestet ist SSO nur gegen nachgebildete IdPs (`apps/backend/test/sso.test.ts`: OIDC-Server mit `jose`, SAML-Antworten mit `xml-crypto` signiert). Die Prüfung mit Microsoft Entra ID und Google steht noch aus (👤).

## Rollen und Sichtbarkeit

| Rolle   | Darf                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Mitglied | eigene Zeiten in Desktop- und Mobile-App, Monat einreichen, Urlaub und Überstundenabbau beantragen und vor Beginn stornieren          |
| Manager | Freigaben und Mitglieder **seiner Teams** (Name, Team), Teamliste; je Tag nur Beginn, Ende, Pausensumme, Auffüllung, Netto, Status, Hinweise; Urlaubsanträge seiner Teams genehmigen/ablehnen, Teamkalender, Konten seiner Teams lesen |
| Admin   | alles in der Organisation: Mitglieder, Rollen, Teams, Einladungen, Sollzeiten, Firmen-Netze, Regelwerk-Parameter, SSO, Export, Audit-Log; Urlaubsanspruch, Übertrag, Korrekturen, Überstunden-Buchungen, Stornierung begonnener Anträge, Lohn-Export und Personio |

- Sitzungen, Quellen, Rohereignisse und Geräte sieht niemand außer der Person selbst. Die Prüfung sitzt zentral im Fastify-Hook `requireOrgRole` (`apps/backend/src/routes/org/access.ts`) und zusätzlich in PostgreSQL-RLS (`drizzle/0003_org_rls.sql`).
- Manager und Admins brauchen Zwei-Faktor (TOTP); eine SSO-Anmeldung ersetzt ihn.
- Den eigenen Monat kann niemand selbst freigeben.
- Freigegebene Monate werden als Snapshot gespeichert und nie neu berechnet. Korrigiert ein Admin einen Tag in einem freigegebenen Monat, wird die Freigabe zurückgesetzt (Status „eingereicht“, Audit-Eintrag `approval.reopen`).
- Alle Admin- und Freigabe-Aktionen stehen im Audit-Log (nur lesbar für Admins, nicht änderbar).

## Urlaub, Überstunden und Lohn

Details, Quellen und 👤-Prüfanleitung: [URLAUB_LOHN.md](URLAUB_LOHN.md).

- **Urlaub** (Manager und Admin): offene Anträge mit Überschneidungen im Team genehmigen oder mit Kommentar ablehnen, Teamkalender (nur Name und Zeitraum, Krankheit als „abwesend“), eigener Antrag (entscheidet eine andere Person), Konten der Mitglieder. Admins pflegen dort Anspruch (Teilzeit, Ein-/Austritt), Übertrag, Korrekturen, Überstunden-Buchungen und die Urlaubseinstellungen der Organisation (Standardanspruch, Verfall mit Stichtag, Höchstsaldo).
- **Lohn** (nur Admin): Lohnarten, DATEV-Berater-/Mandantennummer, LODAS-Ausfallschlüssel, Personalnummern und Personio-IDs, Lohndatei für DATEV LODAS, DATEV Lohn und Gehalt oder Lexware lohn+gehalt (nur freigegebene Monate), Personio-Zugang (verschlüsselt) mit „Übertragen“ und Ergebnisprotokoll.
- Neue Audit-Einträge: `leave.request`, `leave.approve`, `leave.reject`, `leave.cancel`, `leave.settings`, `leave.profile`, `leave.adjust`, `overtime.book`, `payroll.config`, `payroll.member`, `payroll.export`, `payroll.credentials`, `payroll.credentials.delete`, `payroll.transfer`.
- RLS für die neuen Tabellen steht in `drizzle/0006_leave_payroll.sql`: Anträge sieht die Person selbst und wer sie im Team sehen darf; entscheiden dürfen nur Manager/Admin über andere; Antragshistorie, Konto-Buchungen und Übertragungsprotokoll sind nur anhängbar; Lohn-Zuordnung, Zugangsdaten und Protokoll nur für Admins.

## Web-Admin starten

```sh
pnpm build
pnpm --filter @timelog/backend dev     # API auf http://localhost:3000
pnpm --filter @timelog/admin dev       # Web-Admin auf http://localhost:5174 (leitet /api an die API weiter)
```

Relevante Variablen in `.env` (siehe `.env.example`):

| Variable               | Zweck                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `ADMIN_URL`            | Adresse des Web-Admins: Einladungslinks, erlaubter SSO-Rücksprung                         |
| `API_URL`              | öffentliche Adresse der API: OIDC-Callback, SAML-ACS und -Metadaten                       |
| `CORS_ORIGINS`         | nur nötig, wenn der Web-Admin die API über einen anderen Ursprung aufruft                  |
| `SSO_REDIRECT_ORIGINS` | weitere erlaubte Rücksprung-Ursprünge nach SSO                                            |
| `SSO_*`                | Client-Secrets der OIDC-Anbieter; im Web-Admin steht nur der **Name** der Variable        |

In Produktion den Web-Admin (`pnpm --filter @timelog/admin build`, Ausgabe `apps/admin/dist`) und die API am besten unter demselben Ursprung ausliefern (Reverse-Proxy: `/api` → Backend). Sonst `VITE_API_URL` beim Bauen setzen und den Admin-Ursprung in `CORS_ORIGINS` eintragen.

Ablauf beim ersten Mal: Konto registrieren (Desktop- oder Mobile-App oder `POST /api/v1/auth/register`), im Web-Admin anmelden, „Organisation anlegen“ (man wird Admin), Zwei-Faktor einrichten, dann unter „Mitglieder“ einladen.

## SSO einrichten

Im Web-Admin unter **Einstellungen → Single Sign-on**. Voraussetzung ist ein Kurzname der Organisation (z. B. `acme`); daraus ergeben sich die Adressen (`<API_URL>` = Wert aus `.env`):

| Zweck                      | Adresse                                              |
| -------------------------- | ---------------------------------------------------- |
| OIDC-Umleitungs-URI        | `<API_URL>/api/v1/auth/sso/acme/oidc/callback`       |
| SAML Entity-ID / Metadaten | `<API_URL>/api/v1/auth/sso/acme/saml/metadata`       |
| SAML Antwort-URL (ACS)     | `<API_URL>/api/v1/auth/sso/acme/saml/acs`            |

Wer darf sich anmelden: bestehende Mitglieder (Zuordnung über die E-Mail-Adresse, danach fest an das IdP-Konto gebunden), Personen mit offener Einladung, und bei „Unbekannte Personen … anlegen“ alle aus den erlaubten Domains (als Mitglied). Mit „Anmeldung nur über SSO“ ist die Passwort-Anmeldung für Mitglieder und Manager gesperrt; Admins behalten Passwort + Zwei-Faktor als Notzugang.

### Microsoft Entra ID (OIDC)

1. Entra Admin Center → **App-Registrierungen → Neue Registrierung**. Kontotyp „Nur Konten in diesem Organisationsverzeichnis“. Umleitungs-URI: Plattform **Web**, Adresse siehe Tabelle oben.
2. **Zertifikate & Geheimnisse → Neuer geheimer Clientschlüssel**. Den Wert als `SSO_ACME_ENTRA_SECRET=…` in die Server-Umgebung eintragen und die API neu starten.
3. **Tokenkonfiguration → Optionalen Anspruch hinzufügen**: ID-Token, `email`. (Ohne ihn nimmt TimeLog `preferred_username`, meist der UPN.)
4. Im Web-Admin: Anbieter „Microsoft Entra ID“, Issuer `https://login.microsoftonline.com/<Verzeichnis-ID>/v2.0` (mandantenspezifisch, **nicht** `common`), Client-ID = Anwendungs-ID, Variable `SSO_ACME_ENTRA_SECRET`.

### Google Workspace (OIDC)

1. Google Cloud Console → **APIs & Dienste → OAuth-Zustimmungsbildschirm**: Nutzertyp „Intern“.
2. **Anmeldedaten → OAuth-Client-ID erstellen**, Typ „Webanwendung“, autorisierte Weiterleitungs-URI siehe Tabelle.
3. Clientschlüssel als `SSO_ACME_GOOGLE_SECRET=…` in die Server-Umgebung, API neu starten.
4. Im Web-Admin: Anbieter „Google“, Issuer leer lassen (= `https://accounts.google.com`), Client-ID, Variable `SSO_ACME_GOOGLE_SECRET`. Erlaubte Domains auf die Workspace-Domain setzen, da Google auch private Konten anmeldet. Nur bestätigte Adressen (`email_verified`) werden akzeptiert.

### Microsoft Entra ID (SAML)

1. Entra Admin Center → **Unternehmensanwendungen → Neue Anwendung → Eigene Anwendung erstellen** („Nicht-Katalog-Anwendung“) → **Einmaliges Anmelden → SAML**.
2. Grundlegende SAML-Konfiguration: **Bezeichner (Entitäts-ID)** = Metadaten-Adresse, **Antwort-URL** = ACS-Adresse (Tabelle oben). Alternativ die Metadaten-Datei von der Metadaten-Adresse hochladen.
3. Attribute & Ansprüche: Eindeutiger Benutzerbezeichner (NameID) im Format E-Mail-Adresse, Quelle `user.mail`.
4. **SAML-Zertifikate → Zertifikat (Base64)** herunterladen; **Anmelde-URL** und **Microsoft Entra-ID-Bezeichner** kopieren.
5. Im Web-Admin: SAML aktivieren, Anmelde-URL des IdP, Zertifikat einfügen, Entity-ID des IdP = Entra-ID-Bezeichner. Personen oder Gruppen der Anwendung zuweisen.

Hinweise: TimeLog verlangt eine signierte Assertion (Entra-Standard), sendet unsignierte AuthnRequests und prüft `InResponseTo` (vom IdP gestartete Anmeldungen werden abgelehnt).

## 👤 Prüfanleitung mit echtem IdP

Die folgenden Punkte sind **nicht** automatisiert geprüft. Server mit öffentlicher HTTPS-Adresse (oder Tunnel) für `API_URL` und `ADMIN_URL` verwenden.

- [ ] 👤 Entra OIDC: Anmeldung im Web-Admin über „Mit SSO anmelden“ → Kurzname → Microsoft; Rücksprung landet angemeldet in den Freigaben, ohne TOTP-Abfrage.
- [ ] 👤 Entra OIDC ohne optionalen `email`-Anspruch: Anmeldung klappt über `preferred_username`, sofern er der hinterlegten Adresse entspricht.
- [ ] 👤 Google OIDC: Anmeldung mit Workspace-Konto klappt; privates Gmail-Konto wird bei gesetzten Domains mit „Die E-Mail-Domain ist für SSO nicht freigegeben.“ abgelehnt.
- [ ] 👤 Entra SAML: Anmeldung klappt; im Audit-Log erscheint bei automatischer Anlage „Konto per SSO angelegt“.
- [ ] 👤 Falsches Zertifikat im Web-Admin → Anmeldung scheitert mit „Die Antwort des IdP war ungültig.“
- [ ] 👤 Anmeldung aus dem IdP-Portal (IdP-initiiert, „Meine Apps“) wird abgelehnt, nicht stillschweigend angenommen.
- [ ] 👤 Einladung annehmen per SSO: eingeladene Adresse meldet sich direkt über SSO an und wird Mitglied mit der eingeladenen Rolle.
- [ ] 👤 „Anmeldung nur über SSO“: Mitglied mit Passwort → „Deine Organisation verlangt die Anmeldung über SSO.“; Admin mit Passwort + TOTP kommt weiter herein.
- [ ] 👤 Deaktiviertes Mitglied kommt weder per Passwort noch per SSO herein.
- [ ] 👤 Secret-Rotation: neuen Wert in `SSO_…` setzen, API neu starten, Anmeldung klappt; der Wert steht nirgends in Datenbank, Logs oder Web-Admin.
- [ ] 👤 Barrierefreiheit Web-Admin manuell: Tastaturbedienung aller Seiten, Screenreader (NVDA oder VoiceOver) liest Meldungen der Live-Region vor, Kontraste im hellen und dunklen Modus (die automatische axe-Prüfung in jsdom kann Kontraste nicht messen).
