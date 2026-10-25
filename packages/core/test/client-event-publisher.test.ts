import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClientEventPublisher } from '../src/client-event-publisher.js'
import type { AgentMuxClientEvent } from '../src/types.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


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
    const publisher = new AgentMuxClientEventPublisher(), failures = vi.fn(), delivered = vi.fn<(value: AgentMuxClientEvent) => void>()
    let throws = true
    const recovering = vi.fn((_event: AgentMuxClientEvent) => { if (throws) throw new Error('transient failure') })
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
    const delivered = vi.fn<(value: AgentMuxClientEvent) => void>()
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
      mutation,
      stream: { epoch: 'original-epoch', sequence: 4, revision: 7, origin: 'retained-prefix', gaps: [] },
      position: { id: 'assistant-1', firstSequence: 1, sequence: 4, revision: 'a'.repeat(64) }
    }, { source: 'acp', observedAt: _historyFixtureEpoch(0, 0, 2), acpAdapterId: 'adapter-1', acpSessionId: 'native-1' }, 'original-source-host')

    expect(delivered).toHaveBeenCalledWith({
      type: 'agent-timeline',
      agentSessionId: 'session-1',
      revision: 7,
      mutation,
      sourceHostId: 'original-source-host',
      stream: { epoch: 'original-epoch', sequence: 4, revision: 7, origin: 'retained-prefix', gaps: [] },
      position: { id: 'assistant-1', firstSequence: 1, sequence: 4, revision: 'a'.repeat(64) },
      evidence: {
        source: 'acp',
        observedAt: 2,
        acpAdapterId: 'adapter-1',
        acpSessionId: 'native-1'
      }
    })
  })
})

describe('exact Run event index', () => {
  const output = (runId: string): AgentMuxClientEvent => ({ type: 'terminal-output', run: { runId }, data: 'original bytes',
    dataBytes: Buffer.from('original bytes'), evidence: { source: 'terminal-output', observedAt: 1, run: { runId },
      outputByteRange: { startByte: 0, endByte: 14 } } })

  it.each([0, 10_000])('visits only the selected Run registrations with %i unrelated Runs', unrelatedCount => {
    const publisher = new AgentMuxClientEventPublisher(), selected = vi.fn(), global = vi.fn()
    let unrelatedCalls = 0
    for (let index = 0; index < unrelatedCount; index++) publisher.onRunEvent(`unrelated-${index}`, () => { unrelatedCalls++ })
    const release = publisher.onRunEvent('selected', selected)
    publisher.onEvent(global)
    // Count work before Consumer code: callback-local filtering cannot pass this
    // oracle, nor can a full registry scan that eventually selects the right Run.
    const internals = publisher as unknown as { runListeners: Map<string, Map<unknown, unknown>>;
      deliver(value: AgentMuxClientEvent, registrations: unknown[]): void }
    const registry = internals.runListeners
    const scans = [vi.spyOn(registry, Symbol.iterator), vi.spyOn(registry, 'values'), vi.spyOn(registry, 'entries'),
      vi.spyOn(registry, 'keys'), vi.spyOn(registry, 'forEach')]
    const get = vi.spyOn(registry, 'get'), deliver = vi.spyOn(internals, 'deliver')
    const original = output('selected')
    try {
      publisher.publish(original)
      expect(selected).toHaveBeenCalledExactlyOnceWith(original)
      expect(global).toHaveBeenCalledExactlyOnceWith(original)
      expect(unrelatedCalls).toBe(0)
      expect(get).toHaveBeenCalledExactlyOnceWith('selected')
      expect(scans.every(scan => scan.mock.calls.length === 0)).toBe(true)
      expect(deliver.mock.calls.filter(([value]) => value === original).reduce((sum, [, registrations]) => sum + registrations.length, 0)).toBe(2)
      release()
      publisher.publish(original)
      expect(selected).toHaveBeenCalledOnce()
      expect(global).toHaveBeenCalledTimes(2)
      expect(unrelatedCalls).toBe(0)
    } finally { vi.restoreAllMocks(); publisher.dispose() }
  })

  it('delivers exact Run lifecycle facts, never invents a scope for unrelated owner events, and disposes registrations', () => {
    const publisher = new AgentMuxClientEventPublisher(), first = vi.fn(), second = vi.fn()
    publisher.onRunEvent('first', first); const release = publisher.onRunEvent('second', second)
    expect(publisher.hasEventListeners).toBe(true)
    publisher.publish(event)
    expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled()
    const exit: AgentMuxClientEvent = { type: 'process-state', run: { runId: 'second' }, state: 'exited', pid: 11,
      exitCode: 0, evidence: { source: 'run-process', observedAt: 1, run: { runId: 'second' } } }
    publisher.publish(exit)
    expect(second).toHaveBeenCalledExactlyOnceWith(exit); expect(first).not.toHaveBeenCalled()
    release(); publisher.publish(exit); expect(second).toHaveBeenCalledOnce()
    publisher.dispose(); publisher.publish(output('first')); expect(first).not.toHaveBeenCalled()
    expect(publisher.hasEventListeners).toBe(false)
  })

  it('detaches an invalid async Run consumer while preserving other Run readers and explicit resubscription', () => {
    const publisher = new AgentMuxClientEventPublisher(), failure = vi.fn(), healthy = vi.fn(), other = vi.fn()
    const invalid = vi.fn(() => Promise.resolve()) as unknown as (value: AgentMuxClientEvent) => void
    publisher.onRunEvent('selected', invalid, { onError: failure })
    publisher.onRunEvent('selected', healthy); publisher.onRunEvent('other', other)
    const original = output('selected')
    publisher.publish(original); publisher.publish(original)
    expect(invalid).toHaveBeenCalledOnce()
    expect(failure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'CLIENT_EVENT_LISTENER_ASYNC' }))
    expect(healthy).toHaveBeenCalledTimes(2); expect(other).not.toHaveBeenCalled()
    const corrected = vi.fn(); publisher.onRunEvent('selected', corrected); publisher.publish(original)
    expect(corrected).toHaveBeenCalledExactlyOnceWith(original)
    publisher.publish(output('other')); expect(other).toHaveBeenCalledOnce()
    publisher.dispose()
  })
})
