#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run with sudo on Ubuntu 24.04.' >&2; exit 1; fi
. /etc/os-release
if [[ "$ID" != ubuntu || "$VERSION_ID" != 24.04 ]]; then
  echo 'This script supports Ubuntu 24.04 LTS.' >&2; exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-buildx docker-compose-v2 nginx certbot coturn ufw
systemctl enable --now docker nginx
# Do not expose an unconfigured TURN service before installing authentication.
systemctl disable --now coturn
install -d -m 0755 /opt/podcazt /var/www/certbot /etc/coturn/certs
install -d -m 0700 /var/backups/podcazt
# Small instances need headroom; bootstrap before any on-host image build.
if ! swapon --show=NAME --noheadings | grep -q .; then
  if [[ ! -e /swapfile ]]; then
    fallocate -l 1G /swapfile
    chmod 0600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
  if ! grep -q '^/swapfile ' /etc/fstab; then echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
fi
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3478/udp
ufw allow 3478/tcp
ufw allow 5349/tcp
ufw allow 49160:49259/udp
ufw --force enable
echo 'Host ready. Configure the same ports in the EC2 security group or Lightsail firewall; restrict SSH there to your IP.'
