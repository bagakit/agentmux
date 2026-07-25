# Agent 间结构化通信与 Inbox 协作

## 目标

AgentMux 让受管 Agent Session 通过有权限、有因果、有回执的结构化消息协作。调用方必须能够区分一次性 Terminal Input、结构化 Message、完整 Handoff 与受监督 Dispatch，并且只按真实 Evidence 声称消息已投递、已接受或已回复。

最小实现先跑通一条真实 Agent A→Agent B 链路：一个受管 source Agent Session 从 Branch 工作面发起 Discussion，创建一个只服务该 Discussion 的 target Agent Session，首条 Message 复用现有 Agent 启动 Prompt 投递。用户发起的 Discussion 可以复用同一 API 与 UI，但不能代替 A2A 验收。后续能力在这条链路上增加，不建立临时协议或第二套状态机。

## 产品对象

- `Conversation` 是一个 Thread、它的 Message ledger 及与该 Thread 有精确 correlation 的 Agent Session Activity 投影。专属 Session 的全部 Activity 可以归属其唯一 Thread；已有 Session 承载多个 Thread 时，未关联 Activity 只留在并列的 Session Activity 中。
- `Discussion` 是 Desktop 围绕 Branch、Workspace 和参与 Agent 提供的交互工作面。它选择对象、显示 Thread、复用现有 Agent Region 与 Composer，但不保存消息真相。
- `Inbox` 是 Core 中未确认 Delivery、新 Thread revision、Permission 与需要用户处理状态的有界查询投影。Inbox 不是独立表或第三套生命周期。
- `Activity` 仍表示单个 Agent Session 的语义 Timeline。Activity 不改名为 Conversation，也不替代 Thread 或 Message。

这四个对象共享同一组稳定身份与 revision，不互相复制状态。

## 所有权

### ctxmux

ctxmux 只拥有 Run、PTY、Process、ordered bytes、Input application、Replay、Gap、Attachment、Resize、Signal 与 Stop。它不理解 AgentMessage、Thread、Delivery、Inbox、Ask、Reply 或 Discussion。

### packages/core

`packages/core` 是 Agent 通信事实的唯一 owner，负责：

- `AgentThread`、不可变 `AgentMessage`、`AgentDelivery` 与有界 Inbox 投影；
- author、initiator、source/target Agent Session、current exact RunRef、Workspace、parent Message 与 operation id 的稳定绑定；
- Core-issued Agent invocation capability 的签发、hash 持久化、验证、轮换与撤销；
- send、check、ackDeliveryBatch、acceptMessage、reply、ask、cancel 与 timeout 的状态和权限；
- 幂等、consumer generation、Ack 前重放、资源上限与持久化恢复；
- Message/Thread 与 Agent Session Timeline 的 correlation；
- 根据 Provider Evidence 能力限制可声明的最终状态。

Core 不拥有 View、Board、自动调度、Agent 选型、任务 DAG、结果评判或 coordinator loop。

### Desktop

Desktop 负责 Branch/Workspace 上下文、Discussion Canvas、Inbox 卡片、筛选、选中、布局，以及定位到已有 Agent Region。Renderer 只投影 Core 的 Thread、Delivery、Inbox 与 Timeline，不保存第二份通信状态机。

## Author 与 Initiator

每条 Message 都显式记录不可变 author：

- `agent-session` author 只能由 Core 从一个不透明的 Agent invocation capability 解析。公开 `AGENTMUX_AGENT_SESSION_ID` 只提供上下文提示，不能认证 author；调用参数或单独环境变量不能自行声明另一个 Agent Session。
- `user` author 由当前授权 Client 产生，不携带 source Agent Session，也不能冒充 Agent 发言。
- initiator 记录实际触发 Core 操作的 Client 或 Agent Session。P0 不支持 on-behalf-of；未来如需代发，必须是单独授权的显式能力。

Core 在受管 Agent launch 或 resume 时签发高熵 capability，绑定 Agent Session、Workspace、current exact RunRef、允许的通信操作与生命周期世代，只持久化其 hash。capability hash/generation 与 canonical Agent Session/current RunRef 在同一个 Core File Store 事务中激活；进程内缓存不能成为验证 owner。因为 raw capability 必须在 Run 启动前进入受管环境，Core 先把 hash 绑定到 lifecycle reservation，ctxmux 返回 exact RunRef 后再原子激活；激活前的调用返回 typed not-ready，失败回滚立即撤销 reservation 与 capability。

受管进程环境可以携带该不透明 capability，Core CLI/IPC 必须把它交回 Core 验证；raw capability 不进入 argv、日志、Timeline、错误、receipt 或明文持久化。不得把 Session ID、进程环境存在性或提示词内容当作认证。Run replacement、stop、retire 或权限撤回立即使旧 capability 失效；resume 为新 exact Run 签发新 capability。

P0 A2A Gate 必须由持有当前 capability 的受管 Agent A 自己调用 Core 通信 API，并由 Core 把 author 解析为 A。用户在 Desktop 中发起 user→Agent Discussion 是有效产品路径，但不是 A2A 证明。缺失、伪造、改写、跨 Workspace、错误 Session 或旧 Run capability 一律失败关闭。

## 首条消息与启动投递

新 Discussion 一对一绑定一个新目标 Agent Session。Core 先以 operation id 保留首条 Message 操作，再把 Message body 作为该 Session 的启动 Prompt 交给现有 Provider launch：

1. 相同 operation id 的重试只能得到同一结果，不得重复创建 Session 或重复注入 Prompt。
2. 启动成功后，Core 提交 Thread、目标 Agent Session、current exact RunRef 与 Delivery 的绑定。
3. 启动失败时，Delivery 进入 `failed`，且不得留下幽灵 Session、current Run 绑定或假 Thread 活跃状态。
4. ctxmux 接受输入或 Provider 启动参数最多证明 `delivered`。Prompt 本身及模型对 Prompt 的服从不能证明 `accepted` 或 `replied`。
5. 启动 Prompt 只是首条账本消息的 transport。Message ledger 始终是唯一消息真相。

专属 Session 让第一条 Discussion 拥有结构性 correlation：整个 Session Timeline 都属于该 Thread。它不等于逐 Message reply correlation；逐消息的 `accepted` 与 `replied` 仍需要 Hook、ACP、Provider-native turn receipt 或受管 Agent 显式调用 Core accept/reply API。

## 状态与证据

Delivery 状态至少区分：

- `queued`
- `delivered`
- `accepted`
- `replied`
- `failed`
- `timed-out`
- `cancelled`

状态只能单向推进到合法终态。迟到事件、旧 Run、错误 Session、错误 Thread、重复调用、撤回后的 Permission 或过期 deadline 都必须失败关闭。

证据等级遵循以下边界：

- ctxmux input receipt：只证明 exact Run 接受了对应输入字节；
- Provider 启动投递：只证明启动 Prompt 已交给目标 Provider transport；
- Hook、ACP 或 Provider-native turn receipt：可在身份与 correlation 完整时证明 accepted 或 replied；
- 受管 Agent 显式 `acceptMessage` 或 `reply`：必须绑定 caller Agent Session、target Thread/Message、current exact RunRef 与权限；
- Terminal Output、Timeline 文本、idle、标题、心跳或文本相似度：只作为 Activity，不升级 Message 状态。

Provider 没有 reply correlation 时，产品必须明确显示 `Delivered` 或 `Reply unverified`，不能写成已回复。

## Inbox 与消费

- `inbox` 读取历史或当前投影，不消费消息。
- `check` 返回最旧的有界 actionable Delivery 批次。
- 同一 consumer generation 在显式 `ackDeliveryBatch` 前重复 `check`，必须重放同一批次。
- `ackDeliveryBatch` 只推进该 consumer 的批次 cursor。它不重新注入已经投递的 Prompt，不把 Message 推进为 `accepted`，也不改变用户已读状态。
- `ackDeliveryBatch` 只接受当前 consumer generation 与确切 Delivery identity；旧 consumer、跨 Session 或跨 Thread 的确认失败关闭。
- `markRead` 与 `resolveThread` 只更新 Core 持有的用户 Inbox presentation state，不改变 Agent Delivery 或 Message Evidence。P0 是单用户本地 Runtime：一个稳定的 Core user principal 作用于同一 Runtime profile，所有 Desktop Client 共享该 scope；瞬时 client instance id 不是持久用户身份。
- Inbox、单批 Delivery、Message body、Thread 历史、未确认批次、并发 waiter、retry、hop/cycle、token 与 Timeline correlation 都有硬上限。
- 重启后从 Core Store 恢复同一批次与 unread 状态，不从 Desktop 本地缓存、Terminal output 或最近 Tab 推断。

## 权限与可达性

- 跨 Workspace 投递默认拒绝；P0 只允许同一 Workspace 内的显式授权 source 和 target。
- 自动唤醒默认拒绝。只有创建专属 target Agent Session 的 P0 操作携带一次明确 launch 授权。
- Agent 发起 target 的后续 Turn 默认拒绝；持续 send、ask 或 reply 必须具有对应 Thread 与 target capability。
- 附件默认拒绝并保持 unsupported，直到独立需求明确其存储、权限和生命周期。
- T-021 完成前 Remote target 返回 typed unsupported，不降级为 Local 猜测、Terminal 注入或隐藏 fallback。

## Discussion 交互

Board 的 Inbox 单元显示真实 pending/unread Thread 卡片，同时保留紧凑的“新建 Discussion”入口。每张卡片最多两行，优先呈现 subject、参与 Agent、状态与需处理提示。

打开 Discussion 时：

- 定位并复用绑定的 Agent Region；没有已打开 Region 时，按现有 View owner 创建投影，不创建第二 Agent Session；
- 同时呈现 Thread 消息、Session Activity 与统一 Agent Composer；
- reply、cancel、timeout、markRead 与 resolveThread 调用 Core 公共 API；
- 刷新和重启从 Core revision 恢复；
- `delivered`、`accepted`、`replied`、`timed-out` 与 `failed` 使用不同且准确的文案。

## 交付切片

### P0：专属 Session Discussion

- 一个受管 source Agent A 以自己的权威 Session identity 选择同一 Workspace 内的 Branch 与目标 Provider；
- 创建一个专属 target Agent Session；
- 首条 immutable Message 通过现有启动 Prompt 投递；
- Core 持久化 Thread、Message、Delivery、Session 与 exact RunRef 绑定；
- Desktop Inbox 显示未确认 Thread，并能定位到已有 Agent Region；
- Provider 无 reply correlation 时只展示 delivery-level 状态。

P0 的行为 Gate 必须覆盖真实 Agent A→Agent B author 绑定、用户不能冒充 Agent、伪造或改写 Session 环境身份失败、缺失/错误 capability 失败、激活前 typed not-ready、旧 Run capability 重放失败、raw capability 不泄漏、重复 operation、launch failure、stale Run、进程重启恢复、Desktop 投影和资源清理。P0 不以 user→Agent 路径、consumer batch ack 或逐 Message reply 冒充 A2A 成功。

### P1：持续通信

- 对已有 Agent Session 提供 send、check、ackDeliveryBatch、acceptMessage、reply、ask、cancel 与 timeout；
- Ask 使用 `pending`、`answered`、`closed`，相同回答幂等，不同回答冲突；
- Run replacement、Permission withdrawal、timeout/cancel race 与 A→B→A cycle 失败关闭；
- Handoff 交付后原 Owner 不再等待；受监督 Dispatch 保留 question、escalation、worker_done 与 cleanup 责任，并显式绑定 Task、attempt、target Agent 和这些事件的稳定 correlation id。Core 只持有通信事实；
- 默认拒绝跨 Workspace、自动唤醒、Agent 发起后续 Turn 与附件；Remote target 返回 typed unsupported；
- check/ackDeliveryBatch 覆盖 Ack 前批次重放、Ack 后不重复、consumer generation fence、慢 Consumer 与资源释放，且从不重复已提交的 Prompt；
- 至少证明一个显式 correlated reply、一个 delivery-only target 与一个 unsupported target。

### P2：增强体验

- unread-only、按 Project/Workspace/Agent/状态分组、搜索与 mark-all-read；
- 在 Discussion 详情中复用 live Agent View；
- 只有经单独确认后才增加多参与者、group fanout、priority、附件、完整 Handoff 或受监督 Dispatch UI；P1 的 Core correlation 与终止语义不依赖这些 UI。

## 非目标

- 不实现 Account、Relay、Federation、跨服务器消息总线或多租户。
- 不复制 Run、Task、Dispatch 调度器，不把自动调度或结果评判下沉 Core。
- 不以 Terminal Handle 作为持久业务身份。
- 不通过隐藏 Prompt 注入、Terminal Output scraping 或模型服从性推断 reply。
- 不维护 Conversation、Discussion 与 Inbox 三份状态。
- 不增加 compatibility、migration、legacy alias 或 fallback。
- 不为未来附件、多参与者或任意 Transport 预造配置层和抽象框架。

## 验收 Oracle

最小真实竖切为：受管 source Agent A 从 Branch 工作面调用 Core 通信 API，Core 验证当前 Agent invocation capability 并建立 author/initiator，以一次 operation 创建 target Agent B 与首条 Message；B 的 exact Run 接受一次启动投递；Core 重启后仍恢复同一 Thread 与未读 Inbox 投影；重复调用不重复 Prompt；伪造 Session ID、错误 capability 与旧 Run capability 都不能发送；Desktop 点击 Inbox 卡片定位同一 Agent Region；没有 reply evidence 时 UI 始终只声明 `Delivered`。用户发起的 Discussion 另行证明 author 为 user，不能写成 Agent A。

在此基础上，P1 再证明显式 reply correlation、Ask 恢复、Delivery batch replay、consumer fence、Permission 默认拒绝、Run replacement、Remote typed unsupported、Handoff/Dispatch correlation、timeout/cancel、cycle 与资源上限。只有当前 candidate 的 Core、Desktop、真实 Provider、持久化恢复和资源 Gate 汇合后，才能宣称结构化 Agent 通信完成。
