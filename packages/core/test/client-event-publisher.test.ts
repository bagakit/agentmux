import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClientEventPublisher } from '../src/client-event-publisher.js'
import type { AgentMuxClientEvent } from '../src/types.js'

const event: AgentMuxClientEvent = {
  type: 'agent-error',
  code: 'FIXTURE_ERROR',
  message: 'fixture',
  evidence: { source: 'user', observedAt: 1 }
}

describe('AgentMux Client event publisher Consumer isolation', () => {
  it('supports more than 64 actual Consumers and releases only the selected subscription', () => {
    const publisher = new AgentMuxClientEventPublisher()
    const listeners = Array.from({ length: 128 }, () => vi.fn())
    const releases = listeners.map(listener => publisher.onEvent(listener))
    publisher.publish(event)
    expect(listeners.every(listener => listener.mock.calls.length === 1)).toBe(true)
    releases[0]!()
    publisher.publish(event)
    expect(listeners[0]).toHaveBeenCalledOnce()
    expect(listeners.slice(1).every(listener => listener.mock.calls.length === 2)).toBe(true)
    publisher.dispose()
    publisher.publish(event)
    expect(listeners[1]).toHaveBeenCalledTimes(2)
  })

  it('reports rejecting and unresolved JS Consumers without blocking healthy Consumers or a transient synchronous failure', async () => {
    const publisher = new AgentMuxClientEventPublisher(), failures = vi.fn(), delivered = vi.fn()
    let throws = true
    const recovering = vi.fn(() => { if (throws) throw new Error('transient failure') })
    publisher.onEvent(recovering)
    publisher.onEvent((async () => { throw new Error('async failure') }) as unknown as (event: AgentMuxClientEvent) => void, { onError: failures })
    publisher.onEvent((() => new Promise<void>(() => {})) as unknown as (event: AgentMuxClientEvent) => void, { onError: failures })
    publisher.onEvent(delivered)
    expect(() => publisher.publish(event)).not.toThrow()
    expect(failures).toHaveBeenCalledTimes(2)
    expect(failures.mock.calls.every(([error]) => error.code === 'CLIENT_EVENT_LISTENER_ASYNC')).toBe(true)
    expect(delivered.mock.calls.filter(([value]) => value === event)).toHaveLength(1)
    throws = false
    publisher.publish(event)
    expect(recovering.mock.calls.filter(([value]) => value === event)).toHaveLength(2)
    expect(delivered.mock.calls.filter(([value]) => value === event)).toHaveLength(2)
    await Promise.resolve()
    publisher.dispose()
  })

  it('detaches Promise-returning Consumers with a diagnostic and allows explicit corrected registration', () => {
    const publisher = new AgentMuxClientEventPublisher(), diagnostics = vi.fn(), healthy = vi.fn()
    const pending = new Promise<void>(() => {})
    const listener = vi.fn(() => pending) as unknown as (event: AgentMuxClientEvent) => void
    publisher.onEvent(listener, { onError: diagnostics })
    publisher.onEvent(healthy)
    for (let index = 0; index < 1000; index += 1) publisher.publish(event)
    expect(listener).toHaveBeenCalledOnce()
    expect(diagnostics).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'CLIENT_EVENT_LISTENER_ASYNC', message: expect.stringContaining('subscribe again') }))
    expect(healthy.mock.calls.filter(([value]) => value === event)).toHaveLength(1000)
    expect(healthy.mock.calls.filter(([value]) => value.code === 'CLIENT_EVENT_LISTENER_ASYNC')).toHaveLength(1)
    const corrected = vi.fn()
    publisher.onEvent(corrected)
    publisher.publish(event)
    expect(corrected).toHaveBeenCalledOnce()
    publisher.dispose()
  })

  it('reports a sole invalid JS Consumer directly and contains a Promise diagnostic Consumer without recursion', () => {
    const publisher = new AgentMuxClientEventPublisher(), consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      publisher.onEvent((() => Promise.resolve()) as unknown as (event: AgentMuxClientEvent) => void)
      publisher.publish(event)
      expect(consoleError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'CLIENT_EVENT_LISTENER_ASYNC' }))
      const invalidDiagnostic = vi.fn((value: AgentMuxClientEvent) => value.type === 'agent-error' && value.code === 'CLIENT_EVENT_LISTENER_ASYNC' ? Promise.resolve() : undefined)
      publisher.onEvent(invalidDiagnostic as unknown as (event: AgentMuxClientEvent) => void)
      publisher.onEvent((() => Promise.resolve()) as unknown as (event: AgentMuxClientEvent) => void)
      const healthy = vi.fn(); publisher.onEvent(healthy)
      publisher.publish(event)
      expect(invalidDiagnostic).toHaveBeenCalledTimes(2)
      expect(healthy).toHaveBeenCalledTimes(2)
      publisher.publish(event)
      expect(healthy).toHaveBeenCalledTimes(3)
      expect(consoleError).toHaveBeenCalledTimes(3)
    } finally { consoleError.mockRestore(); publisher.dispose() }
  })

  it('publishes the Store-assigned Timeline revision and canonical mutation', () => {
    const publisher = new AgentMuxClientEventPublisher()
    const delivered = vi.fn()
    publisher.onEvent(delivered)
    const mutation = {
      type: 'update' as const,
      agentSessionId: 'session-1',
      itemId: 'assistant-1',
      updatedAt: 2,
      content: 'complete content'
    }

    publisher.publishTimeline({
      agentSessionId: 'session-1',
      revision: 7,
      changed: true,
      mutation
    }, { source: 'acp', observedAt: 2, acpAdapterId: 'adapter-1', acpSessionId: 'native-1' })

    expect(delivered).toHaveBeenCalledWith({
      type: 'agent-timeline',
      agentSessionId: 'session-1',
      revision: 7,
      mutation,
      evidence: {
        source: 'acp',
        observedAt: 2,
        acpAdapterId: 'adapter-1',
        acpSessionId: 'native-1'
      }
    })
  })
})
