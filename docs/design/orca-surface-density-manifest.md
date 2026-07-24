# AgentMux × a mature workbench Surface 与密度清单

本文最初服务 Feature `f-2238fbdxh` / Task `T-010`，用户体验复审后由其后继任务继续维护。它固定视觉参考、层级预算和控件所有权，避免把“像 a mature workbench”误解为像素级换皮。

## Reference Provenance

- `style_reference`：a mature workbench `34f2a62cdaf58dc5924a3b01f560f91b53a5c277`，2026-08-09 从干净 `main` 工作树读取。
- 取证方式：先由 a mature workbench `.codegraph/` 追踪符号与调用关系，再核对当前源码。
- T-010 参考路径：
  - `src/renderer/src/components/right-sidebar/index.tsx`
  - `src/renderer/src/components/right-sidebar/right-sidebar-width.ts`
  - `src/renderer/src/components/right-sidebar/right-sidebar-titlebar-drag-regions.ts`
  - `src/renderer/src/hooks/useSidebarResize.ts`
  - `src/renderer/src/lib/desktop-window-chrome.ts`
  - `src/renderer/src/store/slices/editor.ts`
- T-011 的 Explorer / Editor 移植仍以审计时固定的 a mature workbench `6da7b8e9cfe62e5b4d34bb52e8c570036c1935fc` 为源码基线；视觉参考更新不改变该来源。
- AgentMux 基线：`c0478938afb3eb014f45adb9f1d4f4e10fa067b8`，实现发生在当前树且不创建兼容层。

a mature workbench 在本任务中证明的是成熟模式，而不是配色答案：Sidebar owner 同时拥有展开状态、所选工具、像素宽度、Resize 和活动条；36px Titlebar / Activity Strip 明确划分 drag 与 no-drag；面板只在语义边界保留分隔，内容层级主要靠 Surface 和密度建立。

## Protected-Principle Gate

- `protected_goal_or_principle`：保留 AgentMux 的 Graphite / Mint、Terminal-first 身份，同时删除顶部空行、线框拼装和低分辨率感；Tools 固定在右侧主区标题之前，并按 Workspace/Board 切换子 Tab。
- `project_native_strategy`：复用 Zustand 的 Workspace UI truth、现有 File / Browser / Terminal / Agent Tab 动作、`react-resizable-panels` 的上下分栏；像素宽度拖拽直接移植并最小适配 a mature workbench 的 `useSidebarResize`。
- `failure_boundary`：新增第二套 Terminal / Agent / Browser 生命周期、插件发现／市场／脚本运行时、假可用 Bookmark、全局配置或 Migration，均判定为失败；Board 与 mux Runtime 不在 T-010 改动。
- `proof_plan`：状态与 Resize 纯函数测试、四个入口的真实 Store 转换、`pnpm check`、目标窗口 Rendered 截图，以及透明图标的 RGBA / ICNS 校验。

## Surface 层级

| 层级 | Surface | 用途 | 边界规则 |
| --- | --- | --- | --- |
| S0 | `--bg` / `--surface-0` | Window 与 Pane 工作面 | 不用连续网格包围；分屏边界除外 |
| S1 | `--surface-1` | Project Rail、Workspace Tool Dock、Titlebar Plane | 用明度差和局部阴影分组，只保留拥有 Resize 或 Window 分区语义的边界 |
| S2 | `--surface-2` | Hover、工具内容块、搜索与局部 Toolbar | 无默认描边；交互时才提升 |
| S3 | `--surface-3` | Selected、Segment、Badge、浮层按钮 | 小面积使用，不铺成整列 |
| Accent | Mint / Blue / Amber / Red | Focus、Host、Attention、Danger | 颜色表达状态，不兼任布局线 |

## Density Budget

| 对象 | 预算 | 理由 |
| --- | --- | --- |
| Titlebar Plane | 42px | Topbar 从窗口顶边开始；左侧只为 macOS Traffic Lights 留 76px 安全区；Tools 位于右侧主区标题之前 |
| Workspace Tool Activity Strip | 36px | 与 a mature workbench 成熟活动条一致，容纳四个 28px 命中区 |
| Pane Tabbar | 36px | 保持现有高密度 Universal Tab |
| Explorer / Branch Section Header | 32–34px | 清晰但不形成第二层大 Topbar |
| Tree Row | 24px | 保持专家密度与键盘扫描速度 |
| Tool Dock Width | 默认 300px；最小 236px；最大 440px | 同时容纳 Explorer / Branches，且给主工作面保留容量 |
| Tool Content Padding | 8–12px | 只用于局部卡片；不再以统一大 Padding 包住整栏 |
| 操作与元数据文字 | 11–13px；必要微标不低于 10px | 不再用 7–9px 冒充专家密度 |
| Terminal / Editor 内容 | 默认 14–15px，稳定行高 | 由 xterm/Monaco 原生 DPR 渲染，不加 CSS transform 缩放 |

小于等于 900px 时 Tool Dock 作为覆盖层出现，宽度仍取同一 Store truth；不得复制一套移动端状态。

## Control Ownership

| 控件 / 状态 | Owner | 下游行为 |
| --- | --- | --- |
| `toolsOpen` | Renderer Store | 收起／恢复同一个二级 Tool Dock；Workspace 与 Board 共用 |
| `workspaceTool` | Renderer Store | `files-branches / browser-favorites / terminal-shortcuts` 三选一 |
| `boardTool` | Renderer Store | `branch-lanes / inbox` 二选一；Project Scope |
| `toolDockWidth` | Renderer Store | Workspace/Board 共享像素宽度；拖拽中直接更新 owner DOM，结束时写回，避免 React 回弹 |
| Explorer | Workspace Tool Panel | 展示 File / Branches；打开 File 继续进入 Focused Pane |
| Browser Favorites | Workspace Tool Panel | 只调用 Main-owned Browser Universal Tab；收藏真相必须来自一个 owner，不能用临时按钮伪装持久化 |
| Terminal Shortcuts | Workspace Tool Panel | 只调用 `packages/core` 既有 Terminal launch action |
| Agent Launch | Universal New Tab | 不属于 Tools；继续由 Pane `+` 打开 Agent 创建面 |
| Branch Lanes / Inbox | Board Tool Panel | 选择 Board 的 Project-scoped 主内容，不复用 Workspace 文件工具 |
| Titlebar drag | Titlebar Plane | Breadcrumb 可拖拽；按钮、Tab 和输入区全部 `no-drag` |
| Traffic Lights Safe Area | Project Rail Titlebar | 只在窗口左上保留 76px，不再让右侧主区空出整行 |

## 重复 Token 审计

实现前 `styles.css` 有 82 条 `1px solid/dashed` 规则、63 次 `--line/--line-soft` 使用和 131 条 Padding 声明。数量本身不是错误，但当前根结构连续使用 `sidebar border → topbar border → tool header border → pane border`，形成无语义的 1px 网格；同时 `window-drag-region + sidebar/main padding-top: 38px` 让有效内容整体下移。

T-010 只清理根结构和新工具 Surface 的重复线，不机会主义重写 Settings、Board 或 T-011 文件树内部细节。Pane Split、Resize Handle、Editor Dirty、危险确认等具有明确语义的边界继续保留。

## Copy / Adapt / Omit

| 决策 | a mature workbench 模式 | AgentMux 处理 |
| --- | --- | --- |
| Copy | `useSidebarResize` 的 live DOM width、全屏透明 Drag Overlay、mouseup / blur 收尾 | 保留行为和纯函数，并把方向改为左侧 Dock 的 `deltaSign=1` |
| Adapt | 36px Activity Strip、收起、所选工具、宽度 owner | 入口移到右侧主区标题之前；Workspace 三个子 Tab、Board 两个子 Tab，配色使用 Graphite / Mint |
| Adapt | Titlebar drag/no-drag 与 Traffic Lights 安全区 | Topbar 与 Rail Brand 同处 42px Plane；右侧无全局空行 |
| Keep | Universal Tab、Focused Pane、Main-owned Browser、Core-owned Session | 工具只调用现有 action，不新增 lifecycle |
| Omit | a mature workbench Plugin Panel、隐藏 Tab fallback、Activity Bar 位置菜单 | 当前需求不需要通用扩展框架或复杂兼容路径 |
| Omit | a mature workbench Daemon、Relay、Account、WSL、Issue Integration | 不属于 T-010 或本 Feature |

## 图标资产边界

应用图标采用 `image2` 生成的 low-poly 绿色龙形。龙形之外必须是实际 Alpha，不能使用深色圆角底板或把棋盘格画入 RGB。源 PNG、128px PNG 与 ICNS 由同一 1024px RGBA 资产机械派生；透明角像素应为 `0,0,0,0`。
