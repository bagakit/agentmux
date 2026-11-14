import { expect, it, vi } from 'vitest'
import { connectRelayHostedClient } from '../src/relay-hosted.js'
import { connectHostedAgentMux, type AgentMuxHostedSessionObservation } from '../src/hosted.js'
import { AgentMuxRpcService, type AgentMuxRpcCoreClient } from '../src/public-rpc-service.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import type { AgentMuxHostedRpcPort, AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'
import type { AgentMuxClientEvent } from '../src/types.js'
import { AgentMuxError } from '../src/errors.js'
import { actualRelayOwner, carrierFact, held } from './helpers/relay-carrier-owner.js'

it('the original encrypted Relay returns exact control while the complete session opening is held', async () => {
  const f = await actualRelayOwner(), entered = held(), release = held()
  const original = f.host.client.readAgentSessions.bind(f.host.client)
  vi.spyOn(f.host.client, 'readAgentSessions').mockImplementationOnce(async () => {
    entered.resolve(); await release.promise; return await original()
  })
  const controller = new AbortController()
  let client: Awaited<ReturnType<typeof connectRelayHostedClient>> | undefined
  const opening = connectRelayHostedClient({ ...f.options, name: 'exact first reader', signal: controller.signal,
    sessions: 'summary', waitForReady: false }).then(value => { client = value; f.cleanup(() => value.dispose()); return value })
  try {
    await entered.promise
    await new Promise(resolve => setImmediate(resolve))
    expect(client, 'Exact control must be returned before the held whole-Host directory').toBeDefined()
    const unconfirmed: AgentMuxHostedSessionObservation = client!.sessionObservation()
    expect(unconfirmed).toEqual({ state: 'unconfirmed', hasSnapshot: false })
    expect(() => client!.agentSessions()).toThrow(expect.objectContaining({ code: 'HOSTED_SESSION_OBSERVATION_UNCONFIRMED' }))
    expect(() => client!.catalog()).toThrow(expect.objectContaining({ code: 'HOSTED_SESSION_OBSERVATION_UNCONFIRMED' }))
    expect((await client!.readAgentSession('caller'))?.run).toEqual({ runId: 'run-caller' })
    const sessionEvents: AgentMuxClientEvent[] = []
    client!.onStatusEvent(event => { if (event.type === 'agent-session') sessionEvents.push(event) })
    const actualStatuses: Awaited<ReturnType<typeof f.host.client.statusAgent>>[] = []
    const readStatus = f.host.client.statusAgent.bind(f.host.client)
    vi.spyOn(f.host.client, 'statusAgent').mockImplementation(async id => {
      const value = await readStatus(id); actualStatuses.push(structuredClone(value)); return value
    })
    const first = await client!.statusAgent('caller'), second = await client!.statusAgent('caller')
    expect([first, second]).toEqual(actualStatuses)
    expect(first.session.agentSessionId).toBe('caller'); expect(first.run.runId).toBe('run-caller')
    expect(sessionEvents, 'Exact status receipts before a directory snapshot must not publish self-triggering Session mutations').toEqual([])
    const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'relay', client: client! }] as AgentMuxRpcCoreClient[] })
    f.cleanup(() => service.dispose())
    expect((await service.call('agent.inspect', { target: { kind: 'run', run: { runId: 'run-caller' } } })).session.agentSessionId).toBe('caller')
    expect(f.requests.filter(value => value.frame.method === 'device.hello')).toHaveLength(1)
    expect(f.requests.filter(value => value.frame.method === 'runtime.owner.identity')).toHaveLength(1)
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
    release.resolve(); await client!.connect()
    expect(client!.sessionObservation()).toEqual({ state: 'ready', hasSnapshot: true })
    expect(client!.agentSessions().map(session => session.agentSessionId)).toContain('caller')
    carrierFact({ kind: 'exact-before-complete-catalog', hostId: f.authority.hostId,
      sessionId: 'caller', runId: 'run-caller', ownerRequests: 1, stopCalls: 0 })
  } finally { release.resolve(); await opening; controller.abort() }
})

it('a failed encrypted directory keeps its snapshot and healthy exact control, then independently recovers', async () => {
  const f = await actualRelayOwner(), client = await f.hosted(), entered = held(), release = held()
  const retained = client.agentSessions(), seen: AgentMuxClientEvent[] = []
  client.onStatusEvent(event => { seen.push(event) })
  const owner = client.runtimeOwnerIdentity(), before = f.requests.filter(value => value.frame.method === 'runtime.owner.identity').length
  const original = f.host.client.readAgentSessions.bind(f.host.client)
  vi.spyOn(f.host.client, 'readAgentSessions').mockImplementationOnce(async () => { entered.resolve(); await release.promise; return await original() })
  let failed = false
  f.reply(async (frame, _connection, send) => {
    if (!failed && frame.method === 'system.subscription.event' && frame.params?.method === 'runtime.events') {
      failed = true
      await send({ ...frame, params: { ...frame.params, event: { type: 'error', error: { code: 'CONTROL_UNAVAILABLE', message: 'Only this directory stream ended.' } } } })
    } else await send(frame)
  })
  try {
    await f.host.client.saveAgentFuturePromptIntent({ agentSessionId: 'caller', intentId: 'directory-proof', operationId: 'directory-proof-op', prompt: 'retained exact body', active: false })
    await vi.waitFor(() => expect(client.sessionObservation()).toMatchObject({ state: 'unavailable', hasSnapshot: true }))
    expect(client.agentSessions()).toEqual(retained)
    expect(client.runtimeOwnerIdentity()).toEqual(owner)
    expect((await client.readAgentSession('caller'))?.run.runId).toBe('run-caller')
    expect((await client.readAgentFuturePromptIntent('caller', 'directory-proof'))?.prompt).toBe('retained exact body')
    expect(seen.some(event => event.type === 'session-observation-state' && event.observation.state === 'unavailable')).toBe(true)
    expect(seen.some(event => event.type === 'connection-state' && event.observationOrigin.boundary === 'consumer-core'),
      'A directory outage cannot revoke healthy control or input').toBe(false)
    const reconnecting = client.connect(); await entered.promise; release.resolve(); await reconnecting
    expect(client.sessionObservation()).toEqual({ state: 'ready', hasSnapshot: true })
    expect(f.requests.filter(value => value.frame.method === 'runtime.owner.identity')).toHaveLength(before)
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { release.resolve() }
})

it('one control discovery serves concurrent exact reads and a released old reply cannot replace a newer admission', async () => {
  const f = await actualRelayOwner(), entered = held(), release = held()
  let owner = (await f.rpc.call('runtime.owner.identity', {})).owner as AgentMuxRuntimeOwnerIdentity
  const service = new AgentMuxHostedRuntimeService(f.host.client, null, () => owner)
  f.cleanup(() => service.dispose())
  let calls = 0, firstOwner: AgentMuxRuntimeOwnerIdentity | undefined
  const rpc = {
    call: async (method, params, context) => {
      const result = await service.call(method, params, context)
      if (method === 'runtime.owner.identity') {
        calls++
        if (calls === 1) { firstOwner = result.owner; entered.resolve(); await release.promise }
      }
      return result
    },
    subscribe: f.rpc.subscribe.bind(f.rpc)
  } as AgentMuxHostedRpcPort
  const client = await connectHostedAgentMux({ rpc, connectOnDemand: true })
  f.cleanup(() => client.dispose())
  const old = client.readRuntimeOwnerIdentity().then(value => value, error => error)
  const joined = client.readRuntimeOwnerIdentity().then(value => value, error => error)
  try {
    await entered.promise
    expect(calls).toBe(1)
    client.disconnect()
    owner = { ...owner, ownerInstanceId: owner.ownerInstanceId + '-new-admission' }
    const current = await client.readRuntimeOwnerIdentity()
    expect(calls).toBe(2)
    release.resolve()
    expect(await old).toMatchObject({ code: 'CONTROL_CANCELLED' })
    expect(await joined).toMatchObject({ code: 'CONTROL_CANCELLED' })
    expect(client.runtimeOwnerIdentity()).toEqual(current)
    expect(firstOwner?.ownerInstanceId).not.toEqual(current.ownerInstanceId)
    expect((await client.readAgentSession('caller'))?.run.runId).toBe('run-caller')
    expect(calls).toBe(2)
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { release.resolve(); await old; await joined }
})

it('default Relay opening still waits for the complete directory, and confirmed empty is explicitly ready', async () => {
  const f = await actualRelayOwner({ sessionIds: [] }), entered = held(), release = held()
  const original = f.host.client.readAgentSessions.bind(f.host.client)
  vi.spyOn(f.host.client, 'readAgentSessions').mockImplementationOnce(async () => { entered.resolve(); await release.promise; return await original() })
  let ready = false
  const opening = f.hosted().then(client => { ready = true; return client })
  try {
    await entered.promise; await new Promise(resolve => setImmediate(resolve))
    expect(ready).toBe(false)
    release.resolve(); expect((await opening).agentSessions()).toHaveLength(0)
    const empty = await connectHostedAgentMux({ rpc: f.rpc, waitForReady: false })
    f.cleanup(() => empty.dispose())
    const seen: AgentMuxClientEvent[] = []; empty.onStatusEvent(event => { seen.push(event) })
    await empty.connect()
    expect(empty.agentSessions()).toEqual([])
    expect(empty.sessionObservation()).toEqual({ state: 'ready', hasSnapshot: true })
    expect(seen).toContainEqual(expect.objectContaining({ type: 'session-observation-state', observation: { state: 'ready', hasSnapshot: true } }))
  } finally { release.resolve(); await opening }
})

it('cancelled early Relay admission releases its own discovery and does not retry or stop the healthy owner', async () => {
  const f = await actualRelayOwner(), entered = held(), release = held(), signal = new AbortController()
  const before = f.activeSockets().length
  const requests = new Set<string | number>()
  f.reply(async (frame, connection, send) => {
    const request = f.requests.find(value => value.connection === connection && value.frame.id === frame.id)
    if (request?.frame.method === 'runtime.owner.identity') { requests.add(frame.id as string); entered.resolve(); await release.promise }
    await send(frame)
  })
  const opening = connectRelayHostedClient({ ...f.options, name: 'cancelled early reader', signal: signal.signal, waitForReady: false }).then(value => value, error => error)
  try {
    await entered.promise; signal.abort(new AgentMuxError('This reader was explicitly cancelled.', 'CONTROL_CANCELLED')); const result = await opening
    expect(result).toBeInstanceOf(AgentMuxError)
    expect(result.code).toBe('CONTROL_CANCELLED')
    release.resolve()
    await vi.waitFor(() => expect(f.activeSockets().length).toBeLessThanOrEqual(before))
    await new Promise(resolve => setTimeout(resolve, 160))
    expect(requests.size, 'A cancelled admission cannot reacquire directory retries').toBe(1)
    expect((await f.host.client.readAgentSession('caller'))?.run.runId).toBe('run-caller')
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { signal.abort(); release.resolve(); await opening }
})

it('rejects an old initial Session body after exact control confirms a newer semantic owner', async () => {
  const f = await actualRelayOwner(), entered = held(), release = held()
  let owner = (await f.rpc.call('runtime.owner.identity', {})).owner as AgentMuxRuntimeOwnerIdentity
  const service = new AgentMuxHostedRuntimeService(f.host.client, null, () => owner)
  f.cleanup(() => service.dispose())
  let hold = true, foreignOpening = false
  // The original service is the authority; only delivery of its first body is held.
  const rpc = {
    call: service.call.bind(service),
    subscribe: async (method, params, handlers) => {
      const subscription = await service.subscribe(method, params, async event => {
        if (hold) { hold = false; entered.resolve(); await release.promise }
        handlers.onEvent(event)
      }, { signal: handlers.signal })
      try {
        handlers.onInitial(foreignOpening ? { ...subscription.initial as object, owner: { ...owner, ownerInstanceId: 'foreign-opening' } } : subscription.initial)
      } catch (error) { await subscription.dispose(); throw error }
      void subscription.start?.()
      return { dispose: subscription.dispose }
    }
  } as AgentMuxHostedRpcPort
  const client = await connectHostedAgentMux({ rpc, waitForReady: false, sessions: 'summary' })
  f.cleanup(() => client.dispose())
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => { events.push(event) })
  const opening = client.connect().then(() => null, error => error)
  try {
    await entered.promise
    owner = { ...owner, ownerInstanceId: owner.ownerInstanceId + '-renewed' }
    await expect(client.readAgentSession('caller')).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
    expect((await client.readRuntimeOwnerIdentity()).ownerInstanceId).toBe(owner.ownerInstanceId)
    release.resolve(); await opening
    expect(events.filter(event => event.type === 'agent-session' || event.type === 'process-state'),
      'No old initial Session or Run can be adopted under the newer semantic owner').toEqual([])
    expect(client.sessionObservation().hasSnapshot).toBe(false)
    expect((await client.readAgentSession('caller'))?.run.runId).toBe('run-caller')
    await client.connect()
    expect(client.sessionObservation()).toEqual({ state: 'ready', hasSnapshot: true })
    expect(client.runtimeOwnerIdentity()?.ownerInstanceId).toBe(owner.ownerInstanceId)
    client.disconnect(); foreignOpening = true
    const confirmed = await client.readRuntimeOwnerIdentity()
    await expect(client.connect()).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    expect(client.sessionObservation().diagnostic?.code).toBe('CONTROL_PROTOCOL_ERROR')
    expect(client.runtimeOwnerIdentity(), 'A foreign directory header is not authority to revoke the confirmed control fence').toEqual(confirmed)
    expect((await client.readAgentSession('caller'))?.run.runId).toBe('run-caller')
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { release.resolve(); await opening }
})
