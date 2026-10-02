import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxHostedRuntimeService as SourceService } from '../src/hosted-runtime-service.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'
import type { AgentSessionHistoryObservation, AgentSessionHistoryObservationHandle } from '../src/types.js'
const Service: typeof SourceService = process.env.AGENTMUX_TEST_SERVICE_ENTRY
  ? (await import(process.env.AGENTMUX_TEST_SERVICE_ENTRY)).AgentMuxHostedRuntimeService : SourceService
const owner = { runtimeId: 'reader-runtime', ownerInstanceId: 'reader-generation' } as AgentMuxRuntimeOwnerIdentity
const fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
it('a new reader waits for the previous Core lease release and cannot be detached by its cleanup', async () => {
  const h = await rpcOwnerFixture(); closes.push(h.close)
  let release!: () => void, entered!: () => void
  const enteredRelease = new Promise<void>(yes => { entered = yes }), gate = new Promise<void>(yes => { release = yes })
  let attached = false, delay = true
  const attach = vi.fn(async (id: string) => { attached = true; return { run: h.run(id), replay: [], gap: null, resizeRevision: null, terminal: { type: 'not-requested' } } })
  const detach = vi.fn(async () => { if (delay) { entered(); await gate }; attached = false })
  h.inner.kernel.attach = attach; h.inner.kernel.detach = detach
  const service = new Service(h.client, null, () => ({ ...owner, protocolVersion: 1, processId: 123, availability: 'connected', ctxmux: { hostId: 'local', instanceId: 'private-daemon', processId: null, buildIdentity: 'private-fixture', protocolVersion: 1, ownership: 'owned' } }));
  vi.spyOn(h.client, 'runtimeIdentity').mockReturnValue({ hostId: 'local', instanceId: 'private-daemon', processId: null, buildIdentity: 'private-fixture', protocolVersion: 1, ownership: 'owned' });
  await service.subscribe('runtime.events', { consumerId: 'parent-consumer', fence }, () => {}); closes.push(() => service.dispose())
  const params = { consumerId: 'parent-consumer', fence, target: { kind: 'terminal-run', runId: 'separate-terminal' }, afterByte: 0, view: 'terminal' }
  const first = await service.subscribe('runtime.attachment-watch', params, () => {}, {})
  const closing = first.dispose(); await enteredRelease
  const next = service.subscribe('runtime.attachment-watch', params, () => {}, {}).then(value => ({ value }), error => ({ error }))
  try {
    await new Promise(resolve => setImmediate(resolve))
    expect(attach, 'new reader cannot overlap the previous Core lease release').toHaveBeenCalledOnce()
  } finally { delay = false; release(); await closing }
  const result = await next
  expect(result, 'replacement reader receives its own Core lease').toHaveProperty('value')
  if (!('value' in result)) throw result.error
  expect(attached).toBe(true); expect(attach).toHaveBeenCalledTimes(2); expect(detach).toHaveBeenCalledOnce()
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  await result.value.dispose(); expect(attached).toBe(false)
})
it('a failed history consumer immediately releases only its native observation before peer disconnect', async () => {
  const h = await rpcOwnerFixture(); closes.push(h.close)
  let publish!: (value: AgentSessionHistoryObservation) => void
  const dispose = vi.fn(), source = { kind: 'durable-timeline', agentSessionId: 'caller' } as unknown as AgentSessionHistoryObservationHandle['source']
  vi.spyOn(h.client, 'observeSessionHistory').mockImplementation(async (_id, listener) => { publish = listener; return { source, dispose } })
  const service = new Service(h.client, null, () => ({ ...owner, protocolVersion: 1, processId: 123, availability: 'connected', ctxmux: { hostId: 'local', instanceId: 'private-daemon', processId: null, buildIdentity: 'private-fixture', protocolVersion: 1, ownership: 'owned' } }));
  vi.spyOn(h.client, 'runtimeIdentity').mockReturnValue({ hostId: 'local', instanceId: 'private-daemon', processId: null, buildIdentity: 'private-fixture', protocolVersion: 1, ownership: 'owned' });
  await service.subscribe('runtime.events', { consumerId: 'parent-consumer', fence }, () => {}); closes.push(() => service.dispose())
  let fail = false
  const events: string[] = []
  const sub = await service.subscribe('runtime.history-watch', { consumerId: 'parent-consumer', fence, agentSessionId: 'caller', options: {} }, event => {
    events.push(event.type)
    if (fail && event.type === 'snapshot') throw new Error('This exact reader transport failed')
  }, {})
  await sub.start?.(); expect(events).toEqual(['snapshot'])
  fail = true; publish({ revision: 'actual-observation-revision' } as unknown as AgentSessionHistoryObservation)
  await new Promise(resolve => setImmediate(resolve))
  expect(dispose, 'failed history reader releases its native observer without waiting for peer disconnect').toHaveBeenCalledOnce()
  expect(events).toEqual(['snapshot', 'snapshot', 'error', 'end'])
  expect(h.inner.kernel.stop).not.toHaveBeenCalled(); expect(h.inner.kernel.detach).not.toHaveBeenCalled()
  await sub.dispose(); expect(dispose).toHaveBeenCalledOnce()
})
