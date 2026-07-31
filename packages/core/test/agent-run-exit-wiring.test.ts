import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxAdapterExitEvent } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxClientEvent } from '../src/types.js'

// ---------------------------------------------------------------------------
// f-23r8fq5nw / T-012：退出原因分类的**接线**验收（纯函数分类在 agent-run-exit.test.ts）。
//
// 这里证明的是竖切闭合：停止意图由真实 stop 路径记录、退出事件经 acceptKernelEvent 合成 exitReason 后
// 发布出去。把 acceptKernelEvent 里的分类剪断（回到只发普通 exited、不带 exitReason），下面每条断言都变红。
// ---------------------------------------------------------------------------

type ClientInternals = {
  kernel: Record<string, unknown>
  connected: boolean
  acceptKernelEvent(event: CtxmuxAdapterExitEvent): void
}

function exited(runId: string, code: number, signal: string | null, observedAt = 5): CtxmuxAdapterExitEvent {
  return { type: 'exit', runId, state: { type: 'exited', code, signal }, observedAt }
}

function connectedClient(): {
  client: AgentMuxClient
  internals: ClientInternals
  processStates: () => Extract<AgentMuxClientEvent, { type: 'process-state' }>[]
} {
  const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  const internals = client as unknown as ClientInternals
  const kernel = internals.kernel
  kernel.isConnected = () => true
  kernel.prepareStop = async (runId: string) => ({ daemonInstance: 'daemon', operationKey: 'key', runId })
  kernel.stop = async () => {}
  internals.connected = true
  const events: AgentMuxClientEvent[] = []
  client.onEvent((event) => events.push(event))
  return {
    client,
    internals,
    processStates: () => events.filter(
      (event): event is Extract<AgentMuxClientEvent, { type: 'process-state' }> => event.type === 'process-state'
    )
  }
}

describe('run exit reason wiring', () => {
  let disposeCurrent: (() => Promise<void>) | null = null
  afterEach(async () => {
    if (disposeCurrent) await disposeCurrent()
    disposeCurrent = null
  })

  it('classifies an exit after a recorded user stop as user-stopped', async () => {
    const { client, internals, processStates } = connectedClient()
    disposeCurrent = () => client.dispose()
    // 真实停止路径记录意图……
    await client.stopTerminal({ runId: 'run-stopped' })
    // ……随后内核报出这个 run 的退出，acceptKernelEvent 把意图与结果合成 exitReason。
    internals.acceptKernelEvent(exited('run-stopped', 0, null))
    // 剪断分类接线（不带 exitReason）时这条变红：一个我们明明关掉的 run 又变得无从区分。
    expect(processStates().at(-1)).toMatchObject({
      state: 'exited',
      exitReason: 'user-stopped'
    })
  })

  it('classifies a self-exit with a failure signal or non-zero code as crashed', async () => {
    const { client, internals, processStates } = connectedClient()
    disposeCurrent = () => client.dispose()
    internals.acceptKernelEvent(exited('run-crash-code', 1, null))
    internals.acceptKernelEvent(exited('run-crash-signal', 0, 'SIGKILL'))
    const states = processStates()
    expect(states.at(-2)).toMatchObject({ state: 'exited', exitReason: 'crashed' })
    expect(states.at(-1)).toMatchObject({ state: 'exited', exitReason: 'crashed' })
  })

  it('never dresses a bare 0 without stop intent as a clean finish — it is unknown', async () => {
    const { client, internals, processStates } = connectedClient()
    disposeCurrent = () => client.dispose()
    internals.acceptKernelEvent(exited('run-bare-zero', 0, null))
    // 这条是「裸 0 不当作干净结束」的守门断言，剪断分类同样让它变红。
    expect(processStates().at(-1)).toMatchObject({
      state: 'exited',
      exitCode: 0,
      exitReason: 'unknown'
    })
  })

  it('consumes the stop intent once — a later unrelated exit is classified on its own facts', async () => {
    const { client, internals, processStates } = connectedClient()
    disposeCurrent = () => client.dispose()
    await client.stopTerminal({ runId: 'run-once' })
    internals.acceptKernelEvent(exited('run-once', 0, null))
    // 同一 runId 再退一次不会再借到那条意图（意图读完即删），裸 0 因此归为 unknown。
    internals.acceptKernelEvent(exited('run-once', 0, null))
    const states = processStates()
    expect(states.at(-2)).toMatchObject({ exitReason: 'user-stopped' })
    expect(states.at(-1)).toMatchObject({ exitReason: 'unknown' })
  })
})
