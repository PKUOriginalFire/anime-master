#!/usr/bin/env bash
# 从 WebDAV 最新快照恢复数据库与媒体。恢复前必须停止应用。
set -euo pipefail
if [[ "${1:-}" != "--yes" && "${RESTORE_CONFIRM:-}" != "yes" ]]; then
  echo "恢复会覆盖数据库与媒体，请停止应用并确认后传入 --yes。" >&2
  exit 1
fi
root="${ANIME_QUIZ_ROOT:-/opt/anime-quiz}"
env_file="${BACKUP_ENV_FILE:-$root/config/backup.env}"
data_dir="${BACKUP_DATA_DIR:-$root/data}"
release="${BACKUP_RELEASE:-$(readlink -f "$root/current" 2>/dev/null || true)}"
[[ -f "$env_file" ]] || { echo "缺少备份凭证文件：$env_file" >&2; exit 1; }
if [[ ! -d "$data_dir" ]]; then
  install -d -m 700 -o 1000 -g 1000 "$data_dir"
fi
image="${BACKUP_IMAGE:-}"
if [[ -z "$image" ]]; then
  if [[ -n "$release" && -d "$release" ]]; then
    image="anime-quiz:$(basename "$release")"
  else
    image="anime-quiz:local"
  fi
fi
docker image inspect "$image" >/dev/null 2>&1 || { echo "备份镜像不存在：$image，请先构建镜像。" >&2; exit 1; }
owner="$(stat -c '%u:%g' "$data_dir")"
if [[ "$owner" != "1000:1000" ]]; then
  echo "数据目录必须由 1000:1000 拥有，当前为 $owner：$data_dir" >&2
  exit 1
fi
args=(--rm --init
  --user "$owner"
  --read-only
  --tmpfs /tmp:rw,noexec,nosuid,size=64m
  --cap-drop ALL
  --security-opt no-new-privileges:true
  --env-file "$env_file"
  -e DATA_DIR=/data
  -v "$data_dir:/data:Z")
if [[ -n "${WEBDAV_RESTORE_SNAPSHOT:-}" ]]; then
  args+=(-e "WEBDAV_RESTORE_SNAPSHOT=$WEBDAV_RESTORE_SNAPSHOT")
fi
exec docker run "${args[@]}" "$image" node scripts/webdav-restore.mjs --yes
