import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClientEventPublisher } from '../src/client-event-publisher.js'
import type { AgentMuxClientEvent } from '../src/types.js'

const event: AgentMuxClientEvent = {
  type: 'agent-error',
  code: 'FIXTURE_ERROR',
  message: 'fixture',
  evidence: { source: 'user', observedAt: 1 }
}

describe('AgentMux Client event publisher bounds', () => {
  it('caps distinct listeners and releases capacity when a listener unsubscribes', () => {
    const publisher = new AgentMuxClientEventPublisher()
    const listeners = Array.from({ length: 64 }, () => vi.fn())
    const releases = listeners.map((listener) => publisher.onEvent(listener))

    expect(() => publisher.onEvent(listeners[0]!)).not.toThrow()
    expect(() => publisher.onEvent(vi.fn())).toThrowError(
      expect.objectContaining({ code: 'CLIENT_EVENT_LISTENER_LIMIT' })
    )

    releases[0]!()
    expect(() => publisher.onEvent(vi.fn())).not.toThrow()
    publisher.dispose()
  })

  it('does not let throwing, rejecting, or unresolved consumers block lifecycle publication', async () => {
    const publisher = new AgentMuxClientEventPublisher()
    const delivered = vi.fn()
    publisher.onEvent(() => { throw new Error('consumer failed') })
    publisher.onEvent(async () => await Promise.reject(new Error('async consumer failed')))
    publisher.onEvent(async () => await new Promise<void>(() => {}))
    publisher.onEvent(delivered)

    expect(() => publisher.publish(event)).not.toThrow()
    expect(delivered).toHaveBeenCalledOnce()
    expect(delivered).toHaveBeenCalledWith(event)
    await Promise.resolve()
    publisher.dispose()
  })

  it('detaches a Promise-returning consumer instead of queueing behind it', async () => {
    const publisher = new AgentMuxClientEventPublisher()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const slow = vi.fn(async () => await blocked)
    const fast = vi.fn()
    publisher.onEvent(slow)
    publisher.onEvent(fast)

    for (let index = 0; index < 1_000; index += 1) publisher.publish(event)

    expect(slow).toHaveBeenCalledOnce()
    expect(fast).toHaveBeenCalledTimes(1_000)
    release()
    await blocked
    await Promise.resolve()

    publisher.publish(event)
    expect(slow).toHaveBeenCalledOnce()
    expect(fast).toHaveBeenCalledTimes(1_001)
    publisher.dispose()
  })

  it('allows explicit re-registration after a Promise-returning consumer is detached', () => {
    const publisher = new AgentMuxClientEventPublisher()
    const pending = new Promise<void>(() => {})
    const listener = vi.fn(async () => await pending)
    publisher.onEvent(listener)

    publisher.publish(event)
    publisher.onEvent(listener)
    publisher.publish(event)

    expect(listener).toHaveBeenCalledTimes(2)
    publisher.dispose()
  })
})
