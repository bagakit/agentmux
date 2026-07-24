# a mature workbench Agent Runtime 源码解读与 AgentMux 提取边界

对照源码：`~/proj/github/a mature workbench`，版本
`6da7b8e9cfe62e5b4d34bb52e8c570036c1935fc`（2026-08-08）。

T-002 在 2026-08-10 又通过 CodeGraph 复核了 a mature workbench
`34f2a62cdaf58dc5924a3b01f560f91b53a5c277` 的
`src/main/pty/posix-pty-process-groups.ts` 与对应测试。AgentMux 直接采用其已验证的
PTY 范围识别模式：先用 `ps -p` 获取根进程的 TTY，再用 `ps -t` 限定同一终端，
子进程组先于根进程组强停，并在 Daemon 与目标共享 TTY 时回退到 node-pty 的窄化
Kill。没有复制 a mature workbench 的 Provider、兼容层或 Desktop 状态。

T-003 同日通过 CodeGraph 复核 a mature workbench 当前的
`src/main/ssh/ssh-connection.ts`、`ssh-relay-session.ts`、
`ssh-relay-versioned-install.ts` 与 `src/relay/relay-handshake.ts`：采用长期 Transport
退出后重连、版本化并排安装、完成 Sentinel、握手版本 Fail Closed、重新 Attach 已知
PTY 的模式；AgentMux 没有复制 a mature workbench 的 ssh2 Transport、Relay Account、端口扫描、
兼容 GC 或 Provider 体系，而是继续使用用户确认的系统 OpenSSH 与同一份 Daemon
Protocol。

T-004 在 2026-08-11 通过 CodeGraph 复核 a mature workbench 当前
`src/shared/tui-agent-config.ts`、`src/shared/agent-session-resume.ts` 与 Managed Hook
实现：采用声明式 executable / expected process / prompt delivery、Provider Session
Handle 与 Daemon Attach 分离、配置写入前 Generation Check 和只移除自有 Hook 的模式。
AgentMux 没有复制 a mature workbench 的大型 Agent Catalog、AI Vault、自动全局安装与兼容路径；具体边界见
`docs/plans/agentmux-semantic-session.md`。

## 总体结论

a mature workbench 不是传统意义上的无界面 Agent Runner。它先是一套持久化终端系统，再在终端之上叠加 Agent 语义：

1. 声明式目录描述每个 Agent 的可执行文件、前台进程、Prompt 注入方式和就绪条件。
2. 启动规划器把 `{ agent, prompt, args, env, platform }` 转换成终端启动命令和必要的后续输入。
3. Provider 持有 PTY、Shell 与子进程，负责字节流、重连和进程树清理。
4. Agent 原生 Hook 把生命周期事件发送到带认证的本地接收器；接收器把 Provider 特有事件归一化成小型状态代数，并绑定到稳定 Pane 身份。
5. Renderer 再把同一份状态投影到 Worktree、Tab、Board、通知和移动端。

真正值得提取的边界不是“复制 a mature workbench 的终端”，而是：

```text
Agent Adapter -> Startup Plan -> Terminal / Session Owner
                         |                 |
                         v                 v
                  Native Hook Event    Output / Liveness
                         \                 /
                          Normalized Event Stream
```

旧的 Desktop Redesign Feature 曾保留真实 tmux，随后 Core Maturity 又实现了自建 `agentmuxd`。2026-08-11 的方向修正恢复 ctxmux 为唯一 Run Kernel：a mature workbench 的 Attach-only、Incarnation、增量输出、Replay、背压和进程树清理继续作为 Conformance 证据，但 AgentMux 不再复制这些通用 mux 实现，也不复制 a mature workbench 的账户、Relay 或兼容历史。

## 1. Agent 启动规划由数据驱动

`src/shared/tui-agent-config.ts:4-45` 定义六种 Prompt 交付模式和统一的 Adapter 字段。内置 Agent 的启动方式并不相同：

- Claude 使用 `claude` 加位置参数；`--prefill` 是独立的“只填充、不提交”能力（`48-56`）。
- Codex 也使用位置参数，但 a mature workbench 会先做 Trust Preflight，并通过 Codex 特有的 Composer Ready 信号决定何时粘贴草稿（`80-87`）。
- TraeX 使用已安装的 `traex` 交互式 CLI，初始 Prompt 是一个位置参数。
- Pi 接收位置参数；草稿预填则通过 `ORCA_PI_PREFILL`，避免启动后的粘贴竞争（`129-137`）。
- Hermes 的普通 TUI 是 `hermes --tui`；有初始 Prompt 时使用原生
  `hermes chat --query=... --tui`（`274-280`，以及
  `src/shared/hermes-startup-query.ts:89-139`）。

`buildAgentStartupPlan` 是主要归一化点：它解析配置与覆盖值，按 Shell 规则引用参数，再选择位置参数、`--prompt`、Hermes Query、交互标志或后续输入（`src/shared/tui-agent-startup.ts:43-184`）。因此 Prompt 交付属于 Provider 启动计划，不属于 Terminal 或 UI 的条件分支。

Hermes 还会限制 Prompt 传输大小、从环境恢复 argv-safe Query，并在启动后清理环境变量，避免工具子进程继承原始 Prompt（`src/shared/hermes-startup-query.ts:9-16`、`141-194`）。AgentMux Provider 继续输出 argv-safe Launch Plan，由 Run Kernel 执行；保留 Hermes 的原生命令形状，不让 UI 或 Adapter 拼 Shell 字符串。

## 2. a mature workbench 的普通 Session 是 node-pty，而不是 tmux

a mature workbench Local Provider 通过 Shell Fallback 调用 `pty.spawn`（`src/main/providers/local-pty-provider.ts:838-862`）。它按稳定 Session ID 持有进程，可以重新 Attach，而不是重复 Spawn（`532-553`）。输出统一进入 Provider Event Fanout（`910-929`、`1002-1013`）；退出事件使用 Incarnation Fence，避免旧进程的迟到事件污染新 Session（`1018-1038`）。

停止 Agent 时，a mature workbench 不只杀 Shell，还会清理后代进程，避免 MCP 或工具进程继续占用 Worktree cwd。POSIX 先优雅停止再强制终止；Windows ConPTY 只走强制路径（`1110-1202`）。

切换前的 AgentMux 基线把下列责任交给真实 tmux：

- Detached Session 提供 PTY/Process 持久化；
- `remain-on-exit` 和 Pane Format 提供可检查的退出状态；
- Prefix 限定的 Session Name 提供窄化停止目标；
- `capture-pane` 提供重启后可恢复的终端投影。

T-005 已完成从 tmux 到自建 `agentmuxd` 的历史切换并删除 Capture Polling、command-per-input 和 tmux 类型。该实现现在是待替换 baseline：最终由 ctxmux 负责 Run/PTY/Process、Sequence、Replay、Backpressure 与 Attachment，AgentMux 只保留 AgentSession、Provider 和 Client 投影。

## 3. a mature workbench 的“tmux 支持”是兼容外观

Claude Agent Teams 是一个容易误判的例子。a mature workbench 没有为它启动真实 tmux Server，而是在 `PATH` 前放置 Fake tmux，注入合成的 `TMUX`/`TMUX_PANE`，并为每个 Team 分配随机 Bearer Token（`src/main/runtime/claude-agent-teams-service.ts:25-76`、`claude-agent-teams-shim-env.ts:19-51`、`116-134`）。

Dispatcher 只实现 Claude Code 需要的 `split-window`、`respawn-pane`、`list-panes`、`send-keys`、`capture-pane`、Pane 选择和销毁，再把这些调用翻译成 a mature workbench Terminal API（`claude-agent-teams-tmux-dispatcher.ts:17-80`）。

AgentMux 不复制这层兼容外观：普通 Terminal／Agent 通过 AgentMux Run/AgentSession API 映射到 ctxmux，不暴露 tmux Vocabulary，也不保留 Fake／Real tmux Backend。

## 4. Agent 语义状态来自 Hook，不来自终端猜测

a mature workbench 明确声明：Agent Status 来自原生 Hook，不从终端标题推断（`src/shared/agent-status-types.ts:1-3`）。核心语义状态为 `working`、`blocked`、`waiting`、`done`（`16-17`），同时保留 Prompt、时间、Model、Pane/Worktree 归属、Tool Preview、交互问题、Assistant Preview、Subagent 和 Provider Session 身份（`89-145`）。

Hook Receiver 是只绑定 `127.0.0.1` 的临时认证 HTTP Server。它生成随机 Token、验证 Header、限制请求生命周期，并采用 Fail-open：观察器失败不能阻断 Agent（`src/main/agent-hooks/server.ts:2081-2199`）。状态持久化使用临时文件加原子 Rename（`2804-2863`）。

主要事件映射如下：

| Agent | 工作中 | 需要用户 | 完成 |
| --- | --- | --- | --- |
| Claude | `UserPromptSubmit`、Tool/Compact Progress | `PermissionRequest`、`AskUserQuestion` | `Stop`、`StopFailure` |
| Codex | `SessionStart`、`UserPromptSubmit`、Tool Progress | `PermissionRequest`、`request_user_input` | `Stop` |
| Pi | Agent/Tool/Message Activity | `ask_user_question` | `agent_end` / Settled |
| Hermes | Session/LLM/Tool Activity | `pre_approval_request` | LLM/Session End、Finalize、Reset |

对应归一化证据位于 `src/shared/agent-hook-listener.ts`：Claude `2729-2813`，Codex `3561-3588`，Pi `3800-3854`，Hermes `4043-4087`。

AgentMux 不会在首个交付中静默修改 `~/.claude`、`~/.codex`、Hermes Plugin 或 Pi Extension。Core 只提供带认证的 Hook Ingress 与归一化事件合同；全局 Hook 安装必须是后续显式授权动作。

## 5. 当前 AgentMux 公共领域模型

T-011 把过时的 Session 混合模型直接替换为 Run、Agent Session、Attachment 与 View，不保留类型别名或 IPC 兼容层：

```ts
type AgentMuxRunRef = { runId: string }
type AgentMuxAgentSession = { agentSessionId: string; run: AgentMuxRunRef }
type AgentMuxRunAttachment = { run: AgentMuxRun; replay: AgentMuxRunDataEvent[]; gap: AgentMuxRunReplayGap | null }
type AgentMuxView = AgentMuxAgentView | AgentMuxTerminalView
```

- Agent Session 通过 `AgentProvider.buildLaunch` 生成启动意图，接入 Hook 语义与 Activity。
- Raw Terminal Run 不伪装成 Agent Provider；它运行目标 Host 的默认 Shell。
- 两类 Run 共用启动、停止、输入、Interrupt、Resize、Attach、Local/SSH、断连恢复与事件 API。
- `AgentMuxClient.writeTerminal/writeAgent` 对同一 Run 保证调用顺序，不同 Run 独立推进；失败不会毒化后续输入，Run 清理同时释放输入 tail。这个顺序属于 Core 公共合同，不由 Desktop/xterm 补偿。
- 只有 Agent Session 把 Submit Input 记录为 Prompt Activity；Raw Terminal 输入保持纯终端语义。
- Renderer 的 xterm 在挂载时 Attach 有界 Replay，随后直接消费增量 Output 并在渲染后 Ack；Zustand 不保存终端字节。

Desktop Typed Preload API 也按职责分离：

```text
agents.detect                 Agent 可用性
sessions.*                    Terminal / Agent 生命周期
browser.*                     Electron WebContentsView 生命周期
workspaces.* / files.*        Git 与文件边界
```

Renderer 不直接启动进程，也不持有 SSH Client。

## 6. Browser 为什么不进入 core

a mature workbench Desktop Browser 主要使用 Renderer `<webview>`，而 Offscreen/Headless 路径由 Main Process `BrowserWindow` 持有。AgentMux 已确认采用 Electron 维护中的 `WebContentsView`：

- `BrowserViewManager` 在 Main Process 创建、导航、定位、隐藏和销毁 View；
- Renderer 只通过 Typed Preload IPC 发送 Browser Intent 与像素 Bounds；
- Browser Tab 非活动、拖拽中、切到 Board 或被窄窗口 Navigator 覆盖时，Main-owned View 会隐藏；
- Back、Forward、Reload、Title、Loading、Error 和 Render-process Gone 都回投为 Browser Event；
- Permission Check/Request 默认全部拒绝；每次页面完成导航后重新应用 0.9 Zoom，避免跨 Origin 导航恢复为默认比例；
- Tab Close 先销毁 WebContents 资源，再从 Pane Layout 移除 Tab；
- URL 只接受 `http:`、`https:` 与内部空白页；本地地址默认使用 HTTP，普通域名默认 HTTPS，含空格输入作为搜索词处理。

Browser 不属于 Agent Runtime，也不通过 Agent Daemon。它属于 Desktop Host Capability，但继续遵守 Universal Tab、Pane、拖拽、分屏与关闭生命周期。

## 7. 当前 Core Maturity 的采用、简化与明确不采用

当前采用：

- 声明式 Agent Adapter；
- Startup Plan 纯值边界；
- 稳定 Session Identity 与明确 Owner；
- Hook 归一化与状态来源；
- Raw Output、Process Liveness、Semantic Status 分离；
- 一个 Session 的 Terminal 与 Observable Activity 两种投影。

已经删除的切换前基线：

- Local/SSH 均通过 `ExecutionHost + tmux`，不复制 a mature workbench Daemon/Relay/WSL 图；
- 五个内置 Agent：Codex、Claude、TraeX、Hermes、Pi；
- 从真实 tmux 状态恢复，不序列化 xterm Snapshot；
- Desktop-local Workspace/Worktree，不引入远程账户和 Host Federation。

当前 Feature 最终采用：

- ctxmux 作为 Local/SSH 唯一 Run/PTY/Process Owner；
- AgentMux 明确区分 Run、AgentSession、Attachment 与 View；
- Create/Attach、Incarnation、Incremental Output、Replay/Gap、Backpressure、Applied Size 与 Stop 作为 Kernel-neutral Conformance，而不是 AgentMux 私有实现；
- Provider、ACP、Hook、Permission、Evidence 与 provider-native Resume 继续由 AgentMux 拥有。

明确不采用：

- 直接复制 a mature workbench 的完整 node-pty Host、Checkpoint、Daemon Adoption 与兼容系统；
- AgentMux 自建 agentmuxd、Run wire、Replay、Journal、Remote Artifact 或进程树 Owner；
- Relay/Mobile/Account/Transcript Vault；
- Claude Fake-tmux 兼容层；
- 静默修改用户全局 Agent Hook；
- 把可观察 Hook/Terminal Activity 描述成模型私有 Chain-of-thought；
- 任何 Real／Fake tmux Runtime、Backend Selector、Migration 或 Fallback。

## 8. a mature workbench CLI 的 Agent 间通信边界

2026-08-12 通过当时安装版本的 `a mature workbench skills get a mature workbench-cli` 与 `a mature workbench skills get orchestration` 复核了 a mature workbench 的公开通信合同。2026-08-13 又复核当前 a mature workbench `1.4.176`：`terminal switch --terminal <runtime-issued handle>` 的公开语义是让 a mature workbench UI 切换到对应 Terminal Tab；它是 Client 焦点操作，不是 Terminal Attach、Agent Resume 或进程生命周期操作。

AgentMux 采用这一交互合同，但保留自己的身份边界：Raw Terminal 使用 runtime-issued Terminal/View ID；Agent 调用使用稳定 `agentSessionId`，由 Core-owned Resolver 唯一映射到当前已打开 View，再通过 typed Desktop control 聚焦。unknown、ambiguous、stale、not-open 目标失败关闭；不猜测最近 Tab，不隐式 Open/Attach/Resume，也不让 CLI 或 Renderer 建立第二索引。

真正值得采用的也不是“向另一个终端发送字符串”，而是把低层终端输入与可恢复的 Agent 通信分开：

- `terminal send` 只适合一次性直接输入，不携带任务、收件箱、回复或完成状态；
- 结构化通信使用持久 Message／Delivery：`send`、`check`、`reply`、`ask`、`inbox` 分别表达投递、消费、关联回复、阻塞提问和历史检查；
- 一个协调 Run 只是命名空间与 Inbox，Task 是工作项，Dispatch 是一次 Agent 终端上的执行绑定；Terminal Handle 只是可重新解析的路由信息，不是持久身份；
- Coordinator 的 `check` 按 FIFO 返回有界 Delivery，并在显式 Ack 前重放同一批次；问答以 Message ID 恢复，避免 timeout 后重复提问；
- `worker_done` 同时绑定 Task ID、Dispatch ID 与 outcome，不能只靠终端 idle、输出文本或心跳推断完成；
- 完整 Handoff 与受监督 Dispatch 是两种所有权语义。前者交出工作后原协调者停止监控；后者保留 question、escalation、worker_done 和 cleanup 责任；
- 断线、更新和旧状态恢复必须携带可验证 authority；不能从数据库行、旧 Terminal 或相似 Prompt 猜测当前消息所有权。

AgentMux 采用这些原则时保持自己的分层：

```text
AgentSession identity ── AgentMessage / Thread / Delivery ── bounded Inbox
        │                           │
        │                           ├─ check / ack / reply / ask
        │                           └─ evidence-backed outcome
        ▼
exact RunRef ── Provider delivery ── ctxmux Run control
```

`@agentmux/core` 只拥有 Provider-neutral 的 Message、Thread、Delivery、Permission、Correlation 与有界 Inbox；ctxmux 仍只拥有 Run。Desktop Board Inbox/Discussion Canvas 是同一 Core 状态的第一方投影。Task DAG、自动调度、Agent 选型、结果评判和 coordinator loop 属于调用方策略，不下沉 Core；a mature workbench Account、跨服务器 Relay、legacy adoption、compatibility replay 和 Terminal 注入协议也不复制。
