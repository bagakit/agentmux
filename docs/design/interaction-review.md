# AgentMux Desktop 交互设计

本文记录 AgentMux Desktop 当前的产品模型、状态所有权和交互边界。它只描述 AgentMux 自身的事实；实现历史、外部产品对照和任务流水不进入这份长期文档。

## 产品模型

AgentMux Desktop 是 `packages/core` 的第一方 Client。Core 负责 Agent Provider、Session、进程、终端字节流、权限和交互请求；Desktop 负责 Workspace、文件、浏览器、窗口布局和用户交互。Core 不依赖 Electron 或 React，Desktop 也不绕过 Core 直接管理 Agent 进程。

界面由三层对象组成：

1. Project/Workspace Rail 切换工程上下文。
2. Tools Dock 承载当前 Surface 的高容量工具。Workspace 显示 Files、Branches、Browser Favorites 和 Terminal Shortcuts；Board 显示 Branch Scope、状态图例和统计。
3. 主区在 Workspace 与 Board 间切换。Workspace 使用递归 Pane 布局，Board 使用二维 `Branch × Status` 矩阵。

Workspace、Board、Branches 和 Session 列表消费同一份 Project、Workspace、Host、Branch 和 Agent 状态投影。界面不建立第二份 Session registry，也不根据标签反推运行时真相。

### Workspace 与 Worktree

Files 和 Branches 位于同一个可调整的上下分栏。Branch 行展示真实 Worktree 绑定、路径、当前状态和 dirty 状态，并按 `hostId + worktreePath` 投影仍在运行的 Agent。Terminal、历史记录和已退出 Session 不计入运行中 Agent。

选择已绑定 Worktree 会一起更新 Selected Worktree、Explorer Root、Breadcrumb 和后续新 Tab 的 Workspace 上下文。已经打开的 File、Agent 和 Terminal Tab 保留原绑定，不被静默换根。选择未绑定 Branch 不执行隐式 checkout；只有 Worktree 创建成功并注册为 Workspace 后才切换。

### Board

Board 的纵向行由 Branch/Worktree 决定，横向固定为 Inbox、Working、Needs You 和 Done。真实 Run 由 `(branchId, status)` 落位，状态变化只在所属 Branch 行内移动。

Inbox 是矩阵第一列。Start discussion 打开携带 Branch 和 Workspace 上下文的创建界面，提交后仍经 Renderer Store、typed IPC 和 Core Client 创建真实 Session。启动失败恢复原创建界面，不生成占位 Run 或第二套任务数据。

## Pane、Tab 与对象级反馈

Workspace 的布局是递归 `leaf | split` 树。每个 Leaf 拥有自己的 Tab Strip、Focused 状态和 Ratio；Tab 可以在同一 Strip 内排序、移入其他 Pane，或拖到 Pane 边缘创建 Right/Down Split。Secondary Pane 清空后折叠对应 Split，最后一个 Tab 关闭后仍保留明确的创建入口。

点击 Focused Pane 的 `+` 会立即创建一个 Tab。初始内容提供 Terminal、Agent 和 Browser 选择，选定后在同一个 Tab 内完成转换。Focused Pane 同时决定文件、创建页和 Session 打开的落点。

运行中的 Terminal 或 Agent 在关闭前需要明确确认。恢复、权限、断连和写入失败都显示在受影响对象旁边。跨对象故障由全局 Toast 汇总。

Tab 右键菜单只提供已有状态模型可以完成的操作：Close、Close Others、Close Left、Close Right，以及移动到 Right/Down Split。批量关闭遇到 dirty 文件时使用一个可访问确认框统一决定。Tab Pin、颜色和重命名没有对应模型，因此不显示占位动作。

### Session 信息与 Provider 身份

Agent 与 Terminal Pane 使用紧凑信息带展示 Session Name、短 ID、Started、Active、Recent 和 Stop。ID 可以复制完整值，时间复制无损值；Active 取 Runtime `updatedAt` 与结构化 Activity 的最大时间。Recent 只投影最近的 User/Assistant 结构化消息，不从 PTY 文本推断消息或私有思维。

Provider 图标由 `AgentProviderIcon` 统一投影到 Launcher、Tab、Session header、Settings 和 Board。内置 Provider 使用离线资产，未知 Provider 使用中性 Bot 图标。Provider 是否可用由 Core detection 决定，Renderer 不以图标或配置项替代检测结果。

## Terminal 所有权

应用外框与 Terminal 使用独立的外观边界。外框使用 Graphite/Mint；Renderer 在创建 xterm 时注入完整 Terminal palette。Settings 只持久化严格的 `terminalTheme` 标识，当前 catalog 提供 Graphite 与 Catppuccin Mocha。主题不进入 `packages/core`、RunSpec、PTY 或 CtxMux 协议。

CtxMux 持有 PTY、进程、原始字节、Replay、尺寸和生命周期。Core 将这些能力投影为 Agent 无关的公共 API。Desktop Main 识别 Renderer attach 前出现的 OSC 10/11 查询，等待 Core 发布 ready Session 后再经 Core Input 写回答复；Renderer 消费 Replay 中的历史查询但不重复注入当前进程。

Codex TUI 的输入区属于 PTY 画面。Terminal View 直接把键盘输入交给 xterm/Core，不并列渲染第二个 Composer。Rich Composer 只属于结构化 Activity/Conversation View，提交失败时保留草稿。

xterm 的实际 `cols × rows` 是 Renderer View 真相。Replay 完成后，Renderer 先同步当前网格，再响应 ResizeObserver 的后续变化。首个可测 Render signal 负责替换构造阶段的 `80×24` 默认值。尺寸路径固定为 Desktop Renderer → Core public Resize → CtxMux。

默认 Terminal 使用 `12px` 字号和 `1.0` 行高；Monaco 使用 `14px / 21px`。Browser WebContents 初始 Zoom Factor 为 `0.9`。密度调整必须保留原生 DPR、Canvas backing 和库自身的布局语义，不使用 CSS transform 模拟分辨率。

## Explorer 与 Editor

Explorer 使用文件夹优先的层级树、展开目录缓存、stale response token、刷新时旧 children 保留、行选择、键盘导航和文件操作。Active Editor File 会展开祖先目录并滚动到真实 Row。Rename 和 Delete 会同步重映射或清理 Selection、Tab、Document 与 Last Active File 的对应子树。

文件操作只经 typed preload IPC 到 Desktop Main。Main 负责 Workspace Root confinement、Local/Remote transport、Reveal、创建、同目录重命名和删除；Renderer 只持有树投影、选择和交互状态。跨目录 move 不属于当前文件操作合同。

Monaco 负责文本布局、DPR、tokenization 和编辑行为。语言检测使用集中式 filename/extension 注册，启动时把 detector 输出与 `monaco.languages.getLanguages()` 核对。`.vue`、`.svelte`、`.astro` 和 `.jsonl` 由 AgentMux 显式注册；`.ipynb` 使用 `json`，`.mdx` 使用 `mdx`；未注册的 `notebook`、`mermaid`、`makefile`、`cmake`、`erlang`、`haskell`、`csv`、`tsv` 和 `.nim` 回落为 `plaintext`。

### Revision-aware 保存

Desktop Main 的 `WorkspaceFiles` 是 Workspace Root confinement、磁盘 revision、文件写入和单文件观察的唯一 owner。Shared contract 与 preload 只暴露 typed read、write、observe 能力，不持有磁盘状态。

Local read 从实际字节计算不透明 revision。Write 同时按请求路径和最终 physical path 串行，并执行以下顺序：

1. 在目标同目录独占创建临时文件。
2. 完整写入内容并同步临时文件。
3. 保留原文件的必要 mode。
4. 复核 expected revision。
5. 用原子替换提交完整文件。

临时写入或替换失败会清理临时文件，原文件字节保持不变。Remote workspace 在无法满足同一 revision-aware 原子保存合同的情况下返回 typed unsupported，不提供旧的 revisionless 写入口。

Renderer 持有 Monaco buffer、dirty、保存 generation、observation generation、document lifetime 和冲突交互。保存开始时捕获 buffer、revision、generation 与 lifetime；保存期间继续输入不会被旧 written 回执清除。旧 save/read completion 也不能越过 close→reopen 边界修改新文档 owner。

Main observation 只发布 `{ workspaceId, path }` 失效事实。Renderer 收到失效后重新 read：

- clean buffer 自动采用新内容与 revision；
- dirty buffer 保留草稿并进入 changed 或 deleted conflict；
- read error 保留最后 buffer，并显示为独立错误，不能伪装成删除；
- Reload 明确采用 observed disk state；
- Overwrite 使用最近一次 observed revision，若磁盘再次变化则继续 conflict。

这里的 revision 是普通文件系统上的 optimistic concurrency signal。最终 revision 复核与 `rename` 是两个独立系统调用，外部进程仍可能在两者之间改写目标；实现缩小并显式暴露冲突窗口，但不宣称内核提供强跨进程 compare-and-swap。

## 状态与资源边界

Renderer 只保留跨资源编排和公共 `useAppStore`，各类纯状态转换按真实资源拆分：

| 资源 | 状态转换 owner | Store 职责 |
| --- | --- | --- |
| Pane/Split/Layout | `lib/workbench-layout.ts` | 调用布局操作并处理用户动作参数 |
| Universal Tab 与 Workspace 投影 | `lib/workbench-tabs.ts` | 组合配置、Session 与当前 Workspace |
| Session/Activity/View Mode | `lib/session-state.ts` | IPC 副作用、自动聚焦和 Launch 成败编排 |
| Browser Tab | `lib/browser-state.ts` | WebContents create/navigate/close 副作用 |
| File/Document/Dirty | `lib/file-workbench-state.ts` | 文件 read/write/create/rename/delete 的 Renderer 状态 |
| 工具、检测与宿主交互 | `store.ts` | Zustand 组合、跨资源编排和公共 API |

Session removed 会一起清理 Session、Activity、View Mode、Tab 与 Layout。Browser close 和 File Mutation 只经过各自一个转换 owner。启动中的 Agent/Terminal Tab 使用 `phase: launching | attached`：launch 失败恢复创建界面；attached Session 的 removed 才触发 Session 清理；用户主动关闭的 launching Tab 不会被异步失败回执复活。

Desktop 退出时按顺序等待 IPC owner、文件观察、`WorkspaceFiles` observer child 和 Runtime 释放。Mounted package Gate 只在 relocated Main、Helpers 和 observer worker 全部 graceful 退出后通过；隔离 runtime 的长生命周期 CtxMux daemon 由测试 owner 根据 exact artifact path、socket 和 argv 识别并清理，不触碰用户的常规安装。

资源判断同时观察进程、WebContents、Core Session、Attachment、Monaco Model、Document、Watcher 和 Event Subscription 数量。Chromium 进程间存在共享页，多个 RSS 数值不能直接相加成应用总内存。只有可重复场景中的 owner 数量或 steady-state 趋势才能支持泄漏判断。

## 验证标准

- `packages/core` 不依赖 Electron/React，所有 Agent 生命周期都经过 Core public API。
- Workspace、Board、Branches 和 Session 视图对同一对象给出一致的身份和状态。
- Pane/Tab 拖拽、分屏、关闭确认和对象级恢复在 Production Electron 中工作，无严重 Overflow。
- Explorer 的路径、symlink 和 mutation 受 Workspace Root 约束；跨目录 move 不被重命名入口隐式实现。
- Local save 在继续输入、外部改盘、删除、read error、临时写入失败和替换失败下得到确定结果，草稿和原文件均不被静默覆盖。
- Mounted Desktop 从 DMG 挂载副本经 LaunchServices 走 Renderer → preload → IPC → `WorkspaceFiles`，并在 Gate 结束时留下零个测试拥有的 Desktop/observer/daemon 进程。
- `pnpm check`、Desktop typecheck/build、owner tests、故障注入和 mounted package Gate 共同通过；截图不替代状态一致性、安全或 lifecycle 证据。
