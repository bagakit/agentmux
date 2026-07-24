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

2026-08-17 的 T-020 Local implementation candidate 已完成 Run 层与 Codex 代表纵切；T-017 正在对同一候选做 Package、安全、可靠性与资源收口：

- 固定 CtxMux clean commit `2e32a9d647d627952ea5c455fb2efef6c636643a`、protocol 9；
- `packages/core/vendor/ctxmux/darwin-arm64` 携带其 manifest、SDK tarball、`ctxmux` 与 `ctxmuxd`；
- Core 构建时从固定 tarball 私有打包 SDK，不暴露 CtxMux 类型，不使用 `file:` 依赖、相邻 checkout、全局安装或下载；
- Local endpoint 由 exact artifact identity 隔离，调用方不能插入另一个同协议 daemon；
- `AgentMuxRunRef` 只包含 CtxMux `runId`，没有第二个 incarnation identity；
- Local Terminal 已通过同 Run/PID 重连、累计 byte replay、fragmented UTF-8、丢失 Input receipt 后的跨 Client 去重恢复、Resize、Interrupt-still-live 与 stubborn process-tree Stop；
- Remote/SSH 明确返回 `REMOTE_UNSUPPORTED`；
- 旧自建 daemon、wire、journal、`node-pty` Owner、Remote artifact 和 package bin 已删除。
- Codex 继续使用 AgentMux Provider 的 Launch/Resume/Hook/Permission 语义，只把物理 Run 交给同一个 `CtxmuxRunAdapter`；没有采用 CtxMux 的 Codex Integration；
- Core File Store/Resolver 是 `agentSessionId ↔ exact runId ↔ Provider native session id/ACP handle` 的唯一身份 Owner，Desktop 与 CLI 不再各存一份；
- checkout-external packed consumer 已证明 Codex create、Hook/permission、native-id 反查、跨 Client 同 Run/PID reconnect、send、Interrupt、provider-native Resume 保持 AgentMux ID 但切换 RunId、旧 Run 失败关闭和 Stop；
- `agentmux list/status/send/interrupt/attach/resume/stop` 全部以 AgentMux `agentSessionId` 为主键；
- Core View Resolver 与 typed Desktop focus 只聚焦当前已打开的 Terminal View 或唯一 Agent View，不 Open、Attach、Resume 或 Spawn。

Remote/SSH 仍明确 unsupported；Claude、TraeX、Hermes、Pi 保留同一 Provider/Agent Session 合同，但 T-020 只用 Codex 作为真实代表纵切。

## 使用 Codex 与统一 CLI

```ts
import { connectLocalAgentMux } from '@agentmux/core'

const client = await connectLocalAgentMux()
const session = await client.createAgent({
  agentId: 'codex',
  workspacePath: process.cwd(),
  prompt: 'Inspect this repository'
})

await client.reattachAgent(session.agentSessionId, 0)
await client.submitAgentPrompt(session.agentSessionId, 'Run the focused tests')
await client.signalAgent(session.agentSessionId, 'SIGINT')
await client.dispose()
```

```bash
agentmux list --json
agentmux status <agent-session-id> --json
agentmux send <agent-session-id> --text "Run the focused tests"
agentmux interrupt <agent-session-id>
agentmux attach <agent-session-id>
agentmux resume <agent-session-id>
agentmux stop <agent-session-id>
```

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

`client.onEvent` 是同步观察接口。需要异步处理时，callback 必须先把事件复制到 Consumer 自己的有界队列再返回；返回 Promise 的 callback 会在首个事件后自动退订。需要完整终端字节流时使用独立 Attachment/Replay，不把通用事件观察器当作无界消息队列。

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
