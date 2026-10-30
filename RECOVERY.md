# 冷启动与灾难恢复

本仓库是公开仓库，只包含源码、Compose、通用部署脚本和恢复工具。真实题库、媒体、`.env`、WebDAV 凭证、DNS 凭证和 TLS 私钥不在仓库中。

## 备份由三部分组成

| 内容 | 保存位置 | 说明 |
| --- | --- | --- |
| 源码、Compose、部署脚本 | GitHub 仓库 | 本文档所在仓库 |
| 运行时数据库与媒体 | WebDAV 时间戳快照 | 每份快照含 `quiz.sqlite`、`media.tgz`、`manifest.json`（sha256） |
| 原始配置与凭证 | 密码管理器或离线保险库 | `.env`、`backup.env`、DNS/TLS 凭证，必须另行保存 |

公开仓库不附带 `seed/full-deck.json` 和 `seed/media/`，因此不能只靠 GitHub 恢复真实题库。真实数据必须来自 WebDAV 快照；没有快照时只能以空题库启动。

## 恢复前必须知道

- WebDAV 地址、账号、密码和备份路径（`backup.env`）。
- 原管理员的登录密码。恢复数据库后，服务端不会用 `.env` 中的 `ADMIN_PASSWORD` 覆盖已有管理员；该变量只在空数据库首次初始化时生效。
- 如果使用本仓库的域名和 HTTPS，还需要 DNS 控制权与证书申请凭证。

请现在就把生产环境的 `/opt/anime-quiz/config/production.env` 和 `/opt/anime-quiz/config/backup.env` 存入密码管理器或离线保险库，不要提交到 Git。

## 新机器冷启动

以下命令假设部署到 `/opt/anime-quiz`，数据目录为 `/opt/anime-quiz/data`。端口和路径可通过 `.env` 覆盖。

### 1. 获取代码

```bash
sudo install -d -m 700 -o 1000 -g 1000 /opt/anime-quiz/data
sudo install -d -m 700 /opt/anime-quiz/config
sudo git clone https://github.com/PKUOriginalFire/anime-master.git /opt/anime-quiz/app
cd /opt/anime-quiz/app
```

### 2. 创建配置

```bash
sudo cp .env.example .env
sudo chmod 600 .env
sudoedit .env
```

至少修改：

- `ADMIN_PASSWORD`：新的随机密码；仅用于空库兜底。
- `APP_ORIGIN`：实际公开地址，例如 `https://quiz.example.com`。
- `APP_ALLOWED_ORIGINS`：需要额外放行的来源，留空即可。
- `SEED_PROFILE`：保持 `examples`；`full` 需要私有种子文件。

如果使用不同的数据目录，在 `.env` 中设置 `DATA_DIR_HOST`。

### 3. 构建镜像

```bash
sudo docker compose -p anime-quiz -f compose.yaml build
```

镜像标签默认为 `anime-quiz:local`。构建只需要公开仓库内容，不需要真实题库。

### 4. 恢复最新快照（首次启动前）

从密码管理器取出 `backup.env`，放到仓库外：

```bash
sudo install -m 600 /path/to/backup.env /opt/anime-quiz/config/backup.env
sudo BACKUP_IMAGE=anime-quiz:local \
  BACKUP_ENV_FILE=/opt/anime-quiz/config/backup.env \
  BACKUP_DATA_DIR=/opt/anime-quiz/data \
  bash deploy/restore-webdav.sh --yes
```

脚本会检查数据目录由 `1000:1000` 拥有，然后：

1. 选择时间戳最新的快照，也可用 `WEBDAV_RESTORE_SNAPSHOT=20261030T033000Z` 指定。
2. 下载并校验 `manifest.json`、数据库大小和 sha256，检查 SQLite 完整性与媒体归档路径。
3. 把现有数据库、WAL 和 `media/` 移到 `/opt/anime-quiz/data/backups/pre-restore-*`。
4. 覆盖数据库、解包媒体；中途失败会尝试回滚。

恢复前必须停止应用。首次部署时若暂无快照，可跳过本步，应用会以空题库启动。

### 5. 启动并检查

```bash
sudo docker compose -p anime-quiz -f compose.yaml up -d --wait
curl -fsS http://127.0.0.1:3010/api/health
```

正常返回 `{"ok":true}`。用原管理员账号登录，检查题目数量、媒体播放和 OBS 展示链接。

### 6. 反向代理与 HTTPS

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/conf.d/anime-quiz.conf
sudoedit /etc/nginx/conf.d/anime-quiz.conf
```

把 `quiz.example.com` 替换为实际域名和证书路径。配置已包含 WebSocket 转发、201 MB 上传限制和 HTTP 跳转 HTTPS。证书可向 Let's Encrypt 申请；DNS 凭证和私钥只保存在主机，不进入仓库。

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 定时备份

部署后安装一次 systemd 单元：

```bash
sudo install -m 755 deploy/backup-webdav.sh /usr/local/sbin/anime-quiz-backup
sudo install -m 644 deploy/anime-quiz-backup.service /etc/systemd/system/
sudo install -m 644 deploy/anime-quiz-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now anime-quiz-backup.timer
systemctl list-timers anime-quiz-backup.timer
```

定时器每天 03:30（`Asia/Shanghai`）执行，错过时会在开机后补跑。先手动执行一次并确认远端出现快照：

```bash
sudo systemctl start anime-quiz-backup.service
sudo journalctl -u anime-quiz-backup.service -n 50 --no-pager
```

`backup.env` 必须放在仓库外并保持权限 600。保留份数由 `WEBDAV_BACKUP_KEEP` 控制。新机器没有 `current` 软链时，脚本使用 `anime-quiz:local`；自定义镜像标签可通过 `BACKUP_IMAGE` 覆盖。

## 恢复注意事项

- `production` 与 `preview` 使用不同 `WEBDAV_PATH` 和 `WEBDAV_BACKUP_LABEL`；跨标签恢复会被拒绝。
- 恢复会保留旧会话；如怀疑凭证泄露，恢复后重置管理员密码和 OBS 展示凭证。
- 恢复前数据位于 `data/backups/pre-restore-*`，确认新数据无误后再按保留策略清理。
- 不要删除 `/opt/anime-quiz/config`、`data/backups` 或远端快照，直到新环境完成验证。

## 验证清单

- [ ] `https://<域名>/api/health` 返回 200。
- [ ] 管理员可登录，题目、素材和活动数量与最近一次快照一致。
- [ ] 音视频可播放，切题会停止上一题媒体。
- [ ] OBS 展示链接可打开，未揭晓答案不会提前下发。
- [ ] WebDAV 出现新的时间戳目录，`manifest.json` 包含 `quiz.sqlite` 和 `media.tgz`。
- [ ] 预览环境与生产环境的数据库、媒体和展示凭证相互独立。
