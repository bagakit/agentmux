# AgentMux × a mature workbench 交互设计审计

对照版本：a mature workbench `6da7b8e9cfe62e5b4d34bb52e8c570036c1935fc`，AgentMux
`c0478938afb3eb014f45adb9f1d4f4e10fa067b8`。

## 总结

AgentMux 应保留小而清晰的 Agent Provider Core 和自己的终端视觉气质，但桌面端要从固定三栏演示布局切换为更成熟的三层产品模型：最左侧 Project/Workspace Rail 只负责切换工程上下文；右侧主区 Titlebar 的最左入口是共享 Tools，位于 Workspace/Board 标题之前；Tools 在 Workspace 与 Board 都存在，但内容服从各自 Surface。Workspace 的 Files + Branches 以 Selected Worktree 驱动文件树根目录；Board 使用 Project Scope 的二维 `Branch × Status` 矩阵，Inbox 是矩阵第一列而不是 Tools 独立页。Workspace 拥有递归 Pane 布局，Pane 拥有通用 Tab，文件、终端、Agent、Browser 和可观察 Activity 都是 Tab 内容；Host、Agent 和恢复状态显示在它们所影响的对象旁边。

这是内容模型、交互模式与正确实现的定向移植，不要求视觉临摹。对编辑器、文件树、Terminal/Session 状态、Pane 拖拽和可访问对话框这类成熟能力，优先直接移植 a mature workbench 源码或采用 a mature workbench 已验证的维护中依赖，再按 AgentMux 的 Core 边界裁剪和重新组织；不另写功能缩水的替代实现。a mature workbench 的 daemon/relay、账户、移动端、WSL/runtime environment 图、第三方 Issue 集成和兼容历史不在范围内。

## 各界面的取舍

| 界面 | AgentMux 现状 | a mature workbench 更好的模式 | 决策 |
| --- | --- | --- | --- |
| 应用骨架 | Workspace 侧栏 + 固定 Files / Agent / Editor 三栏 | 工程 Rail、上下联动的文件/分支面板、用户可安排的 Tab Group 工作区 | 删除固定三栏；采用窄 Project/Workspace Rail、Warp 式大二级面板和 Workspace/Board 主区 |
| Workspace | 名称和可展开的 Session 列表 | 卡片同时表达分支/路径、Host、Activity、内联 Agent 和注意状态 | 直接吸收信息层级；不引入 Issue/PR 元数据 |
| Explorer / Branches | 文件树与 Worktree 入口彼此孤立，选择 Branch 不改变文件上下文 | a mature workbench 的工作分区以 Worktree 作为可操作上下文 | 二级面板上半展示 Explorer、下半展示 Branches；Branch 显示 Worktree 绑定与路径，选择已绑定 Branch 会联动文件树 |
| 看板 | Branch 各自一条横向 Run Track，Inbox 是另一个 Tools 页面 | a mature workbench 的稳定状态列、卡片层级、筛选与横向溢出 | Adapt 为二维矩阵：Branch/Worktree 是纵向行轴，Inbox/Working/Needs You/Done 是横向列轴；卡片由 `(branchId, status)` 落位 |
| 创建 Workspace | 文件夹选择与 Worktree 表单分离 | Project → Run on → Name/Create from → Agent → Advanced | 合并为一条流程；保留明确 Git 确认和当前必要字段 |
| Tab | Session Tab 加一个偶发的文档 Tab，`+` 只显示 Agent 启动页 | 通用 Tab、每 Pane 独立 Tab Strip、创建入口、拖拽排序/移动/分屏 | `+` 立即创建 Tab；Tab 内先选择 Terminal、Agent 或 Browser，再进入对应内容 |
| Pane 布局 | `react-resizable-panels` 只调整三个固定区域 | 递归 Split Tree、持久 Ratio、Focused Pane、四向 Drop Zone | 采用同一模型和手势；使用成熟的 `@dnd-kit` 与现有 Resize 能力 |
| Terminal | xterm + 页面级 Agent Header | 每个 Pane 显示标题、Provider/Host/状态、视图切换、分屏/关闭和 Overlay | 采用 Pane 局部 Chrome 与恢复状态 |
| Terminal 恢复 | 只有全局 Error Toast | Pane 内 Reconnect Banner/Overlay、运行中关闭确认、断连状态 | 把恢复放回对象旁；不伪造自动重连能力 |
| 文件树 | 展示完整路径的扁平列表，根目录只由当前 Workspace 决定 | 文件夹优先的层级树、展开、选择、刷新、键盘和文件操作 | 采用层级、密度、刷新及行内创建/重命名/删除；根目录由 Selected Worktree 联动，但文件操作仍受该 Workspace Root 约束 |
| 编辑器 | 永久占据右侧的一块 Editor | 文件作为 Focused Pane 的 Tab，可像 Terminal 一样移动和分屏 | 采用通用 Editor Tab；继续使用 Monaco 和明确保存 |
| Agent 设置 | Codex/Claude/Hermes/Pi 四个命令输入框 | Installed / Not installed、Host Scope、Refresh、默认/启用态、高级命令 Disclosure | 采用内容模型；以 core 的 detect 结果为唯一发现来源，并覆盖 TraeX |
| SSH 设置 | Host 字段和 Workspace 创建混在同一面板 | 独立 Host 管理，含状态、测试、编辑、删除和 Project Host 选择 | 拆开职责；不导入或保存私钥内容 |
| Project/Host | Workspace 直接记录一个 Host ID | Project 展示 Available Hosts，并明确各 Host 的路径/Setup | 在现有 `WorkspaceRecord` 范围内采用选择语言和状态层级 |
| 创建 Tab | 空白中心的一张大 Agent Launch Card | Warp 式新 Tab 先建立容器，再选择内容 | 保留“点击 `+` 立即出现新 Tab”，将初始内容改为 Terminal / Agent / Browser 创建面板；Agent 只是其中一种内容 |
| Activity | 诚实的 Hook 时间线 | Agent UI 是终端事件的可读投影，并保留来源 | 保留“不等于私有思维链”的边界，改善分组与空状态 |
| Composer | 有用的 Rich Textarea，但固定挂在中栏下方 | Composer 属于 Active Agent Pane，并携带当前文件/Workspace 上下文 | 保留交互，改变所有权，展示已引用文件 Chip |
| Settings | 一个右侧抽屉平铺所有字段 | 全尺寸设置工作区，左侧分组导航、搜索和 Pane 级内容 | 改为 General、Agents、Hosts、Workspaces 四组 |
| 状态真相 | Detection/Connection 只存在组件临时状态 | Hook 让 Tab、Launch、Settings、Workspace 共享一份状态 | Detection 以 Host 为键进入 Renderer Store，所有界面只消费同一投影 |

## 要实现的交互模型

1. 选择 Project/Workspace 会恢复其工作分区、Pane Tree 和上一次 Focused Pane；Project/Workspace Rail 不承载完整文件树或 Branch 列表。
2. Warp 式二级面板上下分栏：上半 Explorer，下半 Branches；分隔线可调整高度，任一分区都不能把另一分区挤到不可操作。
3. Branches 同时列出已绑定 Worktree 与未绑定 Worktree 的分支。Branch 行显示绑定状态、Worktree Path 和当前/脏状态等真实 Git 证据，不从 UI 配置重复推导 Git 真相。
4. 选择已有 Worktree 的 Branch，会原子更新 Selected Worktree、Explorer Root、Breadcrumb 和后续新 Tab 的 Workspace 上下文。已经打开的 File/Agent/Terminal Tab 保留原 Workspace 绑定，不被静默换根。
5. 选择未绑定 Worktree 的 Branch 不执行隐式 checkout，也不把当前文件树伪装成该分支；界面提供 Create Worktree，只有 Git 成功并注册 Workspace 后才切换。
6. 右侧主区在 Workspace 与 Board 间切换；Board 使用同一份 Project/Workspace、Branch、Host 和 Agent 状态投影。每个 Branch/Worktree 是稳定行，Run 状态只在该行内横向移动。
7. 点击 Focused Pane 的 `+` 会立即创建一个新 Tab。初始 Tab 提供 Terminal、Agent、Browser 选择；选定后在同一个 Tab 内替换创建面板，不再额外创建 Tab。
8. Focused Pane 决定文件、新 Tab 和 Agent 启动页打开到哪里。Tab 在同一 Strip 内拖拽会排序，拖到另一个 Pane会移动；悬停 Pane 边缘时显示“新建分屏”方向目标，Drop 后用递归 Split 替换原 Leaf。
9. 关闭最后一个 Tab 会保留明确的创建入口；Secondary Pane 没有 Tab 后折叠对应 Split；关闭运行中的 Terminal/Agent 前先确认是否停止 Session。
10. Agent Availability 以 Host 为键。Settings Refresh、Launch 选项和空状态消费同一份检测结果。错误和恢复靠近失败对象；全局 Toast 只用于跨对象失败。

## 借鉴边界

在许可与项目边界内直接移植 a mature workbench 的正确实现，并删除不属于 AgentMux 的附带复杂度：

- 递归 `leaf | split` 布局、Ratio 和 Focused Leaf
- `@dnd-kit` Drag Context、Sortable Tab、Pane Body Droppable、Edge Zone 和 Overlay Preview
- 文件夹优先的层级文件树、展开逻辑和高密度 Row
- a mature workbench 式 Worktree/Branch 工作分区语义，但用 Warp 式大二级面板和上下分栏承载，不把全部内容塞进工程 Rail
- Branch 与 Worktree 的真实 Git 关联、Worktree Path 展示，以及 Selected Worktree 对 Explorer Root 的单向驱动
- Directory Cache、Stale Response Token、刷新时保留旧 Children，以及文件操作的明确确认
- Pane-local Terminal Recovery Banner、运行会话关闭确认与 Host-aware 状态文案
- Settings Sidebar + Pane 组合、Installed / Not installed Agent 分组
- Host-aware 状态文案和上下文内 Retry/Test
- 看板的固定状态列、横向溢出、筛选和 Workspace Card 元数据层级；Branch 行轴与 Inbox Canvas 是 AgentMux 的适配语义

成熟基础能力继续由维护中的库负责：Monaco 提供编辑器，xterm.js 提供终端渲染，`node-pty` 提供 PTY 原语，`agentmuxd` 提供持久进程所有权，`@dnd-kit` 提供跨 Pane 拖拽，Radix Dialog 提供焦点管理与可访问确认。AgentMux 只实现这些能力之间的产品所有权和 Core API 接线。

明确不抄：

- Runtime Relay/Session Mirroring、远程 a mature workbench Server 所有权、移动端同步
- GitHub/Linear/Jira 卡片元数据、账户导入、WSL、Emulator Pane
- 任何兼容分支或 Migration 机制
- 将 Terminal 输出描述成私有 Chain-of-thought 的说法

## 验收标准

- 用户可打开多个 Agent/File Tab，拖到四个边缘创建分屏，调整尺寸，在 Pane 间移动 Tab，并在 Secondary Pane 为空时折叠它。
- Explorer 是层级树，可刷新、创建、重命名、删除本地或 SSH 文件/文件夹；破坏性操作需确认，路径必须受 Workspace Root 约束。
- 二级面板以上下可调整分栏同时显示 Explorer 与 Branches；Branch 行展示真实 Worktree 绑定和路径，选择已有 Worktree 会切换 Explorer Root，选择未绑定 Branch 只提供 Create Worktree 而不隐式 checkout。
- Project/Workspace Rail 保持紧凑；Workspace/Board 切换位于右侧主区，不把 Branches 和看板控制都塞进最左侧。
- `+` 立即创建一个新 Tab；初始 Tab 可选择 Terminal、Agent 或 Browser，三类内容都遵守 Focused Pane、拖拽分屏和关闭生命周期。
- 每个 Terminal Pane 都显示 Session/Provider/Host/状态，并有真实的空、连接中、错误、断连和关闭确认状态。
- Agent Settings 按 Host 展示 Codex、Claude、TraeX、Hermes、Pi 的检测结果和高级 Command/Args/Env；Launch 消费相同状态。
- Workspace 与 Board 一致表达 Branch/Path/Host/Agent 状态，不出现互相矛盾的标签。
- `pnpm check` 通过，Production Electron 在目标窗口尺寸启动，无 Renderer Overflow。

## 2026-08-09 体验复审与追加决策

这轮真实体验说明，前一轮虽然搭出了 Universal Tab、二级面板和 Board 的结构，但还没有达到“对标 a mature workbench 的成熟产品”这一目标。`T-009` 的最终渲染验收因此不能通过；下面的差距必须先成为后续任务和新的最终验收条件。

### 0. 提升默认清晰度与 Tab 内容尺度

真实体验确认当前画面不是单纯“信息密度高”，而是大量 7–10px 字体、过小命中区和 13px Terminal/Editor 默认字号共同造成的发虚与低分辨率感。后续不再把极小字号当作专家密度；优先通过 11–13px 操作层级、14–15px Terminal/Editor 内容、稳定行高和原生 DPR 渲染建立清晰度，再用布局而不是缩字承载容量。

xterm.js 与 Monaco 继续拥有 Canvas/Text 渲染，不另写像素缩放层；实现需要验证 Production Electron 的 `devicePixelRatio`、Canvas backing size、Terminal Cell Metrics、Monaco Font Info 和截图物理像素。若原生库已经正确处理 DPR，修复应落在默认字号、行高与 CSS 缩放，而不是叠加 transform 或模糊的二次缩放。

### 1. 从线框拼装转向面性构成

当前界面依赖大量 `1px` 分隔线、规则直栏和偏大的统一 Padding 来组织层级，信息虽已摆放完整，但视觉仍像线框稿，缺少 a mature workbench 那种由背景、浮层、明暗、局部边界和紧凑密度共同建立的“面”。a mature workbench 在这里是可审计的 `style_reference`，AgentMux 仍保留 Graphite/Mint 的品牌身份，不做像素级换皮。

后续实现需要先记录密度预算、Surface 层级和重复 Token，再减少不承担语义的边框与空白。顶部空行并非产品需要，而是全局 `38px` draggable titlebar padding 将整个内容区下推造成的；Topbar 应进入同一 Titlebar Plane，只为 macOS Traffic Lights 保留明确安全区，不在右侧主区继续留一整行空白。

### 2. Explorer / Editor 采用 a mature workbench 的成熟基础，不再手写缩水版本

现有实现只吸收了 a mature workbench 的 Directory Cache 思路，文件行交互、选择与键盘模型、图标／文件类型注册、Reveal、Watch／Refresh、Mutation 等成熟能力并未真正移植。编辑器的语言识别仍是少量扩展名的局部分支，远低于成熟编辑器的文件类型覆盖。这印证了“看起来能用”和“长期可靠”之间的暗坑。

在许可允许的范围内，后续任务要以 a mature workbench `6da7b8e9cfe62e5b4d34bb52e8c570036c1935fc` 为固定来源，至少审计并直接移植／适配：

- `src/renderer/src/components/right-sidebar/FileExplorerRow.tsx`
- `src/renderer/src/lib/language-detect.ts`
- `src/renderer/src/lib/file-type-icons.ts`
- `src/renderer/src/lib/file-explorer-keyboard-navigation.ts`

实施前留下 Copy/Adaptation Manifest，逐项注明直接保留、因 AgentMux Local/SSH 或 Workspace Root 边界而适配、以及明确不引入的 a mature workbench 附带能力。a mature workbench 已解决且适用于本项目的基础行为，不再另写功能缩水的替代实现；Monaco 继续拥有编辑器渲染，AgentMux 只负责文件上下文、协议接线和产品所有权。

### 3. Tools 属于右侧主区，Workspace 与 Board 共享容器

Tools 不是 Project Rail 的内容，也不是 Topbar 右侧的一项普通 Action。入口固定在右侧主区最左边、Workspace/Board 标题之前；它拥有可收起的高容量二级 Dock。无论当前是 Workspace 还是 Board，Tools 都存在，但内容服从 Surface：

- Workspace：Files + Branches、Browser Favorites、Terminal Shortcuts
- Board：Branch Board 的 Project Scope、状态图例和统计；Inbox 属于主矩阵第一列

Dock 支持整体收起／展开并共享宽度；Workspace 记住上次工具，Board 不保留只有一个选项的伪选择状态。Files + Branches 保持上下联动；Browser Favorites 和 Terminal Shortcuts 只路由现有 Browser/Terminal Universal Tab，不另建进程所有权、Session 生命周期或状态真相。普通 Agent Launch 继续由 Pane 的 `+` / New Tab 创建器负责；Board Inbox 只作为带 Branch 上下文的第二个真实 Launch 入口。这个列表是显式的一方 UI 能力，不引入插件发现、市场、脚本运行时或通用扩展框架。

### 3.1 Explorer / Editor Copy、Adapt、Omit Manifest

固定来源为 a mature workbench Commit `6da7b8e9cfe62e5b4d34bb52e8c570036c1935fc`。下表记录的是实际进入 AgentMux 的实现，不以“参考过”代替来源和适配说明。

| a mature workbench 源码 | AgentMux 落点 | 决策 | 适配与证据 |
| --- | --- | --- | --- |
| `components/right-sidebar/file-explorer-dir-load-tracker.ts` | `components/file-tree/file-explorer-dir-load-tracker.ts` | Copy | 保留“目录独立 revision + Workspace reset session”，旧 Local/SSH 响应都不能覆盖新状态；基础测试覆盖同目录乱序与切换 Workspace。 |
| `components/right-sidebar/file-explorer-stale-dir-cache.ts` | `components/file-tree/file-explorer-stale-dir-cache.ts` | Copy/Adapt | 保留折叠目录标 stale、重新展开强制读取；AgentMux 的 Refresh 继续显示旧 children，避免等待 SSH 时整棵树闪空。 |
| `components/right-sidebar/file-explorer-row-projection.ts` | `components/file-tree/file-explorer-row-projection.ts` | Copy/Adapt | 保留 Path/Index/Parent/First-child 投影；输入改成 AgentMux 的相对 Workspace `TreeNode`，不复制 a mature workbench 的账户与 Issue 行类型。 |
| `components/right-sidebar/file-explorer-selection.ts` | `components/file-tree/file-explorer-selection.ts` | Copy | 保留 Replace、Toggle、Range、Additive Range 及 Active/Anchor truth；重命名和删除时同步重映射或清理整个子树。 |
| `components/right-sidebar/file-explorer-keyboard-navigation.ts` | `components/file-tree/file-explorer-keyboard-navigation.ts` | Copy/Adapt | 保留 Arrow/Home/End/Page、Right 展开或进入首个子项、Left 收起或返回父项；使用非虚拟 Row Projection 作为同一语义输入。 |
| `components/right-sidebar/useFileExplorerTree.ts` | `components/file-tree/useWorkspaceFileTree.ts` | Adapt | 保留 Directory Cache、Stale Response、Refresh Retention 与并发批次；唯一传输改为现有 Typed Preload IPC，由 Main Process 同时约束 Local/SSH Workspace Root。 |
| `components/right-sidebar/useFileExplorerReveal.ts`、`useFileExplorerAutoReveal.ts` | `FileExplorer.tsx` 的 ancestor expansion + reveal effect | Adapt | Active Editor File 展开所有祖先，异步目录完成投影后对真实 Row 调用 `scrollIntoView({ block: 'nearest' })`；不引入第二份 Selection owner。 |
| `components/right-sidebar/FileExplorerRow.tsx` | `FileExplorer.tsx` 的 `FileTreeRow` | Adapt | 保留 disclosure、文件类型图标、选择、Rename/Delete action 与密集 Tree Row；视觉继续使用 AgentMux Graphite/Mint token，文件操作继续走现有确认与 Main IPC。 |
| `lib/language-detect.ts` | `lib/language-detect.ts` | Copy/Adapt | 保留集中式 filename/extension 注册，TSX/JSX 返回 Monaco 真实基础 id；Nim 映射明确删除，避免在未带 tokenizer 时谎称高亮。 |
| `lib/file-type-icons.ts` | `lib/file-type-icons.ts` | Copy/Adapt | 保留集中式 filename/extension Icon Registry；当前 `lucide-react@0.468` 没有 a mature workbench 使用的 `FileBraces`，使用同包已存在的 `Braces`，不为单个图标升级整套依赖。 |
| `lib/monaco-languages/register-vue.ts`、`register-svelte.ts`、`register-astro.ts`、`register-jsonl.ts` | `lib/monaco-languages/` 与 `monaco.ts` | Copy | 四个 tokenizer 与注册测试从固定 Commit 直接移植；应用启动时向当前 Monaco 实例注册，`.vue/.svelte/.astro/.jsonl` 不再只是有 language id 的纯文本。 |
| `lib/monaco-setup.ts` 的 TypeScript/JavaScript worker 配置 | `monaco.ts` | Adapt | 关闭当前单文件 Worker 无法可靠承担的语义与建议诊断，删除假 unresolved-import 红线；AgentMux 编辑的是完整文件，因此与 a mature workbench 的 Diff Viewer 不同，继续保留真实语法诊断，并启用 JSX Preserve。 |
| `lib/monaco-languages/register-nim.ts`、TextMate provider、Nim grammar | 无 | Omit | Nim 需要新增 `vscode-textmate`、`vscode-oniguruma`、WASM 和大语法资产；当前验收没有 Nim 工作流，因此不增加这组依赖，`.nim` 确定性返回 `plaintext`。 |
| a mature workbench 文件系统 Watch/Daemon 通路 | Window Focus Refresh + Manual Refresh | Omit/Equivalent | 真实 Watch 必须同时覆盖 Local 与 SSH，当前 Feature 又明确不调整 mux owner；Local-only watcher 会制造语义分叉。等价验收验证 Focus/Manual Refresh、Stale Response 和状态保持，不伪称持续 Watch。 |
| a mature workbench 虚拟列表与 Row Drag | 无 | Omit | AgentMux 当前按展开目录惰性加载，实际 Row 数量由用户展开行为约束，DOM Row 可直接 `scrollIntoView`；文件移动也不在 T-011。未出现规模证据前不增加 `@tanstack/react-virtual` 或文件拖动生命周期。 |

Monaco 继续负责文本布局、DPR、tokenization 和编辑行为；AgentMux 只提供文件内容、Workspace 绑定与保存动作。a mature workbench 的 Relay/Daemon、账户、Hosted Issue、WSL、兼容历史和文件树之外的产品对象均未进入本次移植。

2026-08-10 注册真相复审补充：Monaco 0.56 未注册 `notebook`、`mermaid`、`makefile`、`cmake`、`erlang`、`haskell`、`csv`、`tsv`。这些映射已删除并回落 `plaintext`；`.ipynb` 作为实际 JSON 源文件使用内置 `json`，`.mdx` 使用内置 `mdx`。启动时会把 detector 输出全集与 `monaco.languages.getLanguages()` 比对，测试则从当前安装包的 `editor.main.js` contribution 入口推导内置注册集合，并加入四个 AgentMux 明确注册 ID，避免再用手写字符串清单自证。

### 4. Board 是二维 Branch × Status 矩阵

用户口述的 “broad” 按现有产品名解释为 `Board`。a mature workbench 的 `AgentKanbanBoard` 已验证固定状态列、列内卡片排序、搜索／筛选、独立滚动和点击卡片打开 Terminal；AgentMux 直接迁移这些空间与卡片层级，但不照搬 a mature workbench 以 Agent 状态作为唯一分组的对象模型。

AgentMux 的纵向泳道身份由 Project 下的 Branch／Worktree 决定，每个 Branch 视觉上占一行；横向固定为 Inbox、Working、Needs You、Done 四列。Inbox 是创建入口，不伪造 Session；真实 Run 由 `(branchId, status)` 共同落位，状态变化是在同一 Branch 行内横向移动，不能跳到别的 Branch。映射保持穷尽且简单：`starting/running/working → Working`、`waiting/blocked/disconnected/error → Needs You`、`done/exited → Done`。

Inbox 是 Board 第一列，不再是 Tools 的独立子 Tab。每个 Branch 的空 Inbox 单元都提供 Start discussion；点击它或已有 Inbox Run 会进入携带 Branch/Workspace 的 Discussion Canvas。Canvas 只选择讨论主题与现有 Provider，提交后通过已有 Store → Typed IPC → Core Client → `agentmuxd` 创建真实 Session；成功 Run 自动出现在该 Branch 对应状态格，失败沿现有 Launcher 事务恢复，不制造 Mock 卡片或第二套任务数据。

“像音乐游戏”只保留平行泳道、清晰落点和横向进展感，不加入积分、皮肤或无关动效。Board 继续使用标题前的共享 Tools Dock，但 Dock 只表达 Project Branch Scope 与矩阵图例；Inbox 的创建和处理留在矩阵本体。横向滚动发生在矩阵容器，纵向滚动浏览 Branch，Branch 标签和状态列头在滚动时保持可辨认。

### 追加验收边界

- a mature workbench 视觉语言必须有 Reference Provenance、Surface／Density 规则和并排截图证据，不能再以“风格类似”代替验证。
- Explorer／Editor 必须有 a mature workbench Source Manifest、集中式语言识别与文件图标测试，以及目录点击、键盘导航、选择、刷新和文件变更的行为矩阵。
- Tools 入口必须位于右侧主区最左侧、标题之前；Workspace/Board 共用容器但拥有不同内容。Browser/Terminal 工具只能路由 Universal Tab，不得形成第二套进程或插件架构；Inbox 不得重复出现在 Board Tools。
- Board 截图与交互证据必须证明 Branch／Worktree 行轴、四个状态列、Run 在同一 Branch 内横向迁移、Inbox Canvas 和项目全局语义；仅按 Agent 状态分列或仅按 Branch 横向串卡片都不通过。
- Production Rendered Proof 必须同时记录 `devicePixelRatio`、Terminal/Monaco 默认字号与关键文本物理像素，不能用极小字号换取“密度”。
- 新一轮最终验收继续要求 `pnpm check`、Production Electron 干净配置启动、目标窗口截图、无 Renderer Error／严重 Overflow，并诚实记录残余差距。

## 2026-08-10 UI 反馈追加

- Editor 与嵌入网页的初始内容偏大。“更高分辨率”不解释为降低 DPR 或缩放 bitmap，而是在原生 HiDPI backing 上提高默认信息容量：Monaco 使用 `14px / 21px`，Main-owned Browser WebContents 初始 Zoom Factor 为 `0.9`。Terminal 仍保持当前 15px，避免把三个不同内容 owner 绑成一项全局比例配置。
- Titlebar 的 Tools 入口改为纯图标，通过 Tooltip 与 ARIA 表达展开／收起；Tool 二级面板不再重复放一个 Collapse 按钮。展开状态仍只有 Zustand 中的一份 truth。
- Settings 只保留 Project Rail 左下角入口，删除右上角重复入口；不保留 Alias 或兼容 UI。
- 上述尺度必须在 Production Electron 的真实 DPR 下验收：Editor 检查字号与 Canvas backing/CSS，Browser 检查 `webContents.getZoomFactor()`，不能用 CSS transform 假装“更高分辨率”。

## 2026-08-10 架构与代码熵复审

这轮复审确认产品对象模型和进程边界没有明显漂移：Core 仍不依赖 Electron/React，Browser、Git、文件系统仍由 Main Process 持有，Agent 生命周期仍经过 Core。真正的问题是执行优先级已经倒置——一级目标 `packages/core` 仍未成熟，Desktop Feature 却持续扩张 Board 与 Renderer。后续 Revision 必须先修复 Core、安全和身份一致性，再恢复 Board 收口。

### 已核实问题

1. Review 快照中的 `BranchesPanel` 重复 `snapshot` 声明已在快照后删除，当前 Desktop typecheck 通过；该旧事实不进入新任务。
2. Core 在 tmux 启动前发布 Session，失败只写入 error 并抛出，导致 Snapshot、Activity 与 Client 可能残留幽灵 Session。
3. `RuntimeController.configure()` 运行中新增或替换 Host 后没有调用 Core Discovery，因此不会发现该 Host 已有 AgentMux Session。
4. 内嵌 Browser 可加载远程页面，但没有 fail-closed permission request/check handler；页面自身导航与重定向也没有复用协议边界。
5. Language Detector 会返回 Monaco 0.56 当前未注册的 Language ID；现有测试只证明字符串映射，没有证明真实 tokenizer 能力。
6. `useWorkspaceBranches` 在 Effect 中才清理 Snapshot，Project 切换后的同步首帧可能组合新 Project 与旧 Branch 数据。
7. ConfigStore 只校验 Host ID 唯一，没有校验 Workspace ID 与规范化 `(hostId, path)` 唯一，可能让同一 Session Tab ID 被多个 Layout 竞争。
8. 文件 Rename/Delete 更新 Last Active File 时使用裸 `startsWith(path)`，会把 `src/app` 错误应用到 `src/application.ts`。

### Revision 6 执行顺序

1. Core Session 启动原子性与动态 Host Discovery。
2. Browser fail-closed 权限与 Navigation/Redirect 协议边界。
3. Workspace 身份唯一性。
4. 文件子树与 Mutation 状态收敛。
5. Monaco 注册真相。
6. Renderer Store 按真实资源所有权降熵。
7. Project Snapshot 隔离与 Branch Board 收口。
8. Production 安全、Runtime 与成熟交互总验收。
9. 最后只与用户讨论 mux 方案，不实施替换。

### 代码品位与熵约束

- 每个任务先修 owner contract，再考虑补偿层；不增加重试、Fallback、Migration、Alias 或新旧双路径。
- 优先使用当前 Core Registry、Electron Session/Navigation API、ConfigStore Schema、现有文件路径 helper、Monaco Registry 与 Zustand 组合模式；没有证据不新增依赖。
- `store.ts` 的拆分只允许沿 Session、Workbench、Document、Browser 这些已存在的资源边界进行。不能用通用事件总线、Repository 层、插件系统或第二套 Store 把行数移动成更多概念。
- 每项修复必须包含能击中原失败模式的 near-miss 测试：失败启动后的同 ID 重试、动态 Host 已有 Session、权限 request/check、非法 redirect、重复 Workspace、`src/app` 对 `src/application.ts`、未注册 Language ID、Project 切换同步首帧。
- 最终 Gate 同时要求 `pnpm check`、Tracker validation、`git diff --check` 与 Production Electron 证据；截图不能替代安全和状态一致性测试。

### Renderer 状态所有权收敛

T-022 不按文件行数机械拆分，也不引入第二个 Store。拆分后的唯一 owner 如下：

| 资源 | 唯一状态转换 owner | Store 保留职责 |
| --- | --- | --- |
| Pane/Split/Layout | `lib/workbench-layout.ts` | 调用纯布局操作并处理用户动作参数 |
| Universal Tab 与 Workspace 投影 | `lib/workbench-tabs.ts` | 组合配置、Session 与当前 Workspace |
| Session/Activity/View Mode | `lib/session-state.ts` | IPC 副作用、Session 自动聚焦和 Launch 成败编排 |
| Browser Tab | `lib/browser-state.ts` | WebContents IPC 的 create/navigate/close 副作用 |
| File/Document/Dirty | `lib/file-workbench-state.ts` | 文件 IPC 的 read/write/create/rename/delete 副作用 |
| 工具、检测与宿主交互 | `store.ts` | Zustand 组合、跨资源编排和公共 `useAppStore` |

`store.ts` 从本轮开始前的 965 行降到约 700 行；这不是验收本身，真正的验收是 Session removed 会同时清理 Session、Activity、View Mode、Tab 与 Layout，Browser close 和 File Mutation 也只经过各自一个纯转换 owner。启动中的 Agent/Terminal Tab 使用必填 `phase: launching | attached`：Core 启动回滚时保留 launching Tab 交给 launch owner 恢复 Launcher，已附着 Session 的 removed 才由 Session owner 清理；用户主动关闭的 launching Tab 不会被 catch 复活。

## 2026-08-10 内存与资源回收追加要求

当前 Production Electron 在完成 Editor、Terminal、Browser 与 Board 交互后，一次起始观测为 Main 约 223 MiB、主 Renderer 约 243 MiB、Browser Renderer 约 98 MiB、GPU 约 96 MiB、Network Utility 约 52 MiB RSS。Chromium 多进程包含共享页，不能把这些 RSS 直接相加成“应用总内存”；单个时点也不足以证明泄漏。

后续工作必须先用同一 Production Build、隔离 user-data、固定窗口和稳定等待点建立可重复基线，分别测量冷启动、Workspace/File Tree、Monaco Editor、Terminal/Daemon、Browser WebContentsView 及关闭后回收。重复开启/关闭循环不只看 RSS，还要核对 Browser WebContents/Process、Core Session、Daemon Session、Monaco Model、Document Cache、Watcher 和 Event Subscription 的真实数量。

只优化有证据的长驻 owner 或未回收资源；先检查 Electron、Monaco、xterm 和当前项目依赖的生命周期 API。不为了数字强制 GC、卸载用户仍在使用的 Surface，也不新建全局 Cache 层、性能框架、兼容路径或一组无证据的配置开关。优化后必须用同一场景复测，并保持完整功能回归通过。
