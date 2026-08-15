# T-014 清晰度与双 Surface Tools 验收

日期：2026-08-09  
验收对象：当前工作树构建出的 AgentMux Desktop，而不是稳定提交的临时演示副本。

## Automated Checks

执行 `pnpm check`，结果通过：

- Core 与 Desktop TypeScript 检查通过。
- 14 个测试文件、52 项测试通过；包含 Tool Dock 宽度 Clamp、共享展开/宽度、Workspace/Board 独立子 Tab、真实 tmux Agent/Terminal、真实 Git Worktree、Local/SSH ExecutionHost 与文件边界。
- Core 与 Desktop Production Build 通过。
- `git diff --check` 通过。
- 静态字号审计中 `font-size/font: 7px | 8px | 9px` 为 0；Terminal 与 Monaco 配置均为 15px。

## Manual Checks

Production Electron 使用当前工作树构建产物、隔离目录 `/tmp/agentmux-t014-prod.BUVYzg`、CDP `9245` 启动；Renderer URL 为 `file:///Users/bytedance/proj/priv/bagakit/agentmux/apps/desktop/out/renderer/index.html`。

- Production `devicePixelRatio=1`，Renderer Console 为 0 error / 0 warning。
- Tools 位于右侧主区最左侧且在标题之前：Tools `X=224`，Title/Breadcrumb `X≈293.5`。
- Workspace 子 Tab 精确为 Files + Branches、Browser Favorites、Terminal Shortcuts；Board 子 Tab 精确为 Branch Lanes、Inbox；Tools 内不存在 Agent Launch。
- Workspace 选择 Browser Favorites、Board 选择 Inbox；宽度从 300px 调为 332px 后切换 Surface，两个选择均恢复。收起后 Dock 不保留交互宽度，恢复后仍为 332px。
- Browser Favorites、Terminal Shortcuts 和 Inbox 都明确显示 `Unavailable`/`Empty`，没有临时持久化列表。
- Monaco 文本实际为 15px；Editor 与 Pane 宽度同为 930px，`editorFits=true`，关键容器 transform 为 `none`。可见 Monaco Canvas backing/CSS 比为 `1:1`。
- xterm 使用 DOM renderer，Canvas 数量为 0；Row 实际为 15px，行高 25px，Terminal 与 Pane 宽度同为 930px，transform 为 `none`。
- Board 与主区高度同为 858px。1440×900 与 900×720 的根级 Overflow 均为 0；900px 宽时 Dock 使用现有绝对定位覆盖模式，主区不被再次压窄。

截图证据：

- `artifacts/t014-production-editor-15px.png`
- `artifacts/t014-production-terminal-15px.png`
- `artifacts/t014-production-board-inbox.png`
- `artifacts/t014-production-board-empty-project.png`
- `artifacts/t014-workspace-browser-favorites.png`
- `artifacts/t014-workspace-clear.png`

## Residual Risks

- Headless Production Electron 的 DPR 为 1；本轮证明了原生 backing/CSS 比例和无二次缩放，没有宣称完成一台 Retina DPR=2 物理屏的 OS 级目测。
- Inbox 聚合、Browser Favorites 持久化和 Terminal Shortcuts 持久化尚未实现 owner；界面已明确为空或不可用，真实 Board/Inbox 能力由 T-015 接管。
- 当前环境没有可达的真实 SSH Server；SSH Main/ExecutionHost 仍由自动化测试证明，没有宣称真实网络端到端成功。
- macOS Accessibility 权限仍拒绝 OS Window Chrome 检查；Production CDP 能证明 Renderer，不证明 Dock、原生菜单与窗口边框。
- 本轮不调整 mux Runtime；最终 T-006 只与用户讨论长期方案。

## 历史阶段证据

## T-010 阶段结论

T-010 的面性视觉、Titlebar Plane、可收起 Workspace 二级工具菜单和四个一方入口已经通过阶段验收。该结论只关闭 T-010 的范围；T-011 的 Refproj Explorer/Editor 移植、T-012 的 Project-scoped Branch Board、T-013 的最终 Production 回归和 T-006 的 mux 用户决策仍未完成，因此本 Feature 不能在此处宣称最终通过。

### Reference Provenance 与实现边界

- `docs/design/refproj-surface-density-manifest.md` 固定 Refproj `34f2a62cdaf58dc5924a3b01f560f91b53a5c277` 为 `style_reference`，记录了源码路径、Surface 层级、Density Budget、Control Ownership、重复 Token 和 Copy/Adapt/Omit 决策。
- T-011 的源码移植基线仍是 Refproj `6da7b8e9cfe62e5b4d34bb52e8c570036c1935fc`，没有被视觉参考更新漂移。
- 当前实现删除 Renderer 根部的 38px 占位；Topbar 与 Project Rail Brand 都从 `Y=0` 开始，并把交互按钮标记为 no-drag。只有左上 Rail 保留 macOS Traffic Lights 安全区。
- 二级工具状态只包含 `workspaceToolsOpen / workspaceTool / workspaceToolWidth`；没有 Config、Migration、插件发现、市场或第二套 Session 生命周期。
- 像素宽度拖拽移植并最小适配 Refproj 的 `useSidebarResize`：拖拽中直接更新 owner DOM，结束时才写回 Zustand；全屏透明 Overlay 防止 Electron 原生 Surface 吞掉 `mouseup`。

### 自动化与 Production Electron

- Desktop TypeScript 检查通过。
- 14 个测试文件、52 项测试通过；新增覆盖 Workspace Tool open/selected/width truth、Agent Launcher View、宽度 clamp、左右拖拽方向与关闭宽度。
- Core 与 Desktop Production Build 通过。
- 当前 Production Bundle 使用独立目录 `/tmp/agentmux-t010-prod.Gq6LyL`、CDP `9231`、`--headless` 启动。
- 干净 Production Renderer：`topbarY=0`、`railTitleY=0`、根部旧 Drag Spacer 不存在、X/Y 根级 Overflow 均为 0、Console 为 0 error / 0 warning。

证据：

- `artifacts/t010-production-clean-titlebar.png`
- `artifacts/t010-workspace-default.png`
- `apps/desktop/test/workspace-tool-panel.test.ts`
- `apps/desktop/test/workspace-selection.test.ts`

### Workspace 二级工具行为矩阵

| 工具 | Rendered 动作 | Owner 证明 |
| --- | --- | --- |
| Explorer | 选择 `README.md` 后，Focused Pane 新增并激活 `README.md` Editor Tab | 继续调用既有 `openFile`；文件仍绑定原 Workspace |
| Web Bookmarks | 点击 `New Browser` 后，Tab Strip 新增 `New Tab`，Pane 显示 Main-owned Browser Empty State | 继续调用既有 `createBrowser`；Saved Bookmarks 明确显示 `Unavailable`，没有假持久化 |
| Quick Terminal | 点击 `Open Terminal` 后，Tab Strip 新增 `Terminal · agentmux`，对象状态显示 `running / Terminal / tmux` | 继续调用既有 `launchTerminal` 与 Core/tmux 生命周期 |
| Agent Launch | 点击 `Choose Agent` 后，同一 Pane 新增 Launcher Tab 并直接显示 Codex、Claude、TraeX、Hermes、Pi Provider Picker | `openLauncher(activePane, 'agent')` 只决定 Launcher 初始 View；启动仍走既有 `launchAgent` |

工具宽度从 300px 拖到 380px 后写回 Store；选择 `Web Bookmarks`、整体收起、再从 Topbar 恢复后，宽度仍为 380px，所选工具仍为 `Web Bookmarks`。收起时主工作面从 Project Rail 之后立即开始，不保留不可见的交互宽度。

证据：

- `artifacts/t010-web-bookmarks.png`
- `artifacts/t010-agent-launch-tool.png`
- `artifacts/t010-tools-collapsed.png`

### 图标资产

- `image2` 的首轮“透明”结果实际是无 Alpha 的 RGB 棋盘格，已判定失败且未接入。
- 最终图标由 `image2` 在纯色 Chroma 背景生成龙形，再由已有 `ffmpeg` 确定性生成 Alpha；没有调用未授权的付费去背景 API。
- `icon.png` 为 1024×1024 RGBA、`icon-128.png` 为 128×128 RGBA，角像素为 `0,0,0,0`；`icon.icns` 可由 `iconutil` 反向展开出 1024px RGBA 资源。
- 应用内 Brand Mark 不再额外绘制深色圆角底板。

### T-010 残余边界

- Saved Bookmarks 的持久化不是当前能力，界面已明确标为 `Unavailable`；T-010 只要求 Web 工具路由 Main-owned Browser，不扩展 Bookmark 数据模型。
- CDP 能证明 Renderer Titlebar Plane 与布局坐标，不能证明 OS 原生 Traffic Lights、Dock 或菜单的最终像素；这仍保留为 T-013 的 OS 级证据边界。
- Explorer 文件类型、语言识别、Watch/Reveal/Keyboard 等成熟基础仍由 T-011 接管；Board 仍由 T-012 接管，不能用 T-010 截图替代它们的验收。

## 状态

本文件记录了 Plan Revision 3 交互模型的真实验收证据。2026-08-09 的体验复审随后将 T-009 标记为 `blocked`，并由 Plan Revision 4 的 T-010～T-013 接管视觉面性、二级工具菜单、Refproj Explorer/Editor 移植、Branch Board 和最终 Production 验收。

因此，下述证据继续证明已经跑通的行为，但不再代表整个 Feature 或最终 Desktop 已通过；T-013 必须在新任务完成后复用并重跑这些检查。

## 中间结论

Plan Revision 3 的代码检查、主要交互链路和 Production Electron 运行边界均已验证。Workspace/Worktree 联动、Universal Tab、Pane 拖拽分屏、文件编辑、Agent/Terminal 投影、Settings 和 Main-owned Browser 都不再只是源码形状；旧 Agent Status Board 只作为被 T-012 替换前的行为基线保留。

本次验收仍保留两个证据边界：当前环境没有可达的真实 SSH 服务器，因此 SSH 的渲染流程使用 Web Preview 的确定性远程 Host，并由 ExecutionHost/WorkspaceFiles 自动化测试补足边界；macOS Accessibility 权限仍拒绝 Computer Use，因此 Production 窗口使用本地 Electron CDP 取证。两者都在下文明确标注，没有被写成更强的能力声明。

## 自动化检查

命令：

```bash
pnpm check
```

结果：通过。

- Core 与 Desktop TypeScript 检查通过。
- 13 个测试文件、47 项测试通过。
- 包含真实 tmux Agent Session、真实 tmux Raw Terminal 默认 Shell、真实 Local Git Worktree，以及 Workspace Root 约束、BrowserViewManager、Workbench Layout 和 Worktree Selection 测试。
- Core 与 Desktop Production Build 通过。

## Production Electron

启动参数：

```text
--user-data-dir=/tmp/agentmux-t009-prod.L2S1Vu
--remote-debugging-port=9225
--headless
```

这是 `mktemp` 创建的独立用户目录；应用使用当前工作树最新 Production Build。Electron 初始窗口配置为 `1480 × 940`，CDP 页面快照同样为 `1480 × 940`。

运行检查：

- 主 Renderer `document.readyState = complete`。
- Renderer Console Error 为 0。
- 页面横向和纵向根级 Overflow 均为 0。
- 主 Renderer 中 `iframe = 0`。
- Raw Terminal 从 New Tab 原位启动为真实 Core/tmux Session；关闭时出现 `Stop this terminal?`，确认后 tmux Session 被移除，原 Pane 回到 New Tab Surface。
- Browser 从 New Tab 原位创建后，CDP 同时出现 AgentMux 主 Renderer 与独立 `Example Domain` 页面 target；独立 target 真实加载 `https://example.com/`，页面标题和 `h1` 均为 `Example Domain`。
- 关闭 Browser Tab 后独立 WebContents target 消失，CDP 只剩 AgentMux 主 Renderer。

证据：

- `artifacts/t009-production-clean-workbench.png`
- `artifacts/t009-production-terminal.png`
- `artifacts/t009-production-browser-toolbar.png`
- `artifacts/t009-production-webcontents-example.png`

## Rendered Verification

### Project、Explorer、Branches 与 Worktree

- Project Rail 只呈现工程/Workspace 聚合；Explorer 与 Branches 同处大二级面板的上下分栏。
- 将二级分隔线从约 `526/247` 拖动为 `407/366`，两区均保持可操作，根页面 Overflow 仍为 0。
- Bound Branch 显示 Worktree Path 与 Current/Worktree 状态；Unbound Branch 显示 `No worktree`，选中后仍保持原 Explorer/Breadcrumb，并显式显示 Create Worktree 表单。
- 创建 `feature/new-tab` Worktree 后，Breadcrumb、二级面板上下文、Explorer Root 和 New Tab Context 一起切换；Branch 行变为 Bound/Current。
- 原 `main` Workspace 中的 Codex Tab 只在切回 `main` 时出现；新 Worktree 不继承该 Tab，证明已打开 Tab 没有被静默换根。

证据：

- `artifacts/t009-workbench.png`
- `artifacts/t009-explorer-branches-resized.png`
- `artifacts/t009-branch-unbound.png`
- `artifacts/t009-worktree-created-linked.png`

### Universal Tab：Terminal、Agent、Browser、File

- 点击 Pane 的 `+` 先创建并激活 New Tab；Terminal、Agent、Browser 在同一个 Tab 中替换 Picker。
- Raw Terminal 以 `Terminal · agentmux`、`running · tmux`、`local · zsh` 呈现，不伪装为 Agent Provider。
- Agent 子流程可从同一 Tab 返回 Picker；Codex、Claude、TraeX、Hermes、Pi 均可见，选择 Pi 并 Launch 后 `New Tab` 消失，原位成为 `pi · agentmux`。
- Browser Web Preview 只表达 Main-owned WebContents 的布局位置；真实网页能力由上面的 Production Electron target 证明。
- File 从 Explorer 打开到当前 Focused Pane，独立参与 Tab 生命周期。

证据：

- `artifacts/t009-new-tab-picker.png`
- `artifacts/t009-raw-terminal.png`
- `artifacts/t009-agent-picker.png`
- `artifacts/t009-agent-launched.png`
- `artifacts/t009-browser-preview.png`

### 四向分屏、Resize、Move 与 Collapse

- 对同一 Pane 分别拖到 Left、Right、Up、Down Edge；四次均出现方向正确的 `New split` Overlay，取消后仍保持一个 Pane。
- 将 Terminal Tab 拖到右侧 Edge 后，Pane 从 1 个变为 2 个，初始宽度为 `468/468`。
- 拖动 Pane Resize Handle 后宽度变为 `596/339`，Console Error 仍为 0。
- 将右 Pane 的唯一 Terminal Tab 拖回左 Pane 中心后，Tab 完成跨 Pane Move；空右 Pane 自动折叠，Pane 数回到 1，Resize Handle 消失。

证据：

- `artifacts/t009-split-target-left.png`
- `artifacts/t009-split-target-right.png`
- `artifacts/t009-split-target-up.png`
- `artifacts/t009-split-target-down.png`
- `artifacts/t009-split-created.png`
- `artifacts/t009-split-resized.png`
- `artifacts/t009-pane-move-collapse.png`

### Agent、Activity、Detection 与 Host

- Codex Agent 的 Terminal/Activity 在同一 Session 中切换；Activity 明确写明只显示 Hook/User Event，不是私有 Chain-of-thought。
- Activity 同时显示 Prompt、Tool/Edit 与 Assistant Response，来源分别为 `user` 或 `native-hook`。
- Settings 的 Agents 页面切换到 `Studio Box` 后，Codex/Claude/TraeX 为 Installed，Hermes/Pi 为 Not installed；展开 Codex 后显示 Command、Arguments 与 Environment，即用户要求的 Agent Commands。
- Hosts 页面同时呈现 Local/SSH Host、运行 Session 约束、Edit/Remove、System SSH 说明与 Test 结果；Studio Box Test 显示 `tmux 3.5a · studio.example.com`。
- Remote Agent 的 Disconnected/Retry 状态在 `render-lab` 中可见，Terminal Composer 被禁用，不把断线伪装成可用。

证据：

- `artifacts/t009-agent-activity.png`
- `artifacts/t009-settings-agents-ssh.png`
- `artifacts/t009-settings-hosts.png`
- `artifacts/t009-workbench.png`

### Local/SSH File Action 与 Editor

- SSH Workspace `render-lab` 中，通过 UI 完成 `ssh-proof.md` Create、Editor Dirty、Save、Rename 为 `ssh-proof-renamed.md`、Delete Confirmation 与 Delete。
- Dirty 同时反映在 Explorer 与 Tab；Save 后按钮回到 Saved；Rename 后 Tab、Editor Header 与 Explorer 一起更新。
- SSH Delete 对话框明确写明删除发生在 `remote host`，确认后目标从 Tree 和 Tab 中消失。
- Local Workspace 中完成 Create、Rename、Delete；Local Delete 对话框不使用 Remote 文案。
- Web Preview 的远程 Host 是确定性渲染夹具；真实 Main Process Root 约束与 Local/SSH 命令路径由 `workspace-files.test.ts`、`execution-host.test.ts` 和本轮 `pnpm check` 证明。本轮没有把 Mock 写成真实 SSH 网络成功。

证据：

- `artifacts/t009-ssh-file-dirty.png`
- `artifacts/t009-ssh-file-renamed.png`
- `artifacts/t009-ssh-file-delete-confirm.png`
- `artifacts/t009-local-file-delete-confirm.png`

### Board、响应式与 Overflow

- Board Filter 使用 Query=`render-lab`、Status=`Needs attention`、Host=`Studio Box` 后，只保留 Remote Attention Workspace；四条 Lane 使用相同 Workspace Status Hierarchy。
- `900 × 720` 时 Navigator 成为宽 294px 的绝对定位覆盖面板；关闭后 Workspace Pane 保持 732px，不发生布局跳窄。
- `900 × 720` 与 `1440 × 900` 的根页面 Overflow 均为 0。

证据：

- `artifacts/t009-board.png`
- `artifacts/t009-board-filtered.png`
- `artifacts/t009-navigator-overlay-900.png`

## 诚实保留的差距

- 没有可达的真实 SSH Server，所以没有宣称完成一次真实网络 SSH File/Worktree Mutation；当前证据是完整 Renderer Flow、系统 SSH Host 边界与自动化 ExecutionHost/WorkspaceFiles 测试的组合。
- macOS Accessibility 权限仍拒绝 Computer Use；Production Electron 使用 CDP 实际操作和截图，能够证明 Renderer、WebContentsView 和 Runtime 行为，但不能证明 OS Window Chrome、Dock 或原生菜单的视觉细节。
- 专家密度整体成立，但部分 Path、辅助标签和 Branch 元数据仍使用约 7–10px 字号，低于 Design Rule 中 11–13px 的理想范围；这属于后续可读性微调，不影响本 Feature 的对象所有权和交互闭环。
- Unbound Branch 的 Create Worktree 面板会压缩并遮住原 Branch 行的大部分内容，表单仍保留 Branch 名称和 Path；后续视觉微调可进一步保持列表连续感。

# T-011：直接移植 Refproj 的 Explorer 与 Editor 基础

固定来源：Refproj `6da7b8e9cfe62e5b4d34bb52e8c570036c1935fc`。逐文件 Copy / Adapt / Omit 清单见 `docs/design/refproj-interaction-review.md` 的“Explorer / Editor Copy、Adapt、Omit Manifest”。

## Repository Proof

命令：

```bash
pnpm check
git diff --check
```

结果：通过。

- Core/Desktop TypeScript 检查通过。
- 21 个测试文件、85 项测试通过。
- 新增的 Refproj 原始 Vue、Svelte、Astro、JSONL Monaco 注册测试全部通过。
- Language Detection 覆盖内置语言、精确文件名、四种已注册 Custom Language、未知类型与明确 Omit 的 Nim。
- Explorer Foundations 覆盖 Row Projection、Arrow/Home/End/Left/Right、Range Selection、Rename/Delete 子树重映射、Reveal Ancestors、同目录乱序响应、Workspace Reset 与 Collapsed Stale Cache。
- Main Process 的 Local/SSH Workspace Root Confinement、真实 Local Worktree 和 Core/tmux 测试继续通过。
- Production Electron Build 通过，`git diff --check` 无错误。

## Web Rendered Verification

使用当前 `dev:web` 确定性 Renderer 夹具，在 `1440 × 900` 逐项操作：

- 单击 `apps` 后 `aria-expanded=true`；聚焦目录后 ArrowRight 进入第一个子项 `apps/desktop`，End 跳到最后一项。
- 初次验证发现 Shift 点击文件仍触发打开，Active File Reveal 随后把范围选择覆盖为单选；按 Refproj `selectRowWithModifiers` 合同修正为“Replace Click 才激活，Range/Toggle 只选择”。复验得到 `package.json + README.md` 两项 Range Selection。
- Manual Refresh 前后两项 Selection 和 `apps` Expanded 状态保持不变。
- 展开 `packages/core/src` 并打开 `runtime.ts` 后，Active File 自动展开祖先、Reveal 对应 Row；模拟 Window Focus Refresh 后三个祖先仍展开，Selection 与 Row 均保持。
- JSON Editor 呈现 5 组 token class / color；TypeScript Editor 呈现 5 组以上 token color，实际内容字号 `15px`、行高 `23px`。
- 通过 UI 完成 `t011-proof.ts` Create、Rename 为 `t011-proof-renamed.ts`、Selection/Editor Header 路径重映射、Delete Confirmation 与删除；删除后 Row 与 Tab 文案同时消失。
- Renderer Console 为 0 error / 0 warning。

最新 Production Build 也使用隔离配置 `/tmp/agentmux-t011-prod.OuaZHi` 与 CDP 9231 启动：真实 Local Git 只投影 `main` 一条 Lane，Board Tools 为 Branch Lanes/Inbox，主内容显示 `agentmux · 1 branches`，Console 为 0 error / 0 warning。该进程在 T-023 验证后保持运行，供最终 Production Gate 继续检查。

证据：

- `artifacts/t011-explorer-json-editor.png`
- `artifacts/t011-explorer-typescript-reveal.png`

## Production Electron：真实 Local Workspace 与 Retina

最新 Production Build 使用隔离目录 `/tmp/agentmux-t011-prod.OuaZHi` 启动，通过 Typed Preload IPC 注册真实 Workspace `/Users/bytedance/proj/priv/bagakit/agentmux`，没有修改用户日常 AgentMux 配置。

- 窗口为 `1480 × 940`，真实显示 `devicePixelRatio=2`、`visualViewport.scale=1`，Root/Body 没有 CSS transform，Root zoom 为 1。
- HiDPI 截图物理尺寸为 `2960 × 1880`；Monaco 可见 canvas backing/CSS 为 `28/14 × 1656/828`，严格 `2:1`，不是低分辨率 bitmap 拉伸。
- 打开真实 `apps/desktop/src/renderer/src/App.tsx`：Editor `15px / 23px`，Pane 与 Editor 同宽，多组 TypeScript token color，根级横纵 Overflow 均为 0。
- 采用 Refproj Worker 策略的 AgentMux 适配后，假 unresolved-import squiggle 从整页红线降为 0；语义与建议诊断关闭，完整文件的语法诊断仍保留，JSX 使用 Preserve。
- Production Renderer Console 为 0 error / 0 warning。
- 最新 Production Electron 已重新构建并保持启动，使用上述隔离配置。

证据：

- `artifacts/t011-production-workspace.png`
- `artifacts/t011-production-typescript-final.png`

## 等价边界与残余风险

- 本 Feature 明确不调整 mux。跨 Host 持续 Watch 没有真实 owner，因此没有引入 Local-only watcher；当前跨 Local/SSH 统一提供 Manual Refresh + Window Focus Refresh，并以 Stale Response / State Retention 证明等价边界，不宣称持续 Watch。
- 没有为当前未验收的 Nim 引入 TextMate、Oniguruma、WASM 与大 Grammar；`.nim` 明确返回 `plaintext`，没有失效 language id。
- 当前目录按展开惰性加载，未出现需要虚拟化的规模证据；不新增 `@tanstack/react-virtual`。File Row Move/Drag 不在 T-011。

# T-023：Project Snapshot 隔离与 Branch Board 收口

## 自动化证明

- `workspace-branches-state.test.ts` 证明 Project 切换后的同步首帧只暴露 `snapshot=null / loading=true / error=null`，旧 Project 的 Snapshot 与 Error 不可见；无 Workspace 时也不泄漏旧状态。
- Hook 的 request token 继续拒绝迟到响应；同 Workspace 手动 Refresh 保留现有 Snapshot 并显示 loading，错误不会清空已经可见的 Git 真相。
- `project-board.test.ts` 证明 Branch 是 Lane Identity，Agent/Terminal 只是 Run；另一 Project 的 Session 不进入 Lane；Inbox 只投影 Waiting、Blocked、Disconnected、Error。

## Web Rendered Verification

在 `1440 × 900` 当前 Web Preview 中验证：

- Board 继续使用标题前纯图标 Tools；Board Tools 只有 Branch Lanes 与 Inbox，并保持各自选中状态。
- Local `agentmux` 显示 `main` 与未绑定 `feature/new-tab` 两条 Lane；`main` Run 为真实 Codex Session，未绑定 Branch 明确显示 No worktree 与 Files + Branches 下一步。
- Inbox 在 Local Project 显示 `All caught up / Project clear`，不伪造 Attention。
- 保持 Inbox 打开切到 SSH Project `render-lab` 后，标题、Tool Summary 与主内容同时切到 `render-lab · 1 open`，只显示真实 Disconnected Claude Session。
- 再切回 Branch Lanes，DOM 投影为 `{"project":"render-lab · 1 branches","lanes":["feat/materials"]}`，没有上一 Project 的 `main` 或 `feature/new-tab` Lane。
- Renderer Console 为 0 error / 0 warning。

证据：

- `artifacts/t023-branch-lanes.png`
- `artifacts/t023-inbox.png`
- `artifacts/t023-project-switch.png`
- `artifacts/t023-production-board.png`
- 当前环境仍没有可达真实 SSH Server；SSH File Transport 与 Root Boundary 由现有 Main/ExecutionHost 自动化证明，没有把 Web Mock 写成真实网络成功。

# T-024：安全、Runtime 与成熟交互的 Production 总验收

验证时间：2026-08-10（Asia/Shanghai）。最终 bundle 来自正式 Gate `artifacts/gate-T-024-r20-0001.log`；Production Electron 使用独立目录 `/tmp/agentmux-t024-release.YPL4Dt`、CDP `9234` 和当前 `apps/desktop/out` 启动。初始 Config 的 Workspace 数为 0，随后只通过 Typed Preload API 注册真实本地 Workspace `/Users/bytedance/proj/priv/bagakit/agentmux`，没有读取或修改日常 AgentMux 配置。

## 总验收中发现并关闭的两个缺口

T-024 没有把首次自动 Gate 通过当成交付完成。第一次 Production 复审发现两个此前测试没有证明的真实问题：

1. Browser 只在创建 `WebContentsView` 时设置一次 `zoomFactor=0.9`；跨 Origin 导航到 `example.com` 后，CDP 的 `devicePixelRatio` 仍为 Retina 基线 `2`，说明页面实际回到了 1.0。
2. xterm 的连续 `onData` 调用经 Typed IPC 并发进入 Core；`load-buffer → paste-buffer` 可以交错，真实 tmux 快照记录到 `prinf tAGENTM0_…`，说明公共 `AgentMuxRuntime.send` 没有输入顺序语义。

Browser 修复仍由 Main Process 的 `BrowserViewManager` 持有：在每次 `did-finish-load` 后重申同一个 `DEFAULT_BROWSER_ZOOM_FACTOR`。测试夹具会在导航和 Reload 时主动把 Zoom 重置为 1，再证明 Manager 恢复 0.9；没有新增 Renderer 设置、配置项或第二套导航路径。

输入修复由 `packages/core` 持有：`AgentMuxRuntime` 仅按 Session 保存 Promise tail。同一 Session 的发送严格串行，不同 Session 不共享全局队列；当前发送失败后下一次继续，Session forget、启动回滚与 Runtime dispose 清理 tail。`TerminalView` 没有增加补偿队列，任意后续 Core Client 都消费同一顺序保证。

T-024 因真实终端乱序曾正式结束为 `blocked`，随后使用 Tracker 允许的 `blocked → in_progress` 恢复路径继续；没有手改 `tasks.json`，也没有为修复伪造新 Feature 或兼容层。

## Repository Proof

- 正式 Gate：`artifacts/gate-T-024-r20-0001.log`，`pnpm check` 通过。
- `packages/core/test/runtime-input-ordering.test.ts`：人为反转底层延迟后，同一 Session 仍按 `a → b → c` 提交；另一 Session 的 `fast` 可先于当前 Session 的 `slow` 完成；一次 `load-buffer` 失败后排队的 `good` 仍成功。
- `packages/core/test/tmux-runtime.integration.test.ts`：向真实 raw terminal 并发发送逐字符命令，tmux 最终原样输出 `ORDERED_INPUT_OK`。
- `apps/desktop/test/browser-view-manager.test.ts`：权限继续默认拒绝；导航、Reload 后 Zoom 仍为 0.9；不支持协议在提交前阻止。
- Tracker validation 与 `git diff --check` 在最终收口再次执行；视觉证据没有替代上述行为测试。

## Production Interaction Matrix

| 对象 | 最新 Production 证据 | 结果 |
| --- | --- | --- |
| 清晰度 | 主 Renderer `devicePixelRatio=2`、`visualViewport.scale=1`；Monaco `14px / 21px`，Canvas backing/CSS 为 2:1；xterm `15px / 25px` | 通过 |
| 根布局 | `1480 × 940`，Root 横纵 Overflow 均为 0 | 通过 |
| Tools 所有权 | Toggle X=`224`、标题 X=`260`；二级面板内重复 Toggle 数为 0；设置入口仅左下 1 个 | 通过 |
| Workspace Tools | Files + Branches、Browser Favorites、Terminal Shortcuts 均可切换并分别表达真实可用/不可用状态 | 通过 |
| Board Tools | Branch Lanes、Inbox 可切换；真实本地 Project 为 `main` Lane，Inbox 为 `All caught up` | 通过 |
| Browser | `Example Domain` 作为独立 WebContents target 加载；跨域后 DPR=`1.7999999523162842`、Viewport=`1078 × 915`、Notifications=`denied` | 通过 |
| Terminal I/O | xterm UI 输入 `printf 'RESULT:%s\n' ORDERED_INPUT_OK`，真实 Core Snapshot 与可见终端均包含 `RESULT:ORDERED_INPUT_OK` | 通过 |
| Burst 输入 | 44 个键盘事件到带结果的 tmux Snapshot 为 4246ms；该测试以零键间隔灌入，证明队列不会乱序，Local 人工键速下不会继续积累反序 backlog | 通过，SSH 延迟未外推 |
| Pane Layout | Left/Right/Up/Down 分别出现方向正确的 `pane-drop-overlay`；Right Drop 后 Pane=`484.5/484.5`，Resize 后=`633.7/335.3`；移回 Center 后 Pane=1、Handle=0 | 通过 |
| Cleanup | 定点复验 Session `9a33c98b-dbaf-4ab6-869c-5c9dbdeab304`：Stop 后当前 Workspace Core Session=0、Terminal Tab=0，`tmux has-session` 明确返回不存在；Close Browser 后 WebContents target 与 Browser Tab=0；Pane 收敛为 1 | 通过 |
| Console | AgentMux 主 Renderer 0 error / 0 warning | 通过 |

## 最终视觉证据

- `artifacts/t024-release-workspace.png`
- `artifacts/t024-release-editor.png`
- `artifacts/t024-release-browser.png`
- `artifacts/t024-release-browser-webcontents.png`
- `artifacts/t024-release-terminal.png`
- `artifacts/t024-release-split-left.png`
- `artifacts/t024-release-split-right.png`
- `artifacts/t024-release-split-up.png`
- `artifacts/t024-release-split-down.png`
- `artifacts/t024-release-split-created.png`
- `artifacts/t024-release-split-resized.png`
- `artifacts/t024-release-pane-collapsed.png`
- `artifacts/t024-release-board.png`
- `artifacts/t024-release-inbox.png`

## 代码所有权与熵复审

- Browser 的协议、权限、Zoom 与原生 View 生命周期仍全部在 `apps/desktop/src/main/browser-view-manager.ts`；Renderer 只投影 Browser Snapshot 和 Bounds。
- 输入顺序属于 `packages/core/src/runtime.ts` 的公共 Session 合同；没有在 Electron IPC、Zustand 或 xterm 分别维护队列。
- 本轮没有新增依赖、配置层、事件总线、Repository、Migration、Alias 或 Compatibility Fallback。
- `store.ts` 没有因最终验收继续增长；前序拆出的 Workbench、Session、Browser、File owner 继续通过完整回归。

## 诚实残余边界

- 当前环境仍没有可达真实 SSH Server。Local 输入顺序有真实 tmux 与 Production UI 证据；SSH 使用相同 Core per-session queue 和 ExecutionHost 边界，但本轮没有把本地 44-key 延迟外推成真实网络性能结论。
- 系统 tmux 中另有一个约四小时前创建、属于 `/Users/bytedance/proj/zhouliqihan/mac-cleaner` 的 `codex · mac-cleaner` Session；它不是本轮目标，已按用户数据边界保留。当前 AgentMux Workspace 的精确 Session 已以上述 ID 证明删除。
- Example Domain 子 WebContents 在未打包 Electron 下会输出 Electron 自带的 Insecure CSP 开发警告；AgentMux 主 Renderer 为 0 warning，打包产物不会显示该开发警告。权限检查实测仍为 `denied`。
- macOS Accessibility 权限仍阻止 OS Window Chrome、Dock 和菜单级 Computer Use；本轮用 Production Electron CDP 证明 Renderer、WebContentsView 和 Runtime，不宣称 OS 外壳像素证据。
- mux 长期方案仍未改变。当前 tmux command transport 已证明正确性和 Local 交互闭环；跨网络的持续字节流、PTY 持有与更低延迟属于最后的 T-006 用户决策，不在 T-024 偷做替换。

# T-029：撤销过早验收并重新完成 Production Gate

验证时间：2026-08-10 03:20（Asia/Shanghai）。Production Electron 来自当前正式构建，使用隔离的 user-data 目录 `/tmp/agentmux-t029.lhWXn6` 和 CDP `9229`，没有读写用户日常 AgentMux 配置。

## 为什么 T-024 不能作为最终结论

T-024 当时的自动化和 Production 交互证据是真实的，但它没有覆盖后续 Review 发现的资源所有权竞态：并发同 ID Launch 可以让失败请求删除成功 Session；`Discard & Close` 只关 Tab 而不释放 Document/Dirty Cache。同一轮 Review 还识别了 tmux 配置与 kill 双失败、配置持久化与 Runtime 切换非事务、Launcher 与 launching Tab 状态分叉。这些都是自动化全绿仍可发生的 P1/P2，因此 T-029 显式 supersede T-023/T-024，而不伪装原验收没有过早。

## Source Manifest 与所有权收口

- Core Launch 事务：`packages/core/src/runtime.ts`、`packages/core/src/execution-host.ts`、`packages/core/src/tmux-client.ts`。Session ID 在第一次 `await` 前 reservation；Launch attempt 只能清理自己持有的真相；tmux 回滚双失败保留可诊断、可显式 Stop 的 Error Session。
- Main 配置事务：`apps/desktop/src/main/runtime-config-transaction.ts`、`runtime-controller.ts`、`ipc.ts`。顺序为候选 Runtime Prepare、配置原子保存、无异步失败点 Commit；不整体替换活动 Runtime，不让已发布的 Agent Hook URL 失效。
- File 生命周期：`apps/desktop/src/renderer/src/lib/file-workbench-state.ts` 作为 File Tab、Document、Dirty、Layout 和 Last Active File 的纯 owner；Close/Discard 释放缓存，Rename/Delete 处理全部 Document key。
- Session/Launcher 生命周期：`apps/desktop/src/renderer/src/lib/session-state.ts`、`store.ts`、`NewTabSurface.tsx`、`WorkspaceWorkbench.tsx`。Launcher view 只存在 Store；异步 Launch 结果只能替换仍持有同一请求的 Tab，迟到成功会 Stop Core Session 而不复活 UI。
- 回归证据：`packages/core/test/runtime-launch-transaction.test.ts`、`runtime-recovery.test.ts`、`execution-host.test.ts`，以及 `apps/desktop/test/runtime-config-transaction.test.ts`、`runtime-controller.test.ts`、`session-launch-lifecycle.test.ts`、`file-mutation-store.test.ts`、`renderer-state-owners.test.ts`。

本轮没有新增依赖、配置层、事件总线、Migration、Alias、Compatibility State 或 Fallback。修复均收口到已经拥有该资源的 Core、Main 或 Renderer owner。

## Repository Proof

- `pnpm check`：通过；31 个测试文件、118 项测试，Core/Desktop TypeScript 与 Production Build 全部通过。
- 真实 tmux 集成测试连续复跑 5 次，5 次全部通过，没有用单次偶然成功替代生命周期证明。
- `git diff --check`：通过。
- Feature Tracker validation：在正式 Task Gate 与 Task Plan 修订后各执行一次；不手改 Tracker 生命周期状态。

## Production Interaction Matrix

| 场景 | 实际操作与可见真相 | 结果 |
| --- | --- | --- |
| Launcher | 从 New Tab 进入 Agent Picker，再 Back 回 Create Surface | 只有 Store 中的 `launcher.view`，重新挂载不分叉 |
| Terminal | 通过 UI 启动真实 tmux Terminal，然后 Stop/Close | 当前 Workspace 的 Core Session、Terminal Tab 与 tmux Session 同时清理 |
| Editor Discard | 打开真实 `README.md`，写入未保存内容，执行 `Discard & Close`，再重开 | 显示磁盘原文，未保存内容与 Dirty 状态均未复活 |
| Browser | 通过 New Tab 创建 Browser，导航到 `https://example.com` | 独立 WebContentsView 正常加载，协议与默认拒绝权限边界保持 |
| Workspace / Board | 切换 Workspace 与 Board，查看 Files + Branches 和 Branch Lanes | 工具、标题和项目内容使用同一 Project 真相，无上一 Project 泄漏 |
| Console | 完成上述整个交互矩阵后检查主 Renderer Console | 0 error / 0 warning |

视觉证据：

- `artifacts/t029-production-workspace.png`
- `artifacts/t029-production-browser.png`
- `artifacts/t029-production-browser-example.png`
- `artifacts/t029-production-board.png`
- `artifacts/t029-production-window.png`

## 内存起始观测（不伪装成泄漏结论）

同一 Production 进程运行约 10 分钟、经过 Editor、Terminal、Browser 和 Board 场景后，`ps` 观测到 Electron Main 约 223 MiB、主 Renderer 约 243 MiB、Browser Renderer 约 98 MiB、GPU 约 96 MiB、Network Utility 约 52 MiB RSS。Chromium 多进程包含共享页，这些 RSS 不能直接相加；单个时点也不能证明泄漏。本数据仅作为后续 T-030 的起始信号，不在 T-029 中为追求数字而拆除已验证可用的 Electron/Monaco/WebContentsView 路径。

## 诚实残余边界

- 当前环境没有可达真实 SSH Server。Local tmux 有真实集成与 Production UI 证据；SSH 使用同一 Core/ExecutionHost 所有权边界，但不把 Local 结果外推为真实网络性能结论。
- macOS 权限查询显示 Accessibility 已授权，但 Computer Use helper 仍持续返回 denied。遵循工具的失败边界停止重试，改用 Production CDP 实际操作与 `screencapture`；证明了 Renderer、WebContentsView 与 Runtime，不宣称 OS Window Chrome、Dock 或原生菜单的可访问性证据。
- 本轮复审没有发现尚未处置的 P1/P2。mux 架构仍保持在最后的 T-006；T-029 没有修改 mux 边界。

# T-030：建立 Production 内存基线并收敛资源回收

验证时间：2026-08-10（Asia/Shanghai）。完整原始样本、命令和逐轮资源计数见 `artifacts/t030-memory-baseline.md`；视觉证据见 `artifacts/t030-optimized-editor.png`。

## 测量方法与污染控制

- 优化前后使用同一 Production Electron 43.3.0 Build、`1480 × 940` 窗口和仅包含当前 Local Workspace 的隔离 user-data；分别使用 CDP `9232` 与 `9233`。
- 每次 UI 动作完成后等待 5 秒，全部关闭样本等待 30 秒；没有调用 GC、Heap Snapshot 或产品内存开关。
- 按 Electron Main、主 Renderer、Browser Renderer、GPU、Utility 分进程记录 RSS；Main 与主 Renderer 额外记录 Physical Footprint，主 Renderer 额外记录 JS Heap、DOM Node、Listener 和 CDP Target。Chromium RSS 包含共享页，没有相加成虚假的“应用总内存”。
- Playwright attach 会创建额外 `about:blank` Target；所有正式内存样本都在 detach 并确认该 Target 消失后采集。系统中另一个属于 `mac-cleaner` Workspace 的 tmux Session 通过 `AGENTMUX_WORKSPACE_PATH` 精确排除并保留。

## 原始基线与优化结果

| 指标 | 优化前冷启动 | 优化后冷启动 | 变化 |
| --- | ---: | ---: | ---: |
| 主 Renderer RSS | 179344 KiB | 102496 KiB | 约 -42.8% |
| 主 Renderer Physical Footprint | 63.4 MiB | 41.1 MiB | 约 -35.2% |
| 主 Renderer JS Heap used | 11809440 bytes | 3456280 bytes | 约 -70.7% |
| Main Physical Footprint | 79.3 MiB | 81.5 MiB | 测量波动内，不宣称改善 |

构建产物中，主 Renderer JS 从 9237.72 KiB 降到 1503.83 KiB；Editor/Monaco 变为首次打开文件时加载的 7725.87 KiB 动态 Chunk。主 CSS 从 296.05 KiB 降到 71.47 KiB，Editor CSS 作为 224.58 KiB 动态资源加载。

加载过 Monaco 后，动态模块不会从 V8 中卸载，因此关闭 Editor 不等于恢复冷启动内存。各 Surface 5 轮后再等待 30 秒，优化后主 Renderer RSS 为 231264 KiB，高于优化前的 169696 KiB；Physical Footprint 则为 102.1 MiB，对比优化前 116.1 MiB。本任务只认定冷启动收益和资源 owner 可回收，不外推“使用后内存总是更低”。

## 五轮资源回收矩阵

优化前、优化后均连续完成 Editor、Terminal、Browser 各 5 轮打开/关闭：

- Editor：每轮 Monaco Editor 与 textbox 为 `1 → 0`，Tab 与 Dirty Document 回到 0；Model 由 `@monaco-editor/react` 既有 unmount 路径 dispose，关闭稳定后 Monaco Worker Target 回到 0。
- Terminal：每轮产生唯一 Core Session，关闭后当前 Workspace 的 Core Session、tmux Session、Terminal DOM 与 Tab 全部回到 0；Watcher、Input Tail、Session 和 Activity 由 Core owner 一并释放。
- Browser：每轮独立 WebContentsView 成功加载 `Example Domain`，关闭后 Browser Renderer、CDP Target、DOM 与 Tab 全部回到 0。
- 优化后完整矩阵结束时，AgentMux 主 Renderer Console 为 0 error / 0 warning，`devicePixelRatio=2`，根布局横纵 Overflow 均为 0。

DOM Node 与 Listener 在加载重型 Surface 后高于冷启动，但没有观测到随 5 轮持续增加的孤儿 WebContents、Session、tmux、Monaco Worker/Model、Tab、Document 或 Dirty Cache；因此保留计数，不把单个高水位解释成泄漏。

## 归因与最小修复

1. Browser 关闭时，React cleanup 会在 Main 已执行 `close()` 后发送 `setBounds(id, null)`。`BrowserViewManager` 现在只对这种预期 hide 幂等返回；未知 Browser 的非空 Bounds 仍然抛错，并由测试锁住 fail-fast 边界。优化后 5 轮不再出现 `Unknown browser` Main 错误。
2. Monaco 是可选重型 Surface，原先由 Renderer entry 静态加载。`main.tsx` 删除全局 Monaco setup，`EditorPane` 自己持有 setup，`WorkspaceWorkbench` 使用 React 现有 `lazy` / `Suspense` 延迟加载；没有新增依赖、缓存层、性能框架、配置项或 Fallback。
3. 没有缩减 xterm 10,000 行 scrollback、Core 2,000 行 Snapshot 或 tmux 50,000 行 history-limit；现有证据没有证明它们是泄漏，而它们直接服务 Terminal 恢复与可用性。

## Repository Proof

- `pnpm check`：通过；31 个测试文件、118 项测试，Core/Desktop TypeScript 与 Production Build 全部通过。
- `apps/desktop/test/browser-view-manager.test.ts`：已关闭 Browser 的空 Bounds 幂等，未知 Browser 的非空 Bounds 继续报错。
- `git diff --check`：通过。
- 正式 Feature Gate 和 Tracker validation 在本章节入账后执行，Gate 日志由 Tracker 记录。

## 诚实残余边界

- 基线期第一次组合脚本曾遇到一次 raw Terminal 执行 `history-limit` 时 tmux Session 已消失；Runtime 正确回滚且没有残留。随后真实 tmux integration 5/5、手工等价启动 5/5、优化前 UI 5/5、优化后 UI 5/5 均通过，无法稳定复现，因此不为一次非确定信号增加 retry、fallback 或新抽象。
- 本任务证明的是当前资源类型没有在五轮中留下可观测孤儿，不是无限时长泄漏证明；若后续出现可重复的 DOM/Listener 线性增长，应以新的 owner-level 证据和 Task 处理。
- mux 所有权没有变化；T-006 仍保持为最终用户讨论任务。

# T-031：二维 Branch × Status 看板与 Inbox Discussion Canvas

验证时间：2026-08-10（Asia/Shanghai）。Refproj 源码对照固定为 `34f2a62cdaf58dc5924a3b01f560f91b53a5c277`，通过其 `.codegraph/` 读取 `AgentKanbanBoard`、`KanbanColumn`、`groupByBucket` 和卡片打开 Terminal 的调用链。AgentMux 复制固定状态列、列内最近变更排序、搜索／筛选、独立滚动与紧凑卡片层级，但把单轴 Agent Bucket 重组为用户确认的二维 Branch × Status 模型。

## SSOT 与产品对象

- Feature Task Plan revision 9 在任何 Board 代码改动前加入 T-031，且 T-006 继续保持最后。Goal 同步删除“Board Tools 含 Inbox”的旧不变量，绑定 revision `bbd87e619481525ac0ca457d611f15d3379fc0067f5ff5a0b7d9040cbadbbb6c`。
- 行轴：Project 下每个真实 Git Branch/Worktree 一行；Branch Name、Worktree Path、Current、Workspace Binding 与 Host 均来自现有 Branch/Project Snapshot。
- 列轴：Inbox、Working、Needs You、Done。Inbox 是创建入口，不伪造 Session；`starting/running/working → Working`，`waiting/blocked/disconnected/error → Needs You`，`done/exited → Done`。
- Run 由 Workspace 的 `(hostId, path)` 归入稳定 Branch，再按状态进入该行的列；同一 Session 状态更新不会改变 Branch 行。
- Host 已经是 `WorkspaceProject` 身份的一部分，因此 Board 将它显示为不可歧义的 Project Scope，而没有增加只有一个有效选项的 Host Filter。可变筛选只保留 Status 与 Worktree Binding。

## 代码所有权与熵

- `lib/project-board.ts` 只拥有 Branch × Status 纯投影、排序和筛选；删除旧 `BranchActivityState`、`buildProjectInbox` 与 attention/active/complete/idle 单轴模型。
- `WorkspaceBoard.tsx` 只渲染矩阵、sticky 行列头、Project 筛选和 Run 卡片；旧 Branch Track 与独立 Inbox 页面直接删除，没有兼容 State。
- `BoardDiscussionCanvas.tsx` 使用已有 Radix Dialog、Host-scoped Agent Detection 与 Branch Context。Unbound Branch 明确禁用 Launch；已有 Worktree Path 但尚未注册 Workspace 时复用 `openBranch` 注册流程。
- Store 只增加 `launchBoardAgent(workspaceId, agentId, prompt)`：复用现有 `selectWorkspace → launchAgent`，并在 Launch 前恢复 Board Surface。Session reservation、失败恢复、迟到结果与 tmux 生命周期仍由既有 Launch owner/Core 持有。
- `boardTool` 类型、Store 字段、setter 和测试全部删除。Board Tool Dock 只有 Project Scope 与四列图例，不再重复 Inbox 页面。
- 没有新增依赖、IPC、配置项、任务数据库、通用 Canvas 框架、Retry、Fallback、Migration 或 mux API。主 Renderer JS 为 1513.57 KiB，对比 T-030 的 1503.83 KiB 约增加 9.74 KiB；CSS 为 77.43 KiB，对比 71.47 KiB 约增加 5.96 KiB，Monaco 仍保持独立动态 Chunk。

## 自动化行为证明

- `project-board.test.ts` 穷尽验证四列常量、全部 Agent Display State 映射、稳定 Branch 行、同一 Run 的 Working → Needs You 横向移动、列内最近更新时间排序、跨 Project 隔离，以及 Query/Status/Binding 筛选。
- `workspace-selection.test.ts` 验证 Board Discussion 选择另一 Worktree Workspace 后仍保持 Board Surface，真实 Launch 输入携带目标 Workspace Path；成功 Session 附着到目标 Workspace Tab，失败不产生 Session，只保留既有 Agent Launcher 恢复面。
- 完整测试为 31 个文件、122 项测试；TypeScript 与 Production Build 通过。

## Production Electron：当前仓库真实 Launch

条件：Electron 43.3.0，`1480 × 940`，Retina DPR=2，隔离 user-data 与 CDP `9234`。测试配置保留五个必填内建 Provider；Codex Command Override 使用 `/bin/sh` 输出固定标记后等待，其余 Provider 明确不可用。首次只提供 Codex 的夹具被配置 schema 正确拒绝；随后补齐真实合同，没有放宽 schema 或增加 fallback。

| 场景 | 可见与运行时真相 | 结果 |
| --- | --- | --- |
| Board 结构 | 列头为 `Inbox / Working / Needs You / Done`，行轴为 `main`；Board Tools 只有 `Branch Board` | 通过 |
| Overflow | 矩阵 `scrollWidth/clientWidth=1250/932`，横向滚动留在矩阵；根 Overflow=`0/0` | 通过 |
| Sticky | 左上 Corner 与 Branch Row Header 的 computed position 均为 `sticky` | 通过 |
| Canvas | 单一 `role=dialog`，标题 `Discuss main`，Branch/Path/Host 可见，Codex Ready；Textarea 自动获得焦点 | 通过 |
| 真实 Launch | 提交后 Canvas 关闭，Run 出现在同一 `main` 行 Working 列；点击卡片进入 Universal Tab | 通过 |
| Terminal | xterm 实际显示 `BOARD_DISCUSSION_OK`，证明经过 Store → Typed IPC → Core → tmux，而不是 Mock Board 卡 | 通过 |
| Cleanup | 精确停止 Session `673e6b7d-b60e-4872-982e-f255567d6c53`；当前 Workspace Core/tmux Session 回到 0 | 通过 |
| Console | 主 Renderer 0 error / 0 warning | 通过 |

系统中另一个属于 `/Users/bytedance/proj/zhouliqihan/mac-cleaner` 的 tmux Session 全程保留，没有被模糊清理。

## Production Electron：三 Branch 隔离 Git 夹具

第二个 Production Profile 使用 `/tmp` 下创建后销毁的隔离 Git 仓库和 CDP `9235`，没有修改 AgentMux 当前仓库 refs。矩阵真实显示三行：

- `feature/active`：存在 Worktree Path、尚未注册 Workspace，Inbox 可打开 Canvas并显示正确路径与 Provider；真正提交时会经过现有 `openBranch` 注册。
- `main`：当前 Root Worktree，Inbox 可直接开始讨论。
- `feature/unbound`：`No worktree`，Inbox 显示 `Worktree required`；Canvas 明确说明不会隐式 checkout，Start discussion 禁用，只提供 `Open Branches`。

三行仍共用四列，根 Overflow=`0/0`，Renderer Console 为 0 error / 0 warning。测试结束后两个隔离 user-data、临时 Git 仓库、Worktree 与 Goal Candidate 均已精确删除；它们只包含本轮生成的测试数据，不可恢复，也不包含用户项目数据。

## 视觉证据

- `artifacts/t031-branch-status-board.png`
- `artifacts/t031-discussion-canvas.png`
- `artifacts/t031-board-run.png`
- `artifacts/t031-discussion-terminal.png`
- `artifacts/t031-three-branch-matrix.png`
- `artifacts/t031-unbound-branch-canvas.png`

## 诚实残余边界

- 当前环境仍没有可达真实 SSH Server。Board 的 Project/Host/Workspace 投影与 Launch 继续复用已测试的 ExecutionHost 边界，但本轮 Production Canvas 只实测 Local。
- Inbox 当前是“从 Branch 开始真实讨论”的入口，不是持久任务收件箱；没有用户授权的任务数据模型，因此重启后不会恢复未提交 Draft。新增持久 Draft/Issue/PR 卡需要独立 Feature，不能藏在 Board Store。
- Done 列投影 Core 当前可发现的已结束 Session，不宣称长期任务历史。长期审计或跨设备同步不在本 Feature。
- mux 所有权没有变化。T-006 仍是最后的用户讨论任务，本轮没有改 tmux transport、PTY holder、SSH Provider 或公共 Core API。

# T-006：确认 Local/SSH 统一的持久 AgentMux Session Daemon

验证时间：2026-08-10（Asia/Shanghai）。正式 Gate 为 `artifacts/gate-T-006-r28-0001.log`。

## 用户确认与决策

用户在三个会改变长期产品语义的候选中回复“1”，明确选择：

- Local 与 SSH 都由独立 AgentMux Session Daemon 持有 PTY/Process；
- Desktop 完全退出、Renderer/Main 崩溃或 SSH 网络中断后，仍在运行的 Agent Session 继续运行并可恢复；
- 接受 SSH Host 显式安装、升级轻量 AgentMux 远端组件；
- 不选择 Main-owned 非持久 PTY、继续真实 tmux、`ctxmux` 唯一 Run Kernel、长期 Hybrid 或任何 Fallback。

确认结果已写入 `docs/plans/mux-runtime-decision.md`。该文档直接替换此前 ctxmux 决策，不保留两套“已确认”文本，也不把推荐方案伪装成用户确认。

Consensus Ledger 位于 `artifacts/t006-mux-spark/consensus-ledger.json` 与生成视图 `consensus-ledger.md`：

- 当前 AgentMux tmux Owner 与 Refproj Local/SSH Runtime 的源码证据均为 `satisfied`；
- `q-persistence` 为 `answered`；
- `er-persistence-confirmation` 由决策文档满足；
- `mux-daemon-decision-v1` 为 `accepted` Snapshot；
- 远端安装/升级、Daemon Crash、主机重启与多 Client Lease 继续作为后续 Feature 必须处理的真实风险，不被本次确认自动视为已经实现。

## 源码比较与失败边界

决策文档基于当前 `packages/core/src/runtime.ts`、`tmux-client.ts`、`execution-host.ts` 及对应测试，记录真实 tmux 的进程持有、发现、输入、Capture、Resize、Stop 与 Local/SSH 行为；Refproj 证据由 `docs/refproj-agent-runtime-notes.md` 固定 Commit 和源码位置，并在本 Task 中通过 Refproj `.codegraph/` 重新核对 Local node-pty、远端 Owner Lease、版本身份、Flow Control 与 Recovery。

比较覆盖真实 tmux、Main-owned node-pty、AgentMux Session Daemon、ctxmux 与长期 Hybrid：

- tmux 已证明持久化与 Local/SSH 同构，但 command-per-input 和 capture polling 限制低延迟、Sequence、Replay 与 Backpressure；
- Main-owned node-pty 有直接字节流，但 App 退出后失去 Owner，不满足用户确认的不变量；
- ctxmux 有通用 Run 能力，但会把 AgentMux 核心交付绑定到另一项目的 Remote、发布和恢复能力边界，且被用户本次选择明确取代；
- AgentMux Daemon 成本更高，必须自己承担协议、安全、Native Artifact、Remote 运维、资源预算与故障恢复，因此这些成本已进入后续 Task，而不是藏在“Refproj-like”一词后面。

Daemon Crash、主机重启、Terminal Replay 与 Provider-native Model Resume 被明确拆开。无法证明模型上下文连续时必须报告 `lost` 或新的 Semantic Session，不能用终端历史伪装恢复。

## 后续 Feature 与 Task SSOT

没有创建重复 Feature。已有依赖 Feature `f-2248f4yx5 / AgentMux Core Maturity` 从 ctxmux 方案修订为 Task Plan revision 4，继续保持 `proposal_only` 并依赖当前 Feature。九个 Task 为：

1. 唯一 Daemon 合同与 Local Terminal/Codex 竖切；
2. Session Transaction、Incarnation Fence、Replay/Backpressure 与内存资源所有权；
3. SSH Remote Daemon、显式安装升级与断线恢复；
4. Catalog、ACP、Hook、Permission 与 Provider Resume；
5. Desktop/外部 Client 切换并删除 tmux/ctxmux Runtime；
6. Package、Daemon Artifact、Activation 与 Doctor；
7. Reliability、Security、Chaos/Stress/Fuzz 与资源测试；
8. 冻结 tmux 基线、延迟/吞吐/恢复/RSS Benchmark；
9. 多个独立 Reviewer 的最终收口。

计划先核对现有依赖：Core 当前只有 `execa` 与 `shell-quote`，Desktop 已有 xterm；它们不提供 PTY。后续 PTY 明确使用维护中的 `node-pty`，不自行实现 PTY/ConPTY/Terminal Emulator。每 Host 一个轻量 Daemon、按 Session 惰性分配、Bounded Replay、慢 Client 背压和释放测试已经写入验收。

## 正式 Gate

- `test -s docs/refproj-agent-runtime-notes.md`：通过。
- `pnpm check`：通过，包含 Core/Desktop TypeScript、完整测试与 Production Build。
- `git diff --check`：在决策与计划写入后通过。
- Feature Tracker validation：当前 Feature 与 Core Maturity revision 4 写入后均通过。
- T-006 未修改 `packages/core` Runtime、tmux 配置、公共 API、SSH Credential、远端软件或用户全局 Agent Hook。
