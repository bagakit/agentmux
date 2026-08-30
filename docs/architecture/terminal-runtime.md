<!--
meta: AgentMux Terminal / CtxMux 运行时架构。
目的：解释终端从字节到像素的端到端链路、各层所有权矩阵，以及 Terminal
palette 与 TUI 自身表现层的边界。
只记录有证据支撑的事实；所有引用为 repo-relative。
入口：docs/plans/mux-runtime-decision.md。
-->

# Terminal 运行时：CtxMux 内核与外观所有权

本文只描述当前源码能证明的事实。术语沿用 `packages/core` 与 Desktop 的既有命名
（Run、Attachment、Agent Session、Provider、OSC 等）。

CtxMux 作为唯一 Run Kernel 的取舍见 `docs/plans/mux-runtime-decision.md`。本文只做
端到端链路与所有权的技术还原。

## 1. 端到端链路

一次终端从字节到像素、从按键到 PTY，跨过四层。每层的权威源码入口如下。

```
Agent CLI / shell (PTY 子进程)
        │  raw bytes
        ▼
CtxMux daemon (ctxmuxd)                 ← 唯一的 Run 生命周期 owner
        │  Unix socket / @ctxmux/sdk
        ▼
CtxmuxRunAdapter                        packages/core/src/ctxmux-run-adapter.ts
        │  CtxmuxAdapter* 事件（data/exit/gap）
        ▼
AgentMuxClient                          packages/core/src/client.ts
        │  AgentMuxClientEvent（terminal-output / process-state / agent-session…）
        ▼
RuntimeController (Desktop Main)         apps/desktop/src/main/runtime-controller.ts
        │  IPC 'agentmux:session-event' → RuntimeEvent
        ▼
TerminalView (Renderer, xterm)          apps/desktop/src/renderer/src/components/TerminalView.tsx
        │  terminal.write(bytes) → WebGL/DOM 渲染
        ▼
像素
```

反向的输入路径：xterm `onData` → `api.sessions.write`
（`TerminalView.tsx:151`）→ `RuntimeController.write`
（`runtime-controller.ts:468`）→ `AgentMuxClient.writeTerminal` /
`writeAgent` → `CtxmuxRunAdapter.input`（`ctxmux-run-adapter.ts:738`）→
CtxMux 的累计 Input cursor → PTY。

关键性质：**主题语义只存在于 Desktop；CtxMux、RunSpec、`packages/core` 只持有
原始字节、尺寸与生命周期**。`packages/core` 的公共类型里没有主题字段（`client.ts` 的
`AgentMuxTerminalCreateInput`、`ctxmux-run-adapter.ts` 的 `CtxmuxAdapterRun` 均无颜色/主题
字段）。

空间操作走另一条正交路径：

```text
managed Agent → agentmux CLI → control.sock → Desktop Main Control Host
                                                │ typed IPC request/receipt
                                                ▼
                                  Renderer Layout Store / reducer
                                                │ Agent / Terminal creation
                                                ▼
                                  RuntimeController → Core → ctxmuxd
```

Core 的 Control 合同只表达类型化的
`inspect.tab/inspect.region/list.agents/open.agent/open.terminal/open.browser/send/focus/arrange/interrupt/resume/stop`
请求和 receipt；它不保存
布局。Desktop Main 持有跨进程事务和长期 Agent lifecycle，Renderer 的 Workspace split tree
是 Tab/Region 的唯一 SSOT。Agent 与 Terminal 创建经长期 RuntimeController，Browser 创建经
Main Browser owner；布局或 owner 丢失时只回滚本次事务。完整命令与 selector 语义只由
`docs/plans/agentmux-ai-native-desktop-composition-cli.md` 定义。布局变化最终只通过既有 viewport
synchronizer 把稳定后的 cols/rows 提交给 ctxmux；CtxMux 从不接收 Tab、Region 或 split direction。

## 2. 所有权矩阵

ctxmux 在这个架构中仍是完整、独立的 Runtime 产品。它的 daemon、CLI、协议和 SDK 不依赖
AgentMux，单独安装时可以运行任意命令并完成完整 Run 生命周期。AgentMux 是 ctxmux 的高级
Client：它消费 Runtime 事实并增加 Agent 语义，不成为 ctxmux 的启动宿主、Provider 容器或
生命周期 Owner。包内固定 ctxmux artifact 只是一项 AgentMux 供应链策略。

分层遵循两个判断：对 shell、server、test、script 和 Agent 都成立，并且只能由 PTY、
process、Backend 或 daemon owner 证明的事实属于 ctxmux；必须理解 Provider、AgentSession、
Permission、消息、任务或 UI 才成立的判断属于 AgentMux 或 Desktop。

这条边界也约束证据提升：`bytes_applied` 不等于 Prompt 已提交，Output byte range 不等于
完整 Agent message，Run `exited` 不等于 Agent task succeeded，transport unreachable 也不等于
远端 Run 已退出。AgentMux 的 semantic event 可以引用 ctxmux Run revision、byte range 和
lineage，但只有 AgentMux Provider 可以解释这些证据。

| 关注点 | Owner | 权威源码 |
| --- | --- | --- |
| PTY raw bytes（stdout/stdin 原始字节） | CtxMux daemon，经 `CtxmuxRunAdapter` 投影 | `ctxmux-run-adapter.ts:418`（`decodeChunk`）、`ctxmux-run-adapter.ts:829`（`emitRunEvent`） |
| Run lifecycle（start/stop/interrupt/resize） | CtxMux，经 adapter 暴露稳定投影 | `ctxmux-run-adapter.ts:587`（`start`）、`:774`（`resize`）、`:787`（`interrupt`）、`:795`（`stop`） |
| Control transaction（inspect.tab/inspect.region/list.agents/open.agent/open.terminal/open.browser/send/focus/arrange/interrupt/resume/stop） | Desktop Main；通过一个版本化 endpoint 连接 CLI 与 Renderer | `apps/desktop/src/main/ipc.ts`、`packages/core/src/control-host.ts` |
| Tab/Region layout 与 placement | Desktop Renderer 的 Layout Store/reducer | `apps/desktop/src/renderer/src/store.ts`、`lib/control.ts`、`lib/workbench-view-layout.ts`、`lib/workbench-layout.ts` |
| Tab 关闭与后台保留决策 | Desktop Renderer；停止动作通过 Core public API 下达 | 关闭承载最后一个 Terminal Region 的完整 Tab 即 Stop Run；Agent 默认 Stop，只有确认保留才继续后台运行；关闭 Tab 内 Region 只改变布局 |
| Viewport grid（何时 fit、向 PTY 提交哪个尺寸） | Desktop Renderer 决定 grid；Desktop Main 用 Region 的 Attachment capability 绑定 exact Run；CtxMux 只应用最终提交的 PTY 尺寸。UI 测得的 cols/rows 是请求，applied `current_size` 才是已生效尺寸 | `terminal-viewport-sync.ts`、`TerminalView.tsx`、`runtime-controller.ts` |
| Owner-confirmed live PTY size | CtxMux `RunInfo.current_size` 与 `RunEvent::Resized`；AgentMux 投影不得用 `RunSpec.size` 冒充当前尺寸，unknown 保持 `null`。`current_size` 是 protocol 16 的**必填**字段：daemon 每次快照都给出答案，`null` 是「没有 owner 能确认」这个真答案（tmux 托管的 pane、历史 Run），不是「字段缺失」。跨客户端 resize 通过广播给所有 attachment 的 `RunEvent::Resized` 收到 | `ctxmux-run-adapter.ts`、`screen-evidence.ts` |
| Replay（重连时的字节回放） | CtxMux 快照，adapter 解码 | `ctxmux-run-adapter.ts:609`（`attach`）、`:641`（`replay`）、`:665`（`observeOutput`） |
| Input（带累计 cursor 的可恢复写入） | CtxMux，adapter 用 `recoverableInput` 重试一次 | `ctxmux-run-adapter.ts:738`（`input`，`attempt < 2` + `disposition === 'unknown'`） |
| Core Provider handshake（终端能力握手） | `AgentMuxClient` | `client.ts:1139`（`ensureTerminalHandshake`） |
| Desktop OSC 10/11 capability reply（Agent 无 Renderer 时） | `RuntimeController`（Main） | `runtime-controller.ts:721`（`publish`）、`:776`（`replyToAgentColorQuery`） |
| Desktop OSC 10/11 capability reply（普通 terminal，Renderer 在场） | Renderer（xterm parser handler） | `terminal-capability-replies.ts:10`、`TerminalView.tsx:155` |
| OSC 查询回复所用的前景/背景色 | Desktop shared palette，经 `setTerminalViewColors` 注入 Main | `runtime-controller.ts:184`、`ipc.ts:46`、`ipc.ts:101` |
| xterm theme（终端外观 `ITheme`） | Renderer，源自 shared palette | `terminal-theme.ts:31`、`terminal-palettes.ts:32` |
| App chrome（产品外框视觉） | Desktop 应用外框（与终端外观分离） | `terminal-theme.ts:12`（注释确立边界） |

Provider-specific executable probe、session id、native resume argv、semantic replay、
working/waiting/done、Permission、Hook 和 A2A 不进入 ctxmux。Provider-native Resume 由
AgentMux 物化通用 `RunSpec` 后交给 ctxmux；Level B provenance 不足时失败关闭，不能自动改成
Level A restart。相反，daemon activation、Run wait、权威生命周期时间与 revision 等不理解
Agent 也成立的能力应由 ctxmux 公共 SDK 提供，AgentMux 不长期维护第二份实现。

一句话概括所有权分层（`terminal-theme.ts:12` 注释原文）：*"App chrome owns product
surfaces, xterm owns terminal appearance, and the PTY/CtxMux path owns bytes only."*

### 2.1 Workbench View 关闭事务

关闭 Tab View 时，Desktop 只持有 Workbench 关闭计划和准入，不接管 Core/CtxMux 的 Stop
事实。关闭请求同步冻结该 View 当时每个 Surface 的精确 owner；Browser 与需要停止的 Session
是互不从属的资源，必须同时发出 cleanup，不能让一个长期 pending 的 Browser 阻塞 Session
Stop。Session Stop owner 还会冻结精确 RunRef；只关闭 presentation、共享 Session 或明确保留的
Agent Session 不绑定 Run epoch。

cleanup 以逐 owner receipt 收敛：成功或已被权威事件精确移除的 owner 从 View 消失，失败且仍在的
owner 保持可见，下一次关闭只重试剩余失败项。不能因为一个资源失败回滚整个 Tab，也不能用完整
Tab 相等判断覆盖关闭期间的新 Region 或新 owner。关闭期间，针对同一 View 的 move、split、
Region close、launch，以及针对待 Stop Session 的 attach、refresh、recover、manual stop 都必须经过
同一 admission；已经在途的异步操作在提交时还要复核精确 owner/Run epoch。Recover 已经创建新
Run 但失去 owner 时，使用现有 Core Stop 清理；清理失败则保留一个可发现、可再次关闭的 View。

Renderer 不保存第二份 Run 状态，也不建立 Stop ledger、重试 tail 或 fallback。权威
`run-removed` 可以先于 API receipt 到达；只要它已经精确满足旧 owner，reconcile 必须幂等接受，
同时绝不能删除同一 Agent Session 后来恢复出的新 Run。

Viewport Resize 是 retained Attachment 的能力，不是只凭 `SessionControl` 就能调用的命令。
Renderer 只在 Attach 成功后用 Desktop 发出的 `attachmentId` 提交尺寸；Main 从 lease 解析权威
exact Run，并让 Resize、Detach 与 Stop 进入同一个 per-Run Attachment 串行器。先进入的 Resize
完成后 Stop 才能开始；Stop 先进入时会撤销 lease，之后到达的 Resize 因 capability 已失效而结束，
不会触达 ctxmux。Agent resize 与 stop 的 Core API 同时要求 `agentSessionId + expectedRun`，旧 View
不能在 provider-native Resume 后控制同一 Agent Session 的新 Run。

## 3. 本地 Shell 与 Run 环境

Desktop 启动时通过用户 `SHELL` 的交互式登录模式读取全部导出变量，使用 NUL 分隔与随机边界隔离启动 banner，保留空值、换行和等号。由 shell 自己选择配置文件，不手工 source 某个 dotfile。非导出变量、alias、function 不作为环境传递。交互式读取失败后可使用非交互式登录结果，但会持续显示部分读取告示；全部失败则保留继承环境并告知用户。

Core 的 `localProcessEnvironment()` 为 daemon 启动及每次本地 Run 创建读取当前进程环境。Run 显式 env 覆盖这份基线，避免常驻 daemon 的旧环境覆盖应用重启后新读取的值。`terminalEnvironment()` 与 `agentEnvironment()` 继续拥有终端能力、CLI 路径与 Agent 身份注入；不由 Desktop 复制这些语义。

基线声明 `TERM=xterm-256color`、`COLORTERM=truecolor`、`TERM_PROGRAM=AgentMux`，版本来自验证过的 `CTXMUX_VERSION`，开启 hyperlink。沿既有终端策略移除宿主遗留的 `NO_COLOR` 与值为 `0` 的 `FORCE_COLOR`/`CLICOLOR`；最终 Agent/Terminal 启动边界再次执行这条清理，避免 executor 快照或长寿命 Runtime 把禁色信号带回来。配置修改对重启应用后创建的新进程生效，不能修改既有进程的环境。

## 4. 完整 ANSI palette 与 Graphite 工作面

### 4.1 palette 结构

终端外观由一份完整的 `ITheme` 决定，SSOT 在 `apps/desktop/src/shared/terminal-palettes.ts`。
`TerminalPalette` 类型要求 22 个键：`background`、`foreground`、
`cursor`、`cursorAccent`、`selection*`，以及 16 个 ANSI 角色（`black`…`brightWhite`）。
`apps/desktop/test/terminal-theme.test.ts` 断言每个 catalog palette 恰好 22 个键，杜绝残缺 palette。

当前 Graphite 默认值：

- `background: '#000000'` — Graphite 的稳定纯黑工作面。
- `foreground: '#ffffff'`。
- `cursorAccent: '#000000'` — 与工作面保持一致。
- `black: '#1d1f21'` — ANSI 黑，与工作面是两个不同角色。

完整 palette 让 TUI 能使用 ANSI 背景区分 composer、instruction block 与终端工作面，
不需要 Desktop 解析或改写 TUI 输出。

### 4.2 主题边界

当前合同是：

1. **Desktop 主题决定工作面。** Graphite 稳定使用 `#000000`，使 Codex 等 TUI
   的灰色 composer 与消息表面保持原生层次。
2. **TUI 决定自己的 surface。** ANSI `black` 保持 `#1d1f21` 且不等于
   `background`；完整的 16 色角色让 composer、消息块和警告自行分层。Desktop
   不解析 ANSI 输出，也不为单个 Provider 动态改写 palette。
3. **OSC 10/11 只报告已选 palette 的真实值。** Renderer 和 Main 使用同一份
   shared palette；Main 在 Renderer 未 attach 时也必须回复 `#000000`，保证同一 Run
   在 attach 前后看到一致的宿主背景事实。

### 4.3 OSC 10/11 回复的编码

回复格式在 `apps/desktop/src/shared/terminal-osc-color-query.ts`：`cssColorToOscRgb`
（`:36`）把 `#rrggbb` 转成 `rgb:RRRR/GGGG/BBBB` 的 16-bit 形式（每字节重复成 4 位十六进制），
`terminalOscColorQueryReply`（`:83`）据 slot 10/11 选 foreground/background 并包上
OSC 终止符。`terminal-osc-color-query.test.ts:10` 锁定该格式
（如 `#000000 → rgb:0000/0000/0000`）。

## 5. OSC ready gate、replay 不回复、历史 Run 只读

Codex 可能在 Renderer 尚未 attach 时就发出 OSC 10/11 查询。若在 Core 完成自己的 Terminal
handshake（`client.ts:1139`）之前抢答，会与 handshake 争用同一个 CtxMux Input cursor。为此有三条防线：

### 5.1 Agent 路径：Main 缓冲，Session ready 后再回

`RuntimeController.publish`（`runtime-controller.ts:721`）在每个 `terminal-output` 事件上
用 `scanTerminalOscColorQueries`（含跨 chunk 的 `remainder`）识别完整或分片的查询（`:724`）：

- 若该 Run 尚未有 ready 的 Agent Session（`readyAgentColorQueryRuns` 无记录），回复被暂存进
  `pendingAgentColorQueryReplies`，且有 4 KiB 上限（`:737`–`:740`）。
- 当 Core 发布 `agent-session` 事件（`:743`），把该 Run 标记为 ready 并 flush 暂存的回复，
  经 `replyToAgentColorQuery` → `writeAgent`（`:745`–`:755`、`:776`）写回。
- Run 结束或移除时清理三张表（`:756`–`:763`）。

回归测试：`apps/desktop/test/runtime-controller.test.ts`「answers split Codex color queries only after
Core publishes the ready Agent Session」——先发一个**跨两个 chunk**的 `OSC 10;?;?` 查询，
断言 `writeAgent` **未**被调用；发布 `agent-session` 后，断言回复
`\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:2828/2c2c/3434\x1b\\` 被写回。
该测试同时证明 Main 回复与 Graphite shared palette 一致。

### 5.2 普通 terminal 路径：Renderer 内答，但 replay 不答

对 `session.kind === 'terminal'`，由 Renderer 的 xterm parser handler 应答
（`TerminalView.tsx:155`–`:161`，`respondFromRenderer: session.kind === 'terminal'`）。
`installTerminalColorQueryReplyHandlers`（`terminal-capability-replies.ts:10`）为 slot 10/11
注册 OSC handler：

- 仅当 `respondFromRenderer && !isReplaying()` 才回复（`:23`）；`isReplaying` 绑定到
  `() => !readyForLiveOutput`（`TerminalView.tsx:156`）。
- **无论是否回复都 `return true`**（`:29`），即 xterm **消费**该 OSC 但在回放期不作答。

意义（`terminal-capability-replies.ts:7` 注释）：Main 已在无 Renderer 时应答 live 查询；
xterm 消费 replay 里的旧查询但不再次作答，避免重开 Tab 后把**历史响应**注入当前前台进程。

### 5.3 历史 Run 只读

`TerminalView` 用 `canControlRun = session.processState === 'running'`
（`TerminalView.tsx:50`）作为总闸：

- 键盘输入仅在 `canControlRun && readyForLiveOutput` 时写回（`:152`）。
- OSC 回复的 `sendInput` 同样受 `canControlRun && readyForLiveOutput` 约束（`:158`–`:160`）。
- 仅 `canControlRun` 时才启动 viewport 的 live 尺寸同步（`:212`）。

因此已退出的历史 Run 在 UI 上是只读回放，不会向已死进程写入按键、尺寸或 OSC 回复。
多个 Renderer View 并发 attach 同一 Run 时，Main 复用同一个 CtxMux Attachment、后续 View 走
`readRunReplay`（`runtime-controller.ts:397`–`:400`；测试 `runtime-controller.test.ts:310`）。

### 5.4 Resize 只提交稳定、最新的网格

DOM 的 `ResizeObserver` 只说明容器几何发生了变化，不代表 xterm 的字符网格已经稳定。
`TerminalViewportSynchronizer` 先比较 `FitAddon.proposeDimensions()` 的连续帧结果
（`terminal-viewport-sync.ts` 的 `observeViewport`/`continueStableFit`，`MAX_STABILITY_FRAMES=8`）：
网格稳定或达到 8 帧上限后才执行 fit；若 xterm 已经等于 proposal，则不做无效 fit。这样
divider 拖拽不会把每一帧都变成 Codex 的整屏重排。

**Wobble gate：只有容器 CSS 像素真的变化才 fit。** 稳定帧门控挡不住一类静止态抖动——拖拽
已停、容器像素固定，但 WebGL renderer 的 cell metrics 会短暂偏离 DOM renderer，使
`proposeDimensions()` 在同一像素几何下于 N 与 N±1 列之间跳动。若照此 fit，xterm 会 reflow
一列再弹回，而 wrap→unwrap 并非完美逆运算，Codex/grok 这类 diff 绘制的 TUI 会被画花，形成
持续闪烁。`fitAndSynchronize`（`terminal-viewport-sync.ts` 的 `fitAndSynchronize` /
`samePixels` / `lastFittedPixels`）因此在网格与 xterm 分歧时，用必需的 `measureViewport()`
读容器 CSS 像素并与上次成功 fit 的基线比较（差异 < 1 CSS 像素视为同一几何）：像素未变即判为
cell-metric 抖动，直接跳过 fit 与 PTY resize；像素确有变化才走 fit → resize。基线存副本，避免
调用方复用同一可变对象时把基线一起改掉。`measureViewport` 由 `TerminalView` 用宿主
div 的 `getBoundingClientRect()` 提供；Synchronizer 不接受缺少像素 owner 的调用方，也不保留
纯网格兼容路径。

xterm 的 `onRender` 只用于证明首帧已经可测量：`TerminalView` 在收到首个 render 时先注销
监听，再请求一次 viewport 同步。普通 TUI 输出不是 geometry 事件，绝不能持续进入 fit 链路；
否则 Codex 重绘与一列宽度波动会形成 render → fit → PTY resize → render 的反馈环。

Attach replay 是状态恢复，不是历史动画。`TerminalView` 将 CtxMux 返回的有序 replay chunk
合并为一次 xterm parser write，并在 replay 与启动期 pending output 排空前保持终端画布不可见，
只展示恢复态。最终状态完成后再原子揭示画布；真实 attach 失败则揭示红色错误。
这样既保留字节顺序与最终 TUI 状态，也不会把数千个历史重绘帧播放成“终端自己 resize”。

**原子揭示有 deadline，超时后揭示优先于原子性。** 隐藏画布的正当理由只有一个：避免把历史重绘
帧当动画播出去。它**不是**一个可以无限期持有的权利——`AGENTS.md` 原则 11 在这里的含义是，
一个我们等不到的步骤不得把一个健康的终端永久藏起来。恢复态此前只有两个出口（全链成功、attach
抛错），于是"链上某处永不 settle"这一类在界面上表现为**永久转圈**，而 ctxmux、Run、PTY 全都好着。

因此揭示的前提收敛为**画面正确所真正依赖的那一步**：replay 字节写完。live 视口同步与 gap redraw
移到揭示之后继续（它们改善画面，但不决定画面是否可看），**不再阻塞揭示**——此前 `startLiveSynchronization`
排在揭示之前，它经由 resize 与 attach 争用同一把按 Run 串行的锁，该 Run 上任一卡住的操作都会让
揭示永不到来。此外揭示本身带一个 deadline：到点仍未揭示则**强制揭示**，画布交还给用户。

强制揭示不得静默：它按原则 11 走服务窗告示（第 2 类——我们的步骤没走通，Agent 没坏），说清哪一步
没走通、现在按什么状态在跑、怎么恢复完整能力。恢复态本身仍是诚实信号，不因"看着烦"而删除；
被削弱的只是它无限期遮挡画布的权利。

CtxMux 的原始 Replay 有界；Gap 表示请求 cursor 与 `firstAvailableByte` 之间的字节已经淘汰，
保留后缀不能被宣称为完整终端屏幕。`TerminalView` 因此不再把 Gap 文案写进 xterm 字节流，
而是在画布上方显示独立提示。对仍在运行的 Run，Replay 和启动期 Live Output 排空后，
`TerminalViewportSynchronizer.requestContentRedraw()` 通过唯一 Resize Owner 临时减少一行，再恢复
最终 xterm 网格，促使 TUI 在同一个 Run 上输出当前完整画面；用户也可以从提示中手动重试。
历史 Run 没有可重绘的 PTY，只显示保留内容和缺失提示，不发送 Resize 或 Input。这个行为恢复的
是“当前可用画面”，不是已经淘汰的滚动记录；完整要求见
`docs/plans/agentmux-terminal-replay-gap-recovery.md`。

PTY resize 仍可能慢于 UI 拖拽，所以 synchronizer 不再把所有中间尺寸串成 Promise 队列。
它只保留一个 in-flight 请求和一个可替换的 pending size（`requestResize`/`drainPendingResizes`）；新尺寸覆盖尚未
发送的旧尺寸，最终由 `api.sessions.resize` → Core → CtxMux 应用。历史 Run 因 `live=false`
只在本地 fit 回放画面，不向 PTY 发 resize。对应测试锁定了稳定帧等待、同帧合并、历史 Run
只读，以及 in-flight 期间 `110×30` 被更新的 `120×30` 取代
（`apps/desktop/test/terminal-viewport-sync.test.ts`）。

## 6. 已发生故障与防回归测试

| 故障/风险 | 防回归测试 | 断言要点 |
| --- | --- | --- |
| Graphite 工作面或 cursor accent 偏离稳定纯黑 | `apps/desktop/test/terminal-theme.test.ts` | Graphite `background === cursorAccent === '#000000'`；`black === '#1d1f21'` 且与工作面不同 |
| palette 残缺导致 TUI 无法分层 | `apps/desktop/test/terminal-theme.test.ts` | 每个 catalog palette 恰好 22 键 |
| OSC 抢答争用 Input cursor / Session 未就绪即回复 | `apps/desktop/test/runtime-controller.test.ts` | ready 前 `writeAgent` 未调用；ready 后写回 shared Graphite 前景/背景 |
| 跨 chunk 的 OSC 查询被漏答或重复答 | `apps/desktop/test/terminal-osc-color-query.test.ts:30` | 分片查询保留 `remainder`，合并后只答一次 |
| replay 旧查询被再次注入当前进程 | `terminal-capability-replies.ts:23`（`!isReplaying()` 门控）；`terminal-osc-color-query.test.ts:44` | 回放期不作答；malformed/颜色变更查询被忽略 |
| OSC 回复格式漂移 | `terminal-osc-color-query.test.ts:10` | 16-bit `rgb:RRRR/GGGG/BBBB` 形式 |
| 历史 Run 被误写输入 | `TerminalView.tsx:50`（`canControlRun` 门控，见 §5.3） | 非 running 时输入/OSC/resize 均不写回 |
| 拖拽后 Codex 因陈旧 PTY 尺寸队列持续闪烁 | `apps/desktop/test/terminal-viewport-sync.test.ts` | proposal 稳定后才 fit；未发送的中间尺寸被最新网格替换 |
| 静止态 WebGL/DOM cell-metric 抖动使一列网格反复 reflow 画花 Codex（wobble） | `apps/desktop/test/terminal-viewport-sync.test.ts`（"skips a one-column grid wobble…"、"fits and resizes when container pixels actually change"） | 容器 CSS 像素未变时跳过 fit+resize；像素真变化才 fit（`measureViewport`/`samePixels`） |
| 首帧 render 监听未注销导致 TUI 自发 resize | `TerminalView.tsx` 的 one-shot `terminal.onRender` | 首个 render 先 dispose；后续输出不再触发 viewport 同步 |
| Attach 逐条写入数千个 replay event，历史 TUI 帧看起来像持续 resize | `apps/desktop/test/terminal-replay.test.ts` | replay 合并为一次 parser write；恢复完成前隐藏画布 |

`docs/testing/strategy.md` 记录了整体测试策略；本表只列与终端运行时直接相关的回归点。

## 7. 交叉引用

- `docs/plans/mux-runtime-decision.md` —— 选择 CtxMux 作为唯一 Run Kernel 的取舍。
- `docs/plans/ctxmux-cutover.md` —— cutover 计划与桌面侧 daemon 退役。
