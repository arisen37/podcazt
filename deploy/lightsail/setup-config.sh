#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Reuse Node/tsx from the deployment image; no host Node or Python dependency.
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/config" podcazt:latest \
  node --import tsx /config/setup-config.ts --config-dir /config "$@"
