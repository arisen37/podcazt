#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -f runtime.env ]]; then echo 'Run bash setup-config.sh --write first.' >&2; exit 1; fi
docker compose up -d --wait postgres redis
# Apply versioned migrations before starting the application. Back up before updates.
docker compose run --rm --no-deps web node node_modules/prisma/build/index.js migrate deploy
docker compose up -d --wait web signaling
curl --fail --silent http://127.0.0.1:3000/api/health
echo
curl --fail --silent http://127.0.0.1:4000/health
echo
