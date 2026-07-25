import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentMuxAcpBridge,
  type AgentMuxAcpBinding
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

  async respondPermission(requestId: string, decision: AgentMuxPermissionDecision): Promise<void> {
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

describe('AgentMux ACP adapter boundary', () => {
  it('maps events to AgentMux evidence and rejects permission when no explicit answer exists', async () => {
    const events: unknown[] = []
    const handles: unknown[] = []
    const bridge = new AgentMuxAcpBridge({
      onEvent(agentSessionId, event, evidence) {
        events.push({ agentSessionId, event, evidence })
      },
      onNativeHandle(agentSessionId, handle) {
        handles.push({ agentSessionId, handle })
      }
    })
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
    await bridge.unbind('semantic-acp')
    expect(binding.closed).toBe(true)
  })

  it('forwards only an explicit valid permission selection', async () => {
    const bridge = new AgentMuxAcpBridge(
      { onEvent() {}, onNativeHandle() {} },
      async () => ({ outcome: 'selected', optionId: 'allow' })
    )
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

  it('rejects unknown selections and permission handler failures', async () => {
    let requestCount = 0
    const bridge = new AgentMuxAcpBridge(
      { onEvent() {}, onNativeHandle() {} },
      async () => {
        requestCount += 1
        if (requestCount === 1) return { outcome: 'selected', optionId: 'not-offered' }
        throw new Error('permission UI unavailable')
      }
    )
    const binding = new FakeBinding()
    await bridge.bind('semantic-acp', binding)
    for (const requestId of ['permission-invalid', 'permission-error']) {
      binding.emit({
        type: 'permission',
        requestId,
        title: 'Run command',
        options: [{ id: 'reject', label: 'Reject', kind: 'reject-once' }]
      })
    }
    await waitForResponses(binding, 2)
    expect(binding.responses).toEqual(expect.arrayContaining([
      { requestId: 'permission-invalid', decision: { outcome: 'selected', optionId: 'reject' } },
      { requestId: 'permission-error', decision: { outcome: 'selected', optionId: 'reject' } }
    ]))
    await bridge.dispose()
  })

  it('rejects a permission handler that never produces an explicit answer', async () => {
    vi.useFakeTimers()
    const bridge = new AgentMuxAcpBridge(
      { onEvent() {}, onNativeHandle() {} },
      async () => await new Promise<undefined>(() => {})
    )
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

  it('fails closed and releases a binding that emits an oversized event', async () => {
    const bridge = new AgentMuxAcpBridge({ onEvent() {}, onNativeHandle() {} })
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
    const bridge = new AgentMuxAcpBridge({
      onEvent(_agentSessionId, event) { events.push(event) },
      onNativeHandle() {
        handleAttempts += 1
        if (handleAttempts === 1) throw new Error('native handle persistence failed')
      }
    })

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
    const bridge = new AgentMuxAcpBridge({
      onEvent(agentSessionId, event, evidence) {
        agentTimelineMutationFromAcpEvent(agentSessionId, event, evidence)
      },
      onNativeHandle() { persistedHandles += 1 }
    })

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
    const bridge = new AgentMuxAcpBridge({
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
    })
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
