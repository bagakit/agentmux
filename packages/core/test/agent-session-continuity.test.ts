import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { decideAgentSessionContinuity } from '../src/agent-session-continuity.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type {
  CtxmuxAdapterDataEvent,
  CtxmuxAdapterObservationEvent,
  CtxmuxAdapterRun
} from '../src/ctxmux-run-adapter.js'
import type {
  AgentMuxAgentSession,
  AgentMuxClientEvent,
  AgentMuxRun,
  AgentMuxStoredAgentSession,
  AgentTerminalPromptDeliveryState
} from '../src/types.js'

const providers = new AgentProviderRegistry()

function session(providerId = 'codex'): AgentMuxAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'agent-1',
    providerId,
    executorId: providerId,
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: 'run-1' },
    retiredRuns: [],
    outputCursorBytes: 0,
    createdAt: 1,
    updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId, sessionId: 'native-1' }
  }
}

function run(state: AgentMuxRun['state'] = 'running'): AgentMuxRun {
  return {
    runId: 'run-1',
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    agentSessionId: 'agent-1',
    workspacePath: '/repo',
    pid: state === 'running' ? 42 : null,
    state,
    cols: 80,
    rows: 24,
    observedAt: 10,
    latestOutputBytes: 12,
    acceptedInputBytes: 0,
    ...(state === 'exited' ? { exitCode: 0 } : {}),
    ...(state === 'interrupted' ? { interruptionReason: 'daemon_restart' } : {})
  }
}

function facts(overrides: Partial<Parameters<typeof decideAgentSessionContinuity>[0]> = {}) {
  const current = session()
  const catalog = providers.get('codex').catalog
  return {
    agentSessionId: current.agentSessionId,
    hostId: current.hostId,
    expectedRun: current.run,
    observedAt: 10,
    session: current,
    retirement: null,
    run: run(),
    catalog,
    capability: {
      providerId: current.providerId,
      executable: 'codex',
      installed: true,
      capabilities: { ...catalog.capabilities }
    },
    ...overrides
  }
}

describe('Agent Session continuity decision', () => {
  it('keeps a matching live Run attach-only even when Provider resume is available', () => {
    expect(decideAgentSessionContinuity(facts())).toMatchObject({
      kind: 'reattachable',
      previousRun: { runId: 'run-1' },
      run: { runId: 'run-1', state: 'running' },
      evidence: { kind: 'run-running', observedAt: 10 }
    })
  })

  it.each(['exited', 'interrupted', null] as const)(
    'selects Provider-native resume for a trusted handle when the Run is %s',
    (state) => {
      const currentRun = state === null ? null : run(state)
      expect(decideAgentSessionContinuity(facts({ run: currentRun }))).toMatchObject({
        kind: 'resume',
        previousRun: { runId: 'run-1' },
        nativeHandle: { providerId: 'codex', sessionId: 'native-1' },
        evidence: state === null
          ? { kind: 'run-missing' }
          : { kind: 'run-ended', state }
      })
    }
  )

  it('returns explicit unavailability without a verified Provider handle', () => {
    const current = session()
    delete current.nativeHandle
    expect(decideAgentSessionContinuity(facts({ session: current, run: null }))).toMatchObject({
      kind: 'unavailable',
      reason: 'native-handle-unavailable',
      evidence: { kind: 'run-missing' }
    })
  })

  it('returns retired only from persisted retired Run truth', () => {
    expect(decideAgentSessionContinuity(facts({
      session: null,
      retirement: {
        agentSessionId: 'agent-1',
        hostId: 'local',
        run: { runId: 'run-1' },
        source: 'user',
        observedAt: 20
      },
      run: null,
      catalog: null,
      capability: null
    }))).toEqual({
      kind: 'retired',
      agentSessionId: 'agent-1',
      previousRun: { runId: 'run-1' },
      evidence: { kind: 'user-retired', observedAt: 20 }
    })
    expect(decideAgentSessionContinuity(facts({
      session: null,
      retirement: null,
      run: null,
      catalog: null,
      capability: null
    }))).toMatchObject({ kind: 'unavailable', reason: 'unknown-session' })
    for (const retirement of [
      {
        agentSessionId: 'another-agent',
        hostId: 'local',
        run: { runId: 'run-1' },
        source: 'user' as const,
        observedAt: 20
      },
      {
        agentSessionId: 'agent-1',
        hostId: 'another-host',
        run: { runId: 'run-1' },
        source: 'user' as const,
        observedAt: 20
      },
      {
        agentSessionId: 'agent-1',
        hostId: 'local',
        run: { runId: 'another-run' },
        source: 'user' as const,
        observedAt: 20
      }
    ]) {
      expect(decideAgentSessionContinuity(facts({
        session: null,
        retirement,
        run: null,
        catalog: null,
        capability: null
      }))).toMatchObject({ kind: 'unavailable', reason: 'unknown-session' })
    }
  })

  it('fails a stale exact Run fence as a typed conflict', () => {
    expect(decideAgentSessionContinuity(facts({ expectedRun: { runId: 'stale-run' } }))).toEqual({
      kind: 'conflict',
      agentSessionId: 'agent-1',
      previousRun: { runId: 'stale-run' },
      currentRun: { runId: 'run-1' },
      reason: 'session-run-changed',
      evidence: { kind: 'agent-session-store' }
    })
  })

  it('requires the Provider locator and a positive host capability', () => {
    const pi = session('pi')
    expect(decideAgentSessionContinuity(facts({
      session: pi,
      run: null,
      catalog: providers.get('pi').catalog,
      capability: null
    }))).toMatchObject({ kind: 'unavailable', reason: 'native-handle-unavailable' })
    expect(decideAgentSessionContinuity(facts({
      run: null,
      capability: {
        providerId: 'codex',
        executable: 'codex',
        installed: false,
        capabilities: { ...providers.get('codex').catalog.capabilities }
      }
    }))).toMatchObject({ kind: 'unavailable', reason: 'provider-unavailable' })
  })

  it('rejects Run and Provider facts that belong to another owner', () => {
    expect(decideAgentSessionContinuity(facts({
      run: { ...run(), runId: 'run-2' }
    }))).toMatchObject({ kind: 'conflict', reason: 'session-run-changed' })
    expect(decideAgentSessionContinuity(facts({
      run: { ...run(), agentSessionId: 'agent-2' }
    }))).toMatchObject({ kind: 'conflict', reason: 'session-run-changed' })
    expect(decideAgentSessionContinuity(facts({
      run: null,
      catalog: providers.get('pi').catalog
    }))).toMatchObject({ kind: 'unavailable', reason: 'provider-resume-unsupported' })
    expect(decideAgentSessionContinuity(facts({
      run: null,
      capability: {
        providerId: 'pi',
        executable: 'pi',
        installed: true,
        capabilities: { ...providers.get('pi').catalog.capabilities }
      }
    }))).toMatchObject({ kind: 'unavailable', reason: 'provider-unavailable' })
  })

  it('keeps a remote user-retirement visible after the Session record is removed', async () => {
    const store = new AgentMuxMemoryAgentSessionStore()
    const current = {
      ...session(),
      hostId: 'ssh-production',
      hookBindingId: 'binding-remote',
      hookToken: 'token-remote'
    }
    await store.compareAndSwap(null, current)

    const client = new AgentMuxClient({ store })
    const registry = (client as unknown as {
      registry: {
        load(hostId: string): Promise<void>
        reserveExisting(
          kind: 'stop',
          agentSessionId: string,
          expectedRun: { runId: string },
          operationId: string,
          stopOperation: { daemonInstance: string; operationKey: string; runId: string }
        ): Promise<unknown>
        commitLifecycle(reservation: unknown, next: null): Promise<void>
      }
    }).registry
    await registry.load('ssh-production')
    const reservation = await registry.reserveExisting(
      'stop',
      current.agentSessionId,
      current.run,
      'retire-remote-agent',
      {
        daemonInstance: 'daemon-remote',
        operationKey: 'retire-remote-agent',
        runId: current.run.runId
      }
    )
    await registry.commitLifecycle(reservation, null)

    const kernel = (client as unknown as {
      kernel: { isConnected(): boolean }
      connected: boolean
    })
    kernel.kernel.isConnected = () => true
    kernel.connected = true

    await expect(client.ensureAgentContinuity({
      agentSessionId: current.agentSessionId,
      expectedRun: current.run,
      operationId: 'recover-remote-agent'
    })).resolves.toMatchObject({
      kind: 'retired',
      agentSessionId: current.agentSessionId,
      previousRun: current.run,
      evidence: { kind: 'user-retired' }
    })
    await client.dispose()
  })
})

// ---------------------------------------------------------------------------
// f-23q8faabh / T-001：屏幕验证失败时服务窗降级，不挡健康 Agent 的提交。
//
// 走到渲染验证这一步时 payload 的 CtxMux 受据已经确认、Run 的输入通道是好的；replay 被截断
// （OUTPUT_GAP）或渲染确认超时只说明**我们的证据链**没走通——原则 11 的第 2 类。这一类绝不
// 阻断 `\r`，但也绝不静默：降级事实要持久、要广播。Run 真没了或 payload 根本没被接受仍然
// fail-closed——那是第 1 类，阻断是诚实的。
// ---------------------------------------------------------------------------

function promptStoredSession(): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'prompt-agent',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/tmp/prompt-agent',
    run: { runId: 'prompt-run' },
    retiredRuns: [],
    hookBindingId: 'binding-prompt',
    hookToken: 'token-prompt',
    outputCursorBytes: 0,
    createdAt: 100,
    updatedAt: 100,
    terminalPromptReadiness: {
      source: 'native-stop',
      id: 'readiness-1',
      run: { runId: 'prompt-run' },
      outputCursorBytes: 0,
      readyThroughByte: 0
    }
  }
}

function promptRun(
  state: CtxmuxAdapterRun['state'] = { type: 'running' }
): CtxmuxAdapterRun {
  return {
    runId: 'prompt-run',
    lifecycleOperationId: null,
    program: 'codex',
    args: [],
    workspacePath: '/tmp/prompt-agent',
    pid: 321,
    state,
    cols: 80,
    rows: 24,
    latestOutputBytes: 0,
    firstAvailableByte: 0,
    acceptedInputBytes: 0
  }
}

type PromptObservation = {
  run: CtxmuxAdapterRun
  replay: CtxmuxAdapterDataEvent[]
  gap: { requestedAfterByte: number; firstAvailableByte: number } | null
  close(): Promise<void>
}

/** replay 被 CtxMux 截断：观察一开始就带 gap。 */
function truncatedReplayObservation(): PromptObservation {
  return {
    run: promptRun(),
    replay: [],
    gap: { requestedAfterByte: 0, firstAvailableByte: 4096 },
    close: async () => {}
  }
}

/** 完整的屏幕证据：replay 里 composer 已经渲染出提交的内容。 */
function renderedComposerObservation(content: string): PromptObservation {
  const data = `› ${content}`
  const dataBytes = Uint8Array.from(Buffer.from(data))
  return {
    run: promptRun(),
    replay: [{
      type: 'data',
      runId: 'prompt-run',
      startByte: 0,
      endByte: dataBytes.byteLength,
      data,
      dataBytes
    }],
    gap: null,
    close: async () => {}
  }
}

/** 无 gap、但 composer 永远不出现——用来触发渲染确认超时。 */
function silentObservation(): PromptObservation {
  return {
    run: promptRun(),
    replay: [],
    gap: null,
    close: async () => {}
  }
}

class CountingMemoryAgentSessionStore extends AgentMuxMemoryAgentSessionStore {
  casWrites = 0

  override async compareAndSwap(
    expected: AgentMuxStoredAgentSession | null,
    next: AgentMuxStoredAgentSession | null,
    signal?: AbortSignal
  ): Promise<void> {
    this.casWrites += 1
    await super.compareAndSwap(expected, next, signal)
  }
}

async function promptClient(options: {
  stored?: AgentMuxStoredAgentSession
  observeOutput?: (
    listener: (event: CtxmuxAdapterObservationEvent) => void
  ) => PromptObservation
  status?: () => CtxmuxAdapterRun
  input?: 'accept' | 'reject'
}): Promise<{
  client: AgentMuxClient
  store: CountingMemoryAgentSessionStore
  inputs: string[]
  events: AgentMuxClientEvent[]
  observeCalls: () => number
  casWrites: () => number
}> {
  const store = new CountingMemoryAgentSessionStore()
  await store.compareAndSwap(null, options.stored ?? promptStoredSession())
  const client = new AgentMuxClient({ store })
  const internals = client as unknown as {
    registry: { load(hostId: string): Promise<void> }
    kernel: Record<string, unknown>
    connected: boolean
  }
  await internals.registry.load('local')
  internals.connected = true
  const inputs: string[] = []
  let observeCalls = 0
  let acceptedInputBytes = 0
  // ctxmux Input 按 operationId 幂等：重放同一操作拿回原始回执，不重复写字节。
  const inputReceipts = new Map<string, { startByte: number; endByte: number }>()
  const kernel = internals.kernel
  kernel.isConnected = () => true
  kernel.identity = () => ({
    daemonInstanceId: 'daemon',
    protocolVersion: 1,
    buildIdentity: 'ctxmux@test'
  })
  kernel.status = options.status ?? (async () => promptRun())
  kernel.input = async (
    _runId: string,
    operation: { operationId: string; expectedByte: number; data: string }
  ) => {
    if (options.input === 'reject') {
      throw new Error('fixture daemon rejected the Input write')
    }
    let receipt = inputReceipts.get(operation.operationId)
    if (!receipt) {
      inputs.push(operation.data)
      receipt = {
        startByte: operation.expectedByte,
        endByte: operation.expectedByte + Buffer.byteLength(operation.data)
      }
      inputReceipts.set(operation.operationId, receipt)
      acceptedInputBytes = Math.max(acceptedInputBytes, receipt.endByte)
    }
    return {
      run: { ...promptRun(), acceptedInputBytes },
      appliedByteRange: { ...receipt }
    }
  }
  kernel.observeOutput = async (
    _runId: string,
    _afterByte: number,
    listener: (event: CtxmuxAdapterObservationEvent) => void
  ) => {
    observeCalls += 1
    if (!options.observeOutput) throw new Error('fixture did not expect a screen observation')
    return options.observeOutput(listener)
  }
  const events: AgentMuxClientEvent[] = []
  client.onEvent((event) => events.push(event))
  return {
    client,
    store,
    inputs,
    events,
    observeCalls: () => observeCalls,
    casWrites: () => store.casWrites
  }
}

function deliveryMarkers(events: AgentMuxClientEvent[]): AgentTerminalPromptDeliveryState[] {
  return events.flatMap((event) => (
    event.type === 'agent-session' && event.session.terminalPromptDelivery
      ? [event.session.terminalPromptDelivery]
      : []
  ))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('prompt 屏幕验证失败的服务窗降级（payload 已受据、Run 存活）', () => {
  it('replay 截断（OUTPUT_GAP）：提交键照发，降级事实持久且被广播', async () => {
    const { client, store, inputs, events } = await promptClient({
      observeOutput: truncatedReplayObservation
    })

    // 恢复成「验证失败即抛错」的旧行为时，这里第一个变红：提交被我们自己的证据链挡住了。
    await expect(client.submitAgentPrompt({
      agentSessionId: 'prompt-agent',
      operationId: 'op-gap',
      prompt: 'hello'
    })).resolves.toBeUndefined()
    expect(inputs).toHaveLength(2)
    expect(inputs.at(-1)).toBe('\r')

    // 降级绝不静默：删掉降级告示（持久化或广播任意一半）时，下面这些断言变红。
    const expected = {
      state: 'unverified',
      mode: 'degraded',
      reason: 'screen-evidence-gap',
      submissionId: expect.any(String),
      run: { runId: 'prompt-run' },
      observedAt: expect.any(Number)
    }
    expect(client.agentSession('prompt-agent').terminalPromptDelivery).toEqual(expected)
    const persisted = (await store.load()).find(
      (value) => (value as AgentMuxStoredAgentSession).agentSessionId === 'prompt-agent'
    ) as AgentMuxStoredAgentSession
    expect(persisted.terminalPromptDelivery).toEqual(expected)
    expect(deliveryMarkers(events)).toEqual([expected])
    await client.dispose()
  })

  it('渲染确认超时：提交键照发，降级原因是 prompt-render-timeout', async () => {
    vi.useFakeTimers()
    const { client, inputs, events } = await promptClient({
      observeOutput: silentObservation
    })
    const submitting = client.submitAgentPrompt({
      agentSessionId: 'prompt-agent',
      operationId: 'op-timeout',
      prompt: 'hello'
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(submitting).resolves.toBeUndefined()
    expect(inputs.at(-1)).toBe('\r')
    expect(client.agentSession('prompt-agent').terminalPromptDelivery).toMatchObject({
      state: 'unverified',
      mode: 'degraded',
      reason: 'prompt-render-timeout'
    })
    expect(deliveryMarkers(events)).toHaveLength(1)
    await client.dispose()
  })

  it('Run 已退出：仍 fail-closed，不发提交键也不立降级告示', async () => {
    let statusCalls = 0
    const { client, inputs, events } = await promptClient({
      observeOutput: truncatedReplayObservation,
      status: () => {
        statusCalls += 1
        return statusCalls === 1
          ? promptRun()
          : promptRun({ type: 'exited', code: 1, signal: null })
      }
    })
    await expect(client.submitAgentPrompt({
      agentSessionId: 'prompt-agent',
      operationId: 'op-exited',
      prompt: 'hello'
    })).rejects.toMatchObject({ code: 'OUTPUT_GAP' })
    // payload 已受据（第一笔 Input），但提交键绝不能对一个已退出的 Run 伪装成交付。
    expect(inputs).toHaveLength(1)
    expect(inputs.at(-1)).not.toBe('\r')
    expect(client.agentSession('prompt-agent').terminalPromptDelivery).toBeUndefined()
    expect(deliveryMarkers(events)).toEqual([])
    await client.dispose()
  })

  it('payload 未被接受：仍 fail-closed，从不进入降级路径', async () => {
    const { client, inputs, events, observeCalls } = await promptClient({
      input: 'reject'
    })
    await expect(client.submitAgentPrompt({
      agentSessionId: 'prompt-agent',
      operationId: 'op-rejected',
      prompt: 'hello'
    })).rejects.toThrow('fixture daemon rejected the Input write')
    expect(inputs).toEqual([])
    expect(observeCalls()).toBe(0)
    expect(client.agentSession('prompt-agent').terminalPromptDelivery).toBeUndefined()
    expect(deliveryMarkers(events)).toEqual([])
    await client.dispose()
  })

  it('恢复路径：下一次完整验证成功的交付撤下服务窗告示', async () => {
    const degraded: AgentTerminalPromptDeliveryState = {
      state: 'unverified',
      mode: 'degraded',
      reason: 'screen-evidence-gap',
      submissionId: 'earlier-submission',
      run: { runId: 'prompt-run' },
      observedAt: 90
    }
    const { client, store, inputs } = await promptClient({
      stored: { ...promptStoredSession(), terminalPromptDelivery: degraded },
      observeOutput: () => renderedComposerObservation('hello')
    })
    // 告示必须先在 store 往返里活下来——normalizer 把它丢掉的话，这里就红了。
    expect(client.agentSession('prompt-agent').terminalPromptDelivery).toEqual(degraded)

    await expect(client.submitAgentPrompt({
      agentSessionId: 'prompt-agent',
      operationId: 'op-verified',
      prompt: 'hello'
    })).resolves.toBeUndefined()
    expect(inputs.at(-1)).toBe('\r')
    expect(client.agentSession('prompt-agent').terminalPromptDelivery).toBeUndefined()
    const persisted = (await store.load()).find(
      (value) => (value as AgentMuxStoredAgentSession).agentSessionId === 'prompt-agent'
    ) as AgentMuxStoredAgentSession
    expect(persisted.terminalPromptDelivery).toBeUndefined()
    await client.dispose()
  })
})

// ---------------------------------------------------------------------------
// f-23q8faabh / T-003：高频受据合并。payload 受据不再单独整写一次 CAS JSON，随 submit 受据
// 一次落盘；崩溃窗口内丢失的受据从 ctxmux 的幂等 Input 回执重推。
// ---------------------------------------------------------------------------

describe('prompt 受据合并与崩溃恢复', () => {
  it('一次验证成功的提交只整写两次 CAS：claim 一次、payload+submit 受据合并一次', async () => {
    const { client, store, inputs, casWrites } = await promptClient({
      observeOutput: () => renderedComposerObservation('hello')
    })
    const baseline = casWrites()
    await expect(client.submitAgentPrompt({
      agentSessionId: 'prompt-agent',
      operationId: 'op-coalesced',
      prompt: 'hello'
    })).resolves.toBeUndefined()
    expect(inputs.at(-1)).toBe('\r')
    // 改前基线是 3 次（claim、payload 受据、submit 受据各一次整写）；恢复逐相持久化时这里变红。
    expect(casWrites() - baseline).toBe(2)
    const persisted = (await store.load()).find(
      (value) => (value as AgentMuxStoredAgentSession).agentSessionId === 'prompt-agent'
    ) as AgentMuxStoredAgentSession
    expect(persisted.terminalPromptSubmission?.payload.acknowledged).toBe(true)
    expect(persisted.terminalPromptSubmission?.submit.acknowledged).toBe(true)
    await client.dispose()
  })

  it('崩溃窗口：payload 受据未落盘也能从 ctxmux 幂等回执重推，重试不重复写字节', async () => {
    let attempt = 0
    const { client, store, inputs } = await promptClient({
      observeOutput: (listener) => {
        attempt += 1
        if (attempt === 1) {
          // 第一次交付在渲染确认前被打断（观察通道崩溃）：payload 已被 ctxmux 接受，
          // 但合并后的受据还没落盘——这就是允许丢失的高频字段。
          queueMicrotask(() => listener({
            type: 'error',
            runId: 'prompt-run',
            error: new AgentMuxError('observation collapsed', 'OBSERVATION_FAILED')
          }))
          return silentObservation()
        }
        return renderedComposerObservation('hello')
      }
    })
    await expect(client.submitAgentPrompt({
      agentSessionId: 'prompt-agent',
      operationId: 'op-recover',
      prompt: 'hello'
    })).rejects.toThrow('observation collapsed')
    expect(inputs).toHaveLength(1)
    expect(inputs.at(-1)).not.toBe('\r')
    const midway = (await store.load()).find(
      (value) => (value as AgentMuxStoredAgentSession).agentSessionId === 'prompt-agent'
    ) as AgentMuxStoredAgentSession
    expect(midway.terminalPromptSubmission?.payload.acknowledged).toBe(false)

    // 同一 operationId 重试：payload 重放拿到幂等回执（字节不重复写），交付走完并一次性落盘受据。
    await expect(client.submitAgentPrompt({
      agentSessionId: 'prompt-agent',
      operationId: 'op-recover',
      prompt: 'hello'
    })).resolves.toBeUndefined()
    expect(inputs).toHaveLength(2)
    expect(inputs.at(-1)).toBe('\r')
    const persisted = (await store.load()).find(
      (value) => (value as AgentMuxStoredAgentSession).agentSessionId === 'prompt-agent'
    ) as AgentMuxStoredAgentSession
    expect(persisted.terminalPromptSubmission?.payload.acknowledged).toBe(true)
    expect(persisted.terminalPromptSubmission?.submit.acknowledged).toBe(true)
    await client.dispose()
  })
})
