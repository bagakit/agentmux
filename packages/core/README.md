# @agentmux/core

无 Electron、React 依赖的 AgentMux Runtime Core。

产品术语只引用 [交互合同《统一概念与空间寻址》](../../docs/design/agentmux-desktop-interaction.md#统一概念与空间寻址2026-10-03)：Space/Zone/Tab/Region 属于 client 空间，Project/Workspace 是来源上下文；Core 持有 AgentSession 语义事实，ctxmux 持有 Run。公开 Control 可以表达空间目标和回执，Core 不拥有 UI 空间生命周期。Core RuntimeProjection 是执行事实投影，Desktop View 是展示；两者分开，不能与 AgentSession/Run 或 Desktop Tab 身份混同。空间移动不改 Session cwd。空间 CLI 的精确寻址、失败保留和丢回执查询遵循[实施合同](../../docs/plans/pmo-cross-workspace-worktree-cli-design-2026-10-03.md)。Desktop Client 组合自己的配置、Git 与持久布局 owner，Core 只传输类型化空间协议并执行公开 Agent API。

当前 Local Run 只由随包 [manifest](vendor/ctxmux/darwin-arm64/manifest.json) 绑定的固定 CtxMux 产物持有。包内携带 exact-commit manifest、SDK tarball 和 darwin-arm64 binaries；开发期依赖只从这份 tarball 取得官方类型，构建再把同一 SDK 私有 bundle 进唯一 `CtxmuxRunAdapter`，不保留手写 wire 声明。公共 API 不导出 CtxMux SDK/wire 类型，发布后的 runtime 也不需要相邻仓库、外部 `@ctxmux/sdk`、全局 `ctxmux` 或运行时下载。

Local Client 不接受外部 socket/state 注入。默认 Endpoint 与持久状态使用稳定宿主 namespace，产物身份变化不另建 Runtime。只启动经过 hash、mode 和公开 `--version` 合同验证的随包 `ctxmuxd`。已有服务按公开 Runtime identity、协议与所需 capability 核验；归属记录未知只限制清理权限，兼容服务上的健康 Run 继续可用。bootstrap 读取原始 `runtimeInfo()`，随后每次业务 dispatch 都在承载该业务帧的同一连接上匹配 expected Runtime identity；身份变化在发送前明确拒绝，不猜已经送达或自动重放。

## Runtime 边界

`@agentmux/core` 是 ctxmux 的 Client，不是 ctxmux 的宿主。ctxmux 自己的 daemon、CLI、
协议和 SDK 构成可独立使用的通用 Run Runtime；Core 随包固定 artifact 只是当前产品的
供应链和 endpoint policy。

Core 只消费 ctxmux 能权威证明的 Run 事实：identity、capability、lifecycle、ordered
bytes、replay、gap、input、resize、interrupt、stop、revision 和时间。Core 自己持有
Provider、AgentSession、provider-native identity、Launch/Resume Plan、Hook、Permission、
Prompt readiness、Agent status 和 Evidence 解释。新增 Provider 不得要求 ctxmux 增加
Agent-specific Run 类型或解析 Provider 输出。

Provider-native Resume 由 Core 从自己的 Session/provenance 物化新的通用 `RunSpec`，再
请求 ctxmux 创建并记录相应 lineage。调用方请求 Level B 而 provenance 不足时必须失败；
Core 和 ctxmux 都不能把它暗中降为 Level A restart。

```ts
import { connectLocalAgentMux } from '@agentmux/core'

const client = await connectLocalAgentMux()
const run = await client.createTerminal({ workspacePath: process.cwd() })
const attachment = await client.attachTerminal(run.runId, 0)
const secondViewReplay = await client.readRunReplay(run, 0)
await client.writeTerminal(run, {
  ownerInstanceId: client.runtimeIdentity().instanceId,
  operationId: crypto.randomUUID(),
  expectedByte: run.acceptedInputBytes,
  data: 'pwd\n'
})
await client.releaseRunAttachment(attachment.run)
```

Run identity 就是 `{ runId }`。关闭 Client 不会停止 Run；`attachTerminal(runId, afterByte)` 用累计 raw-output byte cursor 建立 retained Attachment，`readRunReplay(run, afterByte)` 在不新增 retained owner 的前提下为另一个 View 读取有界 Replay，`releaseRunAttachment(run)` 按 exact RunRef 释放。Input 调用方在 disposition 确定前保留 `ownerInstanceId + operationId + expectedByte + data`，新 Client 可以重试同一 operation，CtxMux 返回精确 applied byte range 且不会重复写 PTY。`signalTerminal(..., 'SIGINT')` 映射 CtxMux portable Interrupt，其他信号失败关闭。Remote 当前返回 `REMOTE_UNSUPPORTED`。

`refreshRunAttachment(run, afterByte, view, operationId?)` 沿同一个 retained owner 重开该 Client 对原 Run 的观察连接：先打开并核对 snapshot，再替换 live pump；打开失败保原 owner，不停止 Run，也不发送 Input。它与只读 `readRunReplay` 的结果范围不同。刷新直接产生的状态投影携带通用 `observationOrigin`（精确 Run 与 operation），仍是事实更新，不构成新的输入执行意图；独立 Hook、重连及 live output 不带该来源。实际新 attachment 只确认观察连接建立，不是 Run 活性或 Input 送达回执。

Replay 和 `terminal-output` 的 `dataBytes: Uint8Array` 是终端消费者应写入的原始字节；`data` 是给语义观察者的流式文本，不用于字节裁剪。CLI `output` 与 `output --follow` 使用 `dataBase64` 表达同一字节流，调用方用 base64 解码后按范围去重。行为合同见设计 SSOT 的「ordered bytes 的公开传输边界」。

Shell checkpoint 已证明：same Run/PID reconnect、fragmented UTF-8、interior byte replay、lost-receipt Input dedup、resize、interrupt-still-live、complete stubborn-tree Stop，以及 checkout-external packed consumer。

Codex 代表纵切现在也走同一个 Adapter。`AgentProvider` 仍在 Core 生成 Launch/Resume Plan、归一化 Hook/Permission，并在 daemon-issued RunId 返回后把每次 Hook binding 锁定到 exact Run。Core File Store/Resolver 独占 `agentSessionId`、当前 RunId、Provider native session id/ACP handle 与有界 retired Run tombstone；旧 Run、未知 native id 和冲突绑定失败关闭。Desktop 与 CLI 共用该 Store，不再维护第二份身份文件。

Hook 的 stable binding identity 与随机 bearer 只存在于权限为 `0600` 的 Stored Session；`createAgent`、`agentSessions`、Resolver、Status、事件和 View 投影都会删除这两个控制字段。`client.onEvent` 只接受同步观察 callback；异步 Consumer 必须先复制到自己的有界队列，返回 Promise 的 callback 会自动退订。完整终端字节使用 Attachment/Replay。

Provider/ACP semantic status 与 pending Permission/Question 也是 Core-owned Session 事实。Client
通过 `interaction` 事件和 `session.pendingInteraction` 公开 typed request；Consumer 用
`respondAgentInteraction({ agentSessionId, expectedRun, response })` 回答。Core 会验证 exact Session、
Run、request 与选项，ACP response 回到 Adapter，Native response 交给 Provider 规划终端协议。
结构化回答的 Consumer 不生成厂商按键，也不从 `status.detail` 猜交互。需要两阶段 Prompt 的 Provider 必须同时
声明真实 transport `payload` 与 TUI `renderedText`；bracketed paste 不是 Core 默认行为。Prompt 采用
64 KiB 上限，screen oracle 的有界 scrollback 覆盖同一范围。pending interaction 期间，普通 Prompt
被 Core 拒绝；原生终端仍通过 `writeAgent({ agentSessionId, expectedRun, data, source })`
可用。`source` 必须为 `user` 或 `terminal-protocol`，自动协议回应不视为用户回答。原生输入
只记录调用时精确请求的投递事实；accepted/unknown 不等于批准，不自动重放。Consumer 从
`session.pendingInteraction` 读取当前事实，用 `agentInteractionResponseUnavailableReason` 显示
结构化回答不可用的原因与原生入口；新请求、Working 或 Stop 不证明旧请求已完成。ACP response
只有在 Adapter delivery 与 semantic settlement 完成后才成功，Native response 按原 ctxmux
recoverable Input claim 收敛。

普通 Prompt 通过 `submitAgentPrompt` 投递。首次可能执行的调用前，用
`agentPromptCondition(await client.refreshAgentSession(agentSessionId, expectedRun))`
读取精确 Session 的 admission 条件，并与 operationId、正文和 Run 一起保存到调用方已有的发送意图。
队列尾部到真正派发时才读取；重试和丢回执恢复复用原条件，不按最新状态重新绑定。
`afterSubmissionId: null` 表示已确认没有前序 admission，缺少该字段表示未知。
如果后续消息已经替换原 admission 且原 tuple 不在，旧消息返回
`AGENT_PROMPT_INPUT_UNCONFIRMED`，保留后续事实与原生终端输入；这不代表 Agent 失效。

```ts
const session = await client.createAgent({
  providerId: 'codex',
  executorId: 'codex-full-auto',
  workspacePath: process.cwd(),
  injectAgentMuxGuide: true,
  prompt: 'Inspect the failing test'
})
const status = await client.statusAgent(session.agentSessionId)
const nativeHandle = status.session.nativeHandle
if (nativeHandle?.kind !== 'provider') throw new Error('Codex native session is not ready')
const byNative = client.resolveAgentSession({
  kind: 'provider-native',
  providerId: nativeHandle.providerId,
  sessionId: nativeHandle.sessionId
})
```

需要报告首次 Prompt 的投递事实时，用同一次创建的公开 API：

```ts
const { session, creation } = await client.createAgentWithDelivery({
  providerId: 'codex',
  executorId: 'codex-full-auto',
  workspacePath: process.cwd(),
  createOperationId: crypto.randomUUID(),
  prompt: 'Inspect the failing test'
})
console.log(session.agentSessionId, creation.initialPrompt)
```

`createAgent` 仍返回同一次创建的 Session；`createAgentWithDelivery` 同时返回 `promptConfirmed` 和 `creation`。`creation.createOperationId` 是关联标识，不能据此盲重试创建。`initialPrompt` 分别表达 `not-requested/confirmed/unconfirmed/unknown`，不证明任务被接受或执行。Agent 已启动而保存投递事实失败时，当前调用返回实际回执、发出明确提醒并保留健康 Run；后续持久查询仍如实保留 unknown，不能据此自动重发。

空间命令从 `@agentmux/core/control` 消费类型化请求和报告。`agent open` 创建 Agent 或增加既有 Session 的投影，`space mv` 只移动确切 Region。Space/Zone/Tab/Region 的生命周期与持久布局由 Client 持有，实际执行 cwd、AgentSession 和 Run identity 由各自原 owner 保持。

Packed consumer 已覆盖 Core API 与 `agentmux list/status/send/interrupt/attach/resume/stop` 的真实 Codex 生命周期。Provider-native Resume 保留 `agentSessionId`，创建新的 CtxMux RunId；旧 Run 只保留有界 stale tombstone，不能再被操作或投影成 Raw Terminal。

浏览器侧只需要 View 投影和 focus resolver 时，从 `@agentmux/core/runtime` 导入。只需要合并 Session Timeline snapshot 与 committed revision 时，从 `@agentmux/core/timeline` 导入。结构化回答的可用性判断从 `@agentmux/core/agent-interaction-state` 导入。这些子路径都不会加载 Agent Client、Hook Server、File Store 或 CtxMux Adapter 等 Node-only Runtime 模块。

`client.sessionTimeline(agentSessionId)` 返回 `{ agentSessionId, revision, items }`。Timeline 事件也带 revision；Core 一定先保存，再发布事件。Store 是 revision 的唯一 owner，只有内容真的变化才加一，完全相同的重试不会改文件，也不会再次发事件。消费者先读取 snapshot，再按 revision 接事件；遇到断号就重新读取 snapshot，不要自己猜缺失内容。流式更新提交当前完整 content，不提交字符串 delta。
