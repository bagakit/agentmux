import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentMuxAcpBridge,
  type AgentMuxAcpBinding
} from '../src/acp-adapter.js'
import type {
  AgentMuxAcpEvent,
  AgentMuxPermissionDecision
} from '../src/types.js'

class FakeBinding implements AgentMuxAcpBinding {
  readonly adapterId = 'fixture-acp'
  readonly sessionId = 'acp-session-1'
  readonly responses: Array<{ requestId: string; decision: AgentMuxPermissionDecision }> = []
  closed = false
  private listener: ((event: AgentMuxAcpEvent) => void) | null = null

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
      evidence: expect.objectContaining({ source: 'acp', acpSessionId: 'acp-session-1' })
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
      kind: 'assistant',
      title: 'oversized',
      content: 'x'.repeat(128 * 1024)
    })

    await waitForClosed(binding)
    expect(binding.closed).toBe(true)
    await bridge.dispose()
  })
})
