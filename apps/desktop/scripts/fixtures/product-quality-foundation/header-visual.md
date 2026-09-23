# Agent 右上自适应角标的真实场景

约束来自两份设计 SSOT 的 Agent Region 身份与视觉密度章节：用户最新要求「24 px 太高，另外这么点信息，弄个自适应的角标放右上角就行」。local 身份不再占固定整行；11px 名字、14px 图标与原 22px 透明动作区保持，完整名字、Executor 和 Session 按需可读；Read-only 和原失败三事实仍明确。已合 Focus portal 继续移动同一 host，自己的 Focus bar 密度没有被这次 local 角标替换。

运行原 probe：

```sh
node apps/desktop/scripts/verify-product-quality-foundation.mjs --source --header-only
node apps/desktop/scripts/verify-product-quality-foundation.mjs --native --header-only
```

Native 在固定私有源码副本编译实际 WorkspaceWorkbench、SessionPane、产品 CSS 和 xterm。场景包括普通与宽长名、320px 双格、Read-only、深浅主题；同矩阵两张 full 帧在实际尺寸稳定后由原 API event consumer 写满当前首行到最后一列，保 FIRST…END，可信 pointer 选择 FIRST- 并沿原 API 发送 q，原 xterm 和草稿保持。Header-only 的 CDP DPR 与实际 display scale 一致，避免 xterm canvas 与 capturePage 的比例错位；旧 DPR1／Retina2 的中部半尺寸画面保历史，不签首行。

长名角标左侧空区实际 elementFromPoint 不得落入透明 Header host，名字与原 More/X 命中完整。触摸打开原菜单，键盘 Escape 返回与 ArrowDown/Enter 消费准确 Region 地址，打开与返回原可见 History，输入原 Terminal，再从原 Composer 的 Tab 路径聚焦并关闭原 X。另一格与 Session/Run/草稿保留。Reader 可以按原 owner 保持隐藏挂载，返回验收核实际可见状态，不能用要求卸载的旧 driver 否定保留阅读状态。原 unknown/lifecycle 服务窗的实际详情末句及恢复动作继续由原 owner 消费。

独立评审逐张打开同轮完整 PNG，判断自适应右上组是否轻、名字是否清楚、空容器是否拦截正文、独立 Terminal 主题下字形是否可读、菜单与 X 焦点是否清楚、原首行与输入是否可用。局部 backing 只覆盖 quiet glyph band，不能以 opaque 22px 面盖首行；hover/open 临时表面沿原菜单语义。几何和采集通过不能代签观感。数据和 API 在既有 preview 边界受控；这里不操作用户 App/Run、剪贴板、权限或系统截图选择器，不证明真实 Core、厂商 CLI 或用户安装。普通 private Core 重启另核同来源编译产物，本轮没有打包安装任务。

昂贵 Gate 前的一次非 gating 反例预检可用 `--native --header-only --header-font-preflight`，由原 SessionPane 配置消费产品支持的 8px 字号，只实绘同一 full-dark 场景，不增加默认矩阵。首行文字在 buffer 中成立不等于实际笔画完整；同轮元数据分别记录 0 flow row、实际 Terminal 阅读内距、22px 命中区与局部 backing，任何一次裁顶原图保留，不能把这些数值合写成固定顶栏高度。

原 T005 的 24px 源码与截图只保历史时点，原件不重写；当前规格只以两份 SSOT 和本次角标 receipt 为准。
