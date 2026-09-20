# Agent 顶栏的真实场景

约束来自两份设计 SSOT 的 Agent 顶栏与视觉密度章节：用户希望 Terminal 上方仅有右上角很小一行名字、菜单和关闭，保持精致、现代、简约、紧凑。11px 名字与原 22px 动作区保持，完整名字、Executor 和 Session 按需可读；Read-only 和原失败三事实仍明确。

运行原 probe：

```sh
node apps/desktop/scripts/verify-product-quality-foundation.mjs --source --header-only
node apps/desktop/scripts/verify-product-quality-foundation.mjs --native --header-only
```

Native 在固定私有源码副本编译实际 WorkspaceWorkbench、SessionPane、产品 CSS 和 xterm。场景包括普通与宽长名、320px 双格、Read-only、深浅主题；触摸打开原菜单，键盘 Escape 返回与 ArrowDown/Enter 消费准确 Region 地址，打开原 History，输入原 Terminal，再从原 Composer 的 Tab 路径聚焦并关闭原 X。另一格与 Session/Run/草稿保留。原 unknown/lifecycle 服务窗的实际详情末句及恢复动作继续由原 owner 消费。

独立评审逐张打开同轮完整 PNG，判断右上组是否轻、名字是否清楚、长名是否仍占满宽格、菜单和 X 焦点是否清楚、原 Terminal 阅读与输入是否可用。几何和采集通过不能代签观感。数据和 API 在既有 preview 边界受控；这里不操作用户 App/Run、剪贴板、权限或系统截图选择器，不证明真实 Core、厂商 CLI 或用户安装。普通 private Core 重启由交付负责人另核同来源编译产物。
