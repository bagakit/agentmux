# AgentMux Core 成熟度合同

## 目标

`@agentmux/core` 是可独立安装、无 UI 依赖、与宿主框架无关的本地 Agent Runtime。
外部 Client 只需选择或注册 Provider、传入工作区并调用公开 API，就能完成 Agent
发现、启动、恢复、交互和停止，不必理解具体 Agent CLI、Electron 或 CtxMux wire。

Desktop 是 Core 的第一方 Client 和完整参考实现，不拥有第二套 Agent 生命周期或 Run
实现。CLI、Desktop 与外部 Node Consumer 必须使用同一套 Core 公共合同。

## Runtime 边界

CtxMux 是唯一 Run Kernel。AgentMux 不拥有第二份 PTY、进程、Replay、Gap、Attachment、
ordered bytes 或 Run lifecycle 实现，也不提供旧 Backend、Fallback、Migration 或兼容入口。

| 能力 | 权威 Owner | AgentMux 的职责 |
| --- | --- | --- |
| Run、PTY、进程与真实运行状态 | CtxMux | 通过唯一私有 Adapter 引用并投影 |
| Ordered bytes、Replay、Gap、Attachment、Input、Resize、Interrupt、Stop | CtxMux | 映射为稳定、类型安全的 Core 操作与事件 |
| Provider Catalog、发现、Launch 与 Prompt Strategy | AgentMux Core | 归一化不同 Agent CLI 的能力差异 |
| AgentSession、Provider handle、ACP、Hook、Permission、Prompt readiness、Agent status | AgentMux Core | 持有语义身份、状态与恢复真相 |
| Workspace、Editor、Pane、Tab、Board、Browser 与 Git 交互 | Client | 只消费 Core，不直接管理 Agent 进程 |

物理 Run 事实只能来自 CtxMux；必须理解 Provider、AgentSession、Permission、消息、任务或
UI 才能成立的判断只能由 AgentMux 或 Client 持有。两侧都不得根据对方的投影反推并保存
第二份权威状态。

## 公开对象模型

- `Provider`：描述一个 Agent CLI 的发现、能力、Launch/Resume、事件与权限归一化规则。
- `AgentSession`：AgentMux 持有的稳定语义身份，关联 Provider、native handle、当前 Run 和
  已退休 Run；它不等同于物理进程。
- `Run`：CtxMux 持有的物理进程和终端事实；新的物理进程必须使用新的 Run ID。
- `Attachment`：Client 对一个 Run output/control 的有界订阅，携带明确 cursor 与 Gap 语义。
- `View`：Client 对 Run 或 AgentSession 的产品投影；聚焦、关闭 View 与改变 Runtime
  生命周期是不同操作。

Reattach 原 Run、Provider-native resume、创建新 AgentSession、Spawn 新 Run 和打开新 View
是不同意图。Terminal Output 只能证明进程输出，不能证明 Agent 已理解 Prompt、权限已处理
或语义上下文连续。

## 当前基线

- Local Terminal 与 Agent Provider 统一经过 `CtxmuxRunAdapter`；仓库中没有第二个 Run
  Kernel 或直接 `node-pty` Owner。
- Core 固定消费经过完整 identity、capability、platform、mode 与 hash 验证的 CtxMux
  artifact；具体 artifact 身份只由 `docs/plans/ctxmux-cutover.md` 维护。
- Core 的 AgentSession Store 是 Agent 身份、当前 Run、retired Run、Hook/Permission receipt
  与 lifecycle reservation 的唯一持久化真相。
- Provider 继续拥有 executable probe、Launch/Resume argv、Hook/Permission、ACP handle、
  Evidence 与 Prompt readiness；CtxMux 不解释 Agent 语义。
- CLI、Desktop 与干净外部 package consumer 已能通过 Core 公共 API 完成代表性的 Local
  create、reattach、send、interrupt、resume、stop 与 View switch。
- Remote/SSH 在公共合同交付前返回 typed unsupported，不存在旧 SSH path 或隐藏 fallback。

## 成熟度闭环

以下是 Core 成熟度的长期验收维度，不表示 Feature Tracker 中的任务状态或执行顺序。

### 最终 Kernel、Package 与 Benchmark 验收

在同一个最终 candidate 上完成 Core、Desktop、干净外部 Consumer、可靠性、安全、资源和
性能证据，确认公开类型不泄漏 CtxMux wire、Electron 或开发路径，并由独立 Review 验证
边界和失败模型。

### 结构化 Agent 通信

在 Core 交付 Agent Message、Inbox、Discussion 与投递状态合同。消息目标使用稳定
AgentSession 身份；消息持久化与协作语义属于 AgentMux，不下沉到 CtxMux，也不从终端文本
猜测投递结果。具体产品合同由 `docs/plans/agent-communication.md` 维护。

### Remote / SSH

Remote 只通过 CtxMux 的公开 Remote 合同进入同一个 Run port。SSH transport、远端 Run
continuity、Partition、Replay/Gap、Stop 和 capability negotiation 必须由公开合同与
Conformance 证明；AgentMux 不复活旧 Remote 实现，不建立 proxy 或 fallback。

## 验收

- 外部 Node Consumer 只安装 Core 包并注册 Provider，即可完成代表性 Agent lifecycle；
- Desktop 与 CLI 不绕过 Core 直接管理 Agent 进程或保存第二份 Agent 身份索引；
- 所有 Local Run 操作只经过 CtxMux 公共合同，Gap、stale identity、lost response 与资源
  释放均失败关闭或确定性收敛；
- Provider 能力差异通过类型和 capability 明确表达，不由 Client 猜测；
- AgentSession continuity 只由同一 live Run 或经过验证的 Provider/ACP handle 证明；
- Remote 未交付时始终 typed unsupported，交付后仍复用同一 Core Run 合同；
- Package、测试、Benchmark 与文档引用同一个最终 candidate，不以旧实现证据冒充完成。

## 非目标

- 在 AgentMux 内补写 CtxMux 缺失的 Runtime 能力；
- 保留自建 daemon、旧 Local/SSH path、Backend Selector、Alias、Migration 或 Fallback；
- 把 Agent Catalog、AgentSession、Hook、Permission、Prompt readiness 或产品布局下沉到
  CtxMux；
- 让 Desktop、CLI 或 Renderer 持有私有 Agent lifecycle、Provider argv 或 Run 真相；
- 为未进入当前需求的 Transport、云同步、多租户或账户体系建立预防性抽象。

## 当前权威引用

- `AGENTS.md`：项目目标、原则与 AgentMux/CtxMux 总边界；
- `docs/plans/mux-runtime-decision.md`：Run Kernel 架构决策；
- `docs/plans/ctxmux-cutover.md`：当前 CtxMux artifact 身份、消费方式和 Local 证据；
- `docs/plans/agentmux-semantic-session.md`：AgentSession continuity 与关闭语义；
- `docs/plans/agent-communication.md`：结构化 Agent 通信合同；
- `docs/architecture/terminal-runtime.md`：Terminal Runtime 分层；
- `docs/testing/strategy.md`：验证矩阵与 Gate。

Feature 的任务状态、顺序与生命周期只由 Feature Tracker 维护；本文只描述当前长期合同。
