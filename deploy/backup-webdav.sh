#!/usr/bin/env bash
set -euo pipefail
root="${ANIME_QUIZ_ROOT:-/opt/anime-quiz}"
env_file="${BACKUP_ENV_FILE:-$root/config/backup.env}"
data_dir="${BACKUP_DATA_DIR:-$root/data}"
release="${BACKUP_RELEASE:-$(readlink -f "$root/current" 2>/dev/null || true)}"
[[ -f "$env_file" ]] || { echo "缺少备份凭证文件：$env_file" >&2; exit 1; }
image="${BACKUP_IMAGE:-}"
if [[ -z "$image" ]]; then
  if [[ -n "$release" && -d "$release" ]]; then
    image="anime-quiz:$(basename "$release")"
  else
    image="anime-quiz:local"
  fi
fi
docker image inspect "$image" >/dev/null 2>&1 || { echo "备份镜像不存在：$image" >&2; exit 1; }
owner="$(stat -c '%u:%g' "$data_dir")"
exec docker run --rm --init \
  --user "$owner" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --env-file "$env_file" \
  -e DATA_DIR=/data \
  -v "$data_dir:/data:z" \
  "$image" node scripts/webdav-backup.mjs
