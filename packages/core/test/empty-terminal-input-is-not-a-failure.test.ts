import { describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxRunInputData, AgentMuxStoredAgentSession } from '../src/types.js'

// ---------------------------------------------------------------------------
// 「按了键但没有字节要发」不是故障（AGENTS.md 原则 11 第 2 类的极端形态：连降级都不是，是无事发生）。
//
// 实战报告：用户**没有**用 Composer，只是直接在 Agent 的 TUI 里打字，却间断收到
//   `Error invoking remote method 'sessions:write': AgentMuxError: recoverable native Input
//    must not be empty`
// 那句话不是本仓抛的，是 vendored ctxmux daemon 的 `Request::RecoverableInput` 校验
// （`vendor/ctxmux/darwin-arm64/bin/ctxmuxd` 里可 strings 到）。而 Agent 一直活着、PTY 一直
// 接受字节——坏的只有我们把一个**空载荷**当成了一次真实输入送下去。
//
// 空载荷有两个真实来源，都在 xterm 那一侧，且都与 Composer 无关：
//   1. IME 组字途中的 `onData('')`（中文输入法尤其常见）
//   2. 旧式鼠标上报被禁用/坐标越界时的 `onBinary('')`，经 encodeTerminalBinaryInput 变成零长 Uint8Array
//
// 判据是**「Agent 还能干活吗」**：能。所以这条路不许抛，也不许留下降级痕迹。
//
// 为什么钉在 Core 而不只是 renderer：Core 是可独立发布的包（AGENTS.md 目标 1），每个 client
// 都会撞上同一条 daemon 校验。renderer 那道闸（terminal-reveal.ts 的 terminalInputSender）是
// 纵深防御，不是唯一防线——把它删掉这里仍须绿。
//
// 变异探针：把 client.ts 的 `if (data.length === 0)` 整块删掉（让空载荷落回常规路径），
// 空载荷那两条用例即从绿转红——它们会拿到 kernel.input 的调用，进而抛。已实测。
// 反向探针：把闸改成 `if (!data)`（真值判据），**零长 Uint8Array 那条转红**——`!new Uint8Array(0)`
// 是 false（对象恒 truthy），所以真值判据只挡得住 `''`、对零长字节完全失明。已实测。
// 这正是「两个编码面不能只挡一面」那条用例存在的理由：少了它，一个只挡字符串的判据会全绿通过。
// ---------------------------------------------------------------------------

const RUN_ID = 'empty-input-run'
const SESSION_ID = 'empty-input-agent'
const ACCEPTED_INPUT_BYTES = 512

function storedSession(): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: SESSION_ID,
    providerId: 'claude',
    executorId: 'claude',
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: RUN_ID },
    retiredRuns: [],
    hookBindingId: 'binding-empty-input'.padEnd(43, 'A'),
    hookToken: 'token-empty-input'.padEnd(43, 'B'),
    outputCursorBytes: 256,
    createdAt: 1,
    updatedAt: 10,
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-1' }
  }
}

/**
 * 一个活着、running 的 run。`acceptedInputBytes` 非 0 是故意的：空载荷回的游标必须是这个
 * **真实持久值**，而不是编造的 0。若这里写 0，「回了真实游标」与「回了字面量 0」两个世界不可
 * 区分，断言就成了恒真（期望值不能由被测对象算出）。
 */
function run(): CtxmuxAdapterRun {
  return {
    runId: RUN_ID,
    lifecycleOperationId: null,
    program: 'claude',
    args: [],
    workspacePath: '/repo',
    pid: 999,
    state: { type: 'running' },
    cols: 80,
    rows: 24,
    latestOutputBytes: 4_096,
    firstAvailableByte: 0,
    acceptedInputBytes: ACCEPTED_INPUT_BYTES
  }
}

type Internals = {
  registry: { load(hostId: string): Promise<void> }
  kernel: Record<string, unknown>
  connected: boolean
}

/** 记下 kernel.input 被喂了什么。空载荷的判据就是这张表**一条都没有**。 */
async function harness(): Promise<{
  client: AgentMuxClient
  sentToKernel: AgentMuxRunInputData[]
}> {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, storedSession())
  const client = new AgentMuxClient({ store })
  const internals = client as unknown as Internals
  await internals.registry.load('local')
  internals.connected = true
  internals.kernel.isConnected = () => true
  internals.kernel.status = async () => run()
  internals.kernel.identity = () => ({ daemonInstanceId: 'daemon-1' })
  const sentToKernel: AgentMuxRunInputData[] = []
  internals.kernel.input = async (
    _runId: string,
    operation: { data: AgentMuxRunInputData; expectedByte: number }
  ) => {
    // 真实 daemon 在这里拒绝空载荷。替身照抄那条校验，否则这个测试证不了「没下到 ctxmux」——
    // 一个什么都接受的替身会让删掉闸门之后照样绿。
    if (operation.data.length === 0) {
      throw new Error('recoverable native Input must not be empty')
    }
    sentToKernel.push(operation.data)
    const endByte = operation.expectedByte + operation.data.length
    return {
      run: { ...run(), acceptedInputBytes: endByte },
      appliedByteRange: { startByte: operation.expectedByte, endByte }
    }
  }
  return { client, sentToKernel }
}

describe('空载荷的终端输入不是故障', () => {
  it('IME 组字途中的空字符串：不抛，不下到 ctxmux，游标停在真实持久值', async () => {
    const { client, sentToKernel } = await harness()
    try {
      const ack = await client.writeAgent(SESSION_ID, '')
      expect(sentToKernel, '空载荷被送下去了——它会撞上 daemon 那条校验').toEqual([])
      expect(ack.acceptedThroughByte).toBe(ACCEPTED_INPUT_BYTES)
      // 没有字节被接受，所以区间是个真正的空区间（首尾同点），不是凭空推进了。
      expect(ack.appliedByteRange).toEqual({
        startByte: ACCEPTED_INPUT_BYTES,
        endByte: ACCEPTED_INPUT_BYTES
      })
      expect(ack.runId).toBe(RUN_ID)
    } finally {
      await client.dispose()
    }
  })

  it('旧式鼠标上报的零长字节：与空字符串同一结局（两个编码面不能只挡一面）', async () => {
    const { client, sentToKernel } = await harness()
    try {
      const ack = await client.writeAgent(SESSION_ID, new Uint8Array(0))
      expect(sentToKernel).toEqual([])
      expect(ack.acceptedThroughByte).toBe(ACCEPTED_INPUT_BYTES)
    } finally {
      await client.dispose()
    }
  })

  it('正向控制：非空输入照样下到 ctxmux 并推进游标（证明闸门没把所有输入都吃掉）', async () => {
    const { client, sentToKernel } = await harness()
    try {
      const ack = await client.writeAgent(SESSION_ID, 'ls\r')
      expect(sentToKernel).toEqual(['ls\r'])
      expect(ack.appliedByteRange).toEqual({
        startByte: ACCEPTED_INPUT_BYTES,
        endByte: ACCEPTED_INPUT_BYTES + 3
      })
      expect(ack.acceptedThroughByte).toBe(ACCEPTED_INPUT_BYTES + 3)
    } finally {
      await client.dispose()
    }
  })

  it("'0' 是合法输入，不是空——闸门判长度而不是判真值", async () => {
    const { client, sentToKernel } = await harness()
    try {
      await client.writeAgent(SESSION_ID, '0')
      expect(sentToKernel, "'0' 被闸门吃掉了——判据写成真值而不是长度").toEqual(['0'])
    } finally {
      await client.dispose()
    }
  })

  it('单个 NUL 字节发得出去：长度 1 的载荷不是空载荷', async () => {
    const { client, sentToKernel } = await harness()
    try {
      await client.writeAgent(SESSION_ID, new Uint8Array([0]))
      expect(sentToKernel).toEqual([new Uint8Array([0])])
    } finally {
      await client.dispose()
    }
  })
})
