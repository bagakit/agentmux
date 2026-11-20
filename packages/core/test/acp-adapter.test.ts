import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentMuxAcpBridge,
  type AgentMuxAcpBinding,
  type AgentMuxAcpBridgeCallbacks
} from '../src/acp-adapter.js'
import { agentTimelineMutationFromAcpEvent } from '../src/session-timeline.js'
import type {
  AgentMuxAcpEvent,
  AgentMuxPermissionDecision,
  AgentMuxPermissionRequest
} from '../src/types.js'

function respondPermission(bridge: AgentMuxAcpBridge, request: AgentMuxPermissionRequest, decision: AgentMuxPermissionDecision) {
  return bridge.preparePermissionResponse(request, decision)()
}

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
    onError() {},
    ...overrides
  }
}

describe('AgentMux ACP adapter boundary', () => {
  it('a failed old initialization cannot remove the replacement binding', async () => {
    let started!: () => void, release!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const requests: Array<Parameters<AgentMuxAcpBridgeCallbacks['onInteraction']>[0]> = []
    const bridge = new AgentMuxAcpBridge(callbacks({
      async onNativeHandle(_sid, handle, _evidence, signal) {
        if (handle.sessionId === 'old-native') { started(); await gate; signal.throwIfAborted() }
      }, onInteraction(request) { requests.push(request) }
    }))
    const old = new FakeBinding('same-adapter', 'old-native')
    const replacement = new FakeBinding('same-adapter', 'new-native')
    const initializing = bridge.bind('semantic-acp', old)
    const rejected = expect(initializing).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
    await waiting
    await bridge.unbind('semantic-acp')
    await bridge.bind('semantic-acp', replacement)
    release()
    await rejected
    replacement.emit({ type: 'permission', requestId: 'replacement-request', title: 'Replacement',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }] })
    await vi.waitFor(() => expect(requests, 'old cleanup must retain the healthy replacement binding').toHaveLength(1))
    await respondPermission(bridge, requests[0]!, { outcome: 'selected', optionId: 'allow' })
    expect(replacement.responses).toEqual([{ requestId: 'replacement-request', decision: { outcome: 'selected', optionId: 'allow' } }])
    await bridge.dispose()
  })

  it('maps events to AgentMux evidence and delivers the explicit denial', async () => {
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
        respondPermission(bridge, request, {
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
        respondPermission(bridge, request, {
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
    const response = respondPermission(bridge, request, {
      outcome: 'selected', optionId: 'allow'
    }).then(() => { acknowledged = true })

    await Promise.resolve()
    expect(acknowledged).toBe(false)
    expect(responses).toEqual([])
    expect(settled).toEqual([])

    releaseDelivery()
    await response
    expect(responses).toEqual(['permission-delivery-gate'])
    expect(settled).toEqual([request.id])
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

    await expect(respondPermission(bridge, request, {
      outcome: 'selected', optionId: 'allow'
    })).rejects.toThrow('adapter delivery failed')
    await bridge.dispose()
  })

  it('keeps a slow delivery until the original binding is explicitly closed', async () => {
    vi.useFakeTimers()
    let emit!: (event: AgentMuxAcpEvent) => void
    let aborted = false
    const published = vi.fn(), errors = vi.fn()
    const binding: AgentMuxAcpBinding = {
      adapterId: 'fixture-acp', sessionId: 'native-1',
      onEvent(listener) { emit = listener; return () => {} },
      async respondPermission(_id, _decision, signal) {
        await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => {
          aborted = true; reject(signal.reason)
        }, { once: true }))
      }, async close() {}
    }
    const bridge = new AgentMuxAcpBridge(callbacks({ onInteraction: published, onError: errors }))
    await bridge.bind('semantic-acp', binding)
    emit({ type: 'permission', requestId: 'slow', title: 'Write', options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }] })
    await vi.waitFor(() => expect(published).toHaveBeenCalledOnce())
    const response = respondPermission(bridge, published.mock.calls[0]![0], { outcome: 'selected', optionId: 'allow' })
    const assertion = expect(response).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(aborted).toBe(false)
    expect(errors).not.toHaveBeenCalled()
    expect(bridge.hasPendingPermission(published.mock.calls[0]![0])).toBe(true)
    await bridge.dispose()
    await assertion
    expect(aborted).toBe(true)
  })

  it('rejects unknown and duplicate typed permission responses', async () => {
    let bridge!: AgentMuxAcpBridge
    const invalidErrors: unknown[] = []
    bridge = new AgentMuxAcpBridge(callbacks({
      onInteraction(request) {
        try {
          respondPermission(bridge, request, {
            outcome: 'selected', optionId: 'not-offered'
          })
        } catch (error) {
          invalidErrors.push(error)
        }
        respondPermission(bridge, request, { outcome: 'cancelled' })
        try {
          respondPermission(bridge, request, { outcome: 'cancelled' })
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

  it.each(['reject-once', 'reject-always'] as const)('keeps an unanswered %s request without selecting any option', async kind => {
    vi.useFakeTimers()
    const published = vi.fn(), settled = vi.fn(), events = vi.fn()
    const bridge = new AgentMuxAcpBridge(callbacks({ onInteraction: published, onInteractionSettled: settled, onEvent: events }))
    const binding = new FakeBinding()
    await bridge.bind('semantic-acp', binding)
    binding.emit({ type: 'permission', requestId: 'unanswered', title: 'Delete', options: [{ id: 'deny', label: 'Deny', kind }] })
    await vi.waitFor(() => expect(published).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(120_000)
    expect(binding.responses, 'unanswered permission must not manufacture a decision').toEqual([])
    expect(settled).not.toHaveBeenCalled()
    expect(bridge.hasPendingPermission(published.mock.calls[0]![0])).toBe(true)
    binding.emit({ type: 'status', state: 'working' })
    await vi.waitFor(() => expect(events).toHaveBeenCalledTimes(2))
    await respondPermission(bridge, published.mock.calls[0]![0], { outcome: 'selected', optionId: 'deny' })
    expect(binding.responses).toEqual([{ requestId: 'unanswered', decision: { outcome: 'selected', optionId: 'deny' } }])
    await bridge.dispose()
  })

  it('cancels an unanswered request without selecting a denial when its exact binding closes', async () => {
    let published!: () => void
    const interactionPublished = new Promise<void>((resolve) => { published = resolve })
    const settled: string[] = []
    let originalRequestId = ''
    const bridge = new AgentMuxAcpBridge(callbacks({
      onInteraction(request) { originalRequestId = request.id; published() },
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
      decision: { outcome: 'cancelled' }
    }])
    expect(settled).toEqual([originalRequestId])
    expect(binding.closed).toBe(true)
  })

  it('retains two permission requests in order while status observations continue', async () => {
    const interactions: AgentMuxPermissionRequest[] = [], statuses: string[] = [], errors = vi.fn()
    const bridge = new AgentMuxAcpBridge(callbacks({ onError: errors,
      onInteraction(request) { interactions.push(request) },
      onEvent(_sid, event) { if (event.type === 'status') statuses.push(event.state) } }))
    const binding = new FakeBinding()
    await bridge.bind('semantic-acp', binding)
    for (const requestId of ['first', 'second']) binding.emit({ type: 'permission', requestId,
      title: requestId, options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }] })
    binding.emit({ type: 'status', state: 'working' })
    await vi.waitFor(() => expect(statuses).toEqual(['working']))
    expect(interactions).toHaveLength(1)
    expect(binding.responses).toEqual([])
    await respondPermission(bridge, interactions[0]!, { outcome: 'selected', optionId: 'allow' })
    await vi.waitFor(() => expect(interactions).toHaveLength(2))
    await respondPermission(bridge, interactions[1]!, { outcome: 'selected', optionId: 'allow' })
    expect(binding.responses.map(value => value.requestId)).toEqual(['first', 'second'])
    expect(errors).not.toHaveBeenCalled()
    await bridge.dispose()
  })

  it('keeps a failed permission handler recoverable by an explicit response without synthesizing a denial', async () => {
    const errors = vi.fn(), events = vi.fn(), settled = vi.fn()
    let attempts = 0
    const requests: Array<Parameters<AgentMuxAcpBridgeCallbacks['onInteraction']>[0]> = []
    const bridge = new AgentMuxAcpBridge(callbacks({ onEvent: events, onError: errors, onInteractionSettled: settled,
      onInteraction(request) { requests.push(request); if (++attempts < 3) throw new Error('Original publication failed') } }))
    const binding = new FakeBinding()
    await bridge.bind('semantic-acp', binding)
    binding.emit({ type: 'permission', requestId: 'handler-failure', title: 'Original request',
      options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }, { id: 'deny', label: 'Reject always', kind: 'reject-always' }] })
    await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce())
    const original = requests[0]!
    expect(binding.responses).toEqual([])
    expect(binding.closed).toBe(false)
    expect(bridge.hasPendingPermission(original)).toBe(true)
    binding.emit({ type: 'status', state: 'working' })
    await vi.waitFor(() => expect(events).toHaveBeenCalledTimes(2))
    const decision = { outcome: 'selected' as const, optionId: 'allow' }
    const failed = await Promise.allSettled([Promise.resolve().then(() => respondPermission(bridge, original, decision))])
    expect(failed[0]!.status, 'an unpublished request must not dispatch an explicit choice').toBe('rejected')
    if (failed[0]!.status === 'rejected') expect(failed[0]!.reason).toMatchObject({ message: 'Original publication failed' })
    expect(binding.responses, 'failed publication must not dispatch or consume the explicit response').toEqual([])
    expect(bridge.hasPendingPermission(original)).toBe(true)
    const result = await Promise.allSettled([Promise.resolve().then(() => respondPermission(bridge, original, decision))])
    expect(result[0]!.status, 'the same original request must recover after its publication callback recovers').toBe('fulfilled')
    expect(requests).toHaveLength(3)
    expect(requests.every(request => request === original)).toBe(true)
    expect(settled).toHaveBeenCalledExactlyOnceWith(original)
    expect(binding.responses).toEqual([{ requestId: 'handler-failure', decision }])
    expect(binding.closed).toBe(false)
    await bridge.dispose()
  })

  it('recovers an unsent synchronous response when its publication callback then fails', async () => {
    const errors = vi.fn()
    let originalRequest!: AgentMuxPermissionRequest
    let firstOutcome = 'pending', firstAttempt = true
    const bridge = new AgentMuxAcpBridge(callbacks({ onError: errors,
      onInteraction(request) {
        originalRequest = request
        if (!firstAttempt) return
        firstAttempt = false
        void respondPermission(bridge, request, { outcome: 'selected', optionId: 'allow' })
          .then(() => { firstOutcome = 'fulfilled' }, () => { firstOutcome = 'rejected' })
        throw new Error('Publication failed after the unsent choice')
      } }))
    const binding = new FakeBinding()
    await bridge.bind('semantic-acp', binding)
    binding.emit({ type: 'permission', requestId: 'synchronous-unsent', title: 'Original request',
      options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }] })
    await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce())
    expect(firstOutcome, 'an unsent response must report its failed publication without stranding the original request').toBe('rejected')
    expect(binding.responses).toEqual([])
    expect(bridge.hasPendingPermission(originalRequest)).toBe(true)
    const recovered = await Promise.allSettled([Promise.resolve().then(() => respondPermission(bridge, originalRequest, { outcome: 'selected', optionId: 'allow' }))])
    expect(recovered[0]!.status, 'the same request must accept a new explicit response after an unsent attempt fails').toBe('fulfilled')
    expect(binding.responses).toEqual([{ requestId: 'synchronous-unsent', decision: { outcome: 'selected', optionId: 'allow' } }])
    await bridge.dispose()
  })

  it('rejects an oversized event without closing its healthy binding', async () => {
    const errors = vi.fn()
    const bridge = new AgentMuxAcpBridge(callbacks({ onError: errors }))
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

    await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce())
    expect(errors.mock.calls[0]?.[1]).toMatchObject({ code: 'ACP_EVENT_TOO_LARGE' })
    expect(binding.closed).toBe(false)
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
