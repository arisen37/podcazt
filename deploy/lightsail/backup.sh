#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run with sudo.' >&2; exit 1; fi
cd /opt/podcazt/deploy/lightsail
exec 9>/var/backups/podcazt/.backup.lock
flock -n 9 || exit 0
backup_name="postgres-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
trap 'if [[ -f "/var/backups/podcazt/$backup_name" ]]; then unlink "/var/backups/podcazt/$backup_name"; fi' EXIT
umask 077
docker compose exec -T postgres pg_dump -U podcazt -d podcazt --no-owner --no-acl | gzip > "/var/backups/podcazt/$backup_name"
chmod 0644 "/var/backups/podcazt/$backup_name"
docker compose run --rm --no-deps \
  -v "/var/backups/podcazt/$backup_name:/backup.sql.gz:ro" \
  web node deploy/lightsail/upload-backup.mjs /backup.sql.gz "backups/$backup_name"
