import type { AgentMuxRuntimeSubject } from '../src/runtime.js'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { parseHostedBootstrap } from '../src/hosted-value.js'
import type { AgentMuxStoredAgentSession, AgentMuxClientEvent, AgentMuxRun } from '../src/types.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { AgentMuxHostedRpcPort } from '../src/hosted-client-contract.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
const session = (id: string): AgentMuxStoredAgentSession => ({ kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'codex',
  hostId: 'local', workspacePath: '/original/' + id, hookBindingId: 'binding-' + id, hookToken: 'token-' + id, run: { runId: 'run-' + id }, retiredRuns: [], createdAt: 1, updatedAt: 1 })
const run = (s: AgentMuxStoredAgentSession): AgentMuxRun => ({ ...s.run, kind: 'agent', nativeService: null, providerId: s.providerId,
  executorId: s.executorId, agentSessionId: s.agentSessionId, workspacePath: s.workspacePath, pid: 123, state: 'running',
  cols: 80, rows: 24, observedAt: 1, latestOutputBytes: 0, acceptedInputBytes: 0 })
async function fixture() {
  const store = new AgentMuxMemoryAgentSessionStore(), core = new AgentMuxClient({ store, providers: [] })
  cleanup.push(() => core.dispose())
  const inner = core as unknown as { registry: AgentMuxAgentSessionRegistry; publishSession(session: AgentMuxStoredAgentSession): void }
  const selected = session('selected-original'), unrelated = session('unrelated-original')
  await inner.registry.put(selected); await inner.registry.put(unrelated)
  vi.spyOn(core, 'connectRuntime').mockResolvedValue()
  const inventory = vi.spyOn(core, 'readAgentSessions').mockRejectedValue(new Error('Full Session inventory is not a scoped bootstrap.'))
  const listRuns = vi.spyOn(core, 'listRuns').mockRejectedValue(new Error('All Run enumeration is not a scoped process observation.'))
  const projection = vi.spyOn(core, 'runtimeProjection').mockRejectedValue(new Error('Full Runtime projection is not scoped.'))
  const exact = vi.spyOn(core, 'readAgentSession'), cuts = vi.spyOn(core.metadata, 'pendingIds')
  const subject = vi.spyOn(core, 'runtimeSubject').mockImplementation(async target => {
    expect(target.kind).toBe('agent-session')
    const s = target.kind === 'agent-session' ? await core.readAgentSession(target.agentSessionId) : null
    if (!s) throw Error('Exact selected Session not found')
    return { kind: 'agent', subjectId: s.agentSessionId, hostId: 'local', workspacePath: s.workspacePath,
      providerId: s.providerId, executorId: s.executorId, agentSession: s, run: run(s) } as AgentMuxRuntimeSubject
  })
  const owner = { runtimeId: 'original-runtime', ownerInstanceId: 'original-instance', protocolVersion: 2 as const,
    processId: 123, availability: 'connected' as const, ctxmux: null }
  const service = new AgentMuxHostedRuntimeService(core, null, () => owner)
  cleanup.push(() => service.dispose())
  const seen: AgentMuxClientEvent[] = []
  const port: AgentMuxHostedRpcPort = {
    call: async (method, params, context) => await service.call(method, params, context) as never,
    subscribe: async (method, params, handlers) => {
      const reader = await service.subscribe(method, params, event => handlers.onEvent(event))
      handlers.onInitial(reader.initial as never); await reader.start?.()
      return { dispose: () => reader.dispose() }
    }
  }
  return { core, inner, selected, unrelated, service, port, owner, seen, inventory, listRuns, projection, exact, cuts, subject }
}
it('reads exact requested metadata and one original Run without inventory, global cuts, messages or history', async () => {
  const f = await fixture(), client = await connectHostedAgentMux({ rpc: f.port, sessions: 'summary', agentSessionIds: [f.selected.agentSessionId, 'missing-original'] })
  cleanup.push(() => client.dispose()); client.onEvent(event => f.seen.push(event), { observeMessages: false })
  expect(client.agentSessions().map(s => s.agentSessionId)).toEqual([f.selected.agentSessionId])
  expect(client.sessionObservationScope()).toEqual({ agentSessionIds: [f.selected.agentSessionId, 'missing-original'], missing: ['missing-original'], unavailable: [] })
  // The explicit public bootstrap and events opening share the same exact scope.
  const bootstrap = await f.port.call('runtime.bootstrap', { consumerId: 'selected-reader', fence: { runtimeId: f.owner.runtimeId, ownerInstanceId: f.owner.ownerInstanceId },
    sessions: 'summary', agentSessionIds: [f.selected.agentSessionId, 'missing-original'] })
  expect(bootstrap.sessions.map(session => session.agentSessionId)).toEqual([f.selected.agentSessionId])
  expect(bootstrap.sessionScope?.missing).toEqual(['missing-original'])
  await vi.waitFor(() => expect(f.subject).toHaveBeenCalledTimes(1))
  expect(f.exact.mock.calls.every(([id]) => id === f.selected.agentSessionId || id === 'missing-original')).toBe(true)
  expect(f.inventory).not.toHaveBeenCalled(); expect(f.listRuns).not.toHaveBeenCalled(); expect(f.projection).not.toHaveBeenCalled(); expect(f.cuts).not.toHaveBeenCalled()
  const changed = { ...f.selected, updatedAt: 2 }
  await f.inner.registry.put(changed, f.selected.run); f.inner.publishSession(changed)
  await vi.waitFor(() => expect(client.agentSession(f.selected.agentSessionId).updatedAt).toBe(2))
  await f.inner.registry.put({ ...f.unrelated, updatedAt: 3 }, f.unrelated.run); f.inner.publishSession({ ...f.unrelated, updatedAt: 3 })
  await new Promise(resolve => setImmediate(resolve))
  expect(client.agentSessions().map(s => s.agentSessionId)).toEqual([f.selected.agentSessionId])
  expect(f.seen.some(e => e.type === 'agent-session' && e.session.agentSessionId === f.unrelated.agentSessionId)).toBe(false)
  const born = session('missing-original'); await f.inner.registry.put(born); f.inner.publishSession(born)
  await vi.waitFor(() => expect(client.agentSessions().map(s => s.agentSessionId)).toContain(born.agentSessionId))
  expect(client.sessionObservationScope()?.missing).toEqual([])
})
it('keeps an explicitly empty scope empty and distinguishes missing from unavailable instead of using an all-Session fallback', async () => {
  const f = await fixture(), client = await connectHostedAgentMux({ rpc: f.port, sessions: 'summary', agentSessionIds: [] })
  cleanup.push(() => client.dispose())
  expect(client.agentSessions()).toEqual([]); expect(client.sessionObservationScope()).toEqual({ agentSessionIds: [], missing: [], unavailable: [] })
  expect(f.exact).not.toHaveBeenCalled(); expect(f.inventory).not.toHaveBeenCalled(); expect(f.subject).not.toHaveBeenCalled()
  f.exact.mockImplementation(async id => { if (id === 'unreadable-original') throw Error('Exact original metadata IO unavailable'); return null })
  const value = await f.service.bootstrap('summary', ['missing-original', 'unreadable-original'])
  expect(value.sessionScope).toMatchObject({ missing: ['missing-original'], unavailable: [{ agentSessionId: 'unreadable-original', message: 'Exact original metadata IO unavailable' }] })
  expect(() => parseHostedBootstrap(value, 'summary', ['missing-original', 'unreadable-original'])).not.toThrow()
  expect(() => parseHostedBootstrap(value, 'summary', ['some-other-original'])).toThrow()
})
it('the actual producer visits only SID-indexed scoped readers for unrelated and related metadata updates', async () => {
  const f = await fixture(), frames = Array.from({ length: 64 }, () => 0), subscriptions = []
  for (let i = 0; i < frames.length; i++) {
    const original = session('member-' + i); await f.inner.registry.put(original)
    const read = await f.service.subscribe('runtime.events', { consumerId: 'scope-reader-' + i,
      fence: { runtimeId: f.owner.runtimeId, ownerInstanceId: f.owner.ownerInstanceId }, sessions: 'summary', agentSessionIds: [original.agentSessionId] }, () => { frames[i]++ })
    subscriptions.push(read); cleanup.push(() => read.dispose()); await read.start?.()
  }
  const consumers = (f.service as unknown as { consumers: Map<string, {events: {closed:boolean}}> }).consumers
  const visits = [...consumers.values()].map(consumer => vi.spyOn(consumer.events, 'closed', 'get'))
  frames.fill(0); for (const spy of visits) spy.mockClear()
  const published = vi.fn()
  const release = f.core.onEvent(event => { if (event.type === 'agent-session' && event.session.agentSessionId === f.unrelated.agentSessionId) published() }, { observeMessages: false })
  cleanup.push(release)
  await f.inner.registry.put({ ...f.unrelated, updatedAt: 3 }, f.unrelated.run); f.inner.publishSession({ ...f.unrelated, updatedAt: 3 })
  await vi.waitFor(() => expect(published).toHaveBeenCalled())
  expect(frames.reduce((sum, value) => sum + value, 0)).toBe(0)
  expect(visits.reduce((sum, spy) => sum + spy.mock.calls.length, 0), 'unrelated metadata must not walk every scoped reader and filter afterward').toBe(0)
  const target = session('member-32'), changed = { ...target, updatedAt: 4 }
  await f.inner.registry.put(changed, target.run); f.inner.publishSession(changed)
  await vi.waitFor(() => expect(frames[32]).toBeGreaterThan(0))
  expect(visits[32]!.mock.calls.length, 'positive guard: the original selected reader was actually visited').toBeGreaterThan(0)
  expect(visits.filter((_, i) => i !== 32).reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBe(0)
  expect(f.inventory).not.toHaveBeenCalled()
})
