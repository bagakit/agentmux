import { afterEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { createDaemonChannel, generateKeyPair, exportPublicKey, type Transport } from '@agentmux/relay/e2ee'
import { HostedRelayRpcPort } from '../../../packages/core/src/relay-hosted.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { themeObservation } from '../src/main/theme-observation.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import type { AgentMuxAppearanceObservation } from '@agentmux/core'
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const until = async (ready: () => boolean) => { for (let i = 0; i < 100 && !ready(); i++) await new Promise(resolve => setTimeout(resolve, 5)); expect(ready()).toBe(true) }

it.each(['dispose', 'stale-revision', 'foreign-source', 'wire-sequence', 'foreign-domain', 'extra-field'])('carries real Main observation through encrypted Relay and Hosted SDK without a Runtime gate (%s)', async failure => {
  const f = await configOwnerFixture(), keys = generateKeyPair()
  const service = new AgentMuxRpcService({ coreClients: () => [], appearance: themeObservation(f.owner) })
  cleanup.push(() => service.dispose())
  let producer: Awaited<ReturnType<typeof service.subscribe>> | undefined, wireSequence = 0
  let inject!: (data: AgentMuxAppearanceObservation, sequence: number) => Promise<void>
  let injectEvent!: (event: unknown, sequence: number) => Promise<void>
  const sockets: FakeSocket[] = []
  class FakeSocket extends EventTarget {
    readyState = 1; bufferedAmount = 0; binaryType = 'arraybuffer'
    readonly daemon: Transport
    constructor() {
      super(); sockets.push(this)
      this.daemon = { onmessage: null, onclose: null, onerror: null,
        send: data => { if (this.readyState === 1) this.dispatchEvent(new MessageEvent('message', { data })) },
        close: () => this.close() }
      const opening = createDaemonChannel(this.daemon, keys, { onmessage: async data => {
        const request = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data))
        const channel = await opening
        injectEvent = async (event, sequence) => { await channel.send(JSON.stringify({ jsonrpc: '2.0', method: 'system.subscription.event', params: {
          subscriptionId: 'original-read-lease', method: request.method, sequence, event
        } })) }
        inject = (data, sequence) => injectEvent({ type: 'snapshot', data }, sequence)
        producer = await service.subscribe(request.method, request.params, async event => {
          await channel.send(JSON.stringify({ jsonrpc: '2.0', method: 'system.subscription.event', params: {
            subscriptionId: 'original-read-lease', method: request.method, sequence: ++wireSequence, event
          } }))
        }, { principal: { kind: 'user', id: 'real-fixture-transport' }, transport: 'relay' })
        await channel.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
          subscriptionId: 'original-read-lease', method: request.method, initial: producer.initial
        } }))
        await producer.start?.()
      } })
      void opening.catch(() => {})
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }
    send(data: string | ArrayBuffer) { this.daemon.onmessage?.({ data, isBinary: typeof data !== 'string' }) }
    close() { if (this.readyState !== 1) return; this.readyState = 3; void producer?.dispose() }
  }
  const rpc = new HostedRelayRpcPort({ offer: { v: 2, serverId: 'original-host', daemonPublicKeyB64: exportPublicKey(keys.publicKey), relay: { endpoint: '127.0.0.1:4321', useTls: false } }, createWebSocket: () => new FakeSocket() as unknown as WebSocket })
  cleanup.push(() => rpc.dispose())
  // There is deliberately no semantic Runtime. Appearance still borrows the original public read transport.
  const runtime = { call: vi.fn(async () => { throw new Error('Runtime is not available in this observation fixture') }), subscribe: vi.fn(async () => { throw new Error('No Runtime events needed') }) }
  const hosted = await connectHostedAgentMux({ rpc: runtime as never, waitForReady: false, subscribeRpc: (method, params, handlers) => rpc.subscribePublic(method, params, handlers) })
  cleanup.push(() => hosted.dispose())
  let initial: AgentMuxAppearanceObservation | undefined
  const events: AgentMuxAppearanceObservation[] = [], end = vi.fn()
  const reader = await hosted.subscribeRpc!('settings.appearance.watch', {}, { onInitial: value => { initial = value.observation }, onEvent: event => { if (event.type === 'snapshot') events.push(event.data) }, onEnd: end })
  expect(reader.subscriptionId).toBe('original-read-lease'); expect(initial?.values.themeId).toBe('graphite')
  initial!.revision = 999 // Consumer annotations cannot alter the private protocol cursor.
  await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, appAppearance: 'light' } }))
  await until(() => events.length === 1)
  expect(events[0]).toMatchObject({ sourceId: initial!.sourceId, revision: 1, values: { appAppearance: 'light' } })
  if (failure !== 'dispose') {
    const malformed = { ...events[0]!, ...(failure === 'foreign-source' ? { sourceId: 'another-owner', revision: 2 } : {}) }
    if (failure === 'foreign-domain') await injectEvent({ type: 'output', data: { agentSessionId: 'other-target', endByte: 20 } }, 2)
    else if (failure === 'extra-field') await injectEvent({ type: 'end', data: {}, unrelated: 'field' }, 2)
    else await inject(malformed, failure === 'wire-sequence' ? 3 : 2)
    await until(() => end.mock.calls.length === 1)
    expect(end.mock.calls[0]![0]).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' }); expect(events).toHaveLength(1)
  }
  await hosted.dispose(); expect(sockets.every(socket => socket.readyState === 3)).toBe(true)
  await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, appAppearance: 'dark' } }))
  expect(events).toHaveLength(1); expect((await f.disk()).appearance.appAppearance).toBe('dark')
})


it.each(['disconnect', 'dispose', 'abort'])('cancels a pending Hosted public opening and suppresses late callbacks (%s)', async action => {
  let finish!: (value: any) => void, handlers: any
  const original = { subscriptionId: 'late-reader', dispose: vi.fn(async () => {}) }, signal = new AbortController()
  const runtime = { call: vi.fn(async () => { throw new Error('Runtime not needed') }), subscribe: vi.fn(async () => { throw new Error('Runtime not needed') }) }
  const hosted = await connectHostedAgentMux({ rpc: runtime as never, waitForReady: false,
    subscribeRpc: (_method, _params, input) => { handlers = input; return new Promise(resolve => { finish = resolve }) } })
  cleanup.push(() => hosted.dispose())
  const initial = vi.fn(), event = vi.fn(), end = vi.fn()
  const pending = hosted.subscribeRpc!('settings.appearance.watch', {}, { ...(action === 'abort' ? { signal: signal.signal } : {}), onInitial: initial, onEvent: event, onEnd: end })
  const refusal = expect(pending).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
  if (action === 'disconnect') hosted.disconnect()
  else if (action === 'dispose') await hosted.dispose()
  else signal.abort()
  expect(handlers.signal.aborted).toBe(true)
  handlers.onInitial({ observation: {} }); handlers.onEvent({ type: 'snapshot', data: {} }); handlers.onEnd(new Error('Late callback'))
  finish(original); await refusal
  expect(original.dispose).toHaveBeenCalledOnce(); expect(initial).not.toHaveBeenCalled(); expect(event).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled()
})
