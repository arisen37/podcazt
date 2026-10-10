#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run with sudo.' >&2; exit 1; fi
public_key_file=${1:?Usage: sudo bash install-github-deploy.sh /path/to/deploy-key.pub}
ssh-keygen -lf "$public_key_file" >/dev/null
read -r key_type key_data _ < "$public_key_file"
[[ "$key_type" == ssh-ed25519 && "$key_data" =~ ^[A-Za-z0-9+/=]+$ ]]
script_dir=$(cd "$(dirname "$0")" && pwd)
deploy_dir=/opt/podcazt/deploy/aws
legacy_dir=/opt/podcazt/deploy/lightsail

# Move configuration in place; keep existing Certbot hooks and backup units valid.
if [[ ! -e "$deploy_dir" && -d "$legacy_dir" && ! -L "$legacy_dir" ]]; then
  mv "$legacy_dir" "$deploy_dir"
fi
[[ -d "$deploy_dir" && -f "$deploy_dir/runtime.env" && -f "$deploy_dir/config.env" ]] || {
  echo 'Provision the production deployment before installing GitHub access.' >&2
  exit 1
}
if [[ ! -e "$legacy_dir" && ! -L "$legacy_dir" ]]; then
  ln -s aws "$legacy_dir"
elif [[ "$(readlink -f "$legacy_dir")" != "$deploy_dir" ]]; then
  echo 'Both AWS and legacy deployment directories exist; merge them first.' >&2
  exit 1
fi
install -m 0755 "$script_dir/github-deploy.sh" "$deploy_dir/github-deploy.sh"
install -m 0755 "$script_dir/cleanup-images.sh" "$deploy_dir/cleanup-images.sh"
install -m 0755 "$script_dir/github-ssh-dispatch.sh" /usr/local/sbin/podcazt-github-ssh
install -d -m 0700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
touch /home/ubuntu/.ssh/authorized_keys
if ! grep -Fq "$key_data" /home/ubuntu/.ssh/authorized_keys; then
  printf '\nrestrict,command="/usr/local/sbin/podcazt-github-ssh" %s %s podcazt-github-actions\n' \
    "$key_type" "$key_data" >> /home/ubuntu/.ssh/authorized_keys
fi
chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys
chmod 0600 /home/ubuntu/.ssh/authorized_keys
echo 'Installed restricted GitHub deployment access; configuration is in deploy/aws.'
