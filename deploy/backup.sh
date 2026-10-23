#!/bin/sh
# Tägliche Sicherung der Datenbank (z. B. per cron um 02:30). Behält BACKUP_KEEP_DAYS Tage.
# Aufruf aus dem Repository-Wurzelverzeichnis: deploy/backup.sh /pfad/zu/backups
set -eu
target="${1:?Zielverzeichnis fehlt}"
keep="${BACKUP_KEEP_DAYS:-30}"
mkdir -p "$target"
file="$target/timelog-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose -f deploy/compose.prod.yml --env-file deploy/.env exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$file.part"
mv "$file.part" "$file"
find "$target" -name 'timelog-*.dump' -mtime "+$keep" -delete
echo "Sicherung geschrieben: $file"
