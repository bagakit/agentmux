# @agentmux/core

无 Electron、React 依赖的 AgentMux Runtime Core。

当前 Local Run 只由固定的 CtxMux `1603908a253162632e8812ceb9db19c3e416fea4` 持有。包内携带 exact-commit manifest、SDK tarball 和 darwin-arm64 binaries；构建把官方 SDK 私有 bundle 进唯一 `CtxmuxRunAdapter`。公共 API 不导出 CtxMux SDK/wire 类型，也不需要相邻仓库、`file:` dependency、全局 `ctxmux` 或运行时下载。

Local Client 不接受外部 socket/state 注入。Endpoint 路径由 exact artifact identity 派生，只启动经过 hash、mode 和公开 `--version` 合同验证的随包 `ctxmuxd`。已存在的 peer 还必须匹配 owner receipt、daemon instance、persistent runtime lineage、runtime build 和五项必需 capability；bootstrap 只读取一次原始 `runtimeInfo()`，随后每次业务 dispatch 都在承载该业务帧的同一连接上匹配完整 expected Runtime identity。同协议的替换 daemon 也会在业务帧发送前失败关闭。

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

Shell checkpoint 已证明：same Run/PID reconnect、fragmented UTF-8、interior byte replay、lost-receipt Input dedup、resize、interrupt-still-live、complete stubborn-tree Stop，以及 checkout-external packed consumer。

Codex 代表纵切现在也走同一个 Adapter。`AgentProvider` 仍在 Core 生成 Launch/Resume Plan、归一化 Hook/Permission，并在 daemon-issued RunId 返回后把每次 Hook binding 锁定到 exact Run。Core File Store/Resolver 独占 `agentSessionId`、当前 RunId、Provider native session id/ACP handle 与有界 retired Run tombstone；旧 Run、未知 native id 和冲突绑定失败关闭。Desktop 与 CLI 共用该 Store，不再维护第二份身份文件。

Hook 的 stable binding identity 与随机 bearer 只存在于权限为 `0600` 的 Stored Session；`createAgent`、`agentSessions`、Resolver、Status、事件和 View 投影都会删除这两个控制字段。`client.onEvent` 只接受同步观察 callback；异步 Consumer 必须先复制到自己的有界队列，返回 Promise 的 callback 会自动退订。完整终端字节使用 Attachment/Replay。

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

Packed consumer 已覆盖 Core API 与 `agentmux list/status/send/interrupt/attach/resume/stop` 的真实 Codex 生命周期。Provider-native Resume 保留 `agentSessionId`，创建新的 CtxMux RunId；旧 Run 只保留有界 stale tombstone，不能再被操作或投影成 Raw Terminal。

浏览器侧只需要 View 投影和 focus resolver 时，从 `@agentmux/core/runtime` 导入。只需要合并 Session Timeline snapshot 与 committed revision 时，从 `@agentmux/core/timeline` 导入。两个子路径都不会加载 Agent Client、Hook Server、File Store 或 CtxMux Adapter 等 Node-only Runtime 模块。

`client.sessionTimeline(agentSessionId)` 返回 `{ agentSessionId, revision, items }`。Timeline 事件也带 revision；Core 一定先保存，再发布事件。Store 是 revision 的唯一 owner，只有内容真的变化才加一，完全相同的重试不会改文件，也不会再次发事件。消费者先读取 snapshot，再按 revision 接事件；遇到断号就重新读取 snapshot，不要自己猜缺失内容。流式更新提交当前完整 content，不提交字符串 delta。
