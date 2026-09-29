# Terminal 局部信息与启动／恢复的实际场景

依据交互 SSOT《Terminal 局部信息与服务提醒不挤占正文》《启动与恢复的分量分开》和密度 SSOT 对应章节。

```sh
node apps/desktop/scripts/verify-terminal-chrome-craft.mjs
node apps/desktop/scripts/verify-terminal-chrome-craft.mjs --recovery
```

前者沿原 Workbench、角标、通知与 xterm，核对 hover 轮廓和终端网格稳定、历史说明按需出现、通知不占纵向布局。后者编译生产 FullPageLoadingSurface、SessionConnectingSurface、SessionPane 和 CSS：

1. App scope 的明暗品牌构图，实际鼠标移动产生背景光照和微小景深，文字舞台不移动；移出后回到静止光照。
2. Region scope 的 Ready to restore、恢复、失败和 connecting，覆盖 720px、420px、320px 窄窗及短窗。恢复区域没有品牌大图，以局部静态光影和精细 glyph 增加安静层次；停泊没有 busy 假象，原失败按钮仍可操作。Restoring terminal 场景沿 TerminalView 的呈现输入，使用受控 Store 的原 Session/Run 并实际点击展开详情；该场景不声称真实 Runtime 恢复成功。
3. reduced-motion 下的 App/Region 静态呈现；原 Executor、完整初始 Prompt、Copy 和失败信息保持。
4. 实际双 Region SessionPane 中停泊一个 Session，展开其保留的 Session/Run 身份，同时保留原 Tab、布局、草稿和相邻 xterm。现有进程退出提醒及 Resume owner 继续存在。
5. 私有编译改坏 parked busy、Region 大图边界、“鼠标只移动背景”和局部光影的承重点，要求场景报 AssertionError，再恢复通过。

每轮输出 `.tmp/terminal-chrome-craft/attempt-*/receipt.json`，保留图片、实际加载源码与编译身份、生产调用者和失败。App scope 的 recovering 是组件主题场景；产品内单 Session 的 Restoring 使用 Region scope，不能把二者的截图混为一谈。

数据来自既有 preview API 和受控 fixture；Electron、CSS 和 xterm 为实际运行。未操作用户 App/Run/权限，不证明真实 CLI、安装包或 durable 重启。图片须另外独立看图评审；行为 `passed` 不能代替审美结论。
