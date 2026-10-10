#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

deploy_dir=${PODCAZT_DEPLOY_DIR:-/opt/podcazt/deploy/aws}
source_dir=${PODCAZT_SOURCE_DIR:-/home/ubuntu/podcazt}
source_user=${PODCAZT_SOURCE_USER:-ubuntu}
image_repository=ghcr.io/arisen37/podcazt
command=${1:-}

if [[ "$command" != check && ! "$command" =~ ^deploy\ ([a-f0-9]{40})\ (sha256:[a-f0-9]{64})\ ([a-zA-Z0-9_-]+(\[bot\])?)$ ]]; then
  echo 'Only check or deploy <commit> <image digest> <registry user> is allowed.' >&2
  exit 2
fi
if [[ "$command" != check ]]; then
  revision=${BASH_REMATCH[1]}
  digest=${BASH_REMATCH[2]}
  registry_user=${BASH_REMATCH[3]}
fi
if [[ $EUID -ne 0 ]]; then echo 'Run through the installed SSH dispatcher.' >&2; exit 1; fi
cd "$deploy_dir"
[[ -f runtime.env && -f config.env ]] || { echo 'Production configuration is missing.' >&2; exit 1; }
compose=(docker compose --project-directory "$deploy_dir")
free_kib=$(df -Pk "$deploy_dir" | awk 'NR==2 {print $4}')
if (( free_kib < 131072 )); then
  echo 'Less than 128 MiB is free. Expand the EC2 root volume before deploying.' >&2
  exit 1
fi
if [[ "$command" == check ]]; then
  "${compose[@]}" config --quiet
  docker image inspect podcazt:latest >/dev/null
  printf 'EC2 deployment access OK; %s KiB free.\n' "$free_kib"
  exit 0
fi

exec 9>"$deploy_dir/.github-deploy.lock"
flock -w 300 9
auth_dir=$(mktemp -d "$deploy_dir/.registry-auth.XXXXXX")
previous_image=$(docker inspect podcazt-web-1 --format '{{.Image}}')
activated=false
cleanup() { rm -rf -- "$auth_dir"; }
rollback() {
  local status=$?
  trap - ERR
  if [[ "$activated" == true ]]; then
    echo 'Deployment failed; restoring the previous application image.' >&2
    docker tag "$previous_image" podcazt:latest
    "${compose[@]}" up -d --wait --wait-timeout 180 --no-deps web signaling
  fi
  exit "$status"
}
trap cleanup EXIT
trap rollback ERR

git_as_owner() { runuser -u "$source_user" -- git -C "$source_dir" "$@"; }
[[ -z "$(git_as_owner status --porcelain)" ]] || { echo 'EC2 source checkout has local changes.' >&2; exit 1; }
git_as_owner fetch origin main
[[ "$(git_as_owner rev-parse origin/main)" == "$revision" ]] || {
  echo 'This release was superseded on main; deploy the newer workflow run.' >&2
  exit 1
}

# The short-lived workflow token arrives on stdin and is never placed in argv.
docker --config "$auth_dir" login ghcr.io --username "$registry_user" --password-stdin
image="$image_repository@$digest"
docker --config "$auth_dir" pull "$image"
[[ "$(docker image inspect "$image" --format '{{.Architecture}}')" == arm64 ]]
[[ "$(docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" == "$revision" ]]

# Both backups and smoke tests run before replacing any application container.
systemctl start podcazt-backup.service
docker run --rm --network none --entrypoint node "$image" scripts/verify-runtime.mjs
git_as_owner merge --ff-only "$revision"
docker tag "$previous_image" podcazt:rollback
activated=true
docker tag "$image" podcazt:latest
"${compose[@]}" up -d --wait --wait-timeout 180 postgres redis
"${compose[@]}" run --rm --no-deps web node node_modules/prisma/build/index.js migrate deploy
"${compose[@]}" up -d --wait --wait-timeout 180 --no-deps web signaling
curl --fail --silent --show-error --retry 5 --retry-delay 2 --max-time 15 http://127.0.0.1:3000/api/health
curl --fail --silent --show-error --retry 5 --retry-delay 2 --max-time 15 http://127.0.0.1:4000/health
domain=$(awk -F= '$1 == "APP_DOMAIN" {print $2}' config.env)
[[ "$domain" =~ ^[a-zA-Z0-9.-]+$ ]]
curl --fail --silent --show-error --retry 5 --retry-delay 2 --max-time 20 "https://$domain/api/health"
curl --fail --silent --show-error --retry 5 --retry-delay 2 --max-time 20 --output /dev/null "https://$domain/icon.png"
[[ "$(docker inspect podcazt-web-1 --format '{{.Image}}')" == "$(docker image inspect "$image" --format '{{.Id}}')" ]]
[[ "$(docker inspect podcazt-signaling-1 --format '{{.Image}}')" == "$(docker image inspect "$image" --format '{{.Id}}')" ]]

# Replace the dispatcher target atomically after a successful release.
install -m 0755 "$source_dir/deploy/aws/github-deploy.sh" "$deploy_dir/github-deploy.sh.next"
mv "$deploy_dir/github-deploy.sh.next" "$deploy_dir/github-deploy.sh"
install -m 0755 "$source_dir/deploy/aws/backup.sh" "$deploy_dir/backup.sh"
install -m 0644 "$source_dir/deploy/aws/podcazt-backup.service" "$deploy_dir/podcazt-backup.service"
install -m 0644 "$deploy_dir/podcazt-backup.service" /etc/systemd/system/podcazt-backup.service
systemctl daemon-reload
printf '%s\n' "$revision $image" > "$deploy_dir/github-release.txt"
printf '\nDeployed %s successfully. Previous image: %s\n' "$revision" "$previous_image"
