# AgentMux mux Runtime 架构决策

状态：已确认
Feature：`f-2238fbdxh`
Task：`T-006`
讨论日期：2026-08-10（Asia/Shanghai）

## 1. 决策

AgentMux 采用 a mature workbench-like embeddable 架构，但不再自行实现 PTY Host、Host Protocol、Replay 和 Backpressure。`ctxmux` 是唯一 Run Kernel；AgentMux 在它之上保留 Agent Catalog、ACP、Hook、Permission、Semantic Status、Workspace、Editor 和 AHP 等 Agent 与产品语义。

```text
AgentMux
  Agent Catalog / Integration / ACP / Hook / Permission
  Semantic Status / Workspace / Editor / AHP
                         │
                         ▼
                  CtxmuxRunAdapter
                         │
                         ▼
                @ctxmux/sdk -> ctxmuxd
  Run / PTY / process owner / ordered output / replay
  input / resize / stop / attach / detach / fork
```

这个决定替代三个旧候选中的“AgentMux 自建 a mature workbench-like Host”，也排除长期维护 tmux/ctxmux 双 Runtime。AgentMux 仍然获得 a mature workbench-like 架构的稳定性，但不复制 ctxmux 已经拥有或明确负责的通用 mux 能力。

本任务只确认长期所有权和后续实施边界，不修改 mux 代码、配置或公共 API。

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

## 3. a mature workbench 提供的成熟模式

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

- daemon 的 attach-or-create、`attachOnly` 和 incarnation fence 让稳定 Session ID 不会被迟到事件污染。
- 输出是增量 `onData`，同时有 Sequence、Snapshot、Replay、Ack 与 producer backpressure；不是定时重抓整屏作为唯一事实。
- Resize 可以读回真实尺寸，Shutdown 区分 graceful 与 immediate，并处理 Agent 后代进程。
- SSH 使用长连接 Multiplexer/Relay，而不是每个字符重新执行一次远程命令。

值得采用的是这组所有权与数据流原则。它们由 ctxmux 实现并公开给多个 Client 后，AgentMux 无需再建立一套私有 Host。

## 4. 为什么选择 ctxmux

ctxmux 当前已经提供这条竖切所需的大部分底座：

- 独立 daemon 持有 PTY 和子进程，Client 断开不结束 Run；
- 稳定 Run 身份和公共协议；
- ordered raw bytes、单调 sequence、bounded replay、`Gap` 与 `Truncated`；
- input、resize、stop、exit、attach、detach 和 reattach；
- 多 Client；
- Level A fork，以及 Codex Level B resume/JSONL observer 的 Integration 证据。

完整切换前仍有若干 capability gap：

- SDK/binary 发布和 daemon activation；
- SSH/Remote Host；
- daemon restart 或主机重启后的 persistence；
- AgentMux metadata/tag；
- idempotent create 与 incarnation fence；
- process-tree stop、applied-size readback；
- Hook durability、replay 截断后的屏幕恢复和 attachment command correlation。

这些缺口不构成“等待 ctxmux 完成全部优化”的理由。AgentMux 现在即可接入已经稳定的协议子集；每项未满足能力都通过显式 capability gate 延后对应场景，失败关闭，不在 AgentMux 内造临时替代品。

## 5. 分阶段接入边界

### 阶段一：立即建立本地竖切

- 在 `packages/core` 增加单一 `CtxmuxRunAdapter`，只依赖 ctxmux 公共 SDK/协议，不读 daemon 内部状态。
- 先覆盖 generic terminal 与 Codex：start、input、resize、ordered output、attach/detach、bounded replay、stop 和 exit。
- AgentMux Session 保存 Agent 语义与 ctxmux Run 引用；Run 生命周期、PTY、字节序列和 replay cursor 的权威仍在 ctxmux。
- 现有 tmux 路径在切换期间只承载尚未迁移的场景，不再新增能力，也不成为公开可选 Backend。

### 阶段二：补齐语义和切换门槛

- ACP 作为独立 semantic backend；Hook、Permission、Provider-native resume 和 Semantic Status 不下沉到 ctxmux。
- 用 capability probe 明确 ctxmux 版本和当前能力。缺少 create fence、process-tree stop、applied size 或恢复证据时，相关操作应返回可操作错误。
- 将 ctxmux 的 `Gap/Truncated` 映射为 Client 可理解的恢复状态；不能把不完整 replay 当成完整屏幕。
- Local 路径达到替换门槛后停止使用 `capture-pane` polling 和 command-per-input。

### 阶段三：Remote 和最终收口

- Remote 采用远端 `ctxmuxd` 加长期系统 SSH transport/socket forwarding；AgentMux 不另写 Remote PTY Host。
- 只有 Local、Remote、stop、recovery 和发布安装 Gate 均通过后，才删除 `TmuxClient`、tmux Environment Discovery、Capture Polling 和 tmux-only 测试。
- 最终公开产品只有一条 Runtime。迁移中的 tmux 不形成配置选项、兼容承诺或 fallback。

## 6. 所有权边界

| 能力 | AgentMux | ctxmux |
| --- | --- | --- |
| Agent catalog、launch plan、prompt strategy | 权威 | 不感知 Agent |
| ACP、Hook、Permission、semantic status | 权威 | 不承载 |
| Workspace、Editor、AHP/client projection | 权威 | 不承载 |
| Run/PTY/process lifecycle | 引用和投影 | 权威 |
| ordered output、replay、gap、backpressure | 映射给 Client | 权威 |
| input、resize、signal、stop、attach/detach | 通过 adapter 请求 | 执行和确认 |
| fork | 组合 Agent 语义 | 提供 Run 级原语 |

Integration 回答“运行什么、如何理解”，ctxmux 回答“进程如何被持有、观察和控制”。两者不能合并。

## 7. 后续验收条件

- 1000 个有序 Input Chunk 不丢失、不重排，输入失败不会重放已确认字节。
- Output 具有单调 Sequence、Bounded Replay 和明确 Gap；慢 Client 不导致任一侧无界增长。
- Desktop 重启只 Attach，不重复启动 Agent；缺少幂等 create 能力时不得自动重试 Spawn。
- Replay 截断会触发明确重建或不完整状态，不把残缺字节流伪装成完整屏幕。
- Stop 能证明 Agent 工具后代不会成为 Run owner 的孤儿进程。
- Remote 只通过系统 SSH 的长期受控 transport 连接版本匹配的远端 ctxmuxd，不复制 Private Key，不静默下载。
- `@agentmux/core` 不依赖 Electron/React；干净外部 Consumer 可安装并运行 ctxmux-backed 最小示例。
- 完整切换后仓库不存在 tmux 公共类型、兼容层、Fallback Route 或隐藏双 Runtime。

## 8. 非目标

- 不等待 ctxmux 完成与 AgentMux 当前竖切无关的所有优化。
- 不在 AgentMux 内实现另一套 PTY daemon、Host Protocol、Replay、Backpressure 或 Run persistence。
- 不把 ACP、Hook、Permission、Agent 状态或编排语义下沉到 ctxmux。
- 不复制 a mature workbench Account、Mobile、AI Vault、WSL、Emulator 或历史兼容分支。
- 不承诺 daemon 崩溃后恢复模型私有上下文；只有 Provider-native Resume/ACP Handle 可以证明该语义。
- 不在切换期间对外发布“临时双后端”作为长期承诺。

## 9. 用户确认

选择：a mature workbench-like embeddable 架构，由 ctxmux 作为唯一 Run Kernel
确认理由：避免 AgentMux 重复实现通用 mux 基建；立即接入稳定子集，缺失能力通过 capability gate 演进
确认时间：2026-08-10（Asia/Shanghai）
