# Agent 间结构化通信 —— 最终 Review

日期：2026-08-29
候选：当前工作树（`pnpm check` 通过：typecheck + 1422 passed / 0 failed / 3 skipped + build）
SSOT：`docs/plans/agent-communication.md`

## 结论先说

**P0 竖切成立。P1 只交付了 Core 侧的状态机纯函数，竖切未闭合——七个动作在
`client.ts` 之外零调用者，因此不能宣称 P1 完成。P2 增强体验未做。**

第一版结论写的是"P0 与 P1 的 Core 侧全部机制已交付"。那句话不成立，本文已改正：
理由见下方「P1 未闭合」。它给出的证据是变异测试——而变异只证明"这行代码被用到了"，
不证明"这条能力接到了产品上"。判断竖切要用另一把尺：**去掉 `client.ts` 自身，
还有没有调用者**。

按 SSOT 的验收 oracle 逐条核对如下。

## 已成立（逐条对着代码核实）

### author 由 Core 从凭证解析，调用方声称的身份不作数

`agent-capability.ts`。Core 在 spawn 前把 `randomBytes(32).toString('base64url')`
注入受管进程环境（`client.ts` 的 `agentEnvironment`，在 `kernel.start` 之前），
**只持久化 sha256 hash**。

这比仓库既有的 hook token 更严一档：后者明文落盘、仅在公开投影里剥离
（`client.ts` 的 `cloneSession`），而凭证只留 hash——SSOT 的硬要求。

`startDiscussion` 的 `callerAgentSessionId` 只是上下文提示，Core 用凭证核对它。
公开的 `AGENTMUX_AGENT_SESSION_ID` 就在环境变量里，改一下就能冒充，**不用于认证**。

三种失败可区分，且**顺序要紧**：先证明凭证属实，再谈是否还活着——
否则会把"猜错的凭证"泄露成"时机不对"。比对用 `timingSafeEqual`。

- `AGENT_CAPABILITY_NOT_READY`（已签发未激活）
- `AGENT_CAPABILITY_INVALID`（缺失或伪造）
- `AGENT_CAPABILITY_STALE_RUN`（旧 Run 重放）

`resume` 换 Run 即换凭证，旧 Run 的那枚随之作废。

### 伪造 Session ID、错误 capability、旧 Run capability 都不能发送

变异验证：不校验凭证 / 旧 Run 放行 / 未激活放行 → **各 1 failed**。

### 重复调用不重复 Prompt

Thread id 由 `operationId` 派生（sha256）而非随机，于是同 id 的重试天然落到同一个
Thread，无需额外去重表；`createAgent` 收同一个 `createOperationId`，
复用它已验证的 reservation → commit 原子路径，**不复制一份创建逻辑**。

变异验证：Thread id 改随机 → **1 failed**。

### 没有 reply evidence 时只能声明 Delivered

`agent-message.ts` 的状态机把证据等级编码进转移表：ctxmux 收下输入或 Provider 收下
启动参数**最多** `delivered`；`accepted`/`replied` 需要 Hook、ACP、Provider 原生回执
或受管 Agent 显式调用 Core。终态集合为空——迟到事件不能复活一条已结束的投递；
不能倒退、不能跳级。

变异验证：终态可复活 / 允许跳级 → **各 1 failed**。

### 受管 Agent 能在自己进程里发起 Discussion

`agentmux discuss --agent <executor-id> --text <first message>`。

它走 `withClient`（**Core 那条传输**）而非 Control socket——消息真相归 Core，
而 Control 面的 handler 住在 Desktop（`control-ipc-bridge.ts` 把请求转给 renderer，
因为布局真相在 renderer）。把账本挂到 Control 上等于让布局层拥有消息真相。

身份不靠 `AGENTMUX_AGENT_SESSION_ID` 自证：raw 凭证从环境取出**交回 Core 验证**，
Core 据此解析 author。CLI help 与 intents 已同步，Agent 发现得到它。

### 跨 Workspace 默认拒绝

`agent-discussion.ts`。变异验证：允许跨 Workspace → **1 failed**。

### 消息真相归 Core

三个模块都在 `packages/core`；ctxmux 完全不理解 Message/Thread/Delivery；
启动 Prompt 只是**账本首条消息的 transport**，Message ledger 始终是唯一消息真相。

### Inbox 是名册的一列，不是第二个收件箱

`RosterRow.unacknowledgedThreads`，与 `awaitingReply` 并列——它们回答同一个问题
"这一行需要我做点什么吗"。`AgentRoster.tsx` 用同一枚 pending 样式渲染，
并把它写进可访问名。

这是按名册自己的声明来的：`agent-roster.ts:5-15` 写着这份列表
"deliberately ONE surface: the pending requests are rows in it, **not a second inbox
that would then have to agree with it**"。两个必须互相同步的列表正是熵增。

缺席读作 0——没有 Thread 不是缺数据。

### 凭证跨重启存活

`capabilityHash` 已纳入 store 的**白名单**持久化（`agent-session-store.ts`）——
store 是白名单式的，不加就会在重启后丢失，Agent 重启一次就永远说不了话。

集成测试用**真实文件 Store 往返**证明：第二个 Store 实例读回同一个 hash，
凭证仍解析得出 author；且落盘的是 hash 而非 raw（断言 dump 里不含原文）。

变异验证：hash 不再落盘 → **2 failed**。

## P1（Core 侧机制，竖切未闭合）

下面每一条的状态机都成立且经变异验证，但都**只到 `client.ts` 的方法为止**。
先读「P1 未闭合」再读这一节，否则容易把"机制有了"读成"能力交付了"。

### 七个 Delivery 状态

补齐 `timed-out` 与 `cancelled`。两者都是"不会有结果了"，但原因不同：一个是没等到、
一个是不等了——混成 `failed` 就分不出该重试还是该放弃。四个终态封死，迟到事件不能翻案。

变异验证：终态可复活 / 允许跳级 → 各 1 failed。

### 投递批次：不丢消息，也不重复消费

`agent-delivery-queue.ts`。规则全在 check 与 ack 之间：

- **Ack 之前重复 check 重放同一批**——否则一次崩溃重连就把那批消息丢了；
  批次大小参数变了也重放原批，因为重放的意义是"你上次没确认的是什么"，答案不该随参数变。
- **generation fence**：慢 consumer 带着过期的号回来，失败关闭而非静默放行——
  否则它会把后来那一批也一起标记掉。
- ack 只推进这个 consumer 的游标，不改变消息状态："我收到了"不等于"我接受了"。

变异验证：不重放未确认批次 → 1 failed；fence 失效 → 2 failed。

### Ask：一对对称规则

`agent-ask.ts`。相同回答**幂等**（网络重试会重放同一答案，判成冲突只会逼调用方猜自己
是不是第一个）；不同回答**冲突**（先到先得地悄悄覆盖，问的人就永远不知道对方改过口）。
超时与取消同为 `closed`，已回答的不会被超时冲掉。

变异验证：幂等失效 / 悄悄覆盖 / 已回答被超时冲掉 → 各 1 failed。

### Handoff 与 Dispatch：谁在等

`agent-handoff.ts`。两者的区别只有一个，但它决定了责任归属：

- **Handoff** 交出去——原 Owner **不再等待**，责任跟着工作走；
- **Dispatch** 派出去——所有权**留在派发方**，它仍要接 question / escalation /
  worker_done / cleanup。只有收工才解除等待；提问与升级恰恰是 Owner 该处理的事。

混成一件事就会出现"我以为你在管、你以为我交出去了"的悬空工作。
事件 correlation id 由 dispatch + attempt + kind 派生，重放幂等。

变异验证：提问也解除等待 / 事件重放不幂等 / Handoff 不转移所有权 → 各 1 failed。

### 每个动作都验凭证

七个通信动作全部先过 `resolveMessageAuthor`——author 由 Core 从凭证解析，
调用方声称的身份不作数。抽成一处是因为"新增动作时漏验"是最容易发生的遗漏，
而漏验一次就是一个冒充口子。有测试钉住"所有动作都过同一道门"。

变异验证：任一动作漏验 → 1 failed。

### UI 只说证据支持的话

`delivery-evidence.ts`。七个状态各有文案，`delivered` 只说送达——把它写成"已回复"，
用户会以为对方看过并回应了，而实际可能连读都没读。注意力归类复用共享语汇，不发明第三套。

变异验证：把 delivered 说成 Replied / 超时与取消混为一谈 → 各 2 failed。

## P1 未闭合

把 `client.ts` 自己排除掉之后，`checkDeliveries`、`ackDeliveryBatch`、`answerAsk`、
`cancelAsk`、`handOff`、`openDispatch`、`recordDispatchEvent` 这七个动作在整个仓库里
**零调用者**——没有 IPC、没有 CLI 子命令、没有 UI。对照它们各自的 P0 同类
（`startDiscussion` 有 `agentmux discuss` 与 Board Canvas 两个真实入口）就能看出差别。

具体缺口，按 SSOT 的 P1 条款：

- **`send` / `acceptMessage` / `reply` 三个 API 根本不存在。** SSOT 要求"对已有 Agent
  Session 提供 send、check、ackDeliveryBatch、acceptMessage、reply、ask、cancel 与
  timeout"，现在只有中间那几个的纯函数。没有 `acceptMessage` 与 `reply`，
  `accepted` 与 `replied` 两档就没有任何东西能推进它们——七状态机里有两个状态
  在生产路径上不可达。
- **Thread、Message、DeliveryQueue 都没有持久化。** `agent-session-store.ts` 里
  对 `AgentThread` / `threadId` / `DeliveryQueue` 零命中。`DeliveryQueue` 由调用方
  当参数传进传出，Core 不持有它，于是"Core 重启后恢复同一 Thread 与未读 Inbox 投影"
  这条 oracle 无从谈起，consumer 游标也活不过一次重启。
- **三类 Provider 的真实竖切矩阵没有。** 九个 Provider 的 `replyCorrelation` 全是
  `'none'`，即全部是 delivery-only。SSOT 要求"至少证明一个显式 correlated reply、
  一个 delivery-only target 与一个 unsupported target"——correlated-reply 那一类
  **在当前 catalog 里不存在**，不是没接，是没有素材。
- **A→B→A cycle、hop 上限、waiter/retry/token/Inbox 上限没有实现。** 只有一个
  复用自 Prompt 的 64KB 大小上限。
- **消息侧的 Remote typed unsupported 没有。** `REMOTE_UNSUPPORTED` 只出现在
  `execution-host.ts` 与 `runtime-client.ts` 的 Run 路径上，通信路径没有接。
- **Discussion Canvas 只读 `describeDeliveryEvidence('delivered')` 一个常量。**
  SSOT 要求 Canvas "允许选择 source/target Agent、查看 Thread、回复/取消/超时和
  Evidence 等级"——现在只有创建入口，没有 Thread 视图，也没有回复/取消/超时。

这些不是收尾工作，量级与 P0 相当。诚实的说法是：P1 的**状态机**已就绪且可信，
P1 的**能力**尚未交付。

## 未成立（P2，本次不做）

- **P2 增强体验**：unread-only、按 Project/Workspace/Agent/状态分组、搜索、mark-all-read，
  以及 Discussion 详情里复用 live Agent View。

## 处置

P0 竖切成立，可以宣称。P1 的状态机成立、能力未交付，不能宣称——七个动作零调用者，
三个 API 缺失，Thread 与 Queue 无持久化，correlated-reply Provider 无素材。

留给自己的教训：变异测试证明的是"这行代码在被某个测试用到"，不是"这条能力接到了
产品上"。第一版结论正是靠 12 处变异验证得出的，而它们全部通过——因为纯函数确实被
纯函数的测试覆盖了。竖切要用零调用者检查来判，两把尺不能互相替代。
