<!--
meta: AgentMux Terminal / CtxMux 运行时架构与演进。
目的：解释终端从字节到像素的端到端链路、各层所有权矩阵，以及为什么 Codex
自己的灰色 composer 现在能正确显示；并用源码与 Git 历史还原 CtxMux 接入前后的实现。
只记录有证据支撑的事实；所有引用为 repo-relative。
入口：docs/design/interaction-review.md「Terminal 外观所有权」。
-->

# Terminal 运行时：CtxMux 内核与外观所有权

本文只描述有源码/Git 证据支撑的事实。凡是历史无法被证据确认之处，明确标注为
**未知**，不补叙事。术语沿用 `packages/core` 与 Desktop 的既有命名（Run、Attachment、
Agent Session、Provider、OSC 等）。

设计与交互决策的一手记录见 `docs/design/interaction-review.md`「Terminal 外观所有权」
与「Terminal 与文件交互先对齐 a mature workbench」两节；CtxMux 作为唯一 Run Kernel 的取舍见
`docs/plans/mux-runtime-decision.md`。本文不重复这些内容，只做端到端链路与所有权的技术还原。

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
字段）。这与 `docs/design/interaction-review.md`「Terminal 外观所有权」记载的原则一致。

## 2. 所有权矩阵

| 关注点 | Owner | 权威源码 |
| --- | --- | --- |
| PTY raw bytes（stdout/stdin 原始字节） | CtxMux daemon，经 `CtxmuxRunAdapter` 投影 | `ctxmux-run-adapter.ts:418`（`decodeChunk`）、`ctxmux-run-adapter.ts:829`（`emitRunEvent`） |
| Run lifecycle（start/stop/interrupt/resize） | CtxMux，经 adapter 暴露稳定投影 | `ctxmux-run-adapter.ts:587`（`start`）、`:774`（`resize`）、`:787`（`interrupt`）、`:795`（`stop`） |
| Viewport grid（何时 fit、向 PTY 提交哪个尺寸） | Desktop Renderer；CtxMux 只应用最终提交的 PTY 尺寸 | `terminal-viewport-sync.ts:77`（稳定网格）、`:115`（latest-wins resize） |
| Replay（重连时的字节回放） | CtxMux 快照，adapter 解码 | `ctxmux-run-adapter.ts:609`（`attach`）、`:641`（`replay`）、`:665`（`observeOutput`） |
| Input（带累计 cursor 的可恢复写入） | CtxMux，adapter 用 `recoverableInput` 重试一次 | `ctxmux-run-adapter.ts:738`（`input`，`attempt < 2` + `disposition === 'unknown'`） |
| Core Provider handshake（终端能力握手） | `AgentMuxClient` | `client.ts:1139`（`ensureTerminalHandshake`） |
| Desktop OSC 10/11 capability reply（Agent 无 Renderer 时） | `RuntimeController`（Main） | `runtime-controller.ts:721`（`publish`）、`:776`（`replyToAgentColorQuery`） |
| Desktop OSC 10/11 capability reply（普通 terminal，Renderer 在场） | Renderer（xterm parser handler） | `terminal-capability-replies.ts:10`、`TerminalView.tsx:155` |
| OSC 查询回复所用的前景/背景色 | Desktop shared palette，经 `setTerminalViewColors` 注入 Main | `runtime-controller.ts:184`、`ipc.ts:46`、`ipc.ts:101` |
| xterm theme（终端外观 `ITheme`） | Renderer，源自 shared palette | `terminal-theme.ts:31`、`terminal-palettes.ts:32` |
| App chrome（产品外框视觉） | Desktop 应用外框（与终端外观分离） | `terminal-theme.ts:12`（注释确立边界） |

一句话概括所有权分层（`terminal-theme.ts:12` 注释原文）：*"App chrome owns product
surfaces, xterm owns terminal appearance, and the PTY/CtxMux path owns bytes only."*

## 3. 环境变量：TERM / COLORTERM / NO_COLOR

终端程序是否输出颜色，取决于它启动时看到的环境。AgentMux 在**两个不同层**设置终端环境，
二者语义不同，不要混淆：

**(a) daemon 自身环境** — `daemonEnvironment()`，`ctxmux-run-adapter.ts:143`。
用于 spawn `ctxmuxd` 进程本身（`ctxmux-run-adapter.ts:490` 处 `env: daemonEnvironment()`）：

- `TERM = 'xterm-256color'`、`COLORTERM = 'truecolor'`、`TERM_PROGRAM = 'AgentMux'`、
  `TERM_PROGRAM_VERSION = '0.1.0'`、`FORCE_HYPERLINK = '1'`（`:145`–`:150`）。
- **`delete environment.NO_COLOR`**（`:152`）——移除会全局禁用颜色的变量。
- 若 `FORCE_COLOR === '0'` 或 `CLICOLOR === '0'` 则删除之（`:153`–`:154`），避免显式的
  "关颜色"信号泄漏进 daemon。

**(b) 每个 Run 的环境** — `terminalEnvironment()`，`client.ts:205`。
用于每个 shell/terminal Run，以及经 `agentEnvironment()`（`client.ts:1122`）派生的 Agent Run：

- 固定注入 `TERM = 'xterm-256color'`、`COLORTERM = 'truecolor'`、
  `TERM_PROGRAM = 'AgentMux'`、`TERM_PROGRAM_VERSION = '0.1.0'`、`FORCE_HYPERLINK = '1'`
  （`client.ts:208`–`:214`），随后展开调用方传入的 `environment`（`:214` 的 `...environment`）。
- `createTerminal` 用它包裹用户/调用方 env（`client.ts:556`）；`createAgent`/`resumeAgent`
  通过 `agentEnvironment`（`client.ts:1130` 的 `...terminalEnvironment(environment)`）复用同一基线。

**证据边界（未知）**：`terminalEnvironment()`（层 b）**没有**像 `daemonEnvironment()`
那样删除 `NO_COLOR`/`FORCE_COLOR=0`/`CLICOLOR=0`。子进程最终看到的环境是否含 `NO_COLOR`，
取决于 daemon 进程的环境经 CtxMux 传播给 Run 的具体行为——这属于 CtxMux daemon 内部，
不在本仓库源码内，故标注为**未知**，不臆测。可确证的是：AgentMux 侧对每个 Run 显式声明了
`TERM=xterm-256color` 与 `COLORTERM=truecolor`，即向终端程序声明支持 256 色与真彩。

## 4. 完整 ANSI palette + 真黑工作面：Codex 灰色 composer 为何现在显现

### 4.1 palette 结构

终端外观由一份完整的 `ITheme` 决定，SSOT 在 `apps/desktop/src/shared/terminal-palettes.ts`。
`TerminalPalette` 类型（`terminal-palettes.ts:3`）要求 22 个键：`background`、`foreground`、
`cursor`、`cursorAccent`、`selection*`，以及 16 个 ANSI 角色（`black`…`brightWhite`）。
`terminal-theme.test.ts:47` 断言每个 catalog palette 恰好 22 个键，杜绝残缺 palette。

当前 Graphite 默认值（`terminal-palettes.ts:33`）：

- `background: '#000000'` — **真黑工作面**。
- `foreground: '#ffffff'`。
- `black: '#1d1f21'` — ANSI 黑，**刻意不等于 background**。

`terminal-theme.ts:12` 的注释解释了为何 palette 必须完整：*"A complete palette is
important: TUIs use ANSI backgrounds to distinguish composers and instruction blocks from
the terminal work area."*

### 4.2 因果链：为什么灰色 composer 现在能显现

Codex 这类 TUI 用 ANSI 背景色/自绘 surface 把 composer（输入区）和消息块与终端工作面区分开。
灰色 composer 能否被看见，取决于**它自绘的灰色 surface 与工作面底色之间是否有对比**。这条链上
有两个必要条件，都由本仓库证据支撑：

1. **工作面必须是真黑，而非近灰。** 迁移前 Graphite `background` 是 `#282c34`
   （见 §5.1，一种深灰蓝）。Codex 的灰色 composer 叠在近灰底上时对比塌陷、难以分辨。
   现在 `background` 为 `#000000`（`terminal-palettes.ts:34`），同时 ANSI `black` 保持
   `#1d1f21`（`:40`），两者分层清晰。回归测试直接锁定这一不变量：
   - `terminal-theme.test.ts:36`「does not collapse the default TUI composer color into the
     work area」断言 `theme.black === '#1d1f21'` 且 `theme.black !== theme.background`；
   - `terminal-theme.test.ts:47` 对每个 catalog palette 断言 `theme.black !== theme.background`。

2. **Codex 需要能查询到工作面底色，以计算自适应 surface。** Codex 会发 OSC 10/11
   （前景/背景）查询。AgentMux 用 shared palette 的 `foreground`/`background` 回复
   （`ipc.ts:45`–`:49` 把 palette 注入 Main；`runtime-controller.ts:184` 存为
   `terminalViewColors`；OSC 回复经 `scanTerminalOscColorQueries` 生成，见 §4.3）。回复的
   背景为真黑 `#000000`，Codex 据此选出与黑底对比的灰色 composer。

3. **颜色本身必须启用。** §3 中每个 Run 显式声明 `TERM=xterm-256color` 与
   `COLORTERM=truecolor`；daemon 环境删除 `NO_COLOR`。

三者叠加，Codex 自己的灰色 composer 与消息 surface 得以从真黑工作面上分层显现。产品识别
留在应用外框，而非靠篡改终端色层实现——这正是 `terminal-theme.ts:12` 与
`terminal-palettes.ts:28` 注释所述边界。

### 4.3 OSC 10/11 回复的编码

回复格式在 `apps/desktop/src/shared/terminal-osc-color-query.ts`：`cssColorToOscRgb`
（`:36`）把 `#rrggbb` 转成 `rgb:RRRR/GGGG/BBBB` 的 16-bit 形式（每字节重复成 4 位十六进制），
`terminalOscColorQueryReply`（`:83`）据 slot 10/11 选 foreground/background 并包上
OSC 终止符。`terminal-osc-color-query.test.ts:10` 锁定该格式与 a mature workbench 一致
（如 `#282c34 → rgb:2828/2c2c/3434`）。

## 5. OSC 就绪门控（ready gate）、replay 不回复、历史 Run 只读

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

回归测试：`runtime-controller.test.ts:261`「answers split Codex color queries only after
Core publishes the ready Agent Session」——先发一个**跨两个 chunk**的 `OSC 10;?;?` 查询，
断言 `writeAgent` **未**被调用（`:284`）；发布 `agent-session` 后，断言回复
`\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:0000/0000/0000\x1b\\` 被写回（`:302`–`:307`）。
该测试同时证明了背景回复为真黑 `rgb:0000/0000/0000`。

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
（`terminal-viewport-sync.ts:77`–`:100`）：网格稳定或达到 8 帧上限后才执行 fit；若 xterm
已经等于 proposal，则不做无效 fit。这样 divider 拖拽不会把每一帧都变成 Codex 的整屏重排。

xterm 的 `onRender` 只用于证明首帧已经可测量：`TerminalView` 在收到首个 render 时先注销
监听，再请求一次 viewport 同步。普通 TUI 输出不是 geometry 事件，绝不能持续进入 fit 链路；
否则 Codex 重绘与一列宽度波动会形成 render → fit → PTY resize → render 的反馈环。

Attach replay 是状态恢复，不是历史动画。`TerminalView` 将 CtxMux 返回的有序 replay chunk
合并为一次 xterm parser write，并在 replay 与启动期 pending output 排空前保持终端画布不可见，
只展示 `Restoring terminal…`。最终状态完成后再原子揭示画布；真实 attach 失败则揭示红色错误。
这样既保留字节顺序与最终 TUI 状态，也不会把数千个历史重绘帧播放成“终端自己 resize”。

PTY resize 仍可能慢于 UI 拖拽，所以 synchronizer 不再把所有中间尺寸串成 Promise 队列。
它只保留一个 in-flight 请求和一个可替换的 pending size（`:115`–`:146`）；新尺寸覆盖尚未
发送的旧尺寸，最终由 `api.sessions.resize` → Core → CtxMux 应用。历史 Run 因 `live=false`
只在本地 fit 回放画面，不向 PTY 发 resize。对应测试锁定了稳定帧等待、同帧合并、历史 Run
只读，以及 in-flight 期间 `110×30` 被更新的 `120×30` 取代
（`apps/desktop/test/terminal-viewport-sync.test.ts`）。

## 6. 迁移前实现及其限制

CtxMux 是**当前唯一的 Run Kernel**。迁移由一串 commit 完成，可用 Git 还原（以下均为
可确证事实）：

- `b02803b docs(core): adopt ctxmux as the sole run kernel` —— 决策：ctxmux 成为唯一 Run
  Kernel（仅改 `docs/plans/*`）。commit 记录的用户更正：*"AgentMux should integrate the
  stable ctxmux subset now instead of waiting for every ctxmux optimization."*
- `523e144 feat(core): cut shell runs over to ctxmux` —— 实际切换。该 commit 的 diffstat
  显示**删除了 AgentMux 自建的 PTY/daemon 栈**：`packages/core/src/agentmuxd.ts`（-251）、
  `daemon-client.ts`（-450）、`daemon-server.ts`（-560）、`daemon-protocol.ts`（-276）、
  `daemon-session-journal.ts`（-121）、`daemon-connector.ts`、`daemon-endpoint.ts`、
  `daemon-diagnostics.ts` 等，并**新增** `packages/core/src/ctxmux-run-adapter.ts`（+496）。
- 其后 `9658ce4 fix(core): make shell input retry-safe`、
  `f898bf2 fix(core): fence the exact ctxmux runtime owner`、
  `8322cbf feat(core): restore codex over ctxmux`、
  `868d822 feat(core): harden ctxmux-backed agent sessions` 逐步加固。

**迁移前 Run Kernel 的形态（据 commit `523e144` 的 message 与 diffstat 可确证）**：
AgentMux 曾自持 PTY、进程组、daemon 协议与会话 journal（commit message：*"AgentMux owned
PTYs, process groups, daemon protocol, and journals -> CtxMux owns Shell Runs behind one
private adapter"*）。其记录的限制是：自建栈与 CtxMux 会**争用 Run 的生命周期所有权**，且需要
**第二套生命周期实现**才能做到断连/重连保持同一 Run；切换后由 CtxMux 单一 owner 承担，
断连重连保持同一 Run 无需第二套实现。

**未知**：迁移前那套 daemon/PTY 的**逐行内部行为**已从当前 main 删除，本文不据删除的实现
细述其运行逻辑；如需精确还原，须 `git show 523e144^:packages/core/src/daemon-*.ts` 逐文件核对。
本文不就已删代码的细节展开，以免超出证据。

### 6.1 迁移前的终端外观状态

终端**外观**的迁移由 `574e531 feat(desktop): align terminal and explorer with a mature workbench`
一次完成（这是 palette 与 OSC 文件在 `git log` 中的**唯一**历史 commit）。据
`git show 574e531^`：

- `apps/desktop/src/shared/terminal-palettes.ts` 与
  `apps/desktop/src/shared/terminal-osc-color-query.ts` 在此 commit **之前并不存在**（新增）。
- 迁移前 Graphite 的 `background` 是 **`#282c34`**（近灰蓝），`cursorAccent` 也是 `#282c34`；
  ANSI 角色色值与今相同。即：**迁移前工作面是近灰底**，正是 §4.2 中导致 Codex 灰色 composer
  对比塌陷的状态。
- 该 commit 的 message 明确列出本轮变更包含 *"true-black Graphite, ready-gated OSC replies,
  and replay-only historical Runs"*，并记录用户更正：*"Terminal behavior and file context
  actions should first match a mature workbench, while all Run lifecycle and control continue through
  CtxMux."*

## 7. 已发生故障与防回归测试

| 故障/风险 | 防回归测试 | 断言要点 |
| --- | --- | --- |
| 工作面灰底吞没 Codex 灰色 composer | `apps/desktop/test/terminal-theme.test.ts:36`、`:47` | `theme.black !== theme.background`；Graphite `background === '#000000'`、`black === '#1d1f21'` |
| palette 残缺导致 TUI 无法分层 | `terminal-theme.test.ts:47` | 每个 catalog palette 恰好 22 键 |
| OSC 抢答争用 Input cursor / Session 未就绪即回复 | `apps/desktop/test/runtime-controller.test.ts:261` | ready 前 `writeAgent` 未调用；ready 后写回含真黑背景的回复 |
| 跨 chunk 的 OSC 查询被漏答或重复答 | `apps/desktop/test/terminal-osc-color-query.test.ts:30` | 分片查询保留 `remainder`，合并后只答一次 |
| replay 旧查询被再次注入当前进程 | `terminal-capability-replies.ts:23`（`!isReplaying()` 门控）；`terminal-osc-color-query.test.ts:44` | 回放期不作答；malformed/颜色变更查询被忽略 |
| OSC 回复格式与 a mature workbench 不一致 | `terminal-osc-color-query.test.ts:10` | 16-bit `rgb:RRRR/GGGG/BBBB` 形式 |
| 历史 Run 被误写输入 | `TerminalView.tsx:50`（`canControlRun` 门控，见 §5.3） | 非 running 时输入/OSC/resize 均不写回 |
| 拖拽后 Codex 因陈旧 PTY 尺寸队列持续闪烁 | `apps/desktop/test/terminal-viewport-sync.test.ts` | proposal 稳定后才 fit；未发送的中间尺寸被最新网格替换 |
| 首帧 render 监听未注销导致 TUI 自发 resize | `TerminalView.tsx` 的 one-shot `terminal.onRender` | 首个 render 先 dispose；后续输出不再触发 viewport 同步 |
| Attach 逐条写入数千个 replay event，历史 TUI 帧看起来像持续 resize | `apps/desktop/test/terminal-replay.test.ts` | replay 合并为一次 parser write；恢复完成前隐藏画布 |

`docs/testing/strategy.md` 记录了整体测试策略；本表只列与终端运行时直接相关的回归点。

## 8. 交叉引用

- `docs/design/interaction-review.md` —— Terminal 外观所有权、OSC 就绪门控与
  "先对齐 a mature workbench" 的一手交互决策与用户原话。
- `docs/plans/mux-runtime-decision.md` —— 选择 CtxMux 作为唯一 Run Kernel 的取舍。
- `docs/plans/ctxmux-cutover.md`、`docs/plans/agentmux-desktop-daemon-cutover.md` ——
  cutover 计划与桌面侧 daemon 退役。
