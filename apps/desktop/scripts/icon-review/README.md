# 图标语义演示页

从仓库根目录构建：

```sh
node apps/desktop/scripts/icon-review/build.mjs --out .local/icon-review/site
```

构建消费共享 `getSemanticIconCatalog`，页面使用 `createSemanticIconElement`、共享 sprite、根主题 runtime 和原主题文件 schema。生成文件留本机，用 Pageville 原 `agentmux-icon-matrix` 页面身份发布新版本。

可选 `--context <先前 catalog.json>` 只保留同语义 ID 的中文审阅说明；图形、默认映射、目录与当前引用重新取自源码。静态引用是审阅线索，不证明某一 Run 状态或全部动态消费。

页面草稿仍用 `agentmux.icon-review.v1`：修改包保存用途、备注和历史，完整主题导出用于 Settings 导入。预览只作用在演示页，不写入产品配置。
