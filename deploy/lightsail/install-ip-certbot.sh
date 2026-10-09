#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run with sudo on Ubuntu.' >&2; exit 1; fi
# Ubuntu 24.04's distribution client predates IP certificate support.
apt-get update
apt-get install -y python3-venv
python3 -m venv /opt/certbot
/opt/certbot/bin/pip install --no-cache-dir --upgrade pip 'certbot>=5.4,<6'
ln -sfn /opt/certbot/bin/certbot /usr/local/bin/certbot
install -d -m 0755 /etc/systemd/system/certbot.service.d
cat > /etc/systemd/system/certbot.service.d/podcazt.conf <<'UNIT'
[Service]
ExecStart=
ExecStart=/opt/certbot/bin/certbot -q renew --no-random-sleep-on-renew
UNIT
systemctl daemon-reload
systemctl enable --now certbot.timer
/opt/certbot/bin/certbot --version
