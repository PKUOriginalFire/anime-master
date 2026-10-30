# 通用部署文件

- `backup-webdav.sh`：使用镜像内的备份脚本，把 SQLite 快照和媒体上传到 WebDAV。
- `restore-webdav.sh`：下载最新快照、校验 sha256，并把当前数据移到 `data/backups/pre-restore-*` 后恢复。
- `anime-quiz-backup.service` / `.timer`：每日 03:30（Asia/Shanghai）定时备份。
- `nginx.conf.example`：反向代理模板，替换域名与证书路径后使用。

完整冷启动步骤见 [RECOVERY.md](../RECOVERY.md)。本目录不包含 `.env`、`backup.env`、证书、真实题库或媒体；这些内容必须单独保存。
