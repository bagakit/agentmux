# AgentMux mux Runtime 架构决策

状态：待用户确认
Feature：`f-2238fbdxh`
Task：`T-006`
讨论日期：2026-08-10（Asia/Shanghai）

## 1. 决策问题

AgentMux 已用真实 tmux 跑通 Local/SSH Session 的启动、发现、输入、Resize、Capture、停止和恢复，也通过 Production Electron 证明了 Terminal/Agent 的第一方 Client 闭环。现在要决定长期的 PTY/Process owner：

1. 继续让真实 tmux 持有 Session；
2. 采用 a mature workbench-like embeddable Host，由 AgentMux 自己的 daemon/Host 持有 PTY；
3. 同时保留 direct PTY 与 tmux 两个可选后端。

本任务只确定长期所有权和后续实施边界，不修改 mux 代码、配置或公共 API。

## 2. 当前 AgentMux 的真实实现

当前链路：

```text
Desktop Renderer
  -> Typed Preload IPC
  -> RuntimeController
  -> AgentMuxRuntime
  -> TmuxClient
  -> LocalExecutionHost | SshExecutionHost
  -> tmux command
```

关键事实：

- `TmuxClient.start` 使用 detached `new-session`，并设置 `remain-on-exit` 与 history limit；tmux Server 是实际 PTY/Process owner。
- `AgentMuxRuntime.discover` 通过 `list-sessions + show-environment` 恢复 AgentMux Session；Environment 保存 Session Kind、Agent、Host、Workspace 和 Label。
- 输入使用 `load-buffer -> paste-buffer -> 可选 Enter`。Core 已增加 per-session 顺序 tail，解决并发调用重排，但每个输入片段仍会启动多个 tmux command。
- 输出使用 `capture-pane`，Runtime 默认每 750ms `inspect + capture`，对 Client 发布的是 Snapshot 变化，不是有序增量字节流。
- Resize 使用一次 `resize-pane`；没有“实际应用尺寸”的 provider readback。
- Stop 使用限定 `agentmux-` Prefix 的 `kill-session`；能精确删除 tmux Session，但没有 AgentMux 自有的 graceful/force 进程树协议。
- Local Host 直接执行命令；SSH Host 使用系统 `ssh -T` 执行每个远程命令。Hook 端口有 Control Connection，但终端输入输出本身不是一条持久 RPC/字节流。

Production T-024 的零键间隔 Burst 基准中，44 个键盘事件到真实 tmux Snapshot 出现结果为 4246ms。它证明输入已经不乱序，也暴露了 command-per-input 与 polling-output 的长期上限；这个数字不能外推成真实 SSH 性能。

## 3. a mature workbench 当前实现提供的成熟模式

a mature workbench 当前源码通过 `IPtyProvider` 把 Terminal owner 抽象为稳定合同：

```text
spawn / attach
write / resize / sendSignal
shutdown
onData / onReplay / onExit
getBufferSnapshot / getAppliedSize
pauseProducer / resumeProducer
```

它不是只把 `node-pty` 塞进 Electron：

- Fresh Local PTY 可由 `LocalPtyProvider` 直接持有；稳定运行时可以把相同合同路由到独立 daemon 的 `DaemonPtyAdapter`。
- daemon 的 `createOrAttachTerminalSession` 对稳定 Session ID 做原子 attach-or-create；`attachOnly` 不得在目标丢失时偷偷创建新 Shell。
- 每次物理进程拥有独立 `incarnationId`。同一公开 Session ID 被复用时，迟到 Exit、旧 daemon PID 或 SSH Relay 事件不能污染新进程。
- 输出是增量 `onData`，同时有 Provider Sequence、Snapshot、Replay、Ack 与 producer backpressure；不是定时重抓整屏作为唯一事实。
- Resize 除了请求，还可用 `getAppliedSize` 读回真实尺寸，修复冷恢复或断线期间丢失的 Resize。
- Shutdown 区分 graceful 与 immediate，Agent Session 会捕获和清理后代进程；终止中 Session 不能被同 ID 新进程覆盖。
- SSH 使用长连接 Multiplexer/Relay 的 `pty.attach`、Replay、Source Activation 和 Incarnation Fence；不是每个字符重新执行一次远程命令。

这些模式值得复制的是合同、身份 fence 和数据流所有权，不是 a mature workbench 的 Account、Mobile、Relay UI、WSL 或历史兼容分支。

## 4. 三个真实候选

### A. 继续真实 tmux

收益：

- 当前实现和测试可以继续使用；Detached Session、重启发现和系统 SSH 已经成立。
- 不需要发布、安装或升级 AgentMux Remote Host。
- tmux 自己处理 PTY 和进程持久化，初始实现面最小。

代价与上限：

- 输入、Resize、Signal、Inspect、Capture 都是外部命令；SSH 延迟会乘到交互路径上。
- Snapshot Polling 很难得到 sequence-safe replay、背压、丢包/间隙证明和低延迟输出。
- tmux Pane/Window/Server 语义会继续渗入 Core Session，而不是一个可被其他宿主嵌入的 Agent Runtime。
- 若继续补 Output Sequence、控制连接、恢复 fence 和多 Client 协议，最终会在 tmux 外再造一套 Host Protocol。

适用前提：产品目标只是“能管理已有 tmux Session”，不追求通用 embeddable Agent Host。

### B. a mature workbench-like AgentMux Host（推荐）

目标结构：

```text
Desktop / CLI / future client
  -> @agentmux/core Client + Domain API
  -> Local socket | long-lived system SSH stdio
  -> AgentMux Host
  -> TerminalProvider
  -> node-pty owned process

Agent Integration / ACP / Native Hook
  -> semantic event stream（与 terminal facts 分离）
```

收益：

- AgentMux 自己拥有稳定 Session、Incarnation、Input Order、Incremental Output、Replay、Resize Readback 和 Teardown 语义。
- Desktop 只是第一方 Client；Node/Electron/Tauri/CLI 不需要理解 tmux 命令或各 Agent TUI 差异。
- Local 与 SSH 共享同一个 Host Contract；SSH 只替换连接和部署方式，不复制 Runtime。
- ACP/Hook 继续提供语义事实；PTY 只保证原始可控与可观察，不伪造 Tool、Permission 或 Chain-of-thought。
- daemon 存活时 Session 不依赖 Desktop 生命周期；重连通过 attach + replay，而不是重新 Spawn。

成本与失败边界：

- 需要维护 Host Protocol、daemon 生命周期、版本协商、认证、Replay Budget、Backpressure 和进程树清理。
- SSH 必须有明确的 Remote Host Artifact。使用系统 SSH 与现有认证传输/启动它，但不能静默联网、`npx` 下载或保存 Private Key。
- daemon 进程死亡不等于原 Session 可恢复；没有足够 checkpoint/native resume 证据时，必须报告 Session Lost，不能伪装成同一上下文。
- `node-pty` 是 Native Dependency，构建和远端 Artifact 必须覆盖明确支持的平台；不支持的平台应明确失败。

### C. direct PTY + tmux 双后端

收益：

- Local 可获得低延迟 PTY；需要 detached persistence 的环境仍可选 tmux。
- 可以覆盖更多部署偏好。

代价：

- 每个 Session 都需要 Capability Matrix：stream/replay、attach、applied size、teardown、remote availability 各不相同。
- Desktop、文档、测试和错误恢复必须长期承载两套行为；配置面和组合数显著增加。
- 在当前没有用户必须保留 tmux 的独立需求时，它属于预防性抽象，而不是最简单长期实现。

结论：架构上可行，但不建议作为当前默认方向，也不应作为迁移兼容层保留。

## 5. 推荐决策

推荐选择 B：a mature workbench-like AgentMux Host。

具体含义：

- 最终公共 Runtime 不暴露 tmux Session Name、Pane、Capture Polling 或 command transport 假设。
- 最终 Local/SSH 都由 AgentMux Host 持有 PTY；tmux 实现完成切换后直接删除，不留 Alias、Migration、Fallback 或新旧双路径。
- `@agentmux/core` 继续拥有 Agent/Session Domain、Provider/Integration、状态和 Client API；Host 作为同一产品的独立运行入口持有 `node-pty` 与 Host Protocol。
- AHP 只能是未来可选 Client Adapter，不能成为 Core 内部唯一状态；ACP 是 Agent Semantic Backend，也不能替代 Terminal owner。

这个选择会覆盖 `docs/plans/agentmux-core-maturity-review.md` 中“direct PTY 与 tmux 两个 first-class Terminal Backend”的旧候选。用户确认后，应通过后续 Feature/Task Plan Revision 明确修改 Core Maturity 计划；本 T-006 不直接改它。

## 6. 确认后的实施边界

后续独立 Feature 应按可运行 Vertical Slice 推进，但最终交付只有一条 Runtime：

1. 定义精简 `TerminalProvider` 合同和 Contract Tests：create/attach、write、resize、signal、stop、incremental data、exit、snapshot/replay、applied size。
2. 增加 `sessionId + incarnationId + createOperationId`，把丢响应、重复 Create、迟到 Exit 和 Attach-only 失败变成确定性行为。
3. 用维护中的 `node-pty` 实现 Local Host；Host 与 Desktop 分离运行，Desktop 重启后可 attach/replay。
4. 让 AgentMux Desktop 的 Terminal/Agent 生命周期全部经过新的 `packages/core` 公共 API，并证明 Input、Resize、Stop、Crash/Restart 和进程树清理。
5. 用系统 SSH 建立一条长连接并显式部署/启动版本匹配的 Remote Host；不复制 Private Key，不静默下载可执行文件。
6. Local 与 SSH Gate 都通过后删除 `TmuxClient`、tmux Environment Discovery、Capture Polling 和 tmux-only 测试；不发布双实现。
7. 另行推进 ACP/Native Hook Semantic Backend；Terminal Output 与 Agent Semantic Event 始终保留来源差异。

## 7. 后续验收条件

- 1000 个有序 Input Chunk 不丢失、不重排，输入失败不会重放已确认字节。
- Output 具有单调 Sequence、Bounded Replay 和明确 Gap；慢 Client 不导致 Host 无界增长。
- Resize 可读回 Applied Size；断连/重连后能检测并修正尺寸漂移。
- Desktop 重启只 Attach，不重复启动 Agent；丢失的 Create Response 由 Operation ID 收敛为单一进程。
- 迟到 Exit 必须携带并匹配 Incarnation；旧进程事件不得删除新 Session。
- Stop 先 graceful、后 force，并证明 Agent 工具后代没有成为 Host 所有的孤儿进程。
- Local Host 只通过用户权限可访问的本地端点；Remote Host 只通过系统 SSH/stdio 或 loopback 认证端点通信。
- SSH Artifact 安装/更新显式可见、版本匹配、可审计；失败时不回退到 tmux。
- `@agentmux/core` 不依赖 Electron/React；干净外部 Consumer 可安装并运行最小 Host/Client 示例。
- 完整切换后仓库不存在 tmux 公共类型、兼容层、Fallback Route 或隐藏双实现。

## 8. 非目标

- 本次决策不实施 mux 替换，也不修改用户全局 Agent Hook、SSH Credential 或远端软件。
- 不复制 a mature workbench Account、Mobile、AI Vault、WSL、Emulator、Hosted Issue Integration 或历史兼容代码。
- 不把 AHP、ACP、tmux 或某个 Agent CLI 的 State Shape 作为 AgentMux Core Domain。
- 不承诺 daemon 崩溃后恢复模型私有上下文；只有 Provider-native Resume/ACP Handle 可以证明该语义。
- 不在切换期间对外发布“临时双后端”作为长期承诺。

## 9. 用户确认

选择：待确认
候选：`a mature workbench-like Host`（推荐） / `继续 tmux` / `双后端`
确认理由：待用户填写
确认时间：待填写

收到明确选择前，T-006 保持 `in_progress`，Feature 不归档，也不修改 mux Runtime。
