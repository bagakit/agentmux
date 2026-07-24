# AgentMux Core Maturity 方案评审

状态：已批准
对应 Feature：`f-2248f4yx5`
当前计划修订：revision 4 候选
前置决策：`docs/plans/mux-runtime-decision.md`

## 1. 结论

`@agentmux/core` 的长期形态是 AgentMux 自有的可嵌入 Agent Runtime；它随包提供 Headless `agentmuxd`，由 Daemon 持有 Local/SSH PTY 与进程。Desktop、CLI 和其他宿主只通过 Core 的类型安全 Client API 创建、附着、观察和控制 Session。

```text
Desktop / CLI / external Node consumer
                  │
                  ▼
          @agentmux/core Client
 Agent Domain / Provider / ACP / Hook / Permission
                  │
        Local socket | system SSH proxy
                  │
                  ▼
              agentmuxd
 Session owner / node-pty / process tree
 ordered bytes / replay / backpressure / recovery
```

最终只有这一条 Runtime。现有 tmux 是已验证的基线和切换前实现，不是可选 Backend；`ctxmux` 提案已被用户确认的 AgentMux Daemon 决策取代。完成切换时直接删除两者的代码、类型、配置、文档和测试假设，不保留 Alias、Migration、Fallback 或公开双路径。

## 2. 当前基线

当前 Core 已经具备可继续利用的 Agent 语义基础：

- UI 无关的 `packages/core` 包形态；
- Local/SSH `ExecutionHost`、真实 tmux Session 与重启发现；
- Codex、Claude、TraeX、Hermes、Pi 的 Catalog 与 Launch Plan；
- 带认证的 Hook Ingress、来源明确的语义状态与 Activity；
- Session Launch Reservation、失败回滚、输入顺序、动态 Host Discovery 和确定性测试；
- Desktop 通过 Typed IPC 消费 Core，不由 Renderer 直接 Spawn Agent。

主要缺口不是“再包一层接口”，而是 PTY/Process Owner 仍在 tmux：

- 输入以命令为单位，输出以 `capture-pane` Snapshot Polling 为单位；
- 没有单调 Output Sequence、有界 Replay、Gap 与 Backpressure 公共合同；
- App 与 SSH Client 的断开恢复依赖 tmux，而不是 AgentMux Session Identity；
- 远端每个操作重新执行命令，缺少长期受控 Transport；
- Core 包尚未由干净外部 Consumer、Daemon Artifact 和真实安装流程证明。

## 3. 依赖与成熟模式

### 现有依赖

当前 `@agentmux/core` 只有 `execa` 与 `shell-quote`；它们能继续负责安全进程执行和 Shell 参数，不提供 PTY、Replay 或 Daemon Transport。Desktop 已有 xterm，继续只负责终端渲染。

项目当前没有 PTY 库、WebSocket/RPC 框架或远端 Daemon SDK。后续实现不能假设“已有库做不了”，但也不能用手写伪终端替代成熟实现。

### 新增依赖原则

- PTY 使用 a mature workbench、VS Code 等成熟产品采用的维护中 `node-pty`，不自行实现 PTY、ConPTY 或 Terminal Emulator。
- 协议与流控先复用 Node Stream/Socket 的成熟原语，并对照固定 a mature workbench 源码移植 Session Fence、Replay、Ack 与 Backpressure 模式；只有明确缺口才增加维护中的协议库。
- ACP 优先使用经验证、精确锁定版本的 Runtime/SDK 并包在 AgentMux Adapter 后面，不重写 JSON-RPC Framing，也不泄漏第三方类型。
- SSH 继续使用系统 Client 与现有认证。远端 Transport 是一条长期 `ssh -T` 代理连接到用户权限 Unix Socket，不复制 Private Key，不开放未授权公网端口。

具体新增版本必须在实施 Task 中用 Package Metadata、License、维护状态、Native Artifact 和最小 Spike 证明后确定；评审文档不预填未经验证的版本号。

## 4. 最终所有权

### Core

Core 拥有 AgentMux 领域：

- Agent Catalog、Provider、Launch Plan、Prompt Delivery；
- Semantic Session、ACP、Hook、Permission、Provider-native Resume；
- Host/Workspace 关联、Session 状态代数、错误与 Capability；
- Client API 以及 Daemon Protocol 的 AgentMux 语义映射。

Core 不依赖 Electron、React 或 Desktop Store，也不让 Client 理解 tmux/ctxmux、Daemon 内部 Map 或某个 Agent CLI 的状态形状。

### Daemon

Daemon 是运行事实的唯一 Owner：

- PTY、Shell、Agent 与工具进程树；
- `sessionId`、`incarnationId`、`createOperationId`；
- Ordered Input、Incremental Output、Sequence、Bounded Replay、Gap 与 Backpressure；
- Applied Size、Signal、Graceful/Force Stop、Attach/Detach；
- 用户权限 Endpoint、版本协商、Client Lease 与资源配额。

每个 Execution Host 只有一个轻量 Daemon，不为每个 Tab 或 Pane 启动 Daemon。Session 和 Replay 按需分配并受全局与每 Session 硬上限约束。

### Client

Desktop 和外部 Consumer 只提交 Intent 和消费事件：

- Client 退出不会结束 Session；
- 重连使用 Attach + Cursor/Replay，不重复 Spawn 或重放已确认 Input；
- xterm 增量写入 Daemon Output，Gap 时显式重建或显示不完整状态；
- Renderer/Main 不直接管理 PTY、SSH Credential 或 Agent 子进程。

## 5. 持久化与恢复语义

用户确认的硬要求是：Desktop 完全退出、UI 崩溃或 SSH 网络中断后，Session 继续运行并可恢复。

为避免“恢复”成为模糊词，Feature 必须分别证明：

- **Client Recovery**：Client 重启 Attach 原 Session，不重复 Create。
- **Transport Recovery**：SSH Partition 后远端 Daemon 与 Session 仍在，重连校验 Host、Build、Session、Incarnation 和 Cursor。
- **Lost Response Recovery**：同一 `createOperationId` 只对应一个物理进程。
- **Late Event Fence**：旧 Incarnation 的 Data/Exit 不得污染新进程。
- **Replay Recovery**：窗口内有序补发；窗口外明确 Gap/Truncated。
- **Daemon Crash**：如果当前实现不能让 Worker 在 Daemon Crash 后继续持有 PTY，必须诚实标记 `lost`，不能伪装恢复。
- **Host Reboot / Model Context**：OS Process、Terminal History、Provider-native Session 是不同对象，只有对应证据存在时才能分别恢复。

## 6. 最小纵向推进顺序

1. 先用同一个 `@agentmux/core` 包中的 `agentmuxd` 跑通 Local Terminal 与 Codex：创建、字节流、输入、Resize、Stop、Detach、Client 重启 Attach。
2. 再补 Session Transaction、Incarnation Fence、Replay/Gap、Backpressure、进程树与资源上限，证明 Local Owner 可靠。
3. 建立远端 Daemon Artifact 与长期系统 SSH Transport，证明网络断开不结束 Session。
4. 将 ACP、Hook、Permission 与 Provider Resume 组合到同一 Session，但不把 Terminal Fact 冒充语义。
5. Desktop 和外部 Consumer 切换后删除 tmux/ctxmux 假设，随后完成 Packaging、Doctor、Chaos/Security、Benchmark 与独立 Review。

这个顺序允许 Feature 工作树中存在尚未接入产品的测试竖切，但不允许发布 Backend 配置、兼容承诺或运行时 Fallback。切换 Gate 通过后旧路径一次删除。

## 7. 资源与内存边界

资源约束是发布合同，不是事后优化：

- 一个 Host 一个 Daemon；空闲 Daemon、每个 PTY Session、每个 Attach Client 和每 MiB Replay 都要有可复现 RSS/CPU 成本。
- Replay、未确认 Output、Client Queue、Hook/Activity 与日志全部有硬上限；慢或失联 Client 不能拖成无界内存。
- Client Detach、Session Stop、SSH Transport Close 和 Daemon Shutdown 都有确定性释放测试。
- Benchmark 必须同时运行 correctness oracle 与泄漏检查，不能以丢数据或缩小恢复语义换低内存。
- Desktop 关闭后 Electron 进程应退出，只保留轻量 Daemon 与真实运行 Session。

## 8. 非目标

- 不发布 Package、Binary 或 Release；发布仍需用户单独授权。
- 不复制 a mature workbench Account、Mobile、AI Vault、WSL、Emulator、Hosted Issue Integration 或兼容历史。
- 不建立 AHP、插件市场、多租户或任意 Transport 框架；当前真实 Client 和 SSH 需求没有要求这些抽象。
- 不静默安装远端软件、修改 SSH Credential 或用户全局 Agent Hook。
- 不把 Terminal Output 描述为 Tool Call、Permission、模型私有 Chain-of-thought 或 Provider-native Resume。
- 不保留 tmux/ctxmux 的迁移器、别名、Fallback 或长期双 Owner。

## 9. Feature 完成门槛

- Local/SSH 只由 AgentMux Daemon 持有 PTY/Process；App 退出、UI Crash 与网络断开恢复通过真实测试。
- Input/Output/Resize/Stop/Attach 的顺序、幂等、Fence、Replay、Gap 与资源上限有 Contract、Integration、Chaos 和 Stress 证据。
- Permission 默认拒绝；Local Endpoint、Remote Transport、协议输入、参数/环境、日志与 Secret 有安全测试。
- Codex、Claude、TraeX、Hermes、Pi 与 Raw Terminal 通过同一 Core 生命周期合同，并诚实表达 Capability 差异。
- Desktop 与干净外部 Consumer 只使用 Core 公共 API；`pnpm pack` 安装、Daemon Activation、Remote Artifact 与 Doctor 可复现。
- 冻结 Benchmark 在预先声明的发布主维度上优于当前真实 tmux 基线，同时没有正确性、RSS、CPU 或泄漏回退。
- 仓库中不存在 ctxmux/tmux Runtime、兼容层、Migration、Fallback Route 或隐藏双 Owner。
- 多个独立 Reviewer 完成功能/架构、可靠性/安全、测试/Benchmark 审查，所有 Release Blocker 已处理。

## 10. 证据

- `AGENTS.md`
- `docs/plans/mux-runtime-decision.md`
- `docs/a mature workbench-agent-runtime-notes.md`
- 当前 `packages/core/package.json` 与源码/测试
- a mature workbench 固定 Commit 的 Local PTY、Daemon、SSH Owner Lease、Replay、Backpressure 与 Recovery 实现
