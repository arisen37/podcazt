#!/usr/bin/env bash
set -euo pipefail
: "${RUNNER_TEMP:?}"
: "${EC2_DEPLOY_KEY:?Missing GitHub secret EC2_DEPLOY_KEY}"
: "${EC2_KNOWN_HOSTS:?Missing GitHub variable EC2_KNOWN_HOSTS}"
umask 077
mkdir -p "$RUNNER_TEMP/podcazt-ssh"
printf '%s\n' "$EC2_DEPLOY_KEY" > "$RUNNER_TEMP/podcazt-ssh/key"
printf '%s\n' "$EC2_KNOWN_HOSTS" > "$RUNNER_TEMP/podcazt-ssh/known_hosts"
