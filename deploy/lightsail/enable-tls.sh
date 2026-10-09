#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run with sudo after DNS points to this instance.' >&2; exit 1; fi
cd "$(dirname "$0")"
bash setup-config.sh --write
read_config() { awk -v key="$1" 'index($0,"=") {name=substr($0,1,index($0,"=")-1); gsub(/^[[:space:]]+|[[:space:]]+$/,"",name); if(name==key) {value=substr($0,index($0,"=")+1); gsub(/^[[:space:]]+|[[:space:]]+$/,"",value); print value; exit}}' config.env; }
app_domain=$(read_config APP_DOMAIN)
turn_domain=$(read_config TURN_DOMAIN)
acme_email=$(read_config ACME_EMAIL)
install -m 0644 generated/nginx-http.conf /etc/nginx/sites-available/podcazt
ln -sfn /etc/nginx/sites-available/podcazt /etc/nginx/sites-enabled/podcazt
if [[ -L /etc/nginx/sites-enabled/default ]]; then unlink /etc/nginx/sites-enabled/default; fi
nginx -t
systemctl reload nginx
certbot certonly --webroot -w /var/www/certbot \
  --cert-name "$app_domain" -d "$app_domain" -d "$turn_domain" \
  --email "$acme_email" --agree-tos --non-interactive --keep-until-expiring
install -o root -g turnserver -m 0640 generated/turnserver.conf /etc/turnserver.conf
if grep -q '^#\?TURNSERVER_ENABLED=' /etc/default/coturn; then
  sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
else
  echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn
fi
install -m 0755 generated/renew-certificates.sh /etc/letsencrypt/renewal-hooks/deploy/podcazt
install -m 0644 generated/nginx-https.conf /etc/nginx/sites-available/podcazt
RENEWED_LINEAGE="/etc/letsencrypt/live/$app_domain" /etc/letsencrypt/renewal-hooks/deploy/podcazt
systemctl enable --now coturn certbot.timer
echo "TLS enabled for https://$app_domain and turns:$turn_domain:5349."
