# @agentmux/core

无 Electron、React 依赖的 AgentMux Runtime Core。

当前 Local Run 只由固定的 CtxMux `3b94288c3a7896bb355e028135409c8e8bbaf764` 持有。包内携带 exact-commit manifest、SDK tarball 和 darwin-arm64 binaries；构建把官方 SDK 私有 bundle 进唯一 `CtxmuxRunAdapter`。公共 API 不导出 CtxMux SDK/wire 类型，也不需要相邻仓库、`file:` dependency、全局 `ctxmux` 或运行时下载。

Local Client 不接受外部 socket/state 注入。Endpoint 路径由 exact commit 与 manifest digest 派生，只启动经过 hash、mode 和公开 `--version` 合同验证的随包 `ctxmuxd`。已存在的 peer 还必须匹配当时启动时写入的 owner receipt 与 daemon instance；同协议的其他 daemon 失败关闭，不会被标记成该 exact build。

```ts
import { connectLocalAgentMux } from '@agentmux/core'

const client = await connectLocalAgentMux()
const run = await client.createTerminal({ workspacePath: process.cwd() })
await client.attachTerminal(run.runId, 0)
await client.writeTerminal(run, {
  ownerInstanceId: client.runtimeIdentity().instanceId,
  operationId: crypto.randomUUID(),
  expectedByte: run.acceptedInputBytes,
  data: 'pwd\n'
})
```

Run identity 就是 `{ runId }`。关闭 Client 不会停止 Run；`attachTerminal(runId, afterByte)` 用累计 raw-output byte cursor 恢复。Input 调用方在 disposition 确定前保留 `ownerInstanceId + operationId + expectedByte + data`，新 Client 可以重试同一 operation，CtxMux 返回精确 applied byte range 且不会重复写 PTY。`signalTerminal(..., 'SIGINT')` 映射 CtxMux portable Interrupt，其他信号失败关闭。Remote 当前返回 `REMOTE_UNSUPPORTED`。

Shell checkpoint 已证明：same Run/PID reconnect、fragmented UTF-8、interior byte replay、lost-receipt Input dedup、resize、interrupt-still-live、complete stubborn-tree Stop，以及 checkout-external packed consumer。Codex/Agent vertical 仍是当前 T-020 的下一闭环，不能从 Shell 证据外推为已完成。
