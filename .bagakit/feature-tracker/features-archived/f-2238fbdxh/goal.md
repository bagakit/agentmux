# Feature Goal：采用 Refproj 成熟模式重构 AgentMux 交互

Contract: `bagakit.feature-goal.v1`
Feature: `f-2238fbdxh`

开始工作前先验证 `owner-receipt.json`，再从 `state.json` 和 `tasks.json` 恢复当前执行状态。聊天上下文可能过时或属于其他 Feature，以本 Feature 目录为准。

## 首要目标
先把 `packages/core` 交付成边界可靠的本地 Agent Runtime，再采用 Refproj 已验证的工作分区、状态与恢复模式，以及 Warp 高容量、Terminal-first 的组件语言，交付专家级 AgentMux 桌面交互：开发者能在真实 Local/SSH Project 中选择 Worktree，联动浏览和编辑文件，并在可自由分屏的 Universal Tab 中运行 Terminal、Agent 与 Browser。桌面端是 `packages/core` 的第一方 Client，必须证明可复用 Runtime 能被宿主安全地安排、检查、恢复和控制，而不是以 UI 完成度掩盖 Core 缺口。

## 受保护的不变量
- 最左 Project/Workspace Rail 只负责工程切换；Tools 入口固定在右侧主区最左侧、Workspace/Board 标题之前。Workspace 与 Board 共用可收起的高容量 Tool Dock，但分别恢复自己的内容：Workspace 为 Files + Branches、Browser Favorites、Terminal Shortcuts；Board 只承载 Project-scope 的 Branch 与筛选控制，Inbox 属于 Board 矩阵而不是 Tools 子 Tab。
- Selected Worktree 是 Explorer Root、Breadcrumb 和后续 New Tab Workspace Context 的真相；选择已有 Worktree 会联动这些对象，已经打开的 File、Terminal、Agent、Browser Tab 不得被静默换根。
- 未绑定 Worktree 的 Branch 只展示真实未绑定状态和 Create Worktree 动作，不隐式 checkout；只有 Git 成功并注册 Workspace 后才能切换文件上下文。
- Workspace 拥有 Recursive Pane Layout；Pane 拥有 Universal Tab；Focused Pane 决定 File 和 New Tab 的打开位置。点击加号立即创建 Tab，Tab 内再选择 Terminal、Agent 或 Browser，选择后原位替换创建面板。
- Board 是 Project Scope 的二维 `Branch × Status` 矩阵：每个 Branch/Worktree 对应一条纵向泳道（视觉上一行），横向按 Inbox、Working、Needs You、Done 分列；Run 位置由 `(branchId, status)` 决定，状态变化只在同一 Branch 行内横向移动。
- Inbox 是 Board 第一列。点击 Branch 的空 Inbox 单元或卡片会打开携带 Branch/Workspace 上下文的 Discussion Canvas；Canvas 通过现有 `packages/core` / tmux Agent Launch 创建真实讨论 Session，成功 Run 回到对应 Branch 泳道，不建立第二套 Session 或 mux 真相。
- 在本 Feature 内 tmux 继续拥有 PTY/Process；`packages/core` 继续拥有 Terminal/Agent 发现、语义和生命周期；Electron Renderer 只能通过 Typed Preload IPC 消费公共 API。mux 的长期替代方案只形成用户确认的后续决策，不在本 Feature 夹带 Runtime 替换。
- Session Launch 必须具备事务语义：tmux 启动失败后 Core Snapshot、Activity、Watcher 与 Client Event 最终收敛为不存在该 Session；运行中新增的 Local/SSH Host 必须立即发现其已有 AgentMux Session。
- Browser 由 Electron Main Process 通过维护中的嵌入式 WebContents 能力与 Typed IPC 管理，权限默认拒绝，页面导航和重定向必须重新校验协议；不使用普遍受 X-Frame-Options/CSP 阻断的 iframe Fallback。
- Agent Detection 和 Host Health 按 Execution Host 作用域存储，由 Settings、Launch、Tab、Sidebar、Empty State 复用，不能各自计算出矛盾真相。
- Raw Terminal 和 Observable Activity 是同一 Session 的两种投影；Activity 不得宣称是私有 Chain-of-thought。
- Local/SSH 的 File Create、Rename、Delete、Read、Write 必须受 Selected Worktree Workspace Root 约束，并由 Main Process 负责。
- Workspace ID 与规范化 `(hostId, path)` 必须唯一；文件子树判断必须按路径分段，字符串前缀相似不得改变无关 Tab、Document 或 Last Active File。
- Language Detector 只能返回 Monaco 内置或 AgentMux 已明确注册的 Language ID；没有 tokenizer 的文件类型回落为 `plaintext`，不能声明虚假支持。
- 所有异步 Project/Workspace Snapshot 必须携带请求身份；Project 切换后的同步首帧与迟到响应都不得泄漏上一 Project 数据。
- Git Worktree 创建必须显式触发，且仅在 Git 成功后注册 Workspace。
- SSH 使用系统 Client 与现有认证，不复制或保存 Private Key 内容。
- 过时的固定布局 State、UI 结构、Alias、Migration、Compatibility Layer、Fallback Implementation 直接删除。
- 成熟依赖负责成熟问题；当前依赖没有跨 Pane Drag/Drop Primitive，因此可采用 Refproj 已验证的 `@dnd-kit`。
- 视觉保持 AgentMux 的 Graphite/Mint Terminal Language；只迁移 Refproj 的信息架构、内容层级、状态语义和交互模式。
- 默认画面和 Tab 内容必须在 Production Electron 中清晰：操作文字以 11–13px 为主，Terminal/Editor 默认 14–15px，并由 xterm/Monaco 原生处理 DPR；不得用 7–9px 大面积文字或 CSS 二次缩放制造假密度。
- 非目标：复制 Refproj 的 Relay/Daemon、Account、Mobile、WSL、Emulator、Hosted Issue Integration 或兼容历史；也不在 Project Rail 中堆叠完整 File Tree、Branch List 和 Board 控制，不在 Board 任务中改造 mux Runtime、引入任务数据库或通用 Canvas 框架。

## 验收与停止规则
- 验收：Repository Check 全部通过；Core 证明失败启动回滚、动态 Host Discovery 与 Local/SSH 恢复；Browser 证明 fail-closed 权限和协议边界；Workspace 身份、文件子树、Monaco 语言注册与 Project Snapshot 隔离有确定性测试。干净配置的 Production Electron 展示清晰的 Titlebar/Tab 内容、Project/Workspace Rail、标题前 Tools、Explorer/Branches 上下 Resize、Bound/Unbound Branch 与 Worktree Path、Worktree Selection 对文件上下文的真实联动，以及纵向按 Branch/Worktree、横向按 Inbox/Working/Needs You/Done 的 Board 矩阵；Inbox Discussion Canvas 能携带 Branch/Workspace 与 Provider 上下文，通过现有 Core/tmux 创建真实 Run 并回落到对应 Branch 行。Universal Tab 同时证明 Terminal/Agent/Browser/File 创建、四向 Drag-to-split、Resize/Move/Collapse、Editor Dirty/Save、Pane-local Terminal/Activity/Recovery、Host-scoped Codex/Claude/TraeX/Hermes/Pi、Local/SSH File 与 Worktree Flow。mux 讨论形成用户确认的中文决策与后续边界，但不在本 Feature 实施替换。
- 不足：存在幽灵 Session、动态 Host 漏发现、Browser 权限默认放行或协议绕过、重复 Workspace 身份、字符串前缀误伤文件、未注册 Monaco Language ID、Project 切换首帧泄漏；Board 仍按 Agent 状态纵向分组、Branch 不是稳定行轴、Run 状态变化会跨 Branch、Inbox 仍是 Tools 独立页、Canvas 只创建 Mock 卡片或绕过 Core；画面或 Tab 默认内容因极小字号／错误缩放而发虚，Tools 位于标题之后或只在 Workspace 出现，Agent Launch 被塞进 Tools，Explorer 与 Branches 互不联动、Branch 选择隐式 checkout、已有 Tab 被静默换根、加号仍等同于 Agent Launcher、Browser 只是 iframe/Mock、仅在固定三栏上换皮、只有 Drag 装饰但不改变 Pane、Compatibility Scaffolding，或只有源码构建／截图没有行为与安全证据。
- 以下情况先询问：修改用户全局 Agent Hook、改变 SSH Credential、没有 App 内明确确认就删除 File、发布 Package/Release、使用付费 API，或扩展到审计边界之外的 Refproj 系统。

## 权限与执行原则
- 只遵循本 Feature 的 Owner Receipt、State 和 Reviewed Task。
- 在 Current Tree 工作，保留无关用户改动；除非用户另行授权，不创建 Commit。
- 在最终对象模型上逐个交付可运行 Vertical Slice；当前进展只更新 Feature Task Truth，除非方向长期变化，否则不改本 Goal。
- Core、安全与身份一致性任务先于 Board 视觉收口；Renderer 熵治理只沿真实资源所有权拆分，不做泛化重构，不新增第二套状态真相。

## 上下文引用
- `AGENTS.md`：定义 Core 第一、编辑器为第一方 Client 的项目目标和工程原则；开始架构改动前读取。
- `docs/design/refproj-interaction-review.md`：定义有证据的 Copy/Keep/Omit 决策；扩大 UI 前读取。
- `.bagakit/design/refproj-informed-interaction-redesign/design-packet.toml`：定义 Product Model、Tone、Rule、Risk 和 Checkpoint。
- `docs/refproj-agent-runtime-notes.md`：定义 Runtime 提取边界；改动 Provider、Hook、tmux、SSH 语义前读取。
