import { describe, expect, it, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxClient } from '../src/client.js'
import {
  AgentMuxMemoryAgentSessionStore,
  type AgentMuxAgentSessionStore
} from '../src/agent-session-store.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import {
  AGENT_TERMINAL_HANDSHAKE_FAILED,
  AGENT_TERMINAL_HANDSHAKE_TIMEOUT,
  AGENT_TERMINAL_CAPABILITY_PERSIST_FAILED,
  classifyTerminalHandshakeFailure,
  degradedInputCursor
} from '../src/agent-terminal-handshake-outcome.js'

// ---------------------------------------------------------------------------
// f-23g8feb8c / T-002：握手探测超时不再杀掉一个健康的 Agent。
//
// 用户原话：「原则上不能因为我们的流程问题，让原本已经跑通的 Agent 受阻，这是绝对不允许的。」
// 判据是「Agent 还能干活吗」，不是「我们的检查过了吗」——所以承重断言落在分流这个纯函数上：
// 超时（Agent 活着）降级，run 退出（Agent 真没了）中止，数据损坏中止。
// ---------------------------------------------------------------------------

function handshakeError(code: string): AgentMuxError {
  return new AgentMuxError('fixture', code)
}

describe('握手失败分流：只有超时降级', () => {
  it('超时降级——Agent 还在跑，只是我们没等到它的能力查询', () => {
    const outcome = classifyTerminalHandshakeFailure(handshakeError(AGENT_TERMINAL_HANDSHAKE_TIMEOUT))
    expect(outcome).toEqual({
      kind: 'degrade',
      code: AGENT_TERMINAL_HANDSHAKE_TIMEOUT,
      reason: 'capability-query-timeout'
    })
  })

  it('run 退出时中止——那是第 1 类，Agent 真没了，阻断是诚实的', () => {
    // 这一条与上一条必须分开。把它折叠进降级，等于让上层以为还有一个能干活的 Agent。
    expect(classifyTerminalHandshakeFailure(handshakeError(AGENT_TERMINAL_HANDSHAKE_FAILED)))
      .toEqual({ kind: 'abort' })
  })

  it('状态非法与受据不匹配中止——数据损坏不是慢探测', () => {
    for (const code of [
      'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID',
      'AGENT_TERMINAL_HANDSHAKE_RECEIPT_MISMATCH',
      'STALE_AGENT_SESSION',
      'CTXMUX_INPUT_CURSOR_MISSING'
    ]) {
      expect(classifyTerminalHandshakeFailure(handshakeError(code))).toEqual({ kind: 'abort' })
    }
  })

  it('不认识的错误默认中止——把未知当成「大概还能跑」是原则明令禁止的', () => {
    // 默认必须是 abort：新增一个错误码时它自动落在中止这边，要放行得显式加进来。
    expect(classifyTerminalHandshakeFailure(handshakeError('SOME_FUTURE_CODE'))).toEqual({ kind: 'abort' })
    expect(classifyTerminalHandshakeFailure(new Error('not an AgentMuxError'))).toEqual({ kind: 'abort' })
    expect(classifyTerminalHandshakeFailure(undefined)).toEqual({ kind: 'abort' })
  })

  it('只认错误码，不认消息文本', () => {
    // 文案会改；用消息匹配会在某次改文案时静默失效，把超时错判成中止。
    expect(classifyTerminalHandshakeFailure(
      new AgentMuxError('Timed out waiting for the Provider terminal capability query.', 'OTHER_CODE')
    )).toEqual({ kind: 'abort' })
  })
})

describe('降级时的输入游标：用 daemon 的权威游标，取不到就不设', () => {
  it('拿到 daemon 游标就用它做首条 prompt 的栅栏起点', () => {
    expect(degradedInputCursor(4096)).toBe(4096)
    expect(degradedInputCursor(0)).toBe(0)
  })

  it('取不到时返回 undefined 而不是猜 0', () => {
    // 猜 0 会让首条 prompt 带着错误的 expectedByte 去撞栅栏——要么被拒，要么写到错误的位置。
    expect(degradedInputCursor(null)).toBeUndefined()
    expect(degradedInputCursor(undefined)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 四个调用点的接线。本仓没有能构造完整 AgentMuxClient 的测试装置（kernel/daemon 都是真的），
// 所以这一组是源码断言——但**剥掉注释再断言**：本轮已经踩过一次「标识符出现在注释里，删掉真代码
// 测试依然绿」的假绿，故这里断言的是注释无法提供的代码形状。
// ---------------------------------------------------------------------------
const clientSource = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
const clientCode = clientSource
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/u, ''))
  .join('\n')

describe('四个调用点都走降级包装', () => {
  it('剥注释后仍能看到被测代码——否则下面的断言在对空字符串取胜', () => {
    expect(clientCode).toContain('private async ensureTerminalHandshakeOrDegrade(')
    expect(clientCode.length).toBeGreaterThan(10_000)
  })

  it('三个生命周期调用点一个不落，且没有任何裸调用残留', () => {
    // Prompt submission deliberately does not call the handshake at all: a one-shot capability query
    // must never become a recurring ten-second gate for an otherwise live Run.
    const degradeCalls = clientCode.match(/this\.ensureTerminalHandshakeOrDegrade\(/gu) ?? []
    expect(degradeCalls).toHaveLength(3)
    // 裸调用只允许出现在降级包装自己的内部实现里，别处一处都不许有。
    const rawCalls = clientCode.match(/this\.ensureTerminalHandshake\(/gu) ?? []
    expect(rawCalls).toHaveLength(1)
    const wrapper = clientCode.slice(clientCode.indexOf('private async ensureTerminalHandshakeOrDegrade('))
    expect(wrapper.slice(0, wrapper.indexOf('\n  private async ensureTerminalHandshake(')))
      .toContain('await this.ensureTerminalHandshake(requestedSession, knownRun)')
  })

  it('connect 循环用降级包装——一个 session 的慢探测不许拆掉整条连接', () => {
    // 这是爆炸半径那一条：外层 catch 会 kernel.disconnect()，所以超时必须在循环内被吃掉。
    const loop = clientCode.slice(
      clientCode.indexOf('const handshakeErrors: unknown[] = []'),
      clientCode.indexOf('await this.recoverPendingInteractionResponses(runs)')
    )
    expect(loop).toContain('ensureTerminalHandshakeOrDegrade(session, run)')
    expect(loop).not.toContain('this.ensureTerminalHandshake(session, run)')
    expect(loop).toContain('Promise.all(this.registry.list().map(async (session)')
  })

  it('connect 时先校正当前 App 的 managed Hook 命令再恢复绑定', () => {
    const open = clientCode.slice(
      clientCode.indexOf('private async open('),
      clientCode.indexOf('  } catch (error) {', clientCode.indexOf('private async open('))
    )
    expect(open).toContain('await this.repairManagedHooks()')
    expect(open.indexOf('await this.repairManagedHooks()'))
      .toBeLessThan(open.indexOf('await this.tryRestoreHookIngress(runs)'))
    expect(clientCode).toContain('private async repairManagedHooks()')
  })

  it('submitAgentPrompt 不被握手拦住——降级后 prompt 照发', () => {
    const submit = clientCode.slice(
      clientCode.indexOf('async submitAgentPrompt('),
      clientCode.indexOf('const plan = this.providers.get(session.providerId).planPromptInput(outbound)')
    )
    expect(submit).toContain('this.requireAgentSession(input.agentSessionId)')
    expect(submit).not.toContain('ensureTerminalHandshake(')
  })
})

describe('降级不许静默，也不许伪造受据', () => {
  const wrapper = (() => {
    const start = clientCode.indexOf('private async ensureTerminalHandshakeOrDegrade(')
    // 切到**下一个方法签名**为止，而不是切到 ensureTerminalHandshake——两者之间还夹着
    // requireRunningTerminalHandshakeRun / persistTerminalCapabilityState / clearTerminalCapability
    // 三个 helper，其中 clearTerminalCapability 自己也 publish 一条 agent-session。把它们圈进来，
    // 「降级路径必定发出事件」就会被邻居的 publish 满足：删掉降级自己那一条依然绿。
    // 锚点必须落在**代码**上：这里的分隔注释是 /** */ 块，上面的 clientCode 已经把它剥掉了，
    // 拿注释文字当锚点会 indexOf 到 -1，slice(0, -1) 反而把整份源码圈回来。
    const body = clientCode.slice(start)
    const end = body.indexOf('  private async requireRunningTerminalHandshakeRun(')
    expect(end).toBeGreaterThan(0)
    return body.slice(0, end)
  })()

  it('降级路径必定发出一条事件——静默降级本身就是违例', () => {
    expect(wrapper).toContain('this.publisher.publish(')
    // The durable `agent-session` projection carries the visible degraded fact; an ordinary
    // `agent-error` would paint a healthy Agent as failed.
    expect(wrapper).toContain("type: 'agent-session'")
    // 不在这里断言 `terminalCapability` 那个字面量：它写在 persistTerminalCapabilityState 里，
    // 而这个切片刻意只圈降级函数本身。「降级事实真的被写进去了」由上面的行为测试断言
    // （它读回 store 里的 terminalCapability），比在源码里找一个标识符强得多。
  })

  it('中止那一类原样抛出，不被事件吞掉', () => {
    expect(wrapper).toContain("if (outcome.kind === 'abort') throw error")
  })

  it('降级时从 daemon 播种输入游标', () => {
    expect(wrapper).toContain('degradedInputCursor(run.acceptedInputBytes)')
    expect(wrapper).toContain('this.agentInputCursors.set(requestedSession.agentSessionId, cursor)')
  })

  it('绝不伪造已确认的握手：降级路径不写 terminalHandshake，也不写 acknowledged', () => {
    // 没送出 [?0u 却写 acknowledged: true 是在受据上撒谎，之后会撞上 acceptedInputBytes >= endByte
    // 的断言并污染崩溃恢复的幂等性。状态保持未设＝未知，而不是编一个。
    expect(wrapper).not.toContain('terminalHandshake:')
  })
})

function storedSession() {
  return {
    kind: 'agent' as const,
    agentSessionId: 'degrade-agent',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/tmp/degrade-agent',
    run: { runId: 'degrade-run' },
    retiredRuns: [],
    hookBindingId: 'binding',
    hookToken: 'token',
    outputCursorBytes: 0,
    createdAt: 100,
    updatedAt: 100
  }
}

/** A Store that fails only when the advisory degraded marker is written. The Session itself and its
 * lifecycle commit remain writable, which models a transient marker/lock failure without making the
 * fake Run disappear. */
class CapabilityMarkerFailingStore extends AgentMuxMemoryAgentSessionStore {
  override async compareAndSwap(
    expected: Parameters<AgentMuxAgentSessionStore['compareAndSwap']>[0],
    next: Parameters<AgentMuxAgentSessionStore['compareAndSwap']>[1],
    signal?: AbortSignal
  ): Promise<void> {
    if (next && 'terminalCapability' in next && next.terminalCapability) {
      throw new Error('fixture marker store is read-only')
    }
    await super.compareAndSwap(expected, next, signal)
  }
}

function runningRun(acceptedInputBytes: number | null = 37): CtxmuxAdapterRun {
  return {
    runId: 'degrade-run',
    lifecycleOperationId: null,
    program: 'codex',
    args: [],
    workspacePath: '/tmp/degrade-agent',
    pid: 123,
    state: { type: 'running' },
    cols: 80,
    rows: 24,
    latestOutputBytes: 0,
    firstAvailableByte: 0,
    acceptedInputBytes
  }
}

function sessionFor(agentSessionId: string, runId: string, workspacePath: string) {
  return {
    ...storedSession(),
    agentSessionId,
    workspacePath,
    run: { runId },
    hookBindingId: `binding-${agentSessionId}`,
    hookToken: `token-${agentSessionId}`
  }
}

function runFor(runId: string, workspacePath: string, acceptedInputBytes = 37): CtxmuxAdapterRun {
  return {
    ...runningRun(acceptedInputBytes),
    runId,
    workspacePath
  }
}

function capabilityQueryReplay(runId: string) {
  const query = '\u001b[?u'
  return [{
    type: 'data' as const,
    runId,
    startByte: 0,
    endByte: Buffer.byteLength(query),
    data: query,
    dataBytes: Uint8Array.from(Buffer.from(query))
  }]
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AgentMuxClient 握手超时行为（真实 registry/store 边界）', () => {
  it('public connect isolates one vanished Run and still connects the other Session', async () => {
    vi.useFakeTimers()
    const store = new AgentMuxMemoryAgentSessionStore()
    const failed = sessionFor('failed-agent', 'failed-run', '/tmp/failed-agent')
    const healthy = sessionFor('healthy-agent', 'healthy-run', '/tmp/healthy-agent')
    await store.compareAndSwap(null, failed)
    await store.compareAndSwap(null, healthy)

    const client = new AgentMuxClient({ store })
    const kernel = (client as unknown as { kernel: Record<string, unknown> }).kernel
    const failedRun = runFor('failed-run', '/tmp/failed-agent')
    const healthyRun = runFor('healthy-run', '/tmp/healthy-agent')
    const query = '\u001b[?u'
    const queryEvent = {
      type: 'data' as const,
      runId: healthyRun.runId,
      startByte: 0,
      endByte: Buffer.byteLength(query),
      data: query,
      dataBytes: Uint8Array.from(Buffer.from(query))
    }
    let connected = false
    const disconnect = vi.fn()
    kernel.connect = async () => { connected = true }
    kernel.isConnected = () => connected
    kernel.disconnect = disconnect
    kernel.list = async () => [failedRun, healthyRun]
    kernel.onEvent = () => () => {}
    kernel.onError = () => () => {}
    const attach = vi.fn(async (runId: string) => ({
      run: runId === failedRun.runId ? failedRun : healthyRun,
      replay: runId === healthyRun.runId ? [queryEvent] : [],
      gap: null
    }))
    kernel.attach = attach
    kernel.status = async (runId: string) => {
      if (runId === failedRun.runId) {
        throw new AgentMuxError(
          'fixture Run disappeared',
          'CTXMUX_run_not_found',
          'daemon no longer owns failed-run'
        )
      }
      return healthyRun
    }
    kernel.detach = async () => undefined
    kernel.identity = () => ({
      daemonInstanceId: 'daemon',
      protocolVersion: 1,
      buildIdentity: 'ctxmux@test'
    })
    kernel.input = async (_runId: string, operation: { expectedByte: number; data: string }) => ({
      run: { ...healthyRun, acceptedInputBytes: operation.expectedByte + Buffer.byteLength(operation.data) },
      appliedByteRange: {
        startByte: operation.expectedByte,
        endByte: operation.expectedByte + Buffer.byteLength(operation.data)
      }
    });
    // Keep this public-connect test focused on the per-Session handshake boundary. Hook restoration is
    // independently owned and would otherwise require a real listener/token fixture here.
    (client as unknown as { tryRestoreHookIngress: () => Promise<void> }).tryRestoreHookIngress = async () => {}
    ;(client as unknown as { repairManagedHooks: () => Promise<void> }).repairManagedHooks = async () => {}
    const events: Array<{
      type: string
      agentSessionId?: string
      code?: string
    }> = []
    client.onEvent((event) => {
      if (event.type === 'agent-error' || event.type === 'agent-session') {
        events.push(event.type === 'agent-error'
          ? { type: event.type, ...(event.agentSessionId ? { agentSessionId: event.agentSessionId } : {}), code: event.code }
          : { type: event.type, agentSessionId: event.session.agentSessionId })
      }
    })

    const connecting = client.connect()
    // Both probes must be armed before either ten-second timeout is allowed to complete. Under
    // the old serial loop the vanished first Run parked here and healthy-run attach was never
    // reached, so this assertion is the concurrency/connection-blast-radius guard.
    for (let i = 0; i < 40 && attach.mock.calls.length < 2; i += 1) await Promise.resolve()
    expect(attach.mock.calls.map(([runId]) => runId)).toEqual(['failed-run', 'healthy-run'])
    await vi.advanceTimersByTimeAsync(10_000)
    await connecting

    expect(disconnect).not.toHaveBeenCalled()
    expect(client.agentSessions()).toHaveLength(2)
    expect(events).toContainEqual({
      type: 'agent-error',
      agentSessionId: 'failed-agent',
      code: AGENT_TERMINAL_HANDSHAKE_FAILED
    })
    expect(client.agentSession('healthy-agent').terminalHandshake?.acknowledged).toBe(true)
    await client.dispose()
  })

  async function clientWithFakeKernel(
    status: () => CtxmuxAdapterRun,
    store: AgentMuxMemoryAgentSessionStore = new AgentMuxMemoryAgentSessionStore()
  ): Promise<{
    client: AgentMuxClient
    session: ReturnType<typeof storedSession>
  }> {
    const session = storedSession()
    await store.compareAndSwap(null, session)
    const client = new AgentMuxClient({ store })
    const registry = (client as unknown as { registry: { load(hostId: string): Promise<void> } }).registry
    await registry.load('local')
    const kernel = (client as unknown as { kernel: Record<string, unknown> }).kernel
    kernel.attach = async () => ({
      run: status(),
      replay: [],
      gap: null
    })
    kernel.status = async () => status()
    kernel.detach = async () => undefined
    kernel.identity = () => ({
      daemonInstanceId: 'daemon',
      protocolVersion: 1,
      buildIdentity: 'ctxmux@test'
    })
    return { client, session }
  }

  it('times out only the capability probe, persists unknown/degraded, and seeds the authoritative cursor', async () => {
    vi.useFakeTimers()
    const { client, session } = await clientWithFakeKernel(() => runningRun(37))
    const events: string[] = []
    client.onEvent((event) => {
      if (event.type === 'agent-session') events.push(event.session.agentSessionId)
    })
    const operation = (client as unknown as {
      ensureTerminalHandshakeOrDegrade(
        session: ReturnType<typeof storedSession>,
        run: CtxmuxAdapterRun
      ): Promise<unknown>
    }).ensureTerminalHandshakeOrDegrade(session, runningRun(37))
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await operation as ReturnType<AgentMuxClient['agentSession']>
    expect(result.terminalHandshake).toBeUndefined()
    expect(result.terminalCapability).toEqual({
      state: 'unknown',
      mode: 'degraded',
      reason: 'handshake-timeout',
      run: { runId: 'degrade-run' },
      observedAt: expect.any(Number)
    })
    expect((client as AgentMuxClient).agentSession('degrade-agent').terminalCapability).toEqual(result.terminalCapability)
    expect(events).toEqual(['degrade-agent'])
    await client.dispose()
  })

  it('keeps a healthy Run usable when the marker Store write fails, and emits an unscoped diagnostic', async () => {
    vi.useFakeTimers()
    const store = new CapabilityMarkerFailingStore()
    const { client, session } = await clientWithFakeKernel(() => runningRun(37), store)
    const events: Array<{
      type: string
      agentSessionId?: string
      code?: string
      session?: ReturnType<AgentMuxClient['agentSession']>
    }> = []
    client.onEvent((event) => {
      if (event.type === 'agent-error' || event.type === 'agent-session') {
        events.push(event.type === 'agent-error'
          ? { type: event.type, ...(event.agentSessionId ? { agentSessionId: event.agentSessionId } : {}), code: event.code }
          : { type: event.type, session: event.session })
      }
    })
    const operation = (client as unknown as {
      ensureTerminalHandshakeOrDegrade(
        session: ReturnType<typeof storedSession>,
        run: CtxmuxAdapterRun
      ): Promise<ReturnType<AgentMuxClient['agentSession']>>
    }).ensureTerminalHandshakeOrDegrade(session, runningRun(37))
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await operation

    // The lifecycle caller receives a usable Session with an explicitly ephemeral marker; no rollback
    // or Run retirement is allowed merely because the advisory projection could not be written.
    expect(result.run).toEqual({ runId: 'degrade-run' })
    expect(result.terminalCapability).toMatchObject({ state: 'unknown', mode: 'degraded' })
    expect(client.agentSession('degrade-agent').run).toEqual({ runId: 'degrade-run' })
    expect((await store.load()).map((value) => (value as ReturnType<typeof storedSession>).run.runId))
      .toEqual(['degrade-run'])

    // The diagnostic has no Session id, so the renderer cannot turn it into a false `status: error`;
    // the adjacent agent-session event is the scoped service-window fact.
    expect(events).toEqual([
      { type: 'agent-error', code: AGENT_TERMINAL_CAPABILITY_PERSIST_FAILED },
      expect.objectContaining({ type: 'agent-session' })
    ])
    await client.dispose()
  })

  it('does not degrade an exited Run discovered after the timeout', async () => {
    vi.useFakeTimers()
    let statusCalls = 0
    const { client, session } = await clientWithFakeKernel(() => {
      statusCalls += 1
      return statusCalls === 1
        ? runningRun(37)
        : { ...runningRun(37), state: { type: 'exited', code: 1, signal: null } }
    })
    const operation = (client as unknown as {
      ensureTerminalHandshakeOrDegrade(
        session: ReturnType<typeof storedSession>,
        run: CtxmuxAdapterRun
      ): Promise<unknown>
    }).ensureTerminalHandshakeOrDegrade(session, runningRun(37))
    // 先挂上 rejection 断言再推进假时钟。反过来的话，promise 在 advanceTimersByTimeAsync 里就已经
    // reject，而此刻还没有人订阅它，Node 会报一次 unhandled rejection——vitest 把它算作 error 并以
    // 退出码 1 收场，于是这个文件在测试全绿的情况下依然让 gate 变红。
    const rejected = expect(operation).rejects.toMatchObject({ code: AGENT_TERMINAL_HANDSHAKE_FAILED })
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    expect(client.agentSession('degrade-agent').terminalCapability).toBeUndefined()
    await client.dispose()
  })

  it('maps a Run that disappears during the timeout race to the handshake-failed contract', async () => {
    vi.useFakeTimers()
    const { client, session } = await clientWithFakeKernel(() => runningRun(37))
    const kernel = (client as unknown as { kernel: { status: () => Promise<never> } }).kernel
    const transportError = new AgentMuxError(
      'fixture run disappeared',
      'CTXMUX_run_not_found',
      'daemon said the run was already gone'
    )
    kernel.status = async () => {
      throw transportError
    }
    const operation = (client as unknown as {
      ensureTerminalHandshakeOrDegrade(
        session: ReturnType<typeof storedSession>,
        run: CtxmuxAdapterRun
      ): Promise<unknown>
    }).ensureTerminalHandshakeOrDegrade(session, runningRun(37))
    const rejected = operation.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10_000)
    const observed = await rejected
    expect(observed).toMatchObject({
      code: AGENT_TERMINAL_HANDSHAKE_FAILED,
      detail: 'daemon said the run was already gone'
    })
    expect(observed).toHaveProperty('cause', transportError)
    expect(client.agentSession('degrade-agent').terminalCapability).toBeUndefined()
    await client.dispose()
  })

  it('maps a vanished Run from attach/replay to the handshake-failed contract', async () => {
    const { client, session } = await clientWithFakeKernel(() => runningRun(37))
    const kernel = (client as unknown as { kernel: Record<string, unknown> }).kernel
    const transportError = new AgentMuxError(
      'fixture attach lost the Run',
      'CTXMUX_run_not_found',
      'attach no longer owns degrade-run'
    )
    kernel.attach = async () => { throw transportError }
    const operation = (client as unknown as {
      ensureTerminalHandshakeOrDegrade(
        session: ReturnType<typeof storedSession>,
        run: CtxmuxAdapterRun
      ): Promise<unknown>
    }).ensureTerminalHandshakeOrDegrade(session, runningRun(37))
    const observed = await operation.catch((error: unknown) => error)
    expect(observed).toMatchObject({
      code: AGENT_TERMINAL_HANDSHAKE_FAILED,
      detail: 'attach no longer owns degrade-run'
    })
    expect(observed).toHaveProperty('cause', transportError)
    await client.dispose()
  })

  it('maps a vanished Run from the post-replay status boundary to the handshake-failed contract', async () => {
    const { client, session } = await clientWithFakeKernel(() => runningRun(37))
    const kernel = (client as unknown as { kernel: Record<string, unknown> }).kernel
    const run = runningRun(37)
    const transportError = new AgentMuxError(
      'fixture boundary lost the Run',
      'CTXMUX_run_not_found',
      'boundary status no longer owns degrade-run'
    )
    kernel.attach = async () => ({ run, replay: capabilityQueryReplay(run.runId), gap: null })
    kernel.status = async () => { throw transportError }
    const operation = (client as unknown as {
      ensureTerminalHandshakeOrDegrade(
        session: ReturnType<typeof storedSession>,
        run: CtxmuxAdapterRun
      ): Promise<unknown>
    }).ensureTerminalHandshakeOrDegrade(session, run)
    const observed = await operation.catch((error: unknown) => error)
    expect(observed).toMatchObject({
      code: AGENT_TERMINAL_HANDSHAKE_FAILED,
      detail: 'boundary status no longer owns degrade-run'
    })
    expect(observed).toHaveProperty('cause', transportError)
    await client.dispose()
  })

  it('maps a vanished Run from the capability Input write to the handshake-failed contract', async () => {
    const { client, session } = await clientWithFakeKernel(() => runningRun(37))
    const kernel = (client as unknown as { kernel: Record<string, unknown> }).kernel
    const run = runningRun(37)
    const transportError = new AgentMuxError(
      'fixture input lost the Run',
      'CTXMUX_run_not_found',
      'input no longer owns degrade-run'
    )
    kernel.attach = async () => ({ run, replay: capabilityQueryReplay(run.runId), gap: null })
    kernel.status = async () => run
    kernel.input = async () => { throw transportError }
    const operation = (client as unknown as {
      ensureTerminalHandshakeOrDegrade(
        session: ReturnType<typeof storedSession>,
        run: CtxmuxAdapterRun
      ): Promise<unknown>
    }).ensureTerminalHandshakeOrDegrade(session, run)
    const observed = await operation.catch((error: unknown) => error)
    expect(observed).toMatchObject({
      code: AGENT_TERMINAL_HANDSHAKE_FAILED,
      detail: 'input no longer owns degrade-run'
    })
    expect(observed).toHaveProperty('cause', transportError)
    await client.dispose()
  })

  it('does not arm another ten-second wait after the degraded fact is durable', async () => {
    vi.useFakeTimers()
    const { client, session } = await clientWithFakeKernel(() => runningRun(37))
    const first = (client as unknown as {
      ensureTerminalHandshakeOrDegrade(
        session: ReturnType<typeof storedSession>,
        run: CtxmuxAdapterRun
      ): Promise<unknown>
    }).ensureTerminalHandshakeOrDegrade(session, runningRun(37))
    await vi.advanceTimersByTimeAsync(10_000)
    await first
    const second = (client as unknown as {
      ensureTerminalHandshakeOrDegrade(
        session: ReturnType<typeof storedSession>,
        run: CtxmuxAdapterRun
      ): Promise<unknown>
    }).ensureTerminalHandshakeOrDegrade(client.agentSession('degrade-agent') as ReturnType<typeof storedSession>, runningRun(37))
    await expect(second).resolves.toMatchObject({ terminalCapability: { state: 'unknown' } })
    // If the second call armed a timer, this would advance observable fake time without any reason.
    expect(vi.getTimerCount()).toBe(0)
    await client.dispose()
  })
})
