# AgentMux

AgentMux 把本地 Coding Agent 的 Provider、Agent Session、Hook、Permission、ACP 与 Client 投影收口成一个可嵌入的 TypeScript Core；Desktop 是它的第一方 Client。

Run 层只有一个 Owner：`ctxmux`。AgentMux 不持有 PTY、子进程、Replay、Socket wire 或进程树，也没有 Backend Selector、兼容层和 fallback。

```text
Desktop / CLI / external Node client
                  │
                  ▼
             @agentmux/core
 Provider / AgentSession / Hook / ACP / View
                  │
                  ▼
       private CtxmuxRunAdapter
                  │
                  ▼
       bundled @ctxmux/sdk + ctxmuxd
 Run / PTY / byte replay / resize / interrupt / stop
```

## 当前实现状态

2026-08-14 的 Shell checkpoint 已完成 Local Run 层切换：

- 固定 CtxMux clean commit `3b94288c3a7896bb355e028135409c8e8bbaf764`、protocol 9；
- `packages/core/vendor/ctxmux/darwin-arm64` 携带其 manifest、SDK tarball、`ctxmux` 与 `ctxmuxd`；
- Core 构建时从固定 tarball 私有打包 SDK，不暴露 CtxMux 类型，不使用 `file:` 依赖、相邻 checkout、全局安装或下载；
- Local endpoint 由 exact artifact identity 隔离，调用方不能插入另一个同协议 daemon；
- `AgentMuxRunRef` 只包含 CtxMux `runId`，没有第二个 incarnation identity；
- Local Terminal 已通过同 Run/PID 重连、累计 byte replay、fragmented UTF-8、丢失 Input receipt 后的跨 Client 去重恢复、Resize、Interrupt-still-live 与 stubborn process-tree Stop；
- Remote/SSH 明确返回 `REMOTE_UNSUPPORTED`；
- 旧自建 daemon、wire、journal、`node-pty` Owner、Remote artifact 和 package bin 已删除。

Coding Agent vertical 尚未在这个 checkpoint 中宣称完成。下一个闭环会把 Codex 接到同一个 Adapter，再恢复 Provider、Hook 与 Agent Session 的真实端到端证据。

## 使用 Local Terminal

```ts
import { connectLocalAgentMux } from '@agentmux/core'

const client = await connectLocalAgentMux()
const run = await client.createTerminal({
  workspacePath: process.cwd()
})

const attachment = await client.attachTerminal(run.runId, 0)
for (const event of attachment.replay) process.stdout.write(event.data)

await client.writeTerminal(run, {
  ownerInstanceId: client.runtimeIdentity().instanceId,
  operationId: crypto.randomUUID(),
  expectedByte: run.acceptedInputBytes,
  data: "printf 'hello from AgentMux\\n'\n"
})
await client.resizeTerminal(run, 120, 40)
await client.signalTerminal(run, 'SIGINT')
await client.stopTerminal(run)
await client.dispose()
```

`dispose()` 只释放当前 Client/Attachment；Run 由 `ctxmuxd` 持有，另一个 Client 可用相同 `runId` 和 byte cursor 重连。

## 验证

```bash
pnpm typecheck
pnpm test:fast
pnpm test:native
pnpm check
```

证据与残余边界见：

- [CtxMux cutover](docs/plans/ctxmux-cutover.md)
- [Testing strategy](docs/testing/strategy.md)
- [Run / Agent Session model](docs/plans/agentmux-semantic-session.md)
