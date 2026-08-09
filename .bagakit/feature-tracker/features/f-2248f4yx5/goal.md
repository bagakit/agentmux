# Feature Goal：交付可独立使用的 AgentMux Core

Contract: `bagakit.feature-goal.v1`
Feature: `f-2248f4yx5`
Convergence: `terminal`
Closure: `state`

开始工作前先验证 `owner-receipt.json`，再从 `state.json` 和 `tasks.json` 恢复当前执行。
聊天上下文可能过时或属于其他 Feature，以本 Feature 目录为准。

## 首要目标

把 `@agentmux/core` 交付成可独立安装、无 UI 依赖、与宿主框架无关的本地 Agent
Runtime。它统一 Provider、AgentSession、ACP、Hook、Permission、Prompt readiness、Agent
status、provider-native resume 与结构化 Agent 通信；CtxMux 作为唯一 Run Kernel 持有
PTY、进程、Run lifecycle、ordered bytes、Replay、Gap 与 Attachment。Desktop、CLI 和外部
Node Client 只消费类型安全的 Core 公共 API，不重复实现 Agent CLI 差异或 Runtime 真相。

## 收敛合同

- 最小充分闭环：Core 的最终公共合同、唯一 CtxMux Kernel、可安装 Package、代表性
  Provider vertical、结构化 Agent Message/Inbox/Discussion 与 Remote/SSH 都有可复现证据。
- 完成判据：Reviewed Task 的有限状态全部由 Feature Tracker 收敛，最终 Package、Kernel、
  Benchmark、可靠性、资源与独立 Review 共同证明上述闭环。
- 扩展规则：只有完成判据必需的发现进入本 Feature；相邻产品能力进入独立 Feature，不能
  用开放式优化扩大 Closure。
- 停止规则：验收和 mandatory gate 全部满足后停止；未满足时返回精确证据或 blocker，
  不以活动量、旧实现证据或暂时可用冒充完成。

## 受保护的不变量

- CtxMux 是唯一 Run Kernel。AgentMux 不实现或保留第二份 PTY、进程、Replay、Gap、
  Attachment、Run lifecycle、Backend Selector、Migration、Alias 或 Fallback。
- AgentMux 拥有 Provider、AgentSession、ACP、Hook、Permission、Prompt readiness、Agent
  status、semantic resume 与 Agent Message；CtxMux 不解释 Agent、任务、权限或 UI 语义。
- `Run`、`AgentSession`、`Attachment`、`View` 与 `AgentMessage` 是不同对象；Reattach、
  Provider-native resume、Spawn、创建 Session、打开 View、Terminal Input 与结构化 Message
  是不同动作。
- Core Store 是 Agent 身份、当前 Run、retired Run、Provider/ACP handle、receipt 与 lifecycle
  reservation 的唯一持久化真相。CLI、Desktop 与 Renderer 不建立第二索引或恢复状态机。
- Terminal Output、Replay、idle 或标题不能证明 Prompt 已理解、Permission 已处理、Message
  已接受、Reply 已相关或 Agent 语义上下文连续。
- Local 与 Remote 使用同一 Core Run 合同。Remote 未交付时只返回 typed unsupported；
  交付后也不复活旧 SSH path、proxy、私有 wire 或隐藏 fallback。
- `packages/core` 不依赖 Electron、React、Desktop Store、CtxMux 私有模块或第三方 wire
  类型。新增 Agent 原则上只需新增 Provider。
- Desktop 是第一方 Client 和完整参考实现，不是第二套 Runtime、Agent lifecycle 或 Message
  Owner。
- 不为未进入当前需求的 Transport、云同步、多租户、账户体系、自动调度或插件市场建立
  预防性抽象。

## 验收与停止条件

- 干净外部 Node Consumer 只安装 Core 包、选择或注册 Provider、传入 Workspace，即可完成
  代表性 Agent lifecycle；Package 不依赖仓库路径、相邻源码、全局安装或隐式下载。
- Local Terminal 与代表性 Agent Provider 的 create、reattach、input、replay/gap、resize、
  interrupt、resume、stop、client reopen 与资源释放只经过 CtxMux 公共合同并确定性收敛。
- Provider capability、AgentSession continuity、Permission、Hook、Prompt readiness 与状态
  通过公共类型和行为测试表达，不由 Client 或 Terminal 文本猜测。
- 结构化通信至少证明 correlated reply、delivery-only 与 unsupported 三类目标；消息因果、
  权限、幂等、超时、取消、Run replacement、资源上限和 UI 投影共享一份 Core 真相。
- Remote/SSH 通过 CtxMux 公开合同证明 transport identity、partition recovery、Replay/Gap、
  Stop 与 capability negotiation；未取得证据前保持 typed unsupported。
- 最终 Package、Kernel、Benchmark、可靠性、安全、资源和独立 Review 引用同一个 candidate，
  Release-blocking finding 全部处理。
- 只完成文档、类型外壳、Mock、Adapter 接口或构建，不足以证明闭环；双 Owner、私有
  Fallback、无界资源、旧 candidate 证据或把 Terminal Output 当语义证据都不算完成。
- 在发布 Package/Binary、连接真实 Remote Host、修改 Credential 或用户全局 Agent 配置、
  使用付费服务、改变隐私/权限边界或执行不可恢复操作前停止并询问。

## 权限与执行原则

- 只遵循本 Feature 的 Owner Receipt、State 和 Reviewed Task；Feature Tracker 是任务、状态、
  blocker、证据与 closeout 的唯一真相。
- 新需求先对照本 Goal 与当前 Task。已覆盖则继续；未覆盖则先通过 Feature Tracker 修订，
  只有长期结果、不变量、验收或权限边界变化时才改 Goal。
- 先证明最小可运行 vertical，再扩大 Provider、UI 或故障矩阵；每次扩展都必须直接服务
  当前验收。
- 在满足验收的方案中，选择持久 Owner、状态、API、抽象和重复真相最少的实现；过时内容
  直接删除，不保留兼容层、Migration 或 Fallback。
- Review 不阻塞独立开发；发现问题后用独立修复提交收敛。提交、验证和 Review 证据由 Git
  与 Feature Tracker 持有，不写进本 Goal。
- 真实环境验证只使用用户已有授权，不读取、复制、记录或显示 Credential，不修改全局
  配置；超出既有权限时停止并询问。

## 上下文引用

- `AGENTS.md`：项目目标、工程原则与 AgentMux/CtxMux 总边界。
- `docs/plans/mux-runtime-decision.md`：唯一 Run Kernel 与长期所有权决策。
- `docs/plans/agentmux-core-maturity-review.md`：当前 Core 成熟度、剩余闭环与验收合同。
- `docs/plans/agentmux-semantic-session.md`：AgentSession continuity 与关闭语义。
- `docs/plans/agent-communication.md`：结构化 Agent Message、Inbox 与 Discussion 合同。
- `docs/architecture/terminal-runtime.md`：Terminal Runtime 分层与 Client 边界。
- `docs/testing/strategy.md`：测试分层、故障模型与最终 Gate。
