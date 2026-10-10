#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run with sudo after public HTTP validation is reachable.' >&2; exit 1; fi
cd "$(dirname "$0")"
bash setup-config.sh --write
read_config() { awk -v key="$1" 'index($0,"=") {name=substr($0,1,index($0,"=")-1); gsub(/^[[:space:]]+|[[:space:]]+$/,"",name); if(name==key) {value=substr($0,index($0,"=")+1); gsub(/^[[:space:]]+|[[:space:]]+$/,"",value); print value; exit}}' config.env; }
app_domain=$(read_config APP_DOMAIN)
turn_domain=$(read_config TURN_DOMAIN)
acme_email=$(read_config ACME_EMAIL)
tls_mode=$(read_config TLS_MODE)
certbot_bin=$(command -v certbot)
if [[ -x /opt/certbot/bin/certbot ]]; then certbot_bin=/opt/certbot/bin/certbot; fi
if [[ "$tls_mode" == ip ]]; then
  version=$("$certbot_bin" --version | awk '{print $2}')
  if ! dpkg --compare-versions "$version" ge 5.4.0; then
    echo 'IP certificates require Certbot >=5.4. Run install-ip-certbot.sh first.' >&2
    exit 1
  fi
fi
site_config=/etc/nginx/sites-available/podcazt
if [[ -f "$site_config" ]]; then
  # Existing Podcazt sites already serve HTTP-01, including for new hostnames
  # on this dedicated server. Keep their HTTPS listener until issuance succeeds.
  if ! grep -Fq 'location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; }' "$site_config"; then
    echo 'Existing Nginx site must serve /var/www/certbot for HTTP-01 validation.' >&2
    exit 1
  fi
else
  install -m 0644 generated/nginx-http.conf "$site_config"
fi
ln -sfn /etc/nginx/sites-available/podcazt /etc/nginx/sites-enabled/podcazt
if [[ -L /etc/nginx/sites-enabled/default ]]; then unlink /etc/nginx/sites-enabled/default; fi
nginx -t
systemctl reload nginx
account_args=(--register-unsafely-without-email)
if [[ -n "$acme_email" ]]; then account_args=(--email "$acme_email"); fi
identifier_args=(-d "$app_domain" -d "$turn_domain")
if [[ "$tls_mode" == ip ]]; then identifier_args=(--ip-address "$app_domain" --preferred-profile shortlived); fi
"$certbot_bin" certonly --webroot -w /var/www/certbot \
  --cert-name "$app_domain" "${identifier_args[@]}" \
  "${account_args[@]}" --agree-tos --non-interactive --keep-until-expiring
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
