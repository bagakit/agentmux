import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { RECONNECT_MAX_ATTEMPTS } from '../src/ctxmux-reconnect.js'
import type { AgentMuxClientEvent, AgentMuxRunAttachment, AgentSessionHistoryObservation } from '../src/types.js'
import { AgentMuxHostedRuntimeService as SourceHostedService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux as SourceConnectHosted } from '../src/hosted-client.js'
import type { AgentMuxHostedClient, AgentMuxHostedRpcPort } from '../src/hosted-client-contract.js'
import { hostedTestOwner, hostedTestFence as fence, logicalHostedEvents } from './helpers/hosted-runtime-port.js'
import { hostedTransfer, encodeHostedValue, decodeHostedValue } from '../src/hosted-value.js'
const connectHostedAgentMux: typeof SourceConnectHosted = process.env.AGENTMUX_TEST_CLIENT_ENTRY
  ? (await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_CLIENT_ENTRY)).connectHostedAgentMux : SourceConnectHosted
const AgentMuxHostedRuntimeService: typeof SourceHostedService = process.env.AGENTMUX_TEST_SERVICE_ENTRY
  ? (await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_SERVICE_ENTRY)).AgentMuxHostedRuntimeService : SourceHostedService
type AgentMuxHostedRuntimeService = SourceHostedService


function fixture() {
  let eventListener: ((event: AgentMuxClientEvent) => void) | undefined
  const attachment: AgentMuxRunAttachment = { run: {
    nativeService: null,
    runId: 'original-run', kind: 'terminal', providerId: null, executorId: null, agentSessionId: null,
    workspacePath: upstreamFixturePath("private-workspace"), pid: 421, state: 'running', cols: 100, rows: 30,
    observedAt: 1, latestOutputBytes: 0, acceptedInputBytes: 0
  }, replay: [], gap: null, terminal: { type: 'not-requested' }, resizeRevision: 0 }
  const core = {
    connect: vi.fn(async () => {}),
    onEvent: vi.fn((listener: (event: AgentMuxClientEvent) => void) => { eventListener = listener; return () => {} }),
    runtimeIdentity: () => ({ hostId: 'local', instanceId: 'original-daemon', buildIdentity: 'private-fixture', protocolVersion: 1, processId: 123, ownership: 'owned' as const }),
    catalog: () => [], agentSessions: () => [], agentMessageQueuePath: () => upstreamFixturePath("original-store/messages.ndjson"),
    refreshRunAttachment: vi.fn(async () => attachment), readRunReplay: vi.fn(async () => attachment),
    runtimeProjection: vi.fn(async () => ({ hostId: 'local', subjects: [{ kind: 'terminal', run: attachment.run }] })),
    observeSessionHistory: vi.fn(async (_id: string, _listener: (value: AgentSessionHistoryObservation) => void) => ({ source: { providerId: 'codex', nativeSessionId: 'original-native' }, dispose: vi.fn() })),
    submitAgentPrompt: vi.fn(async () => {}),
    sessionHistorySources: vi.fn(async () => [{ agentSessionId: 'a123456789012345', providerId: 'codex' }]),
    inspectManagedHooks: vi.fn(async () => ({ status: 'installed' })),
    authorizeAgentCaller: vi.fn(async () => {}), handOff: vi.fn(async () => ({ accepted: true })),
    releaseRunAttachment: vi.fn(async () => {}), stopTerminal: vi.fn(async () => {})
  }
  const service = new AgentMuxHostedRuntimeService(core as unknown as AgentMuxClient, upstreamFixturePath("original-store/sessions.json"), () => hostedTestOwner(core as unknown as AgentMuxClient))
  const eventsA: unknown[] = [], eventsB: unknown[] = []
  const subscribe = async (consumerId: string, events: unknown[]) => {
    const subscription = await service.subscribe('runtime.events', { fence, consumerId }, logicalHostedEvents(value => { if ((value as { type?: string }).type === 'snapshot') events.push(value) }))
    await subscription.start?.(); return subscription
  }
  const invoke = (consumerId: string, method: string, args: unknown[]) => service.call('runtime.invoke', { fence, consumerId, invocation: { method, args } })
  const output = (runId: string) => eventListener!({ type: 'terminal-output', run: { runId }, data: 'x', dataBytes: Uint8Array.of(120),
    evidence: { source: 'terminal-output', observedAt: 2, run: { runId }, outputByteRange: { startByte: 0, endByte: 1 } } })
  return { core, service, eventsA, eventsB, subscribe, invoke, output, emit: (event: AgentMuxClientEvent) => eventListener!(event) }
}

function rpcPort(service: AgentMuxHostedRuntimeService) {
  const connections: Array<{ method: string; close(error?: Error): Promise<void> }> = []
  const calls: Array<{ method: string; params: unknown; signal: AbortSignal | undefined }> = []
  const port = {
    call: async (method: string, params: unknown, options?: { signal?: AbortSignal }) => {
      const transmitted = JSON.parse(JSON.stringify(params))
      calls.push({ method, params: transmitted, signal: options?.signal })
      return JSON.parse(JSON.stringify(await service.call(method, transmitted, options)))
    },
    subscribe: async (method: string, params: unknown, handlers: {
      onInitial(value: unknown): void; onEvent(value: unknown): void; onEnd?(error?: Error): void; signal?: AbortSignal
    }) => {
      let closed = false
      const server = await service.subscribe(method, params, value => {
        handlers.onEvent(value)
        if (value.type === 'end' && !closed) { closed = true; handlers.onEnd?.() }
      }, handlers.signal ? { signal: handlers.signal } : {})
      const close = async (error = new Error('Private test transport disconnected')) => {
        if (closed) return; closed = true
        await server.dispose(); handlers.onEnd?.(error)
      }
      try { handlers.onInitial(server.initial); await server.start?.() }
      catch (error) { await close(); throw error }
      connections.push({ method, close })
      return { dispose: close }
    }
  } as unknown as AgentMuxHostedRpcPort
  return { port, connections, calls }
}

describe('semantic Host observation consumers', () => {
  it('recovers the original Core after its actual bounded reconnect has exhausted, on the next explicit Hosted business retry', async () => {
    const core = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
    let connected = false, unavailable = false, connectionLost!: () => void
    const run = { runId: 'original-run', lifecycleOperationId: null, program: upstreamFixturePath("private-agent"), args: [],
      workspacePath: upstreamFixturePath("private-workspace"), pid: 421, state: { type: 'running' as const },
      cols: 100, rows: 30, latestOutputBytes: 12, firstAvailableByte: 0, acceptedInputBytes: 0 }
    const kernel = {
      isConnected: () => connected,
      connect: vi.fn(async () => { if (unavailable) throw new Error('Private ctxmux connection unavailable'); connected = true }),
      resetConnection: vi.fn(() => { connected = false }), disconnect: vi.fn(() => { connected = false }),
      identity: () => ({ buildIdentity: 'private-ctxmux', protocolVersion: 1, daemonInstanceId: 'original-daemon' }),
      list: vi.fn(async () => [run]), onEvent: () => () => {}, onError: () => () => {},
      onConnectionLost: (listener: () => void) => { connectionLost = listener; return () => {} },
      stop: vi.fn(async () => {})
    }
    // The Core connect/open/reconnect/requireConnected code stays real; only its Runtime collaborator is controlled.
    Object.assign(core, { kernel, reconnectSleep: async () => {} })
    const service = new AgentMuxHostedRuntimeService(core, null, () => hostedTestOwner(core))
    const facts: unknown[] = []
    const consumer = await service.subscribe('runtime.events', { fence, consumerId: 'consumer-a' }, logicalHostedEvents(value => { facts.push(value) })); await consumer.start?.()
    try {
      await core.connect()
      unavailable = true; connected = false; connectionLost()
      await vi.waitFor(() => expect(facts).toContainEqual(expect.objectContaining({ data: { event: expect.objectContaining({ type: 'connection-state', state: 'unrecoverable' }) } })))
      expect(kernel.connect).toHaveBeenCalledTimes(1 + RECONNECT_MAX_ATTEMPTS)
      await expect(core.listRuns()).rejects.toMatchObject({ code: 'CTXMUX_DISCONNECTED' })
      unavailable = false
      const result = await service.call('runtime.invoke', { fence, consumerId: 'consumer-a', invocation: { method: 'listRuns', args: [] } })
      expect(decodeHostedValue(result)).toEqual({ value: [expect.objectContaining({ runId: 'original-run', pid: 421, state: 'running' })] })
      expect(kernel.connect).toHaveBeenCalledTimes(2 + RECONNECT_MAX_ATTEMPTS)
      expect(kernel.list).toHaveBeenCalledTimes(3)
      expect(kernel.stop.mock.calls).toEqual([])
    } finally { await consumer.dispose(); await service.dispose(); await core.dispose() }
  })
  it('preserves original offline history, Hook and authority methods without demanding a Runtime connection', async () => {
    const f = fixture(), events = await f.subscribe('consumer-a', f.eventsA)
    f.core.connect.mockRejectedValue(new Error('Private ctxmux unavailable'))
    expect(await f.invoke('consumer-a', 'sessionHistorySources', [])).toEqual({ value: [{ agentSessionId: 'a123456789012345', providerId: 'codex' }] })
    expect(await f.invoke('consumer-a', 'inspectManagedHooks', ['codex', {}])).toEqual({ value: { status: 'installed' } })
    await f.invoke('consumer-a', 'authorizeAgentCaller', [{ agentSessionId: 'a123456789012345', capability: 'original' }])
    expect(await f.invoke('consumer-a', 'handOff', [{}])).toEqual({ value: { accepted: true } })
    expect(f.core.connect.mock.calls).toEqual([])
    expect(f.core.sessionHistorySources).toHaveBeenCalledTimes(1)
    expect(f.core.inspectManagedHooks).toHaveBeenCalledTimes(1)
    expect(f.core.authorizeAgentCaller).toHaveBeenCalledTimes(1)
    expect(f.core.handOff).toHaveBeenCalledTimes(1)
    await events.dispose(); await f.service.dispose()
  })
  it('rejects a late business write if its request cancelled or original consumer closed while Core reconnect was pending', async () => {
    for (const interruption of ['cancelled', 'closed'] as const) {
      const f = fixture(), events = await f.subscribe('consumer-a', f.eventsA), controller = new AbortController()
      let finish!: () => void
      f.core.connect.mockImplementationOnce(async () => await new Promise<void>(resolve => { finish = resolve }))
      const pending = f.service.call('runtime.invoke', { fence, consumerId: 'consumer-a', invocation: { method: 'submitAgentPrompt', args: [{}] } }, { signal: controller.signal })
      await vi.waitFor(() => expect(f.core.connect).toHaveBeenCalledTimes(1))
      if (interruption === 'cancelled') controller.abort(new Error('Original private request cancelled'))
      else await events.dispose()
      finish()
      if (interruption === 'cancelled') await expect(pending).rejects.toThrow('Original private request cancelled')
      else {
        const outcome = await pending.then(value => ({ value }), error => ({ error }))
        expect(outcome, 'a closed consumer cannot admit a late SDK prompt').toMatchObject({ error: { code: 'CONTROL_UNAVAILABLE' } })
      }
      expect(f.core.submitAgentPrompt.mock.calls).toEqual([])
      expect(f.core.stopTerminal.mock.calls).toEqual([])
      await events.dispose(); await f.service.dispose()
    }
  })
  it('shares one Core attachment and releasing one viewer retains the other and the healthy Run', async () => {
    const f = fixture()
    const first = await f.subscribe('consumer-a', f.eventsA), second = await f.subscribe('consumer-b', f.eventsB)
    await f.invoke('consumer-a', 'attachTerminal', ['original-run', 0, 'terminal'])
    await f.invoke('consumer-b', 'attachTerminal', ['original-run', 0, 'raw'])
    expect(f.core.refreshRunAttachment).toHaveBeenCalledTimes(1)
    expect(f.core.readRunReplay).toHaveBeenCalledTimes(1)
    const state: AgentMuxClientEvent = { type: 'process-state', run: { runId: 'original-run' }, state: 'running', pid: 421,
      evidence: { source: 'run-process', observedAt: 2, run: { runId: 'original-run' } } }
    f.emit(state)
    await new Promise(resolve => setImmediate(resolve))
    const fact = encodeHostedValue({ type: 'snapshot', data: { event: state } })
    expect(f.eventsA, 'one consumer receives each related semantic state once').toEqual([fact])
    expect(f.eventsB, 'one consumer receives each related semantic state once').toEqual([fact])
    f.eventsA.length = 0; f.eventsB.length = 0
    f.output('unrelated-run')
    expect(f.eventsA).toEqual([]); expect(f.eventsB).toEqual([])
    await first.dispose()
    expect(f.core.releaseRunAttachment).not.toHaveBeenCalled()
    f.output('original-run')
    expect(f.eventsA).toEqual([])
    expect(f.eventsB).toHaveLength(1)
    expect(decodeHostedValue(f.eventsB[0])).toMatchObject({ type: 'snapshot', data: { event: { dataBytes: Uint8Array.of(120) } } })
    await second.dispose()
    expect(f.core.releaseRunAttachment).toHaveBeenCalledExactlyOnceWith({ runId: 'original-run' })
    expect(f.core.stopTerminal).not.toHaveBeenCalled()
    await f.service.dispose()
  })
  it('retains existing consumer ownership when an explicit refresh fails', async () => {
    const f = fixture(), first = await f.subscribe('consumer-a', f.eventsA)
    await f.invoke('consumer-a', 'attachTerminal', ['original-run'])
    f.core.refreshRunAttachment.mockRejectedValueOnce(new Error('Refresh handshake timeout'))
    await expect(f.invoke('consumer-a', 'refreshRunAttachment', [{ runId: 'original-run' }])).rejects.toThrow('timeout')
    f.output('original-run')
    expect(f.eventsA).toHaveLength(1)
    expect(f.core.stopTerminal).not.toHaveBeenCalled()
    await first.dispose(); expect(f.core.releaseRunAttachment).toHaveBeenCalledOnce()
    await f.service.dispose()
  })
  it('closes invocation authority immediately while the disconnected consumer is still draining its last observation', async () => {
    const f = fixture(), first = await f.subscribe('consumer-a', f.eventsA)
    await f.invoke('consumer-a', 'attachTerminal', ['original-run'])
    let finish!: () => void
    f.core.releaseRunAttachment.mockImplementationOnce(async () => await new Promise<void>(resolve => { finish = resolve }))
    const draining = first.dispose()
    await vi.waitFor(() => expect(f.core.releaseRunAttachment).toHaveBeenCalledTimes(1))
    try {
      await expect(f.invoke('consumer-a', 'submitAgentPrompt', [{}])).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
      expect(f.core.submitAgentPrompt.mock.calls).toEqual([])
      f.output('original-run'); expect(f.eventsA).toEqual([])
      expect(f.core.stopTerminal).not.toHaveBeenCalled()
    } finally { finish(); await draining; await f.service.dispose() }
  })
  it('refuses an unattached consumer, another event owner and functions outside the public finite methods', async () => {
    const f = fixture()
    await expect(f.invoke('consumer-a', 'attachTerminal', ['original-run'])).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    const first = await f.subscribe('consumer-a', f.eventsA)
    await expect(f.subscribe('consumer-a', f.eventsB)).rejects.toMatchObject({ code: 'CONTROL_OWNER_BUSY' })
    await expect(f.invoke('consumer-a', 'dispose', [])).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(f.core.refreshRunAttachment).not.toHaveBeenCalled()
    expect(f.eventsA).toEqual([])
    await first.dispose(); await f.service.dispose()
  })
  it('validates durable Store identity before exposing a confirmed Hosted client', async () => {
    const f = fixture()
    const port = rpcPort(f.service).port
    await expect(connectHostedAgentMux({ rpc: port, expectedStorePath: upstreamFixturePath("foreign-store/sessions.json") })).rejects.toMatchObject({ code: 'CONTROL_OWNER_BUSY' })
    expect(f.core.refreshRunAttachment).not.toHaveBeenCalled()
    expect(f.core.stopTerminal).not.toHaveBeenCalled()
    await f.service.dispose()
  })
  it('keeps original byte arrays and optional tuple values across JSON', () => {
    const value = { args: [undefined, Uint8Array.of(0, 127, 128, 255)], replay: [{ startByte: 10, endByte: 14, dataBytes: Uint8Array.of(0, 127, 128, 255) }] }
    expect(decodeHostedValue(JSON.parse(JSON.stringify(encodeHostedValue(value))))).toEqual(value)
  })
  it('uses terminal retirement facts to remove the exact Session cache while retaining unrelated Sessions', async () => {
    const f = fixture(), bridge = rpcPort(f.service)
    const original = { kind: 'agent', agentSessionId: 'a123456789012345', providerId: 'codex', executorId: 'codex',
      hostId: 'local', workspacePath: upstreamFixturePath("private-workspace"), run: { runId: 'original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1 }
    f.core.agentSessions = () => [original, { ...original, agentSessionId: 'b123456789012345', run: { runId: 'unrelated-run' } }] as never
    const client = await connectHostedAgentMux({ rpc: bridge.port })
    expect(client.agentSessions().map(value => value.agentSessionId)).toEqual(['a123456789012345', 'b123456789012345'])
    f.emit({ type: 'connection-state', state: 'lost', evidence: { source: 'agentmux', observedAt: 2 } })
    expect(client.agentSessions().map(value => value.agentSessionId)).toEqual(['a123456789012345', 'b123456789012345'])
    f.emit({ type: 'run-removed', agentSessionId: 'a123456789012345', run: { runId: 'original-run' }, evidence: { source: 'user', observedAt: 3 } })
    await vi.waitFor(() => expect(client.agentSessions().map(value => value.agentSessionId)).toEqual(['b123456789012345']))
    await client.dispose(); await f.service.dispose()
  })
  it('reconfirms process facts for a conversation-only consumer when Host observation reconnects', async () => {
    const f = fixture(), bridge = rpcPort(f.service)
    const client = await connectHostedAgentMux({ rpc: bridge.port })
    const events: AgentMuxClientEvent[] = []
    client.onEvent(value => events.push(value))
    await bridge.connections[0]!.close()
    await client.connect()
    expect(events.filter(value => value.type === 'process-state')).toEqual([expect.objectContaining({ type: 'process-state', run: { runId: 'original-run' }, state: 'running', pid: 421 })])
    expect(f.core.refreshRunAttachment).not.toHaveBeenCalled()
    await client.dispose(); await f.service.dispose()
  })
  it('scopes a failed endpoint retry to its connection and preserves a real Agent error with the same code and message', async () => {
    const f = fixture(), bridge = rpcPort(f.service), client = await connectHostedAgentMux({ rpc: bridge.port })
    const events: AgentMuxClientEvent[] = [], message = 'An actual transport and Agent can share this diagnostic text'
    client.onEvent(event => events.push(event))
    f.emit({ type: 'agent-error', agentSessionId: 'a123456789012345', code: 'RUNTIME_UNAVAILABLE', message,
      evidence: { source: 'agentmux', observedAt: 2, run: { runId: 'original-run' } } })
    await vi.waitFor(() => expect(events.filter(event => event.type === 'agent-error')).toHaveLength(1))
    await bridge.connections[0]!.close(new AgentMuxError(message, 'RUNTIME_UNAVAILABLE'))
    const retryCall = vi.spyOn(bridge.port, 'call').mockRejectedValueOnce(new AgentMuxError(message, 'RUNTIME_UNAVAILABLE'))
    await vi.waitFor(() => expect(retryCall).toHaveBeenCalledOnce())
    expect(events.filter(event => event.type === 'connection-state').map(event => event.state), 'one endpoint loss has one state transition even when its retry fails').toEqual(['lost'])
    expect(events).toContainEqual(expect.objectContaining({ type: 'connection-state', state: 'lost',
      diagnostic: { code: 'RUNTIME_UNAVAILABLE', message: expect.stringContaining(message) } }))
    await client.connect()
    expect(events, 'endpoint failure cannot append or overwrite a real Agent error').toContainEqual(expect.objectContaining({ type: 'agent-error',
      agentSessionId: 'a123456789012345', code: 'RUNTIME_UNAVAILABLE', message }))
    expect(events.filter(event => event.type === 'agent-error')).toHaveLength(1)
    expect(events).toContainEqual(expect.objectContaining({ type: 'connection-state', state: 'restored' }))
    expect(f.core.stopTerminal).not.toHaveBeenCalled()
    await client.dispose(); await f.service.dispose()
  })
  it('settles an initial unconfirmed endpoint on its first successful observation without inventing Agent facts', async () => {
    const f = fixture(), bridge = rpcPort(f.service), events: AgentMuxClientEvent[] = []
    let reject!: (error: Error) => void
    vi.spyOn(bridge.port, 'call').mockImplementationOnce(async () => await new Promise((_, no) => { reject = no }))
    const client = await connectHostedAgentMux({ rpc: bridge.port, waitForReady: false })
    client.onEvent(event => events.push(event)); reject(new AgentMuxError('Original initial endpoint is unconfirmed', 'RUNTIME_UNAVAILABLE'))
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'connection-state', state: 'lost', diagnostic: expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE' }) })))
    await client.connect()
    expect(events.filter(event => event.type === 'connection-state').map(event => event.state), 'first confirmation settles its original endpoint service window').toEqual(['lost', 'restored'])
    expect(events.filter(event => event.type === 'agent-error')).toEqual([])
    expect(f.core.stopTerminal).not.toHaveBeenCalled(); expect(f.core.submitAgentPrompt).not.toHaveBeenCalled()
    await client.dispose(); await f.service.dispose()
  })
  it('releases a late ended event lease and reconnects without letting its old callbacks overwrite the new observation', async () => {
    const f = fixture(), bridge = rpcPort(f.service)
    const original = { kind: 'agent', agentSessionId: 'a123456789012345', providerId: 'codex', executorId: 'codex',
      hostId: 'local', workspacePath: upstreamFixturePath("private-workspace"), run: { runId: 'original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1 }
    f.core.agentSessions = () => [original] as never
    const nativeSubscribe = bridge.port.subscribe
    let finish!: () => void, first = true
    let oldHandlers!: Parameters<AgentMuxHostedRpcPort['subscribe']>[2]
    bridge.port.subscribe = (async (method: Parameters<AgentMuxHostedRpcPort['subscribe']>[0], params: Parameters<AgentMuxHostedRpcPort['subscribe']>[1], handlers: Parameters<AgentMuxHostedRpcPort['subscribe']>[2]) => {
      const watch = await nativeSubscribe(method, params, handlers)
      if (method === 'runtime.events' && first) {
        first = false; oldHandlers = handlers
        await new Promise<void>(resolve => { finish = resolve })
      }
      return watch
    }) as AgentMuxHostedRpcPort['subscribe']
    const client = await connectHostedAgentMux({ rpc: bridge.port, consumerId: 'consumer-a', waitForReady: false })
    await vi.waitFor(() => expect(bridge.connections.map(value => value.method)).toEqual(['runtime.events']))
    await bridge.connections[0]!.close()
    finish()
    await expect(client.connect()).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(client.agentSessions()).toEqual([original])
    await client.connect()
    expect(bridge.connections.map(value => value.method)).toEqual(['runtime.events', 'runtime.events'])
    for (const data of hostedTransfer({ kind: 'event', event: { type: 'run-removed', agentSessionId: original.agentSessionId,
      run: original.run, evidence: { source: 'user', observedAt: 3 } } }, 'late-old-epoch')) oldHandlers.onEvent({ type: 'snapshot', data })
    oldHandlers.onEnd?.(new Error('Old private stream repeated its late end callback'))
    expect(client.agentSessions()).toEqual([original])
    await client.connect()
    expect(bridge.connections.map(value => value.method)).toEqual(['runtime.events', 'runtime.events'])
    expect(f.core.stopTerminal.mock.calls).toEqual([])
    await client.dispose()
    expect(await f.service.call('runtime.release-consumer', { fence, consumerId: 'consumer-a' })).toEqual({ released: false })
    await f.service.dispose()
  })
  it('retains a releasable confirmed Host lease and exact Core input while a process-projection read is unconfirmed', async () => {
    const f = fixture(), bridge = rpcPort(f.service)
    const original = { kind: 'agent', agentSessionId: 'a123456789012345', providerId: 'codex', executorId: 'codex',
      hostId: 'local', workspacePath: upstreamFixturePath("private-workspace"), run: { runId: 'original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1 }
    f.core.agentSessions = () => [original] as never
    f.core.runtimeProjection.mockRejectedValueOnce(new Error('Private process-projection handshake timeout'))
    const client = await connectHostedAgentMux({ rpc: bridge.port, consumerId: 'consumer-a' })
    expect(client.agentSessions()).toEqual([original])
    expect(bridge.connections.map(value => value.method)).toEqual(['runtime.events'])
    await client.submitAgentPrompt({ agentSessionId: original.agentSessionId, expectedRun: original.run, prompt: 'exact original request',
      operationId: 'submission-original', afterSubmissionId: null })
    expect(f.core.submitAgentPrompt.mock.calls).toEqual([[expect.objectContaining({ agentSessionId: original.agentSessionId,
      expectedRun: original.run, prompt: 'exact original request' })]])
    const events: AgentMuxClientEvent[] = []
    client.onEvent(value => events.push(value))
    await bridge.connections[0]!.close()
    f.core.runtimeProjection.mockRejectedValueOnce(new Error('Private process-projection handshake timeout'))
    await client.connect()
    expect(events.filter(value => value.type === 'process-state')).toEqual([])
    expect(events.filter(value => value.type === 'agent-error')).toContainEqual(expect.objectContaining({ code: 'CONTROL_UNAVAILABLE',
      message: expect.stringContaining('current process projection is unconfirmed') }))
    expect(f.core.submitAgentPrompt).toHaveBeenCalledTimes(1)
    await client.dispose()
    expect(await f.service.call('runtime.release-consumer', { fence, consumerId: 'consumer-a' })).toEqual({ released: false })
    expect(f.core.stopTerminal).not.toHaveBeenCalled()
    await f.service.dispose()
  })
  it('restores an admitted history watch on its original native identity without repeating any write', async () => {
    const f = fixture(), bridge = rpcPort(f.service)
    const client = await connectHostedAgentMux({ rpc: bridge.port })
    const observations: unknown[] = []
    const observer = await client.observeSessionHistory('a123456789012345', value => observations.push(value), {})
    expect(observer.source).toEqual({ providerId: 'codex', nativeSessionId: 'original-native' })
    expect(f.core.observeSessionHistory).toHaveBeenCalledTimes(1)
    await bridge.connections[0]!.close()
    await client.connect()
    expect(f.core.observeSessionHistory).toHaveBeenCalledTimes(2)
    expect(observations).toContainEqual({ kind: 'invalidated', agentSessionId: 'a123456789012345', source: observer.source })
    expect(f.core.submitAgentPrompt).not.toHaveBeenCalled()
    observer.dispose(); await client.dispose(); await f.service.dispose()
  })
  it('retains the original history identity and window when a reconnect offers a different native source', async () => {
    const f = fixture(), bridge = rpcPort(f.service), released = [vi.fn(), vi.fn()]
    let opened = 0
    f.core.observeSessionHistory.mockImplementation(async () => {
      const index = opened++
      return { source: { providerId: 'codex', nativeSessionId: index ? 'foreign-native' : 'original-native' }, dispose: released[index]! }
    })
    const client = await connectHostedAgentMux({ rpc: bridge.port }), observations: unknown[] = []
    const observer = await client.observeSessionHistory('a123456789012345', value => observations.push(value), {})
    await bridge.connections[0]!.close(); await client.connect()
    expect(observer.source).toEqual({ providerId: 'codex', nativeSessionId: 'original-native' })
    expect(observations, 'a foreign native source cannot replace the original history window').toContainEqual(expect.objectContaining({ kind: 'unavailable',
      source: observer.source, code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' }))
    expect(observations.filter(value => (value as { kind: string }).kind === 'invalidated')).toEqual([])
    expect(released.map(release => release.mock.calls.length)).toEqual([1, 1])
    expect(f.core.submitAgentPrompt).not.toHaveBeenCalled(); expect(f.core.stopTerminal).not.toHaveBeenCalled()
    observer.dispose(); await client.dispose(); await f.service.dispose()
  })
  it('disposes a late native observer exactly once when its original consumer closed during admission', async () => {
    const f = fixture(), events = await f.subscribe('consumer-a', f.eventsA)
    let resolve!: (value: { source: { providerId: string; nativeSessionId: string }; dispose: ReturnType<typeof vi.fn> }) => void
    const source = { providerId: 'codex', nativeSessionId: 'original-native' }, release = vi.fn()
    f.core.observeSessionHistory.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const historyEvents: unknown[] = []
    const admitting = f.service.subscribe('runtime.history-watch', { fence, consumerId: 'consumer-a', agentSessionId: 'a123456789012345' }, value => { historyEvents.push(value) })
    await events.dispose()
    expect(f.core.observeSessionHistory.mock.calls[0]![0]).toBe('a123456789012345')
    f.core.observeSessionHistory.mock.calls[0]![1]({ kind: 'invalidated', agentSessionId: 'a123456789012345', source })
    resolve({ source, dispose: release })
    await expect(admitting).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
    expect(f.core.observeSessionHistory).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(historyEvents).toEqual([])
    await f.service.dispose()
  })
  it('passes request cancellation into the existing Prompt contract without inventing read option fields', async () => {
    const f = fixture(), events = await f.subscribe('consumer-a', f.eventsA), controller = new AbortController()
    await f.service.call('runtime.invoke', { fence, consumerId: 'consumer-a', invocation: { method: 'submitAgentPrompt', args: [{
      agentSessionId: 'a123456789012345', expectedRun: { runId: 'original-run' }, prompt: 'original prompt',
      operationId: 'submission-original', afterSubmissionId: null
    }] } }, { signal: controller.signal })
    expect(f.core.submitAgentPrompt.mock.calls).toEqual([[expect.objectContaining({ signal: controller.signal, prompt: 'original prompt' })]])
    await events.dispose(); await f.service.dispose()
  })

  it('preserves legitimate signal data in the actual typed createAgent call and ordered bytes across a JSON boundary', async () => {
    const f = fixture(), bridge = rpcPort(f.service)
    const create = vi.fn(async (input: Parameters<AgentMuxHostedClient['createAgent']>[0]) => ({
      kind: 'agent' as const, agentSessionId: 'a123456789012345', providerId: input.providerId, executorId: input.executorId,
      hostId: 'local', workspacePath: input.workspacePath, run: { runId: 'original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1
    }))
    Object.assign(f.core, { createAgent: create })
    const client = await connectHostedAgentMux({ rpc: bridge.port })
    const input: Parameters<AgentMuxHostedClient['createAgent']>[0] = {
      providerId: 'codex', executorId: 'codex', workspacePath: upstreamFixturePath("private-workspace"), injectAgentMuxGuide: false,
      env: { signal: 'ordinary environment value', ABORT_SIGNAL: 'also ordinary' }, args: ['--literal', 'signal']
    }
    await client.createAgent(input)
    expect(create.mock.calls).toEqual([[input]])
    const data = { signal: 'ordinary data', nested: { signal: ['ordinary', undefined] },
      args: [undefined, Uint8Array.of(0, 128, 255), undefined, 'operation-original'],
      replay: [{ startByte: 17, endByte: 20, dataBytes: Uint8Array.of(0, 128, 255) }] }
    expect(decodeHostedValue(JSON.parse(JSON.stringify(encodeHostedValue(data))))).toEqual(data)
    await client.dispose(); await f.service.dispose()
  })

  it('takes Prompt and history cancellation only from their existing exact SDK fields and preserves the complete intent tuple', async () => {
    const f = fixture(), bridge = rpcPort(f.service), controller = new AbortController()
    const client = await connectHostedAgentMux({ rpc: bridge.port })
    const prompt: Parameters<AgentMuxHostedClient['submitAgentPrompt']>[0] = {
      agentSessionId: 'a123456789012345', operationId: 'prompt-operation-original', expectedRun: { runId: 'original-run' },
      afterSubmissionId: 'predecessor-original', prompt: 'original whole intent', signal: controller.signal
    }
    await client.submitAgentPrompt(prompt)
    expect(bridge.calls).toEqual([
      { method: 'runtime.owner.identity', params: {}, signal: undefined },
      { method: 'runtime.invoke', params: { fence, consumerId: expect.any(String), invocation: { method: 'runtimeProjection', args: [] } }, signal: undefined },
      { method: 'runtime.invoke', params: { fence, consumerId: expect.any(String), invocation: { method: 'submitAgentPrompt', args: [{ agentSessionId: prompt.agentSessionId,
        operationId: prompt.operationId, expectedRun: prompt.expectedRun, afterSubmissionId: prompt.afterSubmissionId, prompt: prompt.prompt }] } }, signal: controller.signal }
    ])
    expect(f.core.submitAgentPrompt.mock.calls).toEqual([[prompt]])
    const watches: Array<{ options: unknown; signal: AbortSignal | undefined }> = []
    const subscribe = bridge.port.subscribe
    bridge.port.subscribe = ((method: Parameters<AgentMuxHostedRpcPort['subscribe']>[0], params: Parameters<AgentMuxHostedRpcPort['subscribe']>[1], handlers: Parameters<AgentMuxHostedRpcPort['subscribe']>[2]) => {
      if (method === 'runtime.history-watch') watches.push({ options: 'options' in params ? params.options : undefined, signal: handlers.signal })
      return subscribe(method, params, handlers)
    }) as AgentMuxHostedRpcPort['subscribe']
    const observer = await client.observeSessionHistory(prompt.agentSessionId, () => {}, { signal: controller.signal })
    expect(watches).toEqual([{ options: {}, signal: controller.signal }])
    expect(f.core.observeSessionHistory.mock.calls[0]).toEqual([prompt.agentSessionId, expect.any(Function), { signal: controller.signal }])
    observer.dispose(); await client.dispose(); await f.service.dispose()
  })

  it('forwards the original typed refresh operation identity without adding one to an attach or reattach', async () => {
    const f = fixture(), bridge = rpcPort(f.service), client = await connectHostedAgentMux({ rpc: bridge.port })
    await client.attachTerminal('original-run', 11, 'raw')
    await client.refreshRunAttachment({ runId: 'original-run' }, 22, 'terminal', 'refresh-operation-original')
    expect(f.core.refreshRunAttachment.mock.calls).toEqual([
      [{ runId: 'original-run' }, 11, 'raw'],
      [{ runId: 'original-run' }, 22, 'terminal', 'refresh-operation-original']
    ])
    await client.releaseRunAttachment({ runId: 'original-run' })
    await client.refreshRunAttachment({ runId: 'original-run' }, 33, 'terminal', 'refresh-first-lease-original')
    expect(f.core.refreshRunAttachment, 'a first refresh lease preserves its original operation identity').toHaveBeenLastCalledWith(
      { runId: 'original-run' }, 33, 'terminal', 'refresh-first-lease-original')
    await client.dispose(); await f.service.dispose()
  })

  it('isolates a failing synchronous or asynchronous reader while delivering both Runs output, resize and semantic facts to the healthy reader', async () => {
    for (const failure of ['synchronous', 'asynchronous'] as const) {
      const f = fixture()
      const broken = vi.fn((_value: unknown): void | Promise<void> => {
        if (failure === 'synchronous') throw new Error('Reader A send failed')
        return Promise.reject(new Error('Reader A asynchronous send failed'))
      })
      const first = await f.service.subscribe('runtime.events', { fence, consumerId: 'consumer-a' }, logicalHostedEvents(broken))
      const second = await f.subscribe('consumer-b', f.eventsB)
      const releaseConsumer = vi.spyOn(f.service, 'releaseConsumer')
      for (const id of ['consumer-a', 'consumer-b']) for (const runId of ['original-run', 'second-run']) {
        await f.invoke(id, 'attachTerminal', [runId])
      }
      await first.start?.()
      expect(() => {
        f.output('original-run'); f.output('second-run')
        f.emit({ type: 'terminal-resized', run: { runId: 'second-run' }, cols: 81, rows: 25, throughByte: 1, resizeRevision: 1 })
        f.emit({ type: 'connection-state', state: 'lost', evidence: { source: 'agentmux', observedAt: 4 } })
      }).not.toThrow()
      await vi.waitFor(() => expect(f.eventsB.map(value => decodeHostedValue(value))).toEqual([
        expect.objectContaining({ data: { event: expect.objectContaining({ type: 'terminal-output', run: { runId: 'original-run' }, dataBytes: Uint8Array.of(120) }) } }),
        expect.objectContaining({ data: { event: expect.objectContaining({ type: 'terminal-output', run: { runId: 'second-run' }, dataBytes: Uint8Array.of(120) }) } }),
        expect.objectContaining({ data: { event: expect.objectContaining({ type: 'terminal-resized', run: { runId: 'second-run' }, cols: 81, rows: 25 }) } }),
        expect.objectContaining({ data: { event: expect.objectContaining({ type: 'connection-state', state: 'lost' }) } })
      ]))
      await vi.waitFor(() => expect(releaseConsumer).toHaveBeenCalledExactlyOnceWith('consumer-a'))
      await releaseConsumer.mock.results[0]!.value
      expect(await f.service.call('runtime.release-consumer', { fence, consumerId: 'consumer-a' })).toEqual({ released: false })
      expect(f.core.releaseRunAttachment.mock.calls).toEqual([])
      f.output('original-run')
      expect(f.eventsB).toHaveLength(5)
      expect(f.core.stopTerminal.mock.calls).toEqual([])
      await first.dispose(); await second.dispose(); await f.service.dispose()
    }
  })

  it('isolates a failed history observation and end callback while retaining the same consumer event reader and other history leases', async () => {
    const f = fixture(), first = await f.subscribe('consumer-a', f.eventsA)
    const callbacks: Array<(value: AgentSessionHistoryObservation) => void> = []
    const releases = [vi.fn(), vi.fn()]
    f.core.observeSessionHistory.mockImplementation(async (_id, listener) => {
      const index = callbacks.length; callbacks.push(listener)
      return { source: { providerId: 'codex', nativeSessionId: 'original-native' }, dispose: releases[index]! }
    })
    const broken = await f.service.subscribe('runtime.history-watch', { fence, consumerId: 'consumer-a', agentSessionId: 'a123456789012345' }, logicalHostedEvents(() => { throw new Error('History A send failed') }))
    const healthy: unknown[] = []
    const second = await f.service.subscribe('runtime.history-watch', { fence, consumerId: 'consumer-a', agentSessionId: 'b123456789012345' }, logicalHostedEvents(value => { healthy.push(value) }))
    await broken.start?.(); await second.start?.()
    expect(() => callbacks[0]!({ kind: 'invalidated', agentSessionId: 'a123456789012345', source: { providerId: 'codex', nativeSessionId: 'original-native' } })).not.toThrow()
    callbacks[1]!({ kind: 'invalidated', agentSessionId: 'b123456789012345', source: { providerId: 'codex', nativeSessionId: 'original-native' } })
    await vi.waitFor(() => expect(releases.map(release => release.mock.calls.length)).toEqual([1, 0]))
    expect(healthy).toEqual([{ type: 'snapshot', data: { observation: { kind: 'invalidated', agentSessionId: 'b123456789012345', source: { providerId: 'codex', nativeSessionId: 'original-native' } } } }])
    f.emit({ type: 'connection-state', state: 'lost', evidence: { source: 'agentmux', observedAt: 4 } })
    expect(f.eventsA).toEqual([{ type: 'snapshot', data: { event: { type: 'connection-state', state: 'lost', evidence: { source: 'agentmux', observedAt: 4 } } } }])
    await broken.dispose(); await first.dispose()
    expect(releases.map(release => release.mock.calls.length)).toEqual([1, 1])
    expect(healthy[1]).toEqual({ type: 'end', data: { reason: 'consumer-released' } })
    await second.dispose(); await f.service.dispose()
  })
})
