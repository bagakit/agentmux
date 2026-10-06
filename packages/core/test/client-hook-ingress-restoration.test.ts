import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { loadAgentSessions } from '../src/agent-session-store.js'
import { AgentHookServer } from '../src/hook-server.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { hookSession as session, hookRun as run, hookClientFixture } from './helpers/hook-ingress-fixture.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const clients: AgentMuxClient[] = []
afterEach(async () => { for (const client of clients.splice(0)) await client.dispose(); vi.restoreAllMocks() })
async function fixture(records: AgentMuxStoredAgentSession[]) {
  const value = await hookClientFixture(records); clients.push(value.client); return value
}

it('keeps a failed binding scoped in every public Session projection and refreshes only the exact original Run', async () => {
  const healthy = session('healthy'), failed = { ...session('failed'), hookBindingId: 'invalid' }
  const f = await fixture([healthy, failed])
  const create = vi.spyOn(f.inner.hookServer, 'createBinding')
  await expect(f.inner.tryRestoreHookIngress([run(healthy), run(failed)])).resolves.toBeUndefined()
  expect(create).toHaveBeenCalledTimes(2)
  expect(f.inner.hookBindings.size).toBe(1); expect(f.inner.hookRestorations.size).toBe(0)
  const failure = { run: failed.run, phase: 'binding', code: 'INVALID_HOOK_BINDING' }
  expect(f.client.agentSession(failed.agentSessionId).hookIngressObservation).toMatchObject(failure)
  expect((await f.client.readAgentSessions()).find(value => value.agentSessionId === failed.agentSessionId)?.hookIngressObservation).toMatchObject(failure)
  expect((await f.client.statusAgent(failed.agentSessionId)).session.hookIngressObservation).toMatchObject(failure)
  expect((await f.client.runtimeSubject({ kind: 'agent-session', agentSessionId: failed.agentSessionId })).kind).toBe('agent')
  const projected = (await f.client.runtimeProjection()).subjects.find(value => value.kind === 'agent' && value.agentSession.agentSessionId === failed.agentSessionId)!
  expect(projected.kind === 'agent' && projected.agentSession.hookIngressObservation).toMatchObject(failure)
  const service = new AgentMuxHostedRuntimeService(f.client, null, () => hostedTestOwner(f.client))
  expect((await service.bootstrap()).sessions.find(value => value.agentSessionId === failed.agentSessionId)?.hookIngressObservation).toMatchObject(failure)
  expect(f.client.agentSession(healthy.agentSessionId).hookIngressObservation).toBeUndefined()
  expect((await loadAgentSessions(f.store)).every(value => !('hookIngressObservation' in value))).toBe(true)
  expect(f.events.filter(value => value.type === 'agent-error')).toEqual([])
  await expect(f.client.refreshAgentSession(failed.agentSessionId, { runId: 'wrong-run' })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(create).toHaveBeenCalledTimes(2)
  const fixed = { ...failed, hookBindingId: 'f'.repeat(43), updatedAt: reshapeFixtureEpoch(0, 0, 2) }
  await f.store.compareAndSwap(failed, fixed)
  expect((await f.client.refreshAgentSession(failed.agentSessionId, failed.run)).hookIngressObservation).toBeUndefined()
  expect(f.inner.hookBindings.size).toBe(2); expect(f.inner.hookRestorations.size).toBe(0)
  expect(f.client.agentSession(healthy.agentSessionId).run).toEqual(healthy.run)
  await f.client.refreshAgentSession(healthy.agentSessionId, healthy.run)
  expect(create).toHaveBeenCalledTimes(3)
  await service.dispose()
})

it.each(['success', 'failure'])('ignores an old Run restoration that finishes with %s after a new Run failure', async shape => {
  const old = session('same-session', 'old-run'), next = { ...old, run: { runId: 'new-run' }, hookBindingId: 'invalid', updatedAt: reshapeFixtureEpoch(0, 0, 2) }
  const f = await fixture([old]), start = f.inner.hookServer.start.bind(f.inner.hookServer)
  let release!: (value: Awaited<ReturnType<AgentHookServer['start']>>) => void, reject!: (error: Error) => void
  let first = true
  vi.spyOn(f.inner.hookServer, 'start').mockImplementation(async () => {
    if (!first) return await start()
    first = false
    return await new Promise((yes, no) => { release = yes; reject = no })
  })
  const pending = f.inner.tryRestoreHookIngress([run(old)])
  await f.store.compareAndSwap(old, next); await f.inner.registry.refresh(old.agentSessionId, next.run)
  f.replaceRuns([run(next)])
  await f.inner.tryRestoreHookIngress([run(next)])
  const failure = f.client.agentSession(next.agentSessionId).hookIngressObservation!
  expect(failure).toMatchObject({ run: next.run, code: 'INVALID_HOOK_BINDING' })
  if (shape === 'success') release(await start()); else reject(new Error('Old private listener admission failed late'))
  await pending
  expect(f.client.agentSession(next.agentSessionId).hookIngressObservation).toEqual(failure)
  expect(f.inner.hookBindings.size).toBe(0); expect(f.inner.hookRestorations.size).toBe(0)
})


it.each([false, true])('releases the exact Run binding and retained failure on authoritative end (failed=%s)', async failed => {
  const original = { ...session('ending'), ...(failed ? { hookBindingId: 'invalid' } : {}) }
  const other = session('other'), f = await fixture([original, other])
  vi.spyOn(f.inner, 'persistActivityBoundary').mockResolvedValue()
  await f.inner.tryRestoreHookIngress([run(original), run(other)])
  expect(f.client.agentSession(original.agentSessionId).hookIngressObservation !== undefined).toBe(failed)
  const bindingCount = f.inner.hookBindings.size
  f.inner.acceptKernelEvent({ type: 'exit', runId: original.run.runId, state: { type: 'exited', code: 0, signal: null }, observedAt: reshapeFixtureEpoch(0, 0, 2) })
  expect(f.inner.hookBindings.has(original.run.runId)).toBe(false)
  expect(f.inner.hookBindings.size).toBe(bindingCount - (failed ? 0 : 1))
  expect(f.inner.hookBindings.has(other.run.runId)).toBe(true)
  expect(f.client.agentSession(original.agentSessionId).hookIngressObservation).toBeUndefined()
  expect(f.client.agentSession(other.agentSessionId).run).toEqual(other.run)
})

it('releases a binding that finishes admission after its original Run has ended', async () => {
  const original = session('ending'), f = await fixture([original])
  vi.spyOn(f.inner, 'persistActivityBoundary').mockResolvedValue()
  const start = f.inner.hookServer.start.bind(f.inner.hookServer)
  let release!: (value: Awaited<ReturnType<AgentHookServer['start']>>) => void
  vi.spyOn(f.inner.hookServer, 'start').mockImplementationOnce(async () => await new Promise(yes => { release = yes }))
  const pending = f.inner.tryRestoreHookIngress([run(original)])
  f.inner.acceptKernelEvent({ type: 'exit', runId: original.run.runId, state: { type: 'exited', code: 0, signal: null }, observedAt: reshapeFixtureEpoch(0, 0, 2) })
  release(await start()); await pending
  expect(f.inner.hookBindings.size).toBe(0); expect(f.inner.hookRestorations.size).toBe(0)
  expect((f.inner.hookServer as unknown as { bindings: Map<string, unknown> }).bindings.size).toBe(0)
  expect(f.client.agentSession(original.agentSessionId).hookIngressObservation).toBeUndefined()
})

it('retains the original Session when refresh cannot observe the native Run and recovers on its next exact refresh', async () => {
  const original = { ...session('failed'), hookBindingId: 'invalid' }, f = await fixture([original])
  await f.inner.tryRestoreHookIngress([run(original)])
  const before = f.client.agentSession(original.agentSessionId)
  const status = f.inner.kernel.status
  f.inner.kernel.status = async () => { throw Object.assign(new Error('Private native status observation unavailable'), { code: 'PRIVATE_STATUS_UNAVAILABLE' }) }
  const refreshed = await f.client.refreshAgentSession(original.agentSessionId, original.run)
  expect(refreshed).toMatchObject({ agentSessionId: before.agentSessionId, run: before.run,
    hookIngressObservation: { run: before.run, code: 'PRIVATE_STATUS_UNAVAILABLE' } })
  expect(refreshed.semanticStatus).toEqual(before.semanticStatus)
  expect(refreshed.terminalCapability).toEqual(before.terminalCapability)
  expect(refreshed.retiredRuns).toEqual(before.retiredRuns)
  f.inner.kernel.status = status
  await f.store.compareAndSwap(original, { ...original, hookBindingId: 'f'.repeat(43), updatedAt: reshapeFixtureEpoch(0, 0, 2) })
  expect((await f.client.refreshAgentSession(original.agentSessionId, original.run)).hookIngressObservation).toBeUndefined()
})


it.each([false, true])('releases original Hook ownership when a reconnect snapshot first observes Run end (failed=%s)', async failed => {
  const original = { ...session('ending'), ...(failed ? { hookBindingId: 'invalid' } : {}) }, other = session('other')
  const f = await fixture([original, other]); await f.inner.tryRestoreHookIngress([run(original), run(other)])
  f.inner.backfillEndedRuns([run(original, false), run(other)])
  expect(f.inner.hookBindings.has(original.run.runId)).toBe(false)
  expect(f.inner.hookBindings.has(other.run.runId)).toBe(true)
  expect(f.client.agentSession(original.agentSessionId).hookIngressObservation).toBeUndefined()
  expect((f.inner.hookServer as unknown as { bindings: Map<string, unknown> }).bindings.size).toBe(1)
})

it('consumes an ended binding drain rejection as a scoped diagnostic without an unhandled rejection or retained live ownership', async () => {
  const original = session('ending'), f = await fixture([original])
  vi.spyOn(f.inner, 'persistActivityBoundary').mockResolvedValue()
  await f.inner.tryRestoreHookIngress([run(original)])
  const binding = f.inner.hookBindings.get(original.run.runId) as { close(): Promise<void> }
  vi.spyOn(binding, 'close').mockRejectedValue(new Error('Private drain failed after authoritative exit'))
  f.inner.acceptKernelEvent({ type: 'exit', runId: original.run.runId, state: { type: 'exited', code: 0, signal: null }, observedAt: reshapeFixtureEpoch(0, 0, 2) })
  await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'HOOK_BINDING_RELEASE_UNCONFIRMED',
    agentSessionId: original.agentSessionId, evidence: expect.objectContaining({ run: original.run }) })))
  expect(f.inner.hookBindings.has(original.run.runId)).toBe(false)
  expect(f.client.agentSession(original.agentSessionId).hookIngressObservation).toBeUndefined()
})
