#!/usr/bin/env bash
set -euo pipefail
# Install root-owned at /usr/local/sbin/podcazt-github-ssh. authorized_keys
# forces this command; the deploy key cannot open a shell or forward ports.
exec sudo -n /opt/podcazt/deploy/aws/github-deploy.sh "${SSH_ORIGINAL_COMMAND:-}"
