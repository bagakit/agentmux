# f-2248f4yx5 T-019 实现审查：P0 核心竖切

日期：2026-08-29
审查者：主 session
方法：读代码 + 实测变异验证

## 交付了什么

P0 的**核心竖切**：受管 Agent A 用一次 operation 创建专属 Agent B 并投递首条消息，
author 由 Core 从不可伪造的凭证解析。

三个新模块（均在 `packages/core`，通信事实的唯一 owner）：

| 模块 | 职责 |
|---|---|
| `agent-message.ts` | 不可变 Message、Thread、Delivery 状态机 |
| `agent-capability.ts` | 凭证签发/哈希/解析 author |
| `agent-discussion.ts` | 一次 Discussion 的计划（纯函数） |

接线：`client.ts` 的 `startDiscussion` 复用 `createAgent` 那条已验证的
reservation → commit 原子路径，**不复制一份**。

## 一、author 不可伪造 —— 通过（变异验证）

公开的 `AGENTMUX_AGENT_SESSION_ID` 就在环境变量里，改一下就能冒充，
因此**不能**用于认证。Core 在 spawn 前注入一枚 `randomBytes(32)` 凭证
（形状沿用既有 hook token），**只持久化 sha256 hash**——比 hook token 现状
（明文落盘、仅在公开投影里剥离）更严一档，这是 SSOT 的硬要求。

`startDiscussion` 的 `callerAgentSessionId` 只是**上下文提示**：Core 用凭证核对它，
对不上就拒绝。

三种失败**可区分**（混成一个笼统错误，调用方就只能猜该重试还是放弃）：

- `AGENT_CAPABILITY_NOT_READY` —— 已签发未激活（raw 必须在 Run 启动前进环境，存在这段窗口）
- `AGENT_CAPABILITY_INVALID` —— 缺失或伪造
- `AGENT_CAPABILITY_STALE_RUN` —— 旧 Run 重放

顺序也要紧：**先证明凭证属实，再谈是否还活着**——否则会把"猜错的凭证"泄露成"时机不对"。
比对用 `timingSafeEqual`。

变异验证：不校验凭证 / 旧 Run 放行 / 未激活放行 → 各 **1 failed**。

## 二、Delivery 只能单向推进 —— 通过（变异验证）

证据等级是硬边界：ctxmux 收下输入或 Provider 收下启动参数**最多**证明 `delivered`；
Prompt 本身与模型对它的服从**都不能**证明 `accepted`/`replied`。
因此没有 reply 证据时产品只能说 Delivered。

终态集合为空——迟到事件不能复活一条已结束的投递；也不能倒退、不能跳级。

变异验证：终态可复活 / 允许跳级 → 各 **1 failed**。

## 三、幂等 —— 通过（变异验证）

Thread id 由 operationId **派生**（sha256），不是随机——于是同 id 的重试天然落到
同一个 Thread，无需额外去重表；`createAgent` 收同一个 `createOperationId`，
不会重复 Spawn 或重复注入 Prompt。

变异验证：Thread id 改随机 → **1 failed**。

## 四、跨 Workspace 默认拒绝 —— 通过（变异验证）

P0 只允许同一 Workspace 内的显式授权 source 与 target。
变异验证：允许跨 Workspace → **1 failed**。

## 五、零调用者检查

`planDiscussion` 2、`createThread` 2、`advanceDelivery` 2、
`issueAgentCapability` 3、`hashAgentCapability` 4、`resolveCapabilityAuthor` 2 —— 均有生产引用。

`capabilityHash` 已纳入 store 的白名单持久化（`agent-session-store.ts`），
否则重启后凭证就认不出来了；按可选读取（旧记录或未激活时缺失是合法的）。

## 六、门禁

`pnpm check` 通过：typecheck + **1372 passed / 0 failed / 3 skipped** + build。

## 诚实说明：P0 尚未全部完成

本次交付的是 P0 的**核心竖切与全部安全边界**。按 SSOT，P0 完整验收还差：

1. **CLI 子命令** —— 让 Agent 能在自己进程里发起 Discussion。
   须走 `withClient`（Core 那条传输），而非 Control socket——
   消息真相归 Core，而 Control 面的 handler 住在 Desktop。
2. **Inbox 投影与 Desktop 呈现** —— 按既有决定，作为**名册的一列**而非第二个收件箱
   （`agent-roster.ts:5-15` 明确反对第二份列表）。
3. **进程重启恢复的端到端证明** —— hash 已持久化，但"重启后仍恢复同一 Thread 与未读投影"
   这条尚无集成测试。

在这三项补齐前，**不应宣称结构化 Agent 通信已完成**。已就位的部分是它们的地基，
且每一条安全不变量都有在被破坏时变红的断言。
