import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { registerHostRuntimeObservationIpc } from '../src/main/host-runtime-observation-ipc'
import { observeRead } from '../../../packages/core/src/observation-read'
import { senderTrust, assertSenderTrusted } from '../src/main/ipc-sender-trust'
import { AgentMuxError } from '../../../packages/core/src/errors'
class Sender extends EventEmitter { id = 42; isDestroyed() { return false } }
it('uses the existing per-sender read owner, preserves original failures and releases cancelled/navigation readers', async () => {
  const handlers = new Map<string, (...args: any[]) => any>(), sender = new Sender(), signals: AbortSignal[] = []
  const inspect = vi.fn(async (_host: import('../src/shared/contracts').HostConfig, signal: AbortSignal) => {
    signals.push(signal)
    return await observeRead(new Promise<never>(() => {}), signal)
  })
  const trust = vi.fn()
  const owner = registerHostRuntimeObservationIpc({ handle: (channel, listener) => { handlers.set(channel, listener) }, trust, inspect })
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

it('rejects foreign observation and cancellation senders through the actual original trust owner before any read', async () => {
  const handlers = new Map<string, (...args: any[]) => any>(), sender = new Sender(), inspect = vi.fn()
  const owner = registerHostRuntimeObservationIpc({ handle: (channel, listener) => { handlers.set(channel, listener) },
    trust: (channel, event) => assertSenderTrusted(senderTrust(channel, event.sender, sender)), inspect })
  const foreign = { sender: new Sender() }
  expect(() => handlers.get('hosts:inspect')!(foreign, 'foreign-read', { id: 'local', kind: 'local', label: 'Local' })).toThrow('Untrusted Host Runtime observation sender')
  expect(() => handlers.get('hosts:cancelInspect')!(foreign, 'foreign-read')).toThrow('Untrusted Host Runtime observation cancellation sender')
  expect(inspect).not.toHaveBeenCalled(); owner.dispose()
})
