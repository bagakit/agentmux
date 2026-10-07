# 图标语义工作台

长期开发入口，从仓库根目录运行：

```sh
pnpm icons:dev
```

打开输出的 `http://127.0.0.1:4186/` 即可预览当前源码。修改目录、字形、共享呈现或消费源码会自动刷新，沿原语义 ID 恢复草稿；存储失败时保留内存修改并提示先导出。`--open` 可打开系统浏览器，`--port` 可指定端口（占用时不自动漂移），`--context` 仅提供旧注释；`--help` 查看入口。进程停止后该开发 URL 暂不可用，重新运行同一命令即可继续。

开发使用和扩展步骤见[语义图标指南](../../../../docs/guides/semantic-icons.md)。`catalog.mjs` 的 `createReviewCatalog` 同时供开发服务和静态构建投影当前共享 owner；Vite 加载原生预览与主题运行时，不维护第二目录。

构建可分享的静态快照：

```sh
pnpm icons:build
```

指定输出路径：

```sh
node apps/desktop/scripts/icon-review/build.mjs --out .local/icon-review/site
```

构建消费共享 `getSemanticIconCatalog`，页面使用 `createSemanticIconElement`、共享 sprite、根主题 runtime 和原主题文件 schema。生成文件留本机，用 Pageville 原 `agentmux-icon-matrix` 页面身份发布新版本。

可选 `--context <先前 catalog.json>` 只保留同语义 ID 的中文审阅说明；图形、默认映射、目录与当前引用重新取自源码。静态引用是审阅线索，不证明某一 Run 状态或全部动态消费。

页面草稿仍用 `agentmux.icon-review.v1`：修改包保存用途、备注和历史，完整主题导出用于 Settings 导入。预览只作用在演示页，不写入产品配置。

实例模拟提供共享 `animation` 预设与颜色参数，默认静态。它只改变上方四组样例，目录、标题和历史保持静态；模拟参数不保存进草稿或主题文件。动效样式直接复制共享 owner，遵循系统减少动画设置。
