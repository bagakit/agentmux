import { fixturePath } from './helpers/fixture-values.js'
import { loadAgentSessions } from '../src/agent-session-store.js'
import { pathToFileURL } from 'node:url'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AgentMuxRpcService as SourceRpcService } from '../src/public-rpc-service.js'
import { AgentMuxError } from '../src/errors.js'
import { hashAgentCapability, issueAgentCapability } from '../src/agent-capability.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { OrderedSessionOutputFollow } from '../src/session-output-follow.js'
import { parseRpcControlResult, rpcControlRequest } from '../src/rpc-business-codec.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxClientEventPublisher } from '../src/client-event-publisher.js'
import { AGENTMUX_AGENT_MESSAGING_RULES } from '../src/agent-messaging-guidance.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'

const cleanups: Array<() => Promise<void>> = []
const AgentMuxRpcService = process.env.AGENTMUX_TEST_RPC_SERVICE_ENTRY
  ? (await import(process.env.AGENTMUX_TEST_RPC_SERVICE_ENTRY) as typeof import('../src/public-rpc-service.js')).AgentMuxRpcService
  : SourceRpcService
const OwnerError: typeof AgentMuxError = process.env.AGENTMUX_TEST_RPC_SERVICE_ENTRY
  ? (await import(new URL('./errors.js', pathToFileURL(process.env.AGENTMUX_TEST_RPC_SERVICE_ENTRY)).href)).AgentMuxError : AgentMuxError
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function owner(ids?: string[]) { const h = await rpcOwnerFixture(ids); cleanups.push(h.close); return h }
const catalog = { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] }
describe('public service uses the original Core and Desktop business owners', () => {
  it('keeps unrelated output readers out of the SDK ordered-byte metadata dispatch', async () => {
    const h = await owner(['reader-a', 'reader-b', 'reader-c', 'reader-d']), received = vi.fn(), metadata = vi.fn()
    const original = AgentMuxClientEventPublisher.prototype.onStatusEvent
    vi.spyOn(AgentMuxClientEventPublisher.prototype, 'onStatusEvent').mockImplementation(function (listener) {
      return original.call(this, event => { metadata(event); listener(event) })
    })
    const readers = await Promise.all(['reader-a', 'reader-b', 'reader-c'].map(id => h.client.observeAgentOutput(id, 0, received)))
    const sdkPublisher = (h.client as unknown as { publisher: AgentMuxClientEventPublisher }).publisher
    sdkPublisher.publishRunEvent({ type: 'data', runId: 'run-reader-d', startByte: 0, endByte: 1, data: 'x', dataBytes: Uint8Array.of(120) })
    expect(metadata).not.toHaveBeenCalled(); expect(received).not.toHaveBeenCalled()
    sdkPublisher.publish({ type: 'agent-error', agentSessionId: 'reader-a', code: 'PRIVATE_READER_ERROR', message: 'Observed reader error',
      evidence: { source: 'run-process', observedAt: 1, run: { runId: 'run-reader-a' } } })
    // Shared diagnostics cannot establish failure of these healthy, independently attached readers.
    expect(metadata).toHaveBeenCalledTimes(3); expect(received).not.toHaveBeenCalled()
    metadata.mockClear()
    sdkPublisher.publish({ type: 'agent-session', session: h.client.agentSession('reader-a') })
    expect(metadata).toHaveBeenCalledTimes(3); expect(received).not.toHaveBeenCalled()
    sdkPublisher.publish({ type: 'connection-state', state: 'lost', evidence: { source: 'agentmux', observedAt: 2 } })
    expect(received).toHaveBeenCalledTimes(3)
    expect(received.mock.calls.map(([event]) => event.code)).toEqual(Array(3).fill('CONTROL_UNAVAILABLE'))
    expect(received.mock.calls.map(([event]) => event.agentSessionId).sort()).toEqual(['reader-a', 'reader-b', 'reader-c'])
    await Promise.all(readers.map(reader => reader.close())); metadata.mockClear(); received.mockClear()
    sdkPublisher.publish({ type: 'agent-error', agentSessionId: 'reader-a', code: 'PRIVATE_READER_ERROR', message: 'After close',
      evidence: { source: 'run-process', observedAt: 1, run: { runId: 'run-reader-a' } } })
    sdkPublisher.publish({ type: 'connection-state', state: 'lost', evidence: { source: 'agentmux', observedAt: 3 } })
    expect(metadata).not.toHaveBeenCalled(); expect(received).not.toHaveBeenCalled()
    expect(h.inner.kernel.stop).not.toHaveBeenCalled(); expect(h.inner.kernel.attach).not.toHaveBeenCalled()
  })
  it('refreshes only the durable selected Run before long-lived inspection and output observation', async () => {
    const h = await owner(), service = new AgentMuxRpcService({ coreClients: h.coreClients })
    const previous = (await h.store.load()).find(session => session.agentSessionId === 'caller')!
    const neighbor = h.client.agentSession('recipient'), current = { ...previous, run: { runId: 'replacement-run' },
      retiredRuns: [previous.run], updatedAt: previous.updatedAt + 1 }
    await h.store.compareAndSwap(previous, current)
    expect(h.client.agentSession('caller').run).toEqual(previous.run)
    const inspected = await service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'caller' } })
    expect(inspected.status).not.toBeNull()
    expect(inspected.session.run).toEqual(current.run); expect(inspected.status!.session.run).toEqual(current.run)
    const sub = await service.subscribe('agent.output', { agentSessionId: 'caller', follow: false }, vi.fn())
    expect(sub.initial.session.run).toEqual(current.run); expect(sub.initial.run.runId).toBe(current.run.runId)
    await sub.dispose()
    expect(h.client.agentSession('recipient')).toEqual(neighbor)
    expect(h.inner.kernel.attach).not.toHaveBeenCalled(); expect(h.inner.kernel.detach).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it('validates query filters before traversing an empty or nonempty owner collection', async () => {
    const h = await owner(), empty = new AgentMuxRpcService({ coreClients: () => [], execute: async () => ({ operation: 'demand.list', demands: [] }) })
    const filled = new AgentMuxRpcService({ coreClients: h.coreClients })
    await expect(empty.call('goal.activity', { since: -1 })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    for (const service of [empty, filled]) await expect(service.call('agent.ls', { executorId: [] } as any)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(await empty.call('goal.activity', {})).toEqual({ activity: [], diskDurability: 'confirmed' })
    expect(await empty.call('agent.ls', {})).toEqual({ sessions: [], errors: [] })
  })
  it('keeps Core Sessions and per-item status failures when no Desktop exists', async () => {
    const h = await owner(), actualStatus = h.client.statusAgent.bind(h.client)
    vi.spyOn(h.client, 'statusAgent').mockImplementation(async id => {
      if (id === 'caller') throw new OwnerError('Private Run snapshot unavailable', 'CONTROL_UNAVAILABLE')
      return await actualStatus(id)
    })
    const service = new AgentMuxRpcService({ coreClients: h.coreClients })
    const listed = await service.call('agent.ls', {})
    expect(listed.sessions).toHaveLength(1); expect(listed.errors).toEqual([{ agentSessionId: 'caller', hostId: 'local', code: 'CONTROL_UNAVAILABLE', message: 'Private Run snapshot unavailable' }])
    const inspected = await service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'recipient' } })
    expect(inspected.session.agentSessionId).toBe('recipient'); expect(inspected.displayName).toEqual({ override: null, availability: 'unavailable' })
    expect(inspected.unavailable).toHaveLength(1)
    const self = await service.call('whoami', {}, { caller: h.credentials })
    expect(self.messaging).toEqual(AGENTMUX_AGENT_MESSAGING_RULES)
    expect(parseRpcNativeResult('whoami', self, {}, h.credentials)).toMatchObject({ messaging: AGENTMUX_AGENT_MESSAGING_RULES })
    await service.dispose(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it('validates the current durable capability, rather than a long-lived registry cache', async () => {
    const h = await owner(), execute = vi.fn(async () => ({ operation: 'space.ls' as const, catalog }))
    const service = new AgentMuxRpcService({ coreClients: h.coreClients, execute })
    await service.call('space.ls', { target: {} }, { caller: h.credentials })
    const before = (await h.store.load())[0]!
    await h.store.compareAndSwap(before, { ...before, capabilityHash: hashAgentCapability(issueAgentCapability()), updatedAt: 2 })
    await expect(service.call('space.ls', { target: {} }, { caller: h.credentials })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    expect(execute).toHaveBeenCalledOnce(); expect(h.client.agentSession('caller').run).toEqual(before.run)
  })
  it('reads durable prefix collisions before dispatch, retaining exact canonical identity', async () => {
    const h = await owner(['abcdef123-first']), service = new AgentMuxRpcService({ coreClients: h.coreClients })
    const record = (await h.store.load())[0]!
    await h.store.compareAndSwap(null, { ...record, agentSessionId: 'abcdef123-second', run: { runId: 'run-second' } })
    await expect(service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'abcdef123' } })).rejects.toMatchObject({ code: 'AMBIGUOUS_AGENT_SESSION' })
    expect((await service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: record.agentSessionId } })).session.agentSessionId).toBe(record.agentSessionId)
  })
  it('keeps retired identities in prefix admission without resurrecting a retired Session', async () => {
    const h = await owner(['sameprefix-live']), service = new AgentMuxRpcService({ coreClients: h.coreClients })
    vi.spyOn(h.store, 'loadRetiredAgentSessions').mockResolvedValue([{ agentSessionId: 'sameprefix-retired', hostId: 'local',
      run: { runId: 'retired-run' }, source: 'user', observedAt: 2 }])
    await expect(service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'sameprefix' } }))
      .rejects.toMatchObject({ code: 'AMBIGUOUS_AGENT_SESSION' })
    await expect(service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'sameprefix-retired' } }))
      .rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    expect((await service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'sameprefix-live' } })).session.agentSessionId).toBe('sameprefix-live')
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it('uses Session hostId in a shared Store and retains a healthy exact owner when another Host read fails', async () => {
    const h = await owner(), remote = new AgentMuxClient({ store: h.store }); cleanups.push(() => remote.dispose())
    const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: h.client }, { hostId: 'remote', client: remote }] })
    const first = await service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'caller' } })
    expect(first.session.hostId).toBe('local'); expect(first.session.agentSessionId).toBe('caller')
    const remoteRead = vi.spyOn(remote, 'readAgentSessions').mockRejectedValue(new OwnerError('Private remote Store unavailable', 'CONTROL_UNAVAILABLE'))
    const healthy = await service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'caller' } })
    expect(healthy.session.run).toEqual(first.session.run); expect(healthy.status!.run.state).toBe('running')
    expect(remoteRead).not.toHaveBeenCalled()
    expect(healthy.session.agentSessionId).toBe(first.session.agentSessionId)
    expect(healthy.status!.run.pid).toBe(first.status!.run.pid)
    await expect(service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'call' } })).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_READ_UNCONFIRMED' })
    const listed = await service.call('agent.ls', {})
    expect(listed.sessions).toHaveLength(2); expect(listed.errors).toEqual([{ agentSessionId: null, hostId: 'remote', code: 'CONTROL_UNAVAILABLE', message: 'Private remote Store unavailable' }])
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it('keeps retired durable identity in prefix ambiguity without publishing it as an active Session', async () => {
    const retiredId = 'retained-prefix-original', replacementId = 'retained-prefix-replacement'
    const h = await owner([retiredId]), record = (await loadAgentSessions(h.store))[0]!
    const reservation = { kind: 'stop' as const, reservationId: 'retire-prefix-original', ownerId: 'private-stop-owner', ownerPid: process.pid,
      agentSessionId: retiredId, operationId: 'retire-prefix', expiresAt: Date.now() + 60_000, expectedRun: record.run,
      stopOperation: { daemonInstance: 'private-native-owner', operationKey: 'retire-prefix', runId: record.run.runId } }
    await h.store.reserveLifecycle(reservation); await h.store.commitLifecycle(reservation, null)
    await h.store.compareAndSwap(null, { ...record, agentSessionId: replacementId, run: { runId: 'replacement-run' } })
    const service = new AgentMuxRpcService({ coreClients: h.coreClients })
    const prefix = await service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'retained-prefix-' } })
      .then(() => 'incorrectly rebound', error => error.code)
    expect(prefix, 'retired identity prevents prefix rebinding to a replacement').toBe('AMBIGUOUS_AGENT_SESSION')
    await expect(service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: retiredId } })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    expect((await service.call('agent.ls', {})).sessions.map(entry => entry.session.agentSessionId)).toEqual([replacementId])
    await service.dispose(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it('observes a later durable Native binding and exact status without rebuilding the live registry', async () => {
    const h = await owner(), before = h.client.agentSessions(), base = (await loadAgentSessions(h.store))[0]!
    const fresh = { ...base, agentSessionId: 'later-acp-session', run: { runId: 'later-acp-run' },
      nativeHandle: { kind: 'acp' as const, adapterId: 'private-adapter', sessionId: 'later-native-session' } }
    await h.store.compareAndSwap(null, fresh)
    const service = new AgentMuxRpcService({ coreClients: h.coreClients })
    const inspected = await service.call('agent.inspect', { target: { kind: 'acp-native', adapterId: 'private-adapter', sessionId: 'later-native-session' } })
      .then(value => value, error => ({ error: error.code }))
    expect(inspected, 'Native lookup reads the late durable binding').toMatchObject({ session: { agentSessionId: fresh.agentSessionId }, status: { run: { runId: fresh.run.runId } } })
    const listed = await service.call('agent.ls', {})
    expect(listed.sessions.map(entry => entry.session.agentSessionId)).toEqual(['caller', 'recipient', 'later-acp-session'])
    expect(listed.errors).toEqual([])
    expect(h.client.agentSessions()).toEqual(before)
    await service.dispose(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it('refuses old public Goal and operation names while leaving user text literal', () => {
    expect(() => rpcControlRequest('goal.inspect', { demandId: 'g' })).toThrow()
    expect(() => rpcControlRequest('goal.update', { goalId: 'g', patch: { parentDemandId: 'parent' } })).toThrow()
    expect(() => rpcControlRequest('space.inspect', { target: { requestId: 'old' } })).toThrow()
    expect(rpcControlRequest('goal.inspect', { goalId: 'g' })).toMatchObject({ operation: 'demand.show', demandId: 'g' })
  })
  it('preserves original Goal activity in both canonical read and snapshot', async () => {
    const goal = { id: 'g', title: 'demandId is literal prose', description: '', status: 'todo', priority: 'normal',
      projectId: null, projectName: null, assigneeExecutorId: null, sessionIds: [], tags: [], createdAt: 1, updatedAt: 2, source: 'default-topic' as const,
      activities: [{ id: 'activity-original', kind: 'progress', message: 'Real retained activity', createdAt: 1, actorId: 'caller', operationId: 'activity-op' }] }
    const service = new AgentMuxRpcService({ coreClients: () => [], execute: async request => request.operation === 'demand.activity.read'
      ? { operation: request.operation, demandId: goal.id, activities: goal.activities, diskDurability: 'confirmed' }
      : { operation: 'demand.list', demands: [goal] } })
    expect(await service.call('goal.activity', {})).toEqual({ activity: [{ goalId: 'g', ...goal.activities[0] }], diskDurability: 'confirmed' })
    const snapshot = await service.call('app.snapshot', { include: ['goals', 'activity'] })
    expect(snapshot.goals).toHaveLength(1); expect(snapshot.goals[0]!.title).toBe(goal.title); expect(snapshot.activity).toHaveLength(1)
  })
  it('rejects shape-valid results from a foreign Session, File path/Zone and swap leaf', async () => {
    const saved = { layoutApplied: false, localStorageWritten: false, storageFlushRequested: false, diskDurability: 'unconfirmed', reason: null }
    const common = { changed: false, save: null, issues: [] }
    const cases: Array<[Parameters<typeof parseRpcControlResult>[0], unknown, unknown]> = [
      ['agent.view', { agentSessionId: 'wanted' }, { ...common, scope: 'agent-session', agentSessionId: 'foreign', storedOverride: null, effectiveMode: null, sessionFacts: 'unconfirmed', regions: [], locations: [], outcome: 'unknown' }],
      ['file.view', { regionId: 'wanted' }, { ...common, scope: 'file-region', regionId: 'foreign', tabId: null, workspaceId: null, storedOverride: null, effectiveMode: null, supportedModes: null, data: 'unconfirmed', content: { status: 'unconfirmed', reason: null }, locations: [], outcome: 'unknown' }],
      ['file.open', { path: 'wanted.md', zoneId: 'wanted', focus: false }, { ...common, requestedPath: 'wanted.md', resource: { hostId: 'local', workspaceId: 'w', workspacePath: fixturePath("fixture"), zoneId: 'foreign', zonePath: fixturePath("fixture"), path: 'wanted.md' }, placement: { status: 'none', tabId: null, regionId: null, locations: [] }, data: { kind: 'not-file', reason: null }, navigation: 'background', outcome: 'refused', save: saved }],
      ['space.swap', { regionId: 'wanted', withRegionId: 'other' }, { ...common, scope: 'tab-layout', regionId: 'wanted', withRegionId: 'foreign', tabId: null, workspaceId: null, beforeOrder: [], afterOrder: [], activeRegionId: null, locations: [], outcome: 'unknown' }]
    ]
    expect(cases).toHaveLength(4)
    for (const [method, params, reply] of cases) expect(() => parseRpcControlResult(method, reply, params)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })
  it.each([false, true])('output replay/follow preserves mid-UTF8 bytes and only closes its observer (follow %s)', async follow => {
    const h = await owner(), service = new AgentMuxRpcService({ coreClients: h.coreClients }), events: any[] = []
    const subscription = await service.subscribe('agent.output', { agentSessionId: 'self', afterByte: 1, follow }, event => { events.push(event) }, { caller: h.credentials })
    if (follow) for (const push of h.observers) {
      push({ type: 'data', runId: 'run-caller', data: '中', dataBytes: Uint8Array.from([0xb8, 0xad]), startByte: 1, endByte: 3 })
      push({ type: 'exit', runId: 'run-caller', state: { type: 'exited', code: 0, signal: null }, observedAt: 2 })
    }
    await subscription.start!()
    const output = events.filter(event => event.type === 'output')
    expect(output).toHaveLength(follow ? 2 : 1)
    expect(output.flatMap(event => [...Buffer.from(event.data.dataBase64, 'base64')])).toEqual(follow ? [0xb8, 0xad] : [0xb8])
    expect(events.at(-1).type).toBe('end'); await subscription.dispose()
    expect(h.closes).toHaveBeenCalledOnce(); expect(h.inner.kernel.attach).not.toHaveBeenCalled(); expect(h.inner.kernel.detach).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it('serializes two large live chunks under slow delivery and bounds only the reader', async () => {
    let resume!: () => void, entered!: () => void
    const ready = new Promise<void>(yes => { entered = yes }), gate = new Promise<void>(yes => { resume = yes }), ranges: number[] = []
    const failure = vi.fn(), size = 2 * 128 * 1024 + 3
    const ordered = new OrderedSessionOutputFollow('run', 0, async data => {
      for (let offset = 0; offset < data.dataBytes.length; offset += 128 * 1024) {
        ranges.push(data.startByte + offset)
        if (ranges.length === 1) { entered(); await gate }
      }
    }, vi.fn(), failure)
    await ordered.finishReplayAsync([])
    const event = (start: number) => ({ type: 'terminal-output' as const, run: { runId: 'run' }, data: '', dataBytes: new Uint8Array(size),
      evidence: { source: 'terminal-output' as const, observedAt: 1, outputByteRange: { startByte: start, endByte: start + size } } })
    ordered.accept(event(0)); await ready; ordered.accept(event(size)); resume()
    await vi.waitFor(() => expect(ranges).toHaveLength(6))
    expect(ranges).toEqual([0, 128 * 1024, 256 * 1024, size, size + 128 * 1024, size + 256 * 1024])
    expect(failure).not.toHaveBeenCalled()
    let release!: () => void
    const slow = new OrderedSessionOutputFollow('run', 0, () => new Promise<void>(yes => { release = yes }), vi.fn(), failure)
    const replay = slow.finishReplayAsync([{ type: 'data', runId: 'run', startByte: 0, endByte: 1, data: 'x', dataBytes: Uint8Array.from([120]) }])
    for (let i = 0; i < 5; i++) slow.accept(event(size * i))
    expect(failure).toHaveBeenCalledOnce(); release(); await replay
  })
})
