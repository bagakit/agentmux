import { expect, it, vi } from 'vitest'
import * as relayLeaf from '../src/public-rpc-relay.js'
import { HostedRelayRpcPort } from '../src/relay-hosted.js'
import { createMobileTerminalControl } from '../../../apps/mobile/src/terminal/control.js'
import { actualRelayOwner, carrierFact, held } from './helpers/relay-carrier-owner.js'

const settle = <T>(promise: Promise<T>) => promise.then(value => ({ value }), error => ({ error }))

it('actual Host reuses sequential finite Hosted and public RPC calls with separate client identity', async () => {
  const f = await actualRelayOwner()
  await f.rpc.call('device.hello', { name: 'private public consumer' })
  const first = f.connections()
  await f.rpc.call('agent.ls', {})
  await f.rpc.call('agent.ls', {})
  expect(f.connections()).toBe(first)
  const client = await f.hosted()
  await expect.poll(() => f.replies.some(value => f.requests.some(request => request.frame.id === value.frame.id
    && (request.frame.params?.invocation as { method?: string })?.method === 'runtimeProjection'))).toBe(true)
  const before = f.connections()
  await client.writeAgent({ agentSessionId: 'caller', expectedRun: { runId: 'run-caller' }, data: 'a', source: 'user' })
  await client.writeAgent({ agentSessionId: 'caller', expectedRun: { runId: 'run-caller' }, data: 'b', source: 'user' })
  expect(f.connections()).toBe(before)
  expect(f.rawInput.mock.calls.map(call => call[1])).toEqual(['a', 'b'])
  const writes = f.requests.filter(value => value.frame.method === 'runtime.invoke')
  expect(writes.length).toBeGreaterThanOrEqual(2)
  expect(new Set(writes.map(value => value.connection)).size).toBe(1)
  expect(f.host.client.agentSession('caller').run).toEqual({ runId: 'run-caller' })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  carrierFact({ kind: 'actual-host-sequential', publicConnections: first, hostedConnections: before - first,
    writeConnections: [...new Set(writes.map(value => value.connection))], hostId: f.authority.hostId,
    run: client.agentSession('caller').run, nativeWrites: f.rawInput.mock.calls.length })
})

it('actual Host streams keep their own notification reader while finite calls retain one idle carrier', async () => {
  const f = await actualRelayOwner()
  const observe = (f.inner.kernel.observeOutput as ReturnType<typeof vi.fn>).getMockImplementation()!
  ;(f.inner.kernel.observeOutput as ReturnType<typeof vi.fn>).mockImplementation(async (...args) => ({ ...await observe(...args), replay: [{ type: 'data', runId: 'run-caller', startByte: 0, endByte: 3, data: 'abc', dataBytes: Uint8Array.of(97, 98, 99) }] }))
  await f.rpc.call('device.hello', { name: 'private stream consumer' })
  const events: unknown[] = []
  const stream = await f.rpc.subscribe('agent.output', { agentSessionId: 'caller', follow: true }, {
    onInitial: initial => expect(initial.run.runId).toBe('run-caller'), onEvent: event => events.push(event)
  })
  const streamRequest = f.requests.find(value => value.frame.method === 'agent.output')!
  expect(streamRequest.connection).not.toBe(f.requests.find(value => value.frame.method === 'device.hello')!.connection)
  await f.rpc.call('agent.ls', {})
  expect(f.requests.at(-1)!.connection).not.toBe(streamRequest.connection)
  expect(f.activeSockets()).toHaveLength(2)
  for (const observer of f.observers) observer({ type: 'data', runId: 'run-caller', startByte: 3, endByte: 4, data: 'x', dataBytes: Uint8Array.of(120) })
  await expect.poll(() => events.some(event => (event as { data?: { endByte?: number } }).data?.endByte === 4)).toBe(true)
  expect(events).toContainEqual(expect.objectContaining({ type: 'output', data: expect.objectContaining({ runId: 'run-caller', startByte: 3, endByte: 4 }) }))
  await stream.dispose()
  await vi.waitFor(() => expect(f.activeSockets()).toHaveLength(1))
  await expect.poll(() => f.observers.size).toBe(0)
  await f.rpc.call('agent.ls', {})
  expect(f.activeSockets()).toHaveLength(1)
  await f.rpc.dispose()
  await vi.waitFor(() => expect(f.activeSockets()).toHaveLength(0))
  carrierFact({ kind: 'actual-stream-independent', notification: events, idleFinite: 1, afterDispose: 0 })
})

it('held native ACK does not hold another finite call and concurrent completion retains at most one idle', async () => {
  const f = await actualRelayOwner(), client = await f.hosted(), ack = held()
  f.cleanup(() => ack.resolve())
  await expect.poll(() => f.requests.some(value => (value.frame.params?.invocation as { method?: string })?.method === 'runtimeProjection')
    && f.inFlight() === 0).toBe(true)
  const raw = f.rawInput.getMockImplementation()!
  f.rawInput.mockImplementation((id, data) => {
    const applied = raw(id, data)
    return ack.promise.then(() => applied)
  })
  const writing = settle(client.writeAgent({ agentSessionId: 'caller', expectedRun: { runId: 'run-caller' }, data: 'held', source: 'user' }))
  await expect.poll(() => f.rawInput.mock.calls.length).toBe(1)
  let read: Awaited<ReturnType<typeof client.readAgentSessions>> | undefined
  const reading = settle(client.readAgentSessions().then(value => { read = value; return value }))
  await vi.waitFor(() => expect(read?.map(session => session.agentSessionId)).toEqual(['caller']))
  await reading
  expect(f.activeSockets()).toHaveLength(3) // original event stream, exclusive pending write, one idle finite read
  ack.resolve()
  expect(await writing).toHaveProperty('value')
  await vi.waitFor(() => expect(f.activeSockets()).toHaveLength(2))
  const handshakes = f.handshakes()
  await client.readAgentSessions()
  expect(f.handshakes()).toBe(handshakes)
  await client.dispose()
  await vi.waitFor(() => expect(f.activeSockets()).toHaveLength(0))
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  carrierFact({ kind: 'held-native-ack', independentReadCompletedBeforeAck: true, settledClientSockets: 2,
    continuingStreams: 1, idleFinite: 1, afterHostedDispose: 0 })
})

it('pending cancellation reaches the original Host input authority without cancelling peer or later intent', async () => {
  const f = await actualRelayOwner(), capacity = held(), entered = held<AbortSignal>()
  f.cleanup(() => capacity.resolve())
  const { owner } = await f.rpc.call('runtime.owner.identity', {})
  const fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
  const controller = new AbortController(), writable = f.waitWritable.getMockImplementation()!
  f.waitWritable.mockImplementationOnce(async (_bytes, signal) => {
    entered.resolve(signal!)
    await capacity.promise
    signal?.throwIfAborted()
  })
  const write = (data: string, signal?: AbortSignal) => f.rpc.call('runtime.invoke', { consumerId: 'exact-cancel', fence,
    invocation: { method: 'writeAgent', args: [{ agentSessionId: 'caller', expectedRun: { runId: 'run-caller' }, data, source: 'user' }] }
  }, { ...(signal ? { signal } : {}) })
  const pending = settle(write('cancelled-original', controller.signal))
  const originalSignal = await entered.promise
  const peerAck = held()
  f.cleanup(() => peerAck.resolve())
  f.reply(async (frame, _connection, send) => { await peerAck.promise; await send(frame) })
  const peer = settle(f.rpc.call('agent.ls', {}))
  await expect.poll(() => f.replies.some(value => f.requests.some(request => request.frame.id === value.frame.id && request.frame.method === 'agent.ls'))).toBe(true)
  controller.abort()
  expect(await pending).toMatchObject({ error: { code: 'CONTROL_CANCELLED' } })
  await expect.poll(() => originalSignal.aborted).toBe(true)
  await vi.waitFor(() => expect(f.activeSockets()).toHaveLength(1))
  peerAck.resolve()
  expect(await peer).toHaveProperty('value')
  f.reply(undefined)
  capacity.resolve()
  await expect.poll(() => f.inFlight()).toBe(0)
  expect(f.rawInput).not.toHaveBeenCalled()
  f.waitWritable.mockImplementation(writable)
  await write('new-explicit-intent')
  expect(f.rawInput.mock.calls.map(call => call[1])).toEqual(['new-explicit-intent'])
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  carrierFact({ kind: 'accurate-pending-cancel', hostSignalAborted: originalSignal.aborted, replayedBytes: 0,
    laterNativeBytes: f.rawInput.mock.calls.map(call => call[1]), originalFence: fence })
})

it('strict finite reply and actual reader release are both required before a carrier becomes idle', async () => {
  const f = await actualRelayOwner(), relay = relayLeaf.createAgentMuxRpcRelayClient(f.options)
  f.cleanup(() => relay.dispose())
  const firstReply = held(), secondReply = held()
  const first = await relay.open({ jsonrpc: '2.0', id: 'held-reader', method: 'agent.ls', params: {} }, () => firstReply.resolve(), error => { if (error) throw error }, new AbortController().signal, false)
  await firstReply.promise
  const second = await relay.open({ jsonrpc: '2.0', id: 'second-reader', method: 'agent.ls', params: {} }, () => secondReply.resolve(), error => { if (error) throw error }, new AbortController().signal, false)
  await secondReply.promise
  const requests = f.requests.filter(value => value.frame.id === 'held-reader' || value.frame.id === 'second-reader')
  expect(requests).toHaveLength(2)
  expect(requests[0]!.connection).not.toBe(requests[1]!.connection)
  await second.dispose()
  await first.dispose()
  await vi.waitFor(() => expect(f.activeSockets()).toHaveLength(1))
  relay.dispose()
  await vi.waitFor(() => expect(f.activeSockets()).toHaveLength(0))
  carrierFact({ kind: 'strict-reader-release', requests, settledIdle: 1, disposed: 0 })
})

it.each(['foreign-id', 'partial-envelope'])('rejects %s from the original Host before finite reuse', async kind => {
  const f = await actualRelayOwner(), relay = relayLeaf.createAgentMuxRpcRelayClient(f.options)
  f.cleanup(() => relay.dispose())
  let first = true
  f.reply(async (frame, _connection, send) => {
    if (!first) { await send(frame); return }
    first = false
    await send(kind === 'foreign-id' ? { ...frame, id: 'someone-else' } : { jsonrpc: '2.0', id: frame.id })
  })
  const ended = held<Error | undefined>(), frames: unknown[] = []
  const reader = await relay.open({ jsonrpc: '2.0', id: 'exact-original-id', method: 'agent.ls', params: {} }, frame => frames.push(frame), error => ended.resolve(error), new AbortController().signal, false)
  await expect.poll(() => frames.length || f.activeSockets().length === 0).toBeTruthy()
  expect(frames).toHaveLength(0)
  expect(await ended.promise).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  await reader.dispose()
  const connections = f.connections(), received = held()
  const next = await relay.open({ jsonrpc: '2.0', id: 'new-original-id', method: 'agent.ls', params: {} }, () => received.resolve(), () => {}, new AbortController().signal, false)
  await received.promise
  expect(f.connections()).toBe(connections + 1)
  await next.dispose()
  carrierFact({ kind: 'strict-reply', injected: kind, invalidDelivered: frames.length, freshConnections: 1 })
})

it.each(['idle-unobserved', 'active-applied'])('lost %s keeps original Mobile intent unknown without replay and leaves peer healthy', async mode => {
  const f = await actualRelayOwner(), own: WebSocket[] = [], delayedClose: Array<() => void> = []
  const createWebSocket = (url: string) => {
    const socket = new WebSocket(url)
    own.push(socket)
    if (mode === 'idle-unobserved' && own.length === 1) {
      const listen = socket.addEventListener.bind(socket)
      socket.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
        if (type === 'close') listen(type, event => delayedClose.push(() => listener(event)), options)
        else listen(type, listener, options)
      }) as typeof socket.addEventListener
    }
    return socket
  }
  const client = await f.hosted(createWebSocket)
  await client.readAgentSessions()
  await f.rpc.call('device.hello', { name: 'independent healthy peer' })
  const storage = new Map<string, string>(), control = createMobileTerminalControl({ client, agentSessionId: 'caller', report: () => {},
    storage: () => ({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) }, removeItem: key => { storage.delete(key) } }) })
  f.cleanup(() => control.dispose())
  const ack = held(), raw = f.rawInput.getMockImplementation()!
  f.cleanup(() => ack.resolve())
  if (mode === 'active-applied') f.rawInput.mockImplementationOnce((id, data) => { const applied = raw(id, data); return ack.promise.then(() => applied) })
  if (mode === 'idle-unobserved') {
    own[0]!.close(4001, 'Private lost idle connection')
    await expect.poll(() => own[0]!.readyState).toBe(WebSocket.CLOSED)
    expect(delayedClose).toHaveLength(1)
  }
  expect(control.enable()).toBe(true)
  control.send('原始', 'user')
  control.send('tail', 'user')
  if (mode === 'active-applied') {
    await expect.poll(() => f.rawInput.mock.calls.length).toBe(1)
    own[0]!.close(4001, 'Private lost active reply')
  }
  const originalMarker = control.facts().pending
  await expect.poll(() => control.facts().phase).toBe('unknown')
  expect(control.facts().pending).toEqual(originalMarker)
  expect(JSON.parse([...storage.values()][0]!)).toMatchObject({ intentId: originalMarker!.intentId, runId: 'run-caller' })
  const before = f.rawInput.mock.calls.length, connections = own.length
  expect((await f.rpc.call('agent.ls', {})).sessions).toHaveLength(1)
  ack.resolve()
  for (const callback of delayedClose.splice(0)) callback()
  await expect.poll(() => f.inFlight()).toBe(0)
  expect(f.rawInput.mock.calls).toHaveLength(before)
  expect(own).toHaveLength(connections)
  expect(control.continueAfterReview()).toBe(true)
  expect(control.enable()).toBe(true)
  await expect.poll(() => control.facts().phase).toBe('idle')
  expect(f.rawInput.mock.calls.map(call => call[1])).toEqual(mode === 'active-applied' ? ['原始', 'tail'] : ['tail'])
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  carrierFact({ kind: 'lost-carrier-original-intent', mode, originalMarker, unknownReplayCount: 0,
    nativeBytes: f.rawInput.mock.calls.map(call => call[1]), healthyPeer: true, laterExplicitIntent: true })
})

it('original Hosted stream callback failure still releases every active and idle lease before reporting the same error', async () => {
  const f = await actualRelayOwner(), port = new HostedRelayRpcPort(f.options), release = held()
  f.cleanup(() => port.dispose())
  f.cleanup(() => release.resolve())
  const { owner } = await port.forward('runtime.owner.identity', {})
  const fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }, originalError = Error('Original onEnd callback failed')
  let ended = 0
  await port.subscribe('runtime.events', { consumerId: 'throwing-consumer', fence }, {
    onInitial: () => {}, onEvent: () => {}, onEnd: () => { ended++; throw originalError }
  })
  let first = true
  f.reply(async (frame, _connection, send) => {
    if (first) { first = false; await release.promise }
    await send(frame)
  })
  const pending = settle(port.forward('agent.ls', {}))
  await expect.poll(() => f.replies.some(value => value.frame.id === f.requests.at(-1)?.frame.id && f.requests.at(-1)?.frame.method === 'agent.ls')).toBe(true)
  await port.forward('agent.ls', {})
  expect(f.activeSockets()).toHaveLength(3)
  expect(() => port.dispose()).toThrow(originalError)
  await vi.waitFor(() => expect(f.activeSockets()).toHaveLength(0))
  expect(await pending).toMatchObject({ error: { code: 'CONTROL_CANCELLED' } })
  expect(ended).toBe(1)
  release.resolve()
  await expect.poll(() => f.inFlight()).toBe(0)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  carrierFact({ kind: 'throwing-hosted-callback-cleanup', originalError: originalError.message, callbackCount: ended,
    activeBeforeDispose: 3, afterDispose: 0 })
})

it.each([64, 193])('original topology actually attempts %i simultaneous finite calls under unchanged LocalRelay and device budgets', async size => {
  const f = await actualRelayOwner(), release = held()
  f.cleanup(() => release.resolve())
  await f.rpc.call('device.hello', { name: 'bounded topology baseline' })
  await expect.poll(() => f.inFlight()).toBe(0)
  let replies = 0, rejected = 0
  f.reply(async (frame, _connection, send) => { replies++; await release.promise; await send(frame) })
  const calls = Array.from({ length: size }, () => f.rpc.call('agent.ls', {}).then(value => ({ value }), error => { rejected++; return { error } }))
  await expect.poll(() => replies + rejected, { timeout: 15_000 }).toBe(size)
  expect(replies).toBe(Math.min(size, 128))
  expect(rejected).toBe(Math.max(size - 128, 0))
  expect(f.activeSockets()).toHaveLength(Math.min(size, 128))
  release.resolve()
  const results = await Promise.all(calls)
  expect(results.filter(value => 'value' in value)).toHaveLength(Math.min(size, 128))
  for (const result of results) if ('value' in result) expect(result.value!.sessions.map(observation => observation.session.agentSessionId)).toEqual(['caller'])
  const baseline = Boolean(process.env.HOST_RELAY_CARRIER_BASELINE)
  await vi.waitFor(() => expect(f.activeSockets()).toHaveLength(baseline ? 0 : 1))
  const idle = f.activeSockets().length
  await f.rpc.dispose()
  await vi.waitFor(() => expect(f.activeSockets()).toHaveLength(0))
  await expect.poll(() => f.authority.devices().every(device => !device.online)).toBe(true)
  carrierFact({ kind: 'actual-concurrent-topology', baseline, attempted: size, fulfilled: replies, rejected,
    errors: results.flatMap(value => 'error' in value ? [{ code: value.error.code, message: value.error.message }] : []),
    physicalConnections: f.sockets.length, authenticatedConnections: f.connections(), afterSettleIdle: idle,
    afterDispose: 0, originalLocalRelayPairsBudget: 128, originalDeviceReadersBudget: 128, hostPerSocketQueuedBudget: 128 })
})

it.each([0, 20])('actual Host Mobile combines first and suffix over a warm finite carrier with %i ms controlled reply delay', async delay => {
  const f = await actualRelayOwner(), client = await f.hosted()
  await client.readAgentSessions()
  const control = createMobileTerminalControl({ client, agentSessionId: 'caller', report: () => {} })
  f.cleanup(() => control.dispose())
  f.reply(async (frame, _connection, send) => {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay))
    await send(frame)
  })
  const started = performance.now(), native: number[] = [], raw = f.rawInput.getMockImplementation()!
  f.rawInput.mockImplementation((id, data) => { native.push(performance.now() - started); return raw(id, data) })
  const handshakes = f.handshakes()
  expect(control.enable()).toBe(true)
  for (const char of 'abcdefghijkl') control.send(char, 'user')
  await expect.poll(() => control.facts().phase).toBe('idle')
  expect(f.rawInput.mock.calls.map(call => typeof call[1] === 'string' ? call[1] : new TextDecoder().decode(call[1]))).toEqual(['a', 'bcdefghijkl'])
  expect(f.handshakes()).toBe(handshakes)
  carrierFact({ kind: 'actual-host-mobile-coalescing', controlledReplyDelayMs: delay, events: 12, nativeCalls: 2,
    additionalHandshakes: f.handshakes() - handshakes, inputToNativeMs: native, finalReceiptMs: performance.now() - started,
    scope: 'Actual Host/LocalRelay/E2EE/Hosted/Core, deterministic native I/O, no real-phone/IME claim' })
})

it('finite business refusal keeps the same warm connection while original authorization and runtime fence are checked again', async () => {
  const f = await actualRelayOwner()
  const authority = vi.spyOn(f.authority, 'assertCurrentKey')
  const { owner } = await f.rpc.call('runtime.owner.identity', {})
  const connections = f.connections(), checked = authority.mock.calls.length
  await expect(f.rpc.call('runtime.owner.identity', { expectedRuntimeId: 'different-original-owner' })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect((await f.rpc.call('runtime.owner.identity', { expectedRuntimeId: owner.runtimeId })).owner).toEqual(owner)
  expect(f.connections()).toBe(connections)
  const fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
  for (const data of ['first-authorized', 'second-authorized']) await f.rpc.call('runtime.invoke', { consumerId: 'authority-reuse', fence,
    invocation: { method: 'writeAgent', args: [{ agentSessionId: 'caller', expectedRun: { runId: 'run-caller' }, data, source: 'user' }] } })
  expect(f.connections()).toBe(connections)
  expect(authority.mock.calls.length - checked).toBeGreaterThanOrEqual(2)
  expect(f.host.client.agentSession('caller').run.runId).toBe('run-caller')
  carrierFact({ kind: 'finite-refusal-reuse', sameConnections: true, perRequestAuthorityChecks: authority.mock.calls.length - checked,
    originalRuntimeId: owner.runtimeId, rejectedOtherRuntime: true })
})

it('late ready after exact opening cancellation cannot send cancelled bytes or replace a healthy idle peer', async () => {
  const f = await actualRelayOwner(), late: Array<() => void> = [], opened: WebSocket[] = []
  const relay = relayLeaf.createAgentMuxRpcRelayClient({ ...f.options, createWebSocket: url => {
    const socket = new WebSocket(url)
    opened.push(socket)
    if (opened.length === 1) {
      const listen = socket.addEventListener.bind(socket)
      socket.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
        if (type === 'open') listen(type, event => late.push(() => listener(event)), options)
        else listen(type, listener, options)
      }) as typeof socket.addEventListener
    }
    return socket
  } })
  f.cleanup(() => relay.dispose())
  const controller = new AbortController(), ended = held<Error | undefined>()
  const first = await relay.open({ jsonrpc: '2.0', id: 'cancel-before-e2ee', method: 'agent.ls', params: {} }, () => {}, error => ended.resolve(error), controller.signal, false)
  await expect.poll(() => late.length).toBe(1)
  const received = held()
  const peer = await relay.open({ jsonrpc: '2.0', id: 'healthy-peer', method: 'agent.ls', params: {} }, () => received.resolve(), () => {}, new AbortController().signal, false)
  await received.promise
  await peer.dispose()
  controller.abort()
  expect(await ended.promise).toMatchObject({ code: 'CONTROL_CANCELLED' })
  for (const callback of late.splice(0)) callback()
  await first.dispose()
  const nextReply = held(), next = await relay.open({ jsonrpc: '2.0', id: 'next-original-intent', method: 'agent.ls', params: {} }, () => nextReply.resolve(), () => {}, new AbortController().signal, false)
  await nextReply.promise
  await next.dispose()
  expect(opened).toHaveLength(2)
  expect(f.handshakes()).toBe(1)
  expect(f.requests.map(value => value.frame.id)).toEqual(['healthy-peer', 'next-original-intent'])
  carrierFact({ kind: 'late-opening-cancel', cancelledSent: false, originalLateSocketClosed: opened[0]!.readyState >= WebSocket.CLOSING,
    peerRetained: true, subsequentHandshakeCount: f.handshakes() })
})

it('leaf callback failure reports its original error after releasing all independently owned carriers', async () => {
  const f = await actualRelayOwner(), relay = relayLeaf.createAgentMuxRpcRelayClient(f.options), release = held()
  f.cleanup(() => relay.dispose())
  f.cleanup(() => release.resolve())
  const originalError = Error('Original leaf reader end failed'), streamReady = held()
  await relay.open({ jsonrpc: '2.0', id: 'leaf-stream', method: 'agent.output', params: { agentSessionId: 'caller', follow: true } },
    () => streamReady.resolve(), () => { throw originalError }, new AbortController().signal, true)
  await streamReady.promise
  f.reply(async (frame, _connection, send) => { if (frame.id === 'leaf-pending') await release.promise; await send(frame) })
  const activeEnd = held<Error | undefined>()
  await relay.open({ jsonrpc: '2.0', id: 'leaf-pending', method: 'agent.ls', params: {} }, () => {}, error => activeEnd.resolve(error), new AbortController().signal, false)
  const idleReady = held()
  const idle = await relay.open({ jsonrpc: '2.0', id: 'leaf-idle', method: 'agent.ls', params: {} }, () => idleReady.resolve(), () => {}, new AbortController().signal, false)
  await idleReady.promise
  await idle.dispose()
  expect(f.activeSockets()).toHaveLength(3)
  expect(() => relay.dispose()).toThrow(originalError)
  await vi.waitFor(() => expect(f.activeSockets()).toHaveLength(0))
  expect(await activeEnd.promise).toMatchObject({ code: 'CONTROL_CANCELLED' })
  release.resolve()
  await expect.poll(() => f.inFlight()).toBe(0)
  carrierFact({ kind: 'leaf-throw-cleanup', originalError: originalError.message, beforeDispose: 3, afterDispose: 0 })
})
