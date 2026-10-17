import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { registerHostRuntimeObservationIpc } from '../src/main/host-runtime-observation-ipc'
import { observeRead } from '../../../packages/core/src/observation-read'
import { senderTrust, assertSenderTrusted } from '../src/main/ipc-sender-trust'
import { AgentMuxError } from '../../../packages/core/src/errors'
import { createRendererHostObservation } from '../src/renderer/src/lib/host-observation'
class Sender extends EventEmitter { id = 42; isDestroyed() { return false } }
it('uses the existing per-sender read owner, preserves original failures and releases cancelled/navigation readers', async () => {
  const handlers = new Map<string, (...args: any[]) => any>(), sender = new Sender(), signals: AbortSignal[] = []
  const inspect = vi.fn(async (_host: import('../src/shared/contracts').HostConfig, signal: AbortSignal) => {
    signals.push(signal)
    return await observeRead(new Promise<never>(() => {}), signal)
  })
  const trust = vi.fn()
  const owner = registerHostRuntimeObservationIpc({ handle: (channel, listener) => { handlers.set(channel, listener) }, trust,
    call: (_method, params, context) => inspect(params.expected as import('../src/shared/contracts').HostConfig, context.signal) })
  const event = { sender }, host = { id: 'exact-route', kind: 'local' as const, label: 'Original host' }
  const pending = handlers.get('hosts:inspect')!(event, 'reader-one', host)
  expect(inspect.mock.calls[0]![0]).toBe(host)
  handlers.get('hosts:cancelInspect')!({ sender: { id: 999 } }, 'reader-one')
  expect(signals[0]!.aborted).toBe(false)
  handlers.get('hosts:cancelInspect')!(event, 'reader-one')
  expect(signals[0]!.aborted).toBe(true)
  expect(await pending).toMatchObject({ ok: false })
  expect(sender.listenerCount('destroyed')).toBe(0)
  const navigation = handlers.get('hosts:inspect')!(event, 'reader-two', host)
  sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(await navigation).toMatchObject({ ok: false })
  const failure = new AgentMuxError('Original service refused this query', 'RUNTIME_OWNER_MISMATCH')
  inspect.mockRejectedValueOnce(failure)
  expect(await handlers.get('hosts:inspect')!(event, 'reader-three', host)).toMatchObject({ ok: false, error: { code: 'RUNTIME_OWNER_MISMATCH', message: failure.message } })
  expect(trust).toHaveBeenCalledWith('hosts:inspect', event)
  owner.dispose(); expect(sender.listenerCount('destroyed')).toBe(0)
})

it('network-trust: rejects foreign observation and cancellation senders through the actual original trust owner before any read', async () => {
  const handlers = new Map<string, (...args: any[]) => any>(), sender = new Sender(), inspect = vi.fn()
  const owner = registerHostRuntimeObservationIpc({ handle: (channel, listener) => { handlers.set(channel, listener) },
    trust: (channel, event) => assertSenderTrusted(senderTrust(channel, event.sender, sender)), call: inspect })
  const foreign = { sender: new Sender() }
  expect(() => handlers.get('hosts:inspect')!(foreign, 'foreign-read', { id: 'local', kind: 'local', label: 'Local' })).toThrow('Untrusted Host Runtime observation sender')
  expect(() => handlers.get('hosts:cancelInspect')!(foreign, 'foreign-read')).toThrow('Untrusted Host Runtime observation cancellation sender')
  expect(() => handlers.get('hosts:network')!(foreign, 'foreign-read', { id: 'local', kind: 'local', label: 'Local' })).toThrow('Untrusted Host network observation sender')
  expect(inspect).not.toHaveBeenCalled(); owner.dispose()
})

it('network read uses the original trusted per-sender cancellation owner', async () => {
  const handlers = new Map<string, (...args: any[]) => any>(), sender = new Sender()
  let signal!: AbortSignal
  const network = vi.fn(async (_method, _params, context: { signal: AbortSignal }) => { signal = context.signal; return await observeRead(new Promise<never>(() => {}), signal) })
  const owner = registerHostRuntimeObservationIpc({ handle: (channel, listener) => { handlers.set(channel, listener) }, trust: vi.fn(), call: network })
  const host = { id: 'network-original', kind: 'local', label: 'Original' }, event = { sender }
  const pending = handlers.get('hosts:network')!(event, 'network-reader', host)
  expect(network.mock.calls[0]!.slice(0, 2)).toEqual(['settings.hosts.network', { hostId: host.id, expected: host }])
  handlers.get('hosts:cancelInspect')!({ sender: { id: 999 } }, 'network-reader'); expect(signal.aborted).toBe(false)
  handlers.get('hosts:cancelInspect')!(event, 'network-reader'); expect(signal.aborted).toBe(true)
  expect(await pending).toMatchObject({ ok: false })
  owner.dispose(); expect(sender.listenerCount('destroyed')).toBe(0)
})

it('network-bridge: the actual Renderer adapter reaches the registered public read and cancels its exact sender lease', async () => {
  const handlers = new Map<string, (...args: any[]) => any>(), sender = new Sender(), release = vi.fn()
  let observed!: AbortSignal
  const call = vi.fn(async (_method, _params, context: { signal: AbortSignal }) => { observed = context.signal; return await observeRead(new Promise<never>(() => {}), observed) })
  const owner = registerHostRuntimeObservationIpc({ handle: (channel, listener) => { handlers.set(channel, listener) }, trust: vi.fn(), call })
  const read = createRendererHostObservation(async (host, context) => {
    const cancel = context?.onAbort?.(() => { handlers.get('hosts:cancelInspect')!({ sender }, 'bridge-token') })
    try { return await handlers.get('hosts:network')!({ sender }, 'bridge-token', host) } finally { cancel?.(); release() }
  })
  const host = { id: 'bridge-original', kind: 'local' as const, label: 'Bridge original' }, controller = new AbortController()
  const pending = read(host, { signal: controller.signal })
  expect(call.mock.calls[0]!.slice(0, 2)).toEqual(['settings.hosts.network', { hostId: host.id, expected: host }])
  controller.abort(); await expect(pending).rejects.toBeDefined()
  expect(observed.aborted).toBe(true); expect(release).toHaveBeenCalledOnce()
  owner.dispose(); expect(sender.listenerCount('destroyed')).toBe(0)
})
