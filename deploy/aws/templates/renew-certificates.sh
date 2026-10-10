#!/usr/bin/env bash
set -euo pipefail
# Called only after Certbot successfully renews the shared certificate.
if [[ "${RENEWED_LINEAGE:-}" != /etc/letsencrypt/live/@@APP_DOMAIN@@ ]]; then exit 0; fi
install -d -o root -g turnserver -m 0750 /etc/coturn/certs
install -o root -g turnserver -m 0640 "$RENEWED_LINEAGE/fullchain.pem" /etc/coturn/certs/fullchain.pem
install -o root -g turnserver -m 0640 "$RENEWED_LINEAGE/privkey.pem" /etc/coturn/certs/privkey.pem
nginx -t
systemctl reload nginx
# Restarting Coturn interrupts relayed calls. Renewal normally runs infrequently.
systemctl restart coturn
