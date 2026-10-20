# 种子数据

本目录用于放置各部署环境自己的题库清单和素材。公开仓库不包含真实活动题库、参与者署名或媒体文件。

- `questions.json`：默认示例题库清单；缺少时服务仍可启动，题库为空。
- `full-deck.json`：完整原稿清单，仅在 `SEED_PROFILE=full` 时使用。
- `media/`：上述清单引用的素材文件。
- `option-image-patches.json`：可选的历史导入修正；缺少时按无补丁处理。

清单格式可参考 `server/seed.ts`、`shared/model.ts` 和相关测试。请勿提交真实参与者信息、未获授权的图片、音频或视频。
