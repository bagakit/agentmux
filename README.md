# AgentMux

AgentMux 把本地 Coding Agent 的 Provider、Agent Session、Hook、Permission、ACP 与 Client 投影收口成一个可嵌入的 TypeScript Core；Desktop 是它的第一方 Client。

Run 层只有一个 Owner：`ctxmux`。AgentMux 不持有 PTY、子进程、Replay、Socket wire 或进程树，也没有 Backend Selector、兼容层和 fallback。

```text
Desktop / CLI / external Node client
                  │
                  ▼
             @agentmux/core
 Provider / AgentSession / Hook / ACP / Runtime Projection
 Host-neutral Composition contracts
                  │
                  ▼
       private CtxmuxRunAdapter
                  │
                  ▼
       bundled @ctxmux/sdk + ctxmuxd
 Run / PTY / byte replay / resize / interrupt / stop
```

## AgentMux 与 ctxmux 的分层

ctxmux 是可独立安装、发布和使用的通用 Run Runtime。它的 daemon、CLI、协议与 SDK
不依赖 AgentMux；即使没有任何 Agent Provider 或编辑器，ctxmux 也必须能够运行任意命令，
完成 detach/attach、输入、resize、replay、wait、interrupt 和 stop。

AgentMux 是 ctxmux 的高级 Client。`packages/core` 把 Provider、Agent Session、Hook、
Permission、ACP 和语义事件建立在 ctxmux 的 Run 事实之上，但不重新实现或重新判定这些
Runtime 事实。当前随包携带固定 ctxmux artifact 是 AgentMux 的发布与供应链策略，不改变
两个项目的产品边界，也不使 AgentMux 成为 ctxmux 的宿主。

| ctxmux 权威 | AgentMux 权威 |
| --- | --- |
| daemon endpoint、Run identity、PTY/process lifecycle | Provider catalog、AgentSession 与 provider-native identity |
| ordered bytes、replay、gap、input、resize、interrupt、stop | Prompt readiness、Agent message、Hook、Permission 与 ACP |
| Runtime capability、持久化、attach/reconnect、权威 revision 与时间 | Agent working/waiting/done、Evidence 解释与 semantic settlement |
| 执行调用方明确物化的通用 `RunSpec`、fork/resume plan 与 lineage | Provider-specific launch/resume plan、provenance、workspace/context 与产品策略 |

PTY 写入成功只能证明字节进入了 Runtime 边界，不能证明 Agent 接受了 Prompt；进程退出只能
证明 Run 终止，不能证明任务成功。AgentMux 可以引用 ctxmux 的 Run revision、byte range 和
lineage 作为 Evidence，但语义解释仍由 AgentMux 持有。

## 当前实现状态

当前 Local Run、Codex 代表纵切与第一条 Desktop Composition 纵切已经跑通：

- 固定 CtxMux clean commit `a0897087fdd0eb131c39c43d4d6791901335d69e`、protocol 13；
- `packages/core/vendor/ctxmux/darwin-arm64` 携带其 manifest、SDK tarball、`ctxmux` 与 `ctxmuxd`；
- Core typecheck 与构建直接消费固定 tarball 的官方 SDK 类型和实现，不保留手写 wire 声明；公开包仍不暴露 CtxMux 类型，也不读取相邻 checkout、全局安装或下载；
- Local endpoint 由 exact artifact identity 隔离，调用方不能插入另一个同协议 daemon；
- `AgentMuxRunRef` 只包含 CtxMux `runId`，没有第二个 incarnation identity；
- Local Terminal 已通过同 Run/PID 重连、累计 byte replay、fragmented UTF-8、丢失 Input receipt 后的跨 Client 去重恢复、Resize、Interrupt-still-live 与 stubborn process-tree Stop；
- Remote/SSH 明确返回 `REMOTE_UNSUPPORTED`；
- 旧自建 daemon、wire、journal、`node-pty` Owner、Remote artifact 和 package bin 已删除。
- Codex 继续使用 AgentMux Provider 的 Launch/Resume/Hook/Permission 语义，只把物化后的通用 `RunSpec` 和物理 Run 操作交给同一个 `CtxmuxRunAdapter`；ctxmux 不提供第二份 Agent-specific Provider；
- Core File Store/Resolver 是 `agentSessionId ↔ exact runId ↔ Provider native session id/ACP handle` 的唯一身份 Owner，Desktop 与 CLI 不再各存一份；
- checkout-external packed consumer 已证明 Codex create、Hook/permission、native-id 反查、跨 Client 同 Run/PID reconnect、send、Interrupt、provider-native Resume 保持 AgentMux ID 但切换 RunId、旧 Run 失败关闭和 Stop；
- `agentmux session list/resolve/status/send/interrupt/output/resume/stop` 全部以 AgentMux `agentSessionId` 为主键；非流式输出默认是版本化 JSON，`session output --follow` 输出 JSON Lines；
- Core 的 `RuntimeProjection` 只投影 Run 与 Agent Session，不表示界面。真实 `View` 是 Desktop 的 Pane/Tab presentation；
- `agentmux context/launch/view open/view focus` 通过一个版本化 Composition Control 进入 Desktop。Renderer 是 Layout SSOT，Desktop Main 持有长期 RuntimeController，`ctxmuxd` 仍只持有最终产生的 Run、PTY 与 Replay；
- `tab` 与四向 `split-left/right/up/down` 使用精确 View 或唯一 caller View，不读取 UI 焦点，也不猜最近 Pane。

Remote/SSH 仍明确 unsupported；Claude、TraeX、Hermes、Pi 与 Codex 共享同一
Provider/Agent Session 合同，当前真实端到端覆盖以 Codex 为代表。

## 使用 Codex 与统一 CLI

```ts
import { connectLocalAgentMux } from '@agentmux/core'

const client = await connectLocalAgentMux()
const session = await client.createAgent({
  agentId: 'codex',
  workspacePath: process.cwd(),
  injectAgentMuxGuide: true,
  prompt: 'Inspect this repository'
})

await client.reattachAgent(session.agentSessionId, 0)
await client.submitAgentPrompt(session.agentSessionId, 'Run the focused tests')
await client.signalAgent(session.agentSessionId, 'SIGINT')
await client.dispose()
```

```bash
agentmux context
agentmux launch --agent codex --prompt "Inspect the failing tests" \
  --placement split-right --relative-to self

agentmux session list
agentmux session status <agent-session-id>
agentmux session send <agent-session-id> --text "Run the focused tests"
agentmux session output <agent-session-id> --follow
agentmux session interrupt <agent-session-id>
agentmux session resume <agent-session-id> --text "Continue from the provider context"
agentmux session stop <agent-session-id>

agentmux view open --session <agent-session-id> \
  --placement tab --relative-to self
agentmux view focus --view <view-id>
```

`context`、`launch` 与 `--relative-to self` 只接受受管 Agent 注入的
`AGENTMUX_AGENT_SESSION_ID`。同一 Agent Session 打开多个 View 时，`self` 会失败关闭；调用方
必须改用 receipt 返回的精确 `viewId`。Desktop 不可用时，Composition 命令不会退化为 UI
automation 或直接访问 ctxmux socket。

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
