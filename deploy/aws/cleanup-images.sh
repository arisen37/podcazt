#!/usr/bin/env bash
set -euo pipefail

# Only retire this application's GHCR digests, after a healthy deployment.
# Resolve every protected image first; missing tags/containers fail closed.
protected_ids=(
  "$(docker image inspect podcazt:latest --format '{{.Id}}')"
  "$(docker image inspect podcazt:rollback --format '{{.Id}}')"
  "$(docker inspect podcazt-web-1 --format '{{.Image}}')"
  "$(docker inspect podcazt-signaling-1 --format '{{.Image}}')"
)
for protected_id in "${protected_ids[@]}"; do
  [[ "$protected_id" =~ ^sha256:[a-f0-9]{64}$ ]] || {
    echo 'Cannot identify all protected application images; skipping cleanup.' >&2
    exit 1
  }
done

references=$(docker image ls --digests --no-trunc --format '{{.Repository}}@{{.Digest}}' ghcr.io/arisen37/podcazt | sort -u)
failed=0
while IFS= read -r reference; do
  [[ "$reference" =~ ^ghcr\.io/arisen37/podcazt@sha256:[a-f0-9]{64}$ ]] || continue
  image_id=$(docker image inspect "$reference" --format '{{.Id}}')
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
  protected=false
  for protected_id in "${protected_ids[@]}"; do
    if [[ "$image_id" == "$protected_id" ]]; then protected=true; break; fi
  done
  [[ "$protected" == false ]] || continue
  # No --force: Docker must refuse removal if another container still uses it.
  if ! docker image rm "$reference"; then failed=1; fi
done <<< "$references"
exit "$failed"
