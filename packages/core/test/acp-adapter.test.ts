import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentMuxAcpBridge,
  type AgentMuxAcpBinding,
  type AgentMuxAcpBridgeCallbacks
} from '../src/acp-adapter.js'
import { agentTimelineMutationFromAcpEvent } from '../src/session-timeline.js'
import type {
  AgentMuxAcpEvent,
  AgentMuxPermissionDecision
} from '../src/types.js'

class FakeBinding implements AgentMuxAcpBinding {
  readonly responses: Array<{ requestId: string; decision: AgentMuxPermissionDecision }> = []
  closed = false
  private listener: ((event: AgentMuxAcpEvent) => void) | null = null

  constructor(
    readonly adapterId = 'fixture-acp',
    readonly sessionId = 'acp-session-1'
  ) {}

  onEvent(listener: (event: AgentMuxAcpEvent) => void): () => void {
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = null
    }
  }

  emit(event: AgentMuxAcpEvent): void {
    this.listener?.(event)
  }

  async respondPermission(
    requestId: string,
    decision: AgentMuxPermissionDecision,
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) throw signal.reason
    if (this.closed) throw new Error('ACP binding closed before its permission response')
    this.responses.push({ requestId, decision })
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

async function waitForResponse(binding: FakeBinding): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (binding.responses.length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('Timed out waiting for ACP permission response')
}

async function waitForResponses(binding: FakeBinding, count: number): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (binding.responses.length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`Timed out waiting for ${count} ACP permission responses`)
}

async function waitForClosed(binding: FakeBinding): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (binding.closed) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('Timed out waiting for ACP binding closure')
}

afterEach(() => {
  vi.useRealTimers()
})

function callbacks(
  overrides: Partial<AgentMuxAcpBridgeCallbacks> = {}
): AgentMuxAcpBridgeCallbacks {
  return {
    onEvent() {},
    onNativeHandle() {},
    onInteraction() {},
    onInteractionSettled() {},
    ...overrides
  }
}

describe('AgentMux ACP adapter boundary', () => {
  it('maps events to AgentMux evidence and rejects permission when no explicit answer exists', async () => {
    const events: unknown[] = []
    const handles: unknown[] = []
    const interactions: unknown[] = []
    const settled: unknown[] = []
    const bridge = new AgentMuxAcpBridge(callbacks({
      onEvent(agentSessionId, event, evidence) {
        events.push({ agentSessionId, event, evidence })
      },
      onNativeHandle(agentSessionId, handle) {
        handles.push({ agentSessionId, handle })
      },
      onInteraction(request) {
        interactions.push(request)
        bridge.respondPermission('semantic-acp', request.id, {
          outcome: 'selected', optionId: 'reject'
        })
      },
      onInteractionSettled(request) {
        settled.push(request)
      }
    }))
    const binding = new FakeBinding()
    await bridge.bind('semantic-acp', binding)
    binding.emit({
      type: 'permission',
      requestId: 'permission-1',
      title: 'Run tests',
      options: [
        { id: 'allow', label: 'Allow once', kind: 'allow-once' },
        { id: 'reject', label: 'Reject once', kind: 'reject-once' }
      ]
    })
    await waitForResponse(binding)

    expect(handles).toEqual([{
      agentSessionId: 'semantic-acp',
      handle: { kind: 'acp', adapterId: 'fixture-acp', sessionId: 'acp-session-1' }
    }])
    expect(events).toContainEqual(expect.objectContaining({
      agentSessionId: 'semantic-acp',
      evidence: expect.objectContaining({
        source: 'acp',
        acpAdapterId: 'fixture-acp',
        acpSessionId: 'acp-session-1'
      })
    }))
    expect(binding.responses).toEqual([{
      requestId: 'permission-1',
      decision: { outcome: 'selected', optionId: 'reject' }
    }])
    expect(interactions).toHaveLength(1)
    expect(settled).toHaveLength(1)
    await bridge.unbind('semantic-acp')
    expect(binding.closed).toBe(true)
  })

  it('forwards only an explicit valid permission selection', async () => {
    let bridge!: AgentMuxAcpBridge
    bridge = new AgentMuxAcpBridge(callbacks({
      onInteraction(request) {
        bridge.respondPermission('semantic-acp', request.id, {
          outcome: 'selected', optionId: 'allow'
        })
      }
    }))
    const binding = new FakeBinding()
    await bridge.bind('semantic-acp', binding)
    binding.emit({
      type: 'permission',
      requestId: 'permission-2',
      title: 'Read file',
      options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }]
    })
    await waitForResponse(binding)
    expect(binding.responses[0]?.decision).toEqual({ outcome: 'selected', optionId: 'allow' })
    await bridge.dispose()
  })

  it('acknowledges a typed response only after delivery and semantic settlement', async () => {
    let publishInteraction!: (request: Parameters<AgentMuxAcpBridgeCallbacks['onInteraction']>[0]) => void
    let releaseDelivery!: () => void
    const interaction = new Promise<Parameters<AgentMuxAcpBridgeCallbacks['onInteraction']>[0]>(
      (resolve) => { publishInteraction = resolve }
    )
    const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve })
    const settled: string[] = []
    const responses: string[] = []
    let emit!: (event: AgentMuxAcpEvent) => void
    const binding: AgentMuxAcpBinding = {
      adapterId: 'fixture-acp',
      sessionId: 'native-1',
      onEvent(listener) {
        emit = listener
        return () => {}
      },
      async respondPermission(requestId, _decision, signal) {
        await deliveryGate
        if (signal.aborted) throw signal.reason
        responses.push(requestId)
      },
      async close() {}
    }
    const bridge = new AgentMuxAcpBridge(callbacks({
      onInteraction(request) { publishInteraction(request) },
      onInteractionSettled(request) { settled.push(request.id) }
    }))
    await bridge.bind('semantic-acp', binding)
    emit({
      type: 'permission',
      requestId: 'permission-delivery-gate',
      title: 'Write file',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }]
    })
    const request = await interaction
    let acknowledged = false
    const response = bridge.respondPermission('semantic-acp', request.id, {
      outcome: 'selected', optionId: 'allow'
    }).then(() => { acknowledged = true })

    await Promise.resolve()
    expect(acknowledged).toBe(false)
    expect(responses).toEqual([])
    expect(settled).toEqual([])

    releaseDelivery()
    await response
    expect(responses).toEqual(['permission-delivery-gate'])
    expect(settled).toEqual(['permission-delivery-gate'])
    await bridge.dispose()
  })

  it('rejects the typed response when adapter delivery fails', async () => {
    let publishInteraction!: (request: Parameters<AgentMuxAcpBridgeCallbacks['onInteraction']>[0]) => void
    const interaction = new Promise<Parameters<AgentMuxAcpBridgeCallbacks['onInteraction']>[0]>(
      (resolve) => { publishInteraction = resolve }
    )
    let emit!: (event: AgentMuxAcpEvent) => void
    const binding: AgentMuxAcpBinding = {
      adapterId: 'fixture-acp',
      sessionId: 'native-1',
      onEvent(listener) {
        emit = listener
        return () => {}
      },
      async respondPermission() { throw new Error('adapter delivery failed') },
      async close() {}
    }
    const bridge = new AgentMuxAcpBridge(callbacks({
      onInteraction(request) { publishInteraction(request) }
    }))
    await bridge.bind('semantic-acp', binding)
    emit({
      type: 'permission',
      requestId: 'permission-delivery-failure',
      title: 'Write file',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }]
    })
    const request = await interaction

    await expect(bridge.respondPermission('semantic-acp', request.id, {
      outcome: 'selected', optionId: 'allow'
    })).rejects.toThrow('adapter delivery failed')
    await bridge.dispose()
  })

  it('aborts a hanging adapter delivery before rejecting the typed response', async () => {
    vi.useFakeTimers()
    let publishInteraction!: (request: Parameters<AgentMuxAcpBridgeCallbacks['onInteraction']>[0]) => void
    const interaction = new Promise<Parameters<AgentMuxAcpBridgeCallbacks['onInteraction']>[0]>(
      (resolve) => { publishInteraction = resolve }
    )
    let aborted = false
    let emit!: (event: AgentMuxAcpEvent) => void
    const binding: AgentMuxAcpBinding = {
      adapterId: 'fixture-acp',
      sessionId: 'native-1',
      onEvent(listener) {
        emit = listener
        return () => {}
      },
      async respondPermission(_requestId, _decision, signal) {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(signal.reason)
          }, { once: true })
        })
      },
      async close() {}
    }
    const bridge = new AgentMuxAcpBridge(callbacks({
      onInteraction(request) { publishInteraction(request) }
    }))
    await bridge.bind('semantic-acp', binding)
    emit({
      type: 'permission',
      requestId: 'permission-delivery-timeout',
      title: 'Write file',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }]
    })
    const request = await interaction
    const response = bridge.respondPermission('semantic-acp', request.id, {
      outcome: 'selected', optionId: 'allow'
    })
    const assertion = expect(response).rejects.toMatchObject({
      code: 'ACP_PERMISSION_RESPONSE_TIMEOUT'
    })

    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
    expect(aborted).toBe(true)
    await bridge.dispose()
  })

  it('rejects unknown and duplicate typed permission responses', async () => {
    let bridge!: AgentMuxAcpBridge
    const invalidErrors: unknown[] = []
    bridge = new AgentMuxAcpBridge(callbacks({
      onInteraction(request) {
        try {
          bridge.respondPermission('semantic-acp', request.id, {
            outcome: 'selected', optionId: 'not-offered'
          })
        } catch (error) {
          invalidErrors.push(error)
        }
        bridge.respondPermission('semantic-acp', request.id, { outcome: 'cancelled' })
        try {
          bridge.respondPermission('semantic-acp', request.id, { outcome: 'cancelled' })
        } catch (error) {
          invalidErrors.push(error)
        }
      }
    }))
    const binding = new FakeBinding()
    await bridge.bind('semantic-acp', binding)
    binding.emit({
      type: 'permission',
      requestId: 'permission-invalid',
      title: 'Run command',
      options: [{ id: 'reject', label: 'Reject', kind: 'reject-once' }]
    })
    await waitForResponse(binding)
    expect(binding.responses).toEqual([{
      requestId: 'permission-invalid', decision: { outcome: 'cancelled' }
    }])
    expect(invalidErrors).toHaveLength(2)
    await bridge.dispose()
  })

  it('rejects a permission handler that never produces an explicit answer', async () => {
    vi.useFakeTimers()
    const bridge = new AgentMuxAcpBridge(callbacks())
    const binding = new FakeBinding()
    await bridge.bind('semantic-acp', binding)
    binding.emit({
      type: 'permission',
      requestId: 'permission-timeout',
      title: 'Delete files',
      options: [{ id: 'reject', label: 'Reject', kind: 'reject-once' }]
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(binding.responses[0]?.decision).toEqual({ outcome: 'selected', optionId: 'reject' })
    await bridge.dispose()
  })

  it('drains a pending rejection and semantic settlement before closing the binding', async () => {
    let published!: () => void
    const interactionPublished = new Promise<void>((resolve) => { published = resolve })
    const settled: string[] = []
    const bridge = new AgentMuxAcpBridge(callbacks({
      onInteraction() { published() },
      onInteractionSettled(request) { settled.push(request.id) }
    }))
    const binding = new FakeBinding()
    await bridge.bind('semantic-acp', binding)
    binding.emit({
      type: 'permission',
      requestId: 'permission-during-dispose',
      title: 'Write file',
      options: [{ id: 'reject', label: 'Reject', kind: 'reject-once' }]
    })
    await interactionPublished

    await bridge.dispose()

    expect(binding.responses).toEqual([{
      requestId: 'permission-during-dispose',
      decision: { outcome: 'selected', optionId: 'reject' }
    }])
    expect(settled).toEqual(['permission-during-dispose'])
    expect(binding.closed).toBe(true)
  })

  it('fails closed and releases a binding that emits an oversized event', async () => {
    const bridge = new AgentMuxAcpBridge(callbacks())
    const binding = new FakeBinding()
    await bridge.bind('semantic-acp', binding)
    binding.emit({
      type: 'activity',
      operation: 'append',
      activityId: 'oversized-activity',
      kind: 'assistant_message',
      status: 'complete',
      title: 'oversized',
      content: 'x'.repeat(128 * 1024)
    })

    await waitForClosed(binding)
    expect(binding.closed).toBe(true)
    await bridge.dispose()
  })

  it('does not expose initialization events when binding persistence fails', async () => {
    const events: AgentMuxAcpEvent[] = []
    let unsubscribed = false
    let closed = false
    let handleAttempts = 0
    const binding: AgentMuxAcpBinding = {
      adapterId: 'fixture-acp',
      sessionId: 'initial-native-session',
      onEvent(listener) {
        listener({ type: 'native-session', sessionId: 'uncommitted-native-session' })
        listener({
          type: 'activity',
          operation: 'append',
          activityId: 'uncommitted-activity',
          kind: 'assistant_message',
          status: 'complete',
          title: 'Must stay private'
        })
        return () => { unsubscribed = true }
      },
      async respondPermission() {},
      async close() { closed = true }
    }
    const bridge = new AgentMuxAcpBridge(callbacks({
      onEvent(_agentSessionId, event) { events.push(event) },
      onNativeHandle() {
        handleAttempts += 1
        if (handleAttempts === 1) throw new Error('native handle persistence failed')
      }
    }))

    await expect(bridge.bind('semantic-acp', binding)).rejects.toThrow(
      'native handle persistence failed'
    )
    expect(events).toEqual([])
    expect(unsubscribed).toBe(true)
    expect(closed).toBe(true)

    const replacement = new FakeBinding()
    await expect(bridge.bind('semantic-acp', replacement)).resolves.toBeUndefined()
    await bridge.dispose()
  })

  it('rejects invalid synchronous initialization events before bind succeeds', async () => {
    let closed = false
    let persistedHandles = 0
    const binding: AgentMuxAcpBinding = {
      adapterId: 'fixture-acp',
      sessionId: 'native-1',
      onEvent(listener) {
        listener({
          type: 'activity',
          operation: 'update',
          activityId: 'assistant-1',
          contentDelta: 'legacy delta'
        } as unknown as AgentMuxAcpEvent)
        return () => {}
      },
      async respondPermission() {},
      async close() { closed = true }
    }
    const bridge = new AgentMuxAcpBridge(callbacks({
      onEvent(agentSessionId, event, evidence) {
        agentTimelineMutationFromAcpEvent(agentSessionId, event, evidence)
      },
      onNativeHandle() { persistedHandles += 1 }
    }))

    await expect(bridge.bind('semantic-acp', binding))
      .rejects.toMatchObject({ code: 'INVALID_AGENT_TIMELINE' })
    expect(closed).toBe(true)
    expect(persistedHandles).toBe(0)
  })

  it('persists a new native Session handle before delivering Activity in that scope', async () => {
    const order: string[] = []
    let releaseHandle!: () => void
    let newHandleStarted!: () => void
    const handleGate = new Promise<void>((resolve) => { releaseHandle = resolve })
    const handleStarted = new Promise<void>((resolve) => { newHandleStarted = resolve })
    const bridge = new AgentMuxAcpBridge(callbacks({
      onEvent(_agentSessionId, event, evidence) {
        if (event.type === 'activity') order.push(`activity:${evidence.acpSessionId}`)
      },
      async onNativeHandle(_agentSessionId, handle) {
        if (handle.sessionId === 'native-1') {
          order.push('handle:native-1')
          return
        }
        order.push('handle:native-2:start')
        newHandleStarted()
        await handleGate
        order.push('handle:native-2:done')
      }
    }))
    const binding = new FakeBinding('fixture-acp', 'native-1')
    await bridge.bind('semantic-acp', binding)

    binding.emit({ type: 'native-session', sessionId: 'native-2' })
    binding.emit({
      type: 'activity',
      operation: 'append',
      activityId: 'assistant-1',
      kind: 'assistant_message',
      status: 'complete',
      title: 'Scoped response'
    })
    await handleStarted
    expect(order).toEqual(['handle:native-1', 'handle:native-2:start'])
    releaseHandle()
    for (let index = 0; index < 100 && order.length < 4; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(order).toEqual([
      'handle:native-1',
      'handle:native-2:start',
      'handle:native-2:done',
      'activity:native-2'
    ])
    await bridge.dispose()
  })
})
