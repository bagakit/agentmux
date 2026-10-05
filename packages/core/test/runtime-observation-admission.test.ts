import { randomBytes } from 'node:crypto'
import { AgentMuxError } from '../src/errors.js'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import type { AgentMuxHostedRpcPort } from '../src/hosted-client-contract.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { hostedTestOwner, hostedTestFence } from './helpers/hosted-runtime-port.js'

it('original healthy Run input remains available while an unrelated Session write delays reconnect observation', async () => {
  const h = await rpcOwnerFixture(['slow', 'healthy']), inner = h.client as any
  Object.assign(inner.hookServer, { port: 0 })
  let release!: () => void, entered = false
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(h.store, 'compareAndSwapMetadata').mockImplementation(async () => { entered = true; await gate })
  const writer = inner.registry.update('slow', { runId: 'run-slow' }, (current: any) => ({ ...current, updatedAt: current.updatedAt + 1 }))
  await vi.waitFor(() => expect(entered).toBe(true))
  const load = vi.spyOn(inner.registry, 'load')
  inner.connected = false
  inner.kernel.connect = vi.fn(async () => {})
  inner.kernel.list = vi.fn(async () => [])
  inner.kernel.identity = () => ({ buildIdentity: 'isolated', protocolVersion: 1, daemonInstanceId: 'original-daemon' })
  inner.kernel.input = vi.fn(async () => ({ run: { acceptedInputBytes: 1 }, appliedByteRange: { startByte: 0, endByte: 1 } }))
  let settled = false
  const connect = h.client.connect().finally(() => { settled = true })
  try {
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    await expect(h.client.writeTerminal({ runId: 'run-healthy' }, { ownerInstanceId: 'original-daemon', operationId: 'original-input', expectedByte: 0, data: 'x' }))
      .resolves.toMatchObject({ runId: 'run-healthy', acceptedThroughByte: 1 })
    expect(inner.kernel.input).toHaveBeenCalledExactlyOnceWith('run-healthy', { ownerInstanceId: 'original-daemon', operationId: 'original-input', expectedByte: 0, data: 'x' })
    expect(h.client.agentSessions().map(session => session.agentSessionId)).toEqual(['slow', 'healthy'])
  } finally { release(); await writer; await connect; await h.close(); vi.restoreAllMocks() }
})

it('Hosted confirms only transport for exact input after store observation failure and preserves owner fences', async () => {
  const core = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  let connected = false
  const input = vi.fn(async () => ({ run: { acceptedInputBytes: 1 }, appliedByteRange: { startByte: 0, endByte: 1 } }))
  const kernel = { connect: vi.fn(async () => { connected = true }), isConnected: () => connected,
    disconnect: async () => { connected = false }, resetConnection: () => { connected = false },
    onEvent: () => () => {}, onError: () => () => {}, onConnectionLost: () => () => {}, input,
    identity: () => ({ buildIdentity: 'private-proof', protocolVersion: 1, daemonInstanceId: 'original-daemon' }) }
  const inner = core as any; inner.kernel = kernel
  const load = vi.spyOn(inner.registry, 'load').mockRejectedValue(new Error('private store observation unavailable'))
  const service = new AgentMuxHostedRuntimeService(core, null, () => hostedTestOwner(core))
  const consumer = await service.subscribe('runtime.events', { fence: hostedTestFence, consumerId: 'proof-consumer' }, () => {})
  await consumer.start?.()
  try {
    await expect(core.connect()).rejects.toThrow('private store observation unavailable')
    const invoke = (fence: unknown) => service.call('runtime.invoke', { fence, consumerId: 'proof-consumer',
      invocation: { method: 'writeTerminal', args: [{ runId: 'original-run' }, { ownerInstanceId: 'original-daemon', operationId: 'original-input', expectedByte: 0, data: 'x' }] } })
    await expect(invoke(hostedTestFence)).resolves.toMatchObject({ value: { runId: 'original-run', acceptedThroughByte: 1 } })
    expect(load).toHaveBeenCalledOnce()
    expect(kernel.connect).toHaveBeenCalledOnce()
    await expect(invoke({ ...hostedTestFence, ownerInstanceId: 'other-owner' })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
    expect(input).toHaveBeenCalledOnce()
  } finally { await consumer.dispose(); await service.dispose(); await core.dispose(); vi.restoreAllMocks() }
})

it('automatically recovers a later transport loss while the older full observation remains pending', async () => {
  const h = await rpcOwnerFixture(['retained'])
  const inner = h.client as any
  Object.assign(inner.hookServer, { port: 0 })
  let release!: () => void, transportConnected = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const originalLoad = inner.registry.load.bind(inner.registry)
  const load = vi.spyOn(inner.registry, 'load').mockImplementationOnce(async (hostId: string, assertCurrent?: () => void) => { await gate; await originalLoad(hostId, assertCurrent) })
  inner.kernel.isConnected = () => transportConnected
  inner.kernel.connect = vi.fn(async () => { transportConnected = true })
  inner.kernel.resetConnection = () => { transportConnected = false }
  inner.kernel.list = vi.fn(async () => [])
  inner.kernel.identity = () => ({ buildIdentity: 'isolated', protocolVersion: 1, daemonInstanceId: 'isolated' })
  inner.reconnectSleep = async () => {}
  inner.connected = false
  const opening = h.client.connect(); void opening.catch(() => {})
  try {
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    expect(transportConnected).toBe(true)
    expect(inner.connected).toBe(true)
    transportConnected = false
    inner.handleConnectionLost(inner.connectionEpoch)
    await vi.waitFor(() => expect(inner.kernel.connect).toHaveBeenCalledTimes(2))
    expect(transportConnected).toBe(true)
    expect(load).toHaveBeenCalledTimes(2) // A new observer starts independently; the original one remains pending.
    expect(h.client.agentSession('retained').run.runId).toBe('run-retained')
  } finally { release(); await opening.catch(() => {}); await h.close(); vi.restoreAllMocks() }
})

it('late old Run snapshot cannot mutate the new transport observation', async () => {
  const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  const state = client as any
  let connected = false, release!: (runs: unknown[]) => void
  const pending = new Promise<unknown[]>(resolve => { release = resolve })
  Object.assign(state.hookServer, { port: 0 })
  const kernel = { connect: vi.fn(async () => { connected = true }), isConnected: () => connected,
    disconnect: () => { connected = false }, resetConnection: vi.fn(() => { connected = false }),
    onEvent: () => () => {}, onError: () => () => {}, onConnectionLost: () => () => {},
    list: vi.fn().mockReturnValueOnce(pending).mockResolvedValue([]) }
  state.kernel = kernel; state.reconnectSleep = async () => {}
  const consume = vi.spyOn(state, 'backfillEndedRuns')
  const old = client.connect(); void old.catch(() => {})
  try {
    await vi.waitFor(() => expect(kernel.list).toHaveBeenCalledTimes(1))
    const oldEpoch = state.connectionEpoch
    connected = false; state.handleConnectionLost(oldEpoch)
    await vi.waitFor(() => expect(kernel.connect).toHaveBeenCalledTimes(2))
    const stale = { runId: 'old-snapshot-only', pid: 111, state: { type: 'exited', code: 0, signal: null } }
    release([stale]); await old.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(consume.mock.calls.some(([runs]) => (runs as any[]).some(run => run.runId === stale.runId))).toBe(false)
    expect(state.runPids.has(stale.runId)).toBe(false)
    expect(state.endedRuns.has(stale.runId)).toBe(false)
    expect(connected).toBe(true)
  } finally { release([]); await old.catch(() => {}); await client.dispose(); vi.restoreAllMocks() }
})

it('the real Hosted SDK admits original transport input while its bootstrap projection awaits Session observation', async () => {
  const h = await rpcOwnerFixture(['retained']), core = h.client, inner = core as any
  Object.assign(inner.hookServer, { port: 0 })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const load = vi.spyOn(inner.registry, 'load').mockImplementation(async () => { await gate })
  inner.connected = false
  inner.kernel.connect = vi.fn(async () => {})
  inner.kernel.list = vi.fn(async () => [])
  inner.kernel.input = vi.fn(async () => ({ run: { acceptedInputBytes: 1 }, appliedByteRange: { startByte: 0, endByte: 1 } }))
  inner.kernel.identity = () => ({ buildIdentity: 'isolated', protocolVersion: 1, daemonInstanceId: 'original-daemon' })
  const service = new AgentMuxHostedRuntimeService(core, null, () => hostedTestOwner(core))
  const port = {
    call: async (method: string, params: unknown) => JSON.parse(JSON.stringify(await service.call(method, JSON.parse(JSON.stringify(params))))),
    subscribe: async (method: string, params: unknown, handlers: Parameters<AgentMuxHostedRpcPort['subscribe']>[2]) => {
      const stream = await service.subscribe(method, params, event => handlers.onEvent(JSON.parse(JSON.stringify(event))))
      handlers.onInitial(JSON.parse(JSON.stringify(stream.initial)))
      await stream.start?.()
      return { dispose: async () => { await stream.dispose() } }
    }
  } as AgentMuxHostedRpcPort
  const sdk = await connectHostedAgentMux({ rpc: port, waitForReady: false })
  let admission: Promise<void> | undefined
  try {
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    let admitted = false
    admission = sdk.connectRuntime().then(() => { admitted = true })
    void admission.catch(() => {})
    await vi.waitFor(() => expect(admitted).toBe(true))
    await admission
    await expect(sdk.writeTerminal({ runId: 'run-retained' }, { ownerInstanceId: 'original-daemon', operationId: 'original-sdk-input', expectedByte: 0, data: 'x' }))
      .resolves.toMatchObject({ runId: 'run-retained', acceptedThroughByte: 1 })
    expect(load).toHaveBeenCalledOnce()
    expect(inner.kernel.input).toHaveBeenCalledExactlyOnceWith('run-retained', { ownerInstanceId: 'original-daemon', operationId: 'original-sdk-input', expectedByte: 0, data: 'x' })
    expect(sdk.agentSession('retained').run.runId).toBe('run-retained')
  } finally { release(); await admission?.catch(() => {}); await sdk.dispose(); await service.dispose(); await h.close(); vi.restoreAllMocks() }
})

it('a fully observed healthy connect does not emit recovery or repeat unrelated directory work', async () => {
  const h = await rpcOwnerFixture(['healthy']), inner = h.client as any, events: unknown[] = []
  const load = vi.spyOn(inner.registry, 'load')
  h.client.onEvent(event => events.push(event))
  try {
    await Promise.all([h.client.connect(), h.client.connect()])
    await h.client.connect()
    expect(load).not.toHaveBeenCalled()
    expect(events).toEqual([])
  } finally { await h.close(); vi.restoreAllMocks() }
})

it('late old handshake failure cannot mark the recovered original Agent unhealthy', async () => {
  const h = await rpcOwnerFixture(['retained']), state = h.client as any
  const [stored] = await h.store.load() as any[]
  await h.store.compareAndSwap(stored, { ...stored, hookBindingId: randomBytes(32).toString('base64url'), hookToken: randomBytes(32).toString('base64url') })
  let connected = false, reject!: (error: Error) => void
  const oldHandshake = new Promise<void>((_resolve, fail) => { reject = fail })
  void oldHandshake.catch(() => {})
  Object.assign(state.hookServer, { port: 0 })
  state.kernel.isConnected = () => connected
  state.kernel.connect = vi.fn(async () => { connected = true })
  state.kernel.resetConnection = () => { connected = false }
  state.kernel.list = vi.fn(async () => [h.run('run-retained')])
  state.kernel.hasAttachment = () => true
  state.reconnectSleep = async () => {}; state.connected = false
  const handshake = vi.spyOn(state, 'ensureTerminalHandshakeOrDegrade').mockReturnValueOnce(oldHandshake)
    .mockImplementation(async session => session)
  const events: any[] = []; h.client.onEvent(event => { events.push(event) })
  const old = h.client.connect(); void old.catch(() => {})
  try {
    await vi.waitFor(() => expect(handshake).toHaveBeenCalledOnce())
    connected = false; state.handleConnectionLost(state.connectionEpoch)
    await vi.waitFor(() => expect(handshake).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(events.some(event => event.type === 'connection-state' && event.state === 'restored' && !event.diagnostic)).toBe(true))
    reject(new AgentMuxError('Old transport could not observe the original Run.', 'AGENT_TERMINAL_HANDSHAKE_FAILED'))
    await old.catch(() => {})
    expect(events.filter(event => event.type === 'agent-error' && event.code === 'AGENT_TERMINAL_HANDSHAKE_FAILED')).toEqual([])
    expect(connected).toBe(true)
  } finally { reject(new Error('private cleanup')); await old.catch(() => {}); await h.close(); vi.restoreAllMocks() }
})
