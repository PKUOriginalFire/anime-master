#!/bin/sh
# 保留依赖卷，并在锁文件变化后同步；不触碰正式或预览数据库。
set -eu
lock_hash="$(sha256sum package-lock.json | cut -d ' ' -f 1)"
installed_hash=""
if [ -f "node_modules/.anime-quiz-lock.sha256" ]; then
  installed_hash="$(cat "node_modules/.anime-quiz-lock.sha256")"
fi
if [ "$lock_hash" != "$installed_hash" ]; then
  npm ci
  printf '%s\n' "$lock_hash" > "node_modules/.anime-quiz-lock.sha256"
fi
exec npm run dev:remote
