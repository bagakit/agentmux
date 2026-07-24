# Desktop 切换到 AgentMux Daemon

> 历史实现文档：本文记录已完成的 tmux → 自建 agentmuxd 切换证据。2026-08-11 的 ctxmux 决策修正已取代其“长期实现”结论；当前代码在 T-016 前继续运行，但不会获得新能力，最终切换后直接删除，不提供兼容入口。

## 1. 唯一运行链路

```text
React Renderer
  → Typed Preload IPC
  → Electron Main RuntimeController
  → 每个 Host 一个 AgentMuxClient
  → Local Unix Socket 或长期 SSH stdio
  → 每个 Host 一个 agentmuxd
  → node-pty 与进程树
```

`agentmuxd` 是这一历史候选中的 PTY、进程、Input Sequence、Output Sequence、Replay、Backpressure 和 Attach Owner。`RuntimeController` 不保存第二份 Run Map，只把 Core View 投影成 Desktop 所需的 Tab 状态；Renderer Store 不保存终端字节。

Browser、文件系统与 Git Worktree 仍由 Electron Main 的 Host Capability 持有。它们与 Agent Session 共用 Workspace 身份，但不进入 Daemon。

## 2. Main 与配置事务

- T-014 后 Desktop 只调用 `connectLocalAgentMux()` / `connectSshAgentMux()`；过渡 Runtime 的 Activation、Connector 和 wire 都封装在 Core 内部。
- SSH Host 必须显式提供 Build Identity、远端 Node、`agentmuxd` 绝对路径和 Socket 绝对路径；运行期使用一条长期系统 SSH stdio Transport。
- Host 配置采用 `prepare → 持久化 → commit`：新 Host 必须先完成 Daemon Hello 与身份核对，失败时释放准备中的 Client 和 ExecutionHost，不改变磁盘或当前 Runtime 真相。
- 配置版本直接升级为 v3；SSH Host 使用中立的 `runtime.buildIdentity/remoteNodePath/remoteEntrypointPath/remoteEndpointPath`。旧 v2 明确失败，不迁移、不留 daemon 字段别名。
- Agent Session 由 Desktop 的原子 JSON Store 保存。Store 串行写入、限制为 1 MiB，并且只有原子替换成功后才更新内存投影。

## 3. Session 与关闭语义

Agent Session 的稳定身份是 `agentSessionId`；Raw Terminal 的稳定身份是 `runId + incarnationId`。只有 Agent Session 拥有 Provider、Hook、ACP、Permission 和 Provider-native Resume 语义。

- 关闭 Tab 只移除 View；运行中的 Run 必须经过确认后才能显式 Stop。
- Detach 只解除当前 Client 对 Run 的输出订阅，不停止进程。
- Stop 才结束 Run；Agent Stop 还会删除对应 Agent Session，并发布 `run-removed`。
- Provider-native Resume、重新 Attach 当前 Run、创建新 Agent Session 和打开新 View 是不同操作；终端 Replay 不冒充模型上下文恢复。
- Raw Terminal 输入不生成 Agent Activity。Rich Composer 只对 Agent 调用 `submitAgentPrompt()`，并以 `user` Evidence 记录 Prompt。

## 4. xterm 的增量恢复

Terminal Pane 挂载时先订阅 Core Event，再 Attach 当前 Run：

1. 请求从 Sequence 0 开始的有界 Replay，用它重建新的 xterm 实例。
2. Replay 超出窗口时显示明确 Gap，不把缺失历史伪装成完整屏幕。
3. Attach 期间到达的 Live Output 进入最多 256 项、512 KiB 的 Pane 启动队列；溢出时丢弃最旧字节并显示不完整提示。
4. 后续 Output 直接写入 xterm；只有 xterm 写入回调完成后才按 Sequence Ack。
5. Zustand 只更新 `latestOutputBytes`，不复制 Output、Terminal Snapshot 或 Scrollback。
6. Pane 卸载时 Release Attachment，并释放 xterm、ResizeObserver、Input 和 Event Subscription；Run 继续由 Kernel 持有。

xterm Scrollback 固定为 5000 行。Daemon Replay、Client Queue 与 Pane 启动队列各自有独立硬上限，慢 Pane 不能把 Main 或 Renderer 变成无界终端缓存。

## 5. 启动与事件顺序

Renderer 初始化先订阅 Run/Agent 与 Browser Event，再并行读取配置和 Runtime View。初始化期间不缓存 Terminal Output；Agent 与 Browser Event 各保留最近 256 项，完成初始投影后再归并。这避免读取窗口丢失状态事件，也避免应用启动时复制终端流。

Run 启动继续由 Launcher Tab 持有事务：只有仍属于该启动请求的 Tab 才能接收成功或失败结果。关闭中的启动不会被迟到 Promise 复活。Run Create 由 `createOperationId` 收敛，Agent Session ID 由 Registry Reservation 收敛。

## 6. 诚实的故障边界

- Daemon 或 SSH 连接失败会返回明确错误，不回退旧 Runtime。
- Daemon 重启后无法继续 Attach 的 PTY 投影为 `lost/error`；只有显式 Stop 或 Provider Resume 能继续处理。
- 新 Client 只在 Run 明确携带 Agent、Agent Session、Host、Workspace 和 Incarnation 身份时重建最小 Agent Session；不会伪造 Native Provider Handle。
- Output、Process、Native Hook、ACP 与 User Action 的 Evidence Source 始终分开；Desktop 不从 ANSI 文本猜测 Agent 状态或私有思维链。

## 7. 验证入口

完整回归使用 `pnpm check`。当前关键回归覆盖 Local Activation、Run/Agent Session/View 投影、外部 Client 重建、Desktop Agent Session Store、Host 配置事务、Launcher 生命周期和 Renderer 状态 Owner。T-016 接入 ctxmux 时会删除这条历史 daemon 路径，不保留兼容入口。
