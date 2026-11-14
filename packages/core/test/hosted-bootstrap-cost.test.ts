import { appendFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxError } from '../src/errors.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import type { AgentMuxClient } from '../src/client.js'
import type { AgentMuxHostedRpcPort } from '../src/hosted-client-contract.js'
import type { AgentMuxAgentSession, AgentMuxClientEvent } from '../src/types.js'

const session = (id: string): AgentMuxAgentSession => ({ kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'controlled',
  hostId: 'local', workspacePath: 'controlled', run: { runId: 'run-' + id }, retiredRuns: [], createdAt: 1, updatedAt: 1 })
function fixture(originals: AgentMuxAgentSession[]) {
  const sessions = new Map(originals.map(value => [value.agentSessionId, value])), listeners = new Set<(event: AgentMuxClientEvent) => void>()
  let listRunsResolved = false, releaseRuns!: () => void
  const heldRuns = new Promise<never[]>(resolve => { releaseRuns = () => { listRunsResolved = true; resolve([]) } })
  const metadata = async (id: string) => {
    if (id === 'unavailable-original') throw new Error('Original metadata is temporarily unavailable')
    return sessions.get(id) ?? null
  }
  const core = { connectRuntime: vi.fn(async () => {}), onEvent: (listener: (event: AgentMuxClientEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    runtimeIdentity: () => ({ hostId: 'local', instanceId: 'controlled', buildIdentity: 'fixture', protocolVersion: 1, processId: 1 }), catalog: () => [], agentMessageQueuePath: () => 'controlled',
    metadata: { pendingIds: () => [], read: async (id: string, consume: (value: AgentMuxAgentSession | null) => void) => consume(await metadata(id)), retainObservation: () => null },
    readAgentSessions: vi.fn(async () => [...sessions.values()]), readAgentSession: vi.fn(metadata), listRuns: vi.fn(() => heldRuns), runtimeProjection: vi.fn(async () => ({ hostId: 'local', subjects: [] })),
    runtimeSubject: vi.fn(async (target: { agentSessionId: string }) => { const value = sessions.get(target.agentSessionId)!; return { kind: 'agent', subjectId: value.agentSessionId,
      hostId: 'local', workspacePath: value.workspacePath, providerId: value.providerId, executorId: value.executorId, agentSession: value,
      run: { runId: value.run.runId, kind: 'agent', agentSessionId: value.agentSessionId, providerId: value.providerId, executorId: value.executorId, nativeService: null, workspacePath: value.workspacePath, state: 'running', pid: 1, cols: 80, rows: 24, observedAt: 1, latestOutputBytes: 0, acceptedInputBytes: 0 } } }) } as unknown as AgentMuxClient
  const service = new AgentMuxHostedRuntimeService(core, null, () => hostedTestOwner(core)), methods: string[] = []
  const readers: Array<{ dispose(): Promise<void>; end(): void }> = []
  const port: AgentMuxHostedRpcPort = {
    call: async (method, params, options) => { methods.push(method === 'runtime.invoke' ? 'runtime.invoke:' + (params as { invocation: { method: string } }).invocation.method : method); return await service.call(method, structuredClone(params), options) as never },
    subscribe: async (method: string, params: unknown, handlers: {
      onInitial(value: unknown): void; onEvent(value: unknown): void; onEnd?(error?: Error): void
    }) => {
      methods.push(method)
      const read = await service.subscribe(method, structuredClone(params), event => handlers.onEvent(structuredClone(event)))
      readers.push({ dispose: () => read.dispose(), end: () => handlers.onEnd?.(new AgentMuxError('Controlled original observation ended', 'CONTROL_UNAVAILABLE')) })
      handlers.onInitial(structuredClone(read.initial) as never); await read.start?.()
      return { dispose: () => read.dispose() }
    }
  }
  return { core, service, port, sessions, methods, releaseRuns, runsResolved: () => listRunsResolved,
    emit: (event: AgentMuxClientEvent) => { for (const listener of listeners) listener(event) },
    drop: async () => { const original = readers.at(-1)!; await original.dispose(); original.end() } }
}

it('initial bootstrap costs stay linear for actual 200 and 2000 summary consumers', async () => {
  const costs: Array<{ count: number; lookups: number; comparisons: number }> = []
  for (const count of [200, 2000]) {
    const records = Array.from({ length: count }, (_, index) => session('bootstrap-cost-' + index)), f = fixture(records)
    const client = await connectHostedAgentMux({ rpc: f.port, sessions: 'summary', connectOnDemand: true })
    let comparisons = 0, lookups = 0, statuses = 0
    const events: string[] = []
    client.onEvent(event => { if (event.type === 'agent-session') events.push(event.session.agentSessionId) })
    client.onStatusEvent(event => { if (event.type === 'agent-session') statuses++ })
    const original = Array.prototype.findIndex
    Array.prototype.findIndex = function (predicate, receiver) {
      if (this.length !== count || this[0]?.sessionProjection !== 'summary' || this[0]?.agentSessionId !== 'bootstrap-cost-0') return original.call(this, predicate, receiver)
      lookups++; return original.call(this, (value, index, array) => { comparisons++; return predicate.call(receiver, value, index, array) })
    }
    const start = performance.now()
    try {
      await client.connect()
      const elapsedMs = performance.now() - start
      const measurement = { count, initialSessionEvents: events.length, statusEvents: statuses, findIndexCalls: lookups, comparisons, elapsedMs, controlledNodeOnly: true }
      costs.push({ count, lookups, comparisons })
      if (process.env.HOSTED_SUMMARY_MEASUREMENTS) appendFileSync(process.env.HOSTED_SUMMARY_MEASUREMENTS, JSON.stringify(measurement) + '\n')
      expect(events).toEqual(records.map(value => value.agentSessionId)); expect(statuses).toBe(count)
      expect(client.agentSessions()).toEqual(records.map(value => ({ ...value, sessionProjection: 'summary' })))
      expect(f.core.readAgentSessions).toHaveBeenCalledTimes(1)
      expect(f.runsResolved(), 'The automatic process read must not hold this initial observation open').toBe(false)
    } finally { Array.prototype.findIndex = original; f.releaseRuns(); await client.dispose(); await f.service.dispose() }
  }
  expect(costs, 'An accepted complete initial array must not be searched again for each initial Session').toEqual([
    { count: 200, lookups: 0, comparisons: 0 }, { count: 2000, lookups: 0, comparisons: 0 }
  ])
})

it.each(['full', 'summary'] as const)('initial %s publication retains cache isolation, ordering and reconnect mutations', async projection => {
  const first = session('original-first'), second = session('original-second'), f = fixture([first, second])
  f.emit({ type: 'connection-state', state: 'restored', observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' }, evidence: { source: 'agentmux', observedAt: 1 } })
  const client = await connectHostedAgentMux({ rpc: f.port, sessions: projection, connectOnDemand: true }), seen: AgentMuxClientEvent[] = [], statuses: AgentMuxClientEvent[] = []
  client.onEvent(() => { throw Error('One consumer failure cannot prevent the next original publication') })
  const cachedAtFirstPublication: string[][] = []
  client.onEvent(event => {
    seen.push(structuredClone(event))
    if (event.type === 'agent-session' && event.session.agentSessionId === first.agentSessionId)
      cachedAtFirstPublication.push(client.agentSessions().map(value => value.agentSessionId))
  })
  client.onStatusEvent(event => { statuses.push(structuredClone(event)); if (event.type === 'agent-session') event.session.workspacePath = 'consumer-private-edit' })
  try {
    await client.connect(); f.releaseRuns()
    expect(seen.slice(0, 3).map(event => event.type === 'agent-session' ? event.session.agentSessionId : event.type)).toEqual([first.agentSessionId, second.agentSessionId, 'connection-state'])
    expect(statuses.slice(0, 3).map(event => event.type)).toEqual(['agent-session', 'agent-session', 'connection-state'])
    expect(client.agentSession(first.agentSessionId).workspacePath).toBe(first.workspacePath)
    expect(cachedAtFirstPublication).toEqual([[first.agentSessionId, second.agentSessionId]])
    expect(f.methods.slice(0, 2)).toEqual(['runtime.owner.identity', 'runtime.events'])
    const changed = { ...first, updatedAt: 2 }, added = session('later-added')
    f.sessions.set(first.agentSessionId, changed); f.sessions.set(added.agentSessionId, added)
    f.emit({ type: 'agent-session', session: changed }); f.emit({ type: 'agent-session', session: added })
    await vi.waitFor(() => expect(client.agentSessions().map(value => [value.agentSessionId, value.updatedAt])).toEqual([[first.agentSessionId, 2], [second.agentSessionId, 1], [added.agentSessionId, 1]]))
    f.sessions.delete(second.agentSessionId)
    f.emit({ type: 'run-removed', agentSessionId: second.agentSessionId, run: second.run, evidence: { source: 'agentmux', observedAt: 3 } })
    await vi.waitFor(() => expect(client.agentSessions().map(value => value.agentSessionId)).toEqual([first.agentSessionId, added.agentSessionId]))
    const beforeReconnect = seen.length
    await f.drop(); await client.connect()
    await vi.waitFor(() => expect(seen.slice(beforeReconnect).filter(event => event.type === 'agent-session').map(event => event.session.agentSessionId)).toEqual([first.agentSessionId, added.agentSessionId]))
    expect(client.agentSession(first.agentSessionId).updatedAt).toBe(2)
    const after = { ...added, updatedAt: 4 }; f.emit({ type: 'agent-session', session: after })
    await vi.waitFor(() => expect(client.agentSession(added.agentSessionId).updatedAt).toBe(4))
  } finally { f.releaseRuns(); await client.dispose(); await f.service.dispose() }
})

it('initial scoped publication retains missing and unavailable until their exact later events', async () => {
  const original = session('scoped-original'), f = fixture([original]), missing = 'missing-original', unavailable = 'unavailable-original'
  const client = await connectHostedAgentMux({ rpc: f.port, sessions: 'summary', connectOnDemand: true, agentSessionIds: [original.agentSessionId, missing, unavailable] })
  const seen: AgentMuxClientEvent[] = []; client.onEvent(event => seen.push(structuredClone(event)))
  try {
    await client.connect()
    expect(client.agentSessions().map(value => value.agentSessionId)).toEqual([original.agentSessionId])
    expect(client.sessionObservationScope()).toMatchObject({ agentSessionIds: [original.agentSessionId, missing, unavailable], missing: [missing], unavailable: [{ agentSessionId: unavailable }] })
    expect(f.core.readAgentSessions).not.toHaveBeenCalled(); expect(f.core.listRuns).not.toHaveBeenCalled(); expect(f.core.runtimeProjection).not.toHaveBeenCalled()
    f.emit({ type: 'agent-session', session: session('unrelated-original') })
    f.emit({ type: 'agent-session', session: session(missing) }); f.emit({ type: 'agent-session', session: session(unavailable) })
    await vi.waitFor(() => expect(client.sessionObservationScope()).toMatchObject({ missing: [], unavailable: [] }))
    expect(seen.filter(event => event.type === 'agent-session').map(event => event.session.agentSessionId)).toEqual([original.agentSessionId, missing, unavailable])
  } finally { f.releaseRuns(); await client.dispose(); await f.service.dispose() }
})
