import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import type { AgentHookBinding, AgentHookServer } from '../src/hook-server.js'
import { AgentMuxMemoryAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { hookSession, hookRun } from './helpers/hook-ingress-fixture.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession, NativeHookEnvelope } from '../src/types.js'

/**
 * Core consumes the Hook binding's per-Run delivery fact as one public Session field. It
 * republishes the Session only when the fact changes, keeps it out of storage, never routes it
 * through the Hook restore owner, and drops it when the Run ends. The same generic path serves
 * every Provider; recovery goes through the real Core Hook ingestion.
 */
const clients: AgentMuxClient[] = []
afterEach(async () => { for (const client of clients.splice(0)) await client.dispose(); vi.restoreAllMocks() })
const post = (binding: AgentHookBinding, receiptId: string) => fetch(binding.endpoint.url, {
  method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ receiptId, eventName: 'observation', payload: {} })
})

type Internals = {
  connected: boolean; hookServer: AgentHookServer; hookBindings: Map<string, AgentHookBinding>
  hookIngressObservations: Map<string, unknown>; sessionObservationRetries: { has(): boolean }
  registry: { load(hostId: string): Promise<void> }
  kernel: { isConnected(): boolean; identity(): unknown; status(id: string): Promise<unknown>; list(): Promise<unknown[]> }
  acceptHookEvent(event: NativeHookEnvelope, signal: AbortSignal): Promise<void>
  acceptKernelEvent(event: unknown): void
  persistActivityBoundary(): Promise<void>
  ensureNativeStatusObservation(): Promise<void>
}

async function fixture(record: AgentMuxStoredAgentSession) {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, record)
  const client = new AgentMuxClient({ store }); clients.push(client)
  const inner = client as unknown as Internals
  // The production Hook server and its Core observer wiring; only the listener port is private.
  Object.defineProperty(inner.hookServer, 'port', { value: 0 })
  await inner.registry.load('local')
  inner.connected = true; inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'private-daemon', buildIdentity: 'private', protocolVersion: 18 })
  inner.kernel.list = async () => [hookRun(record)]
  inner.kernel.status = async () => hookRun(record)
  vi.spyOn(inner, 'ensureNativeStatusObservation').mockResolvedValue()
  const ingest = inner.acceptHookEvent.bind(inner)
  let failing = true
  inner.acceptHookEvent = async (event, signal) => {
    if (failing) throw new Error('private store unavailable')
    await ingest(event, signal)
  }
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => { events.push(event) })
  await inner.hookServer.start()
  const binding = inner.hookServer.createBinding(record.agentSessionId, record.providerId); await binding.bindRun(record.run.runId)
  inner.hookBindings.set(record.run.runId, binding)
  const published = () => events.filter(event => event.type === 'agent-session' && event.session.agentSessionId === record.agentSessionId)
  return { client, inner, store, events, binding, published, recover: () => { failing = false } }
}

it.each(['codex', 'claude'] as const)('%s: twenty lost observations publish the Session once, and the next delivered one clears it', async providerId => {
  const base = hookSession(`converge-${providerId}`)
  const record = { ...base, providerId, executorId: providerId, nativeHandle: { kind: 'provider' as const, providerId, sessionId: `native-${providerId}` } }
  const f = await fixture(record)
  for (let index = 0; index < 20; index++) expect((await post(f.binding, `lost-${index}`)).status).toBe(503)
  const delivery = { run: record.run, since: expect.any(Number), accepted: 'unknown', code: 'HOOK_DELIVERY_FAILED' }
  expect(f.published()).toHaveLength(1)
  expect(f.published()[0]).toMatchObject({ session: { hookDeliveryObservation: delivery } })
  expect(f.client.agentSession(record.agentSessionId).hookDeliveryObservation).toEqual(delivery)
  expect((await f.client.readAgentSessions()).find(value => value.agentSessionId === record.agentSessionId)?.hookDeliveryObservation).toEqual(delivery)
  const service = new AgentMuxHostedRuntimeService(f.client, null, () => hostedTestOwner(f.client))
  try {
    expect((await service.bootstrap()).sessions.find(value => value.agentSessionId === record.agentSessionId)?.hookDeliveryObservation).toEqual(delivery)
  } finally { await service.dispose() }
  expect(f.events.filter(event => event.type === 'agent-error'), 'no per-receipt diagnostics').toEqual([])
  // The Session itself is stored; only the live delivery fact is absent from it.
  const stored = await loadAgentSessions(f.store)
  expect(stored).toEqual([expect.objectContaining({ agentSessionId: record.agentSessionId, run: record.run })])
  expect(Object.hasOwn(stored[0]!, 'hookDeliveryObservation')).toBe(false)
  // The delivery fact is not a restore failure: no retry and nothing that qualifies a connection restore.
  expect(f.inner.hookIngressObservations.size).toBe(0)
  expect(f.inner.sessionObservationRetries.has()).toBe(false)
  expect(f.client.agentSession(record.agentSessionId).hookIngressObservation).toBeUndefined()
  f.recover()
  // The real ingestion may publish this Session while the receipt is still in flight; the loss is
  // still current then. Once the owner accepts it, the clear is published and the fact is gone.
  expect((await post(f.binding, 'delivered')).status).toBe(204)
  expect(f.client.agentSession(record.agentSessionId).hookDeliveryObservation).toBeUndefined()
  const last = f.published().at(-1)
  expect(last?.type === 'agent-session' && last.session.hookDeliveryObservation, 'the clear is the latest publication').toBeUndefined()
})

it('Refresh does not clear a delivery loss without a delivered observation', async () => {
  const record = hookSession('refresh-keeps'), f = await fixture(record)
  expect((await post(f.binding, 'lost')).status).toBe(503)
  const refreshed = await f.client.refreshAgentSession(record.agentSessionId, record.run)
  expect(refreshed.hookDeliveryObservation).toMatchObject({ accepted: 'unknown' })
  expect(refreshed.hookIngressObservation).toBeUndefined()
  expect(f.inner.sessionObservationRetries.has()).toBe(false)
})

it('an authoritative Run end releases the delivery loss and the ended binding takes no more receipts', async () => {
  const record = hookSession('ending-loss'), f = await fixture(record)
  const boundary = vi.spyOn(f.inner, 'persistActivityBoundary').mockResolvedValue()
  expect((await post(f.binding, 'lost')).status).toBe(503)
  expect(f.client.agentSession(record.agentSessionId).hookDeliveryObservation).toBeDefined()
  f.inner.acceptKernelEvent({ type: 'exit', runId: record.run.runId, state: { type: 'exited', code: 0, signal: null }, observedAt: 2 })
  await vi.waitFor(() => expect(f.client.agentSession(record.agentSessionId).hookDeliveryObservation).toBeUndefined())
  expect(f.published().at(-1)).toMatchObject({ session: { agentSessionId: record.agentSessionId } })
  expect((f.published().at(-1) as Extract<AgentMuxClientEvent, { type: 'agent-session' }>).session.hookDeliveryObservation).toBeUndefined()
  // Settle point: the exit handling's own boundary write has run, so its publications are in.
  await vi.waitFor(() => expect(boundary).toHaveBeenCalled())
  const ended = f.published().length
  expect((await post(f.binding, 'after-end')).status).toBe(403)
  const afterEnd = f.published().slice(ended - 1)
  expect(afterEnd.length, 'the release itself was published').toBeGreaterThan(0)
  // Exit handling may still publish this Session; none of it may bring the released loss back.
  expect(afterEnd.filter(event => event.type === 'agent-session' && event.session.hookDeliveryObservation !== undefined)).toEqual([])
  expect(f.client.agentSession(record.agentSessionId).run).toEqual(record.run)
})

it('a loss on another binding never appears on this Session', async () => {
  const record = hookSession('own-loss'), f = await fixture(record)
  const other = f.inner.hookServer.createBinding('other-loss', 'codex'); await other.bindRun('other-loss')
  expect((await post(other, 'other-lost')).status).toBe(503)
  expect(f.client.agentSession(record.agentSessionId).hookDeliveryObservation).toBeUndefined()
  expect(f.published()).toHaveLength(0)
})
