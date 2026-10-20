# Betrieb des Backends

## Container

`apps/backend/Dockerfile` baut ein schlankes Image (Node 22, läuft als Benutzer `node`).
Konfiguration nur über Umgebungsvariablen (Vorlage `.env.example`); die Datenbank-Migrationen
laufen beim Start. Der Container meldet seinen Zustand über `GET /health`.

```sh
docker build -f apps/backend/Dockerfile -t timelog-backend .
```

## Eigener Server mit Docker Compose

`deploy/compose.prod.yml` startet PostgreSQL 16, das Backend und Caddy, der das
TLS-Zertifikat automatisch holt.

1. Server in einem EU-Rechenzentrum mit Docker; DNS-Eintrag `API_DOMAIN` auf den Server.
2. `deploy/.env` anlegen (nicht einchecken) mit `POSTGRES_PASSWORD`, `JWT_SECRET`,
   `TOTP_ENCRYPTION_KEY`, `NETWORK_HMAC_SECRET`, `APP_URL`, `SMTP_URL`, `MAIL_FROM`,
   `API_DOMAIN`. Die Schlüssel erzeugen wie in `.env.example` beschrieben.
3. `docker compose -f deploy/compose.prod.yml --env-file deploy/.env up -d --build`
4. `curl https://API_DOMAIN/health` liefert `{"ok":true}`.

`NETWORK_HMAC_SECRET` nach dem ersten Einrichten von Arbeitsnetzen nicht mehr ändern, sonst
erkennt die App die gespeicherten Netze nicht wieder. Alle Schlüssel gehören zusätzlich in
einen Passwort-Tresor.

Update: `git pull`, dann denselben `up -d --build`-Befehl. Migrationen laufen automatisch.

## Sicherung

`deploy/backup.sh /srv/backups` schreibt einen `pg_dump` (custom format) und löscht Dateien
älter als `BACKUP_KEEP_DAYS` (Standard 30). Per cron täglich ausführen und das Verzeichnis
verschlüsselt außer Haus kopieren (z. B. restic auf einen Speicher in der EU).

Wiederherstellen:

```sh
docker compose -f deploy/compose.prod.yml --env-file deploy/.env exec -T postgres \
  pg_restore -U timelog -d timelog --clean --if-exists < /srv/backups/timelog-….dump
```

## Überwachung

- **Erreichbarkeit:** externer Uptime-Dienst ruft `https://API_DOMAIN/health` jede Minute auf
  und alarmiert nach zwei Fehlschlägen.
- **Logs:** das Backend schreibt JSON nach stdout (`docker compose logs backend`), ohne
  IP-Adressen, Namen oder E-Mail-Adressen. Caddy schreibt keine Zugriffsprotokolle.
- **Platten- und Datenbankgröße** im Blick behalten (Ereignisse sind nur Insert).

## 👤 Prüfung

- [ ] Server aufsetzen, `/health` über HTTPS erreichbar, Zertifikat gültig.
- [ ] Registrierung mit echter Mail (SMTP) funktioniert.
- [ ] Sicherung erstellen und auf einer leeren Datenbank wiederherstellen.
- [ ] Uptime-Alarm auslösen (Backend stoppen) und wieder entwarnen.
- [ ] Auftragsverarbeitungsvertrag mit Hoster und Mail-Anbieter abschließen.
