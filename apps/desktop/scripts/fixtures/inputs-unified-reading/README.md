# Inputs 原记录阅读验收

行为归 [Message Tools 邮箱](../../../../../docs/design/behavior/conversation-input.md#message-tools-邮箱)，呈现归 [Message Tools 邮箱](../../../../../docs/design/presentation/conversation-input.md#message-tools-邮箱)。

在仓库根目录运行：

```sh
node apps/desktop/scripts/fixtures/inputs-unified-reading/capture.mjs --tag=review
```

场景使用当前源码的 `AgentSessionComposer`、`SessionMailbox`、共同样式与 Core 输入投影，在独立 Electron 窗口及临时 userData 中运行。原始读取页是明确的合成夹具；不会连接用户应用、Session、Provider 或 Runtime。它验证真实 Renderer 消费与交互，不单独证明 Provider 读取、真实消息投递或安装后的用户现场。

每个 640/320 px、明/暗主题组合依次采集 Inputs 主列表、原记录详情、展开的原生贡献、Fill 后草稿和原生正文查询结果，共 20 张完整截图。交互断言覆盖同输入一行、相同正文的独立输入仍存在、未知回执可见、Copy 保留原文、Fill 使用实际 Composer、原草稿保留且不发送。

随后运行同一生产原贡献组件的 Chromium Range 场景：展开首条并选中正文，再撤回它的当前关联且保留兄弟项；断言实际选中文字、原 DOM 与 Range 都保持，防止仅验证对象身份而漏掉节点移动造成的空选区。该场景独立记录在交互回执中，不增加视觉截图。

截图、交互回执和加载源码哈希保存在被 Git 忽略的 `.bagakit/feature-tracker/inputs-unified-reading/native/<tag>/`。采集成功只证明交互断言，仍须独立 Agent 实际打开全部图片并判断是否可交付。
