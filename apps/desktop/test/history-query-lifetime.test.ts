import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { SessionHistoryReadOwners } from '../src/main/session-history-read'
import { createRendererHistoryRead } from '../src/renderer/src/lib/history-read'

const sender = (id: number) => Object.assign(new EventEmitter(), { id, isDestroyed: () => false })

it('cancels only the exact sender read, and ordinary completion releases its listeners', async () => {
  const owners = new SessionHistoryReadOwners(), a = sender(1), b = sender(2)
  let release!: () => void
  const paused = new Promise<void>(resolve => { release = resolve })
  let first!: AbortSignal, second!: AbortSignal
  const cancelled = owners.read(a, 'same-token', async signal => { first = signal; await paused; return 'a' })
  const retained = owners.read(b, 'same-token', async signal => { second = signal; await paused; return 'b' })
  const rejected = expect(cancelled).rejects.toThrow('reader closed')
  owners.cancel(a.id, 'same-token')
  expect(first.aborted).toBe(true); expect(second.aborted).toBe(false)
  release(); await rejected; await expect(retained).resolves.toBe('b')
  expect(a.listenerCount('destroyed')).toBe(0); expect(b.listenerCount('did-start-navigation')).toBe(0)
  await expect(owners.read(a, 'same-token', async () => 'reused after release')).resolves.toBe('reused after release')
})

it('navigation, owner destruction and dispose cancel readers without any Agent control operation', async () => {
  const owners = new SessionHistoryReadOwners(), a = sender(1), signals: AbortSignal[] = []
  const read = () => owners.read(a, 'original', async signal => { signals.push(signal); return await new Promise<string>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) })
  let result = read(), rejected = expect(result).rejects.toThrow('reader closed')
  a.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false }); expect(signals[0]!.aborted).toBe(false)
  a.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); await rejected
  result = read(); rejected = expect(result).rejects.toThrow('reader closed'); a.emit('destroyed'); await rejected
  result = read(); rejected = expect(result).rejects.toThrow('reader closed'); owners.dispose(); await rejected
  expect(a.listenerCount('destroyed')).toBe(0)
})

it('Renderer cancellation remains local, crosses only a callback, and rejects late results', async () => {
  const reference = { hostId: 'original-host', agentSessionId: 'original-agent' }
  const controller = new AbortController(), cancelled = vi.fn(), release = vi.fn()
  let finish!: (value: never) => void
  const transport = vi.fn(async (_reference, _input, context) => {
    expect(context).not.toHaveProperty('signal')
    context.onAbort(cancelled)
    return await new Promise<never>(resolve => { finish = resolve })
  })
  // Transport fixture binds its cleanup to the exact local signal listener.
  transport.mockImplementationOnce(async (_reference, _input, context) => {
    const cleanup = context.onAbort(cancelled)
    return await new Promise<never>(resolve => { finish = value => { cleanup(); release(); resolve(value) } })
  })
  const read = createRendererHistoryRead(transport), reason = new Error('original local cancellation')
  const pending = read(reference, { source: 'native' }, { signal: controller.signal })
  const rejected = expect(pending).rejects.toBe(reason)
  controller.abort(reason); expect(cancelled).toHaveBeenCalledTimes(1); finish({} as never)
  await rejected; expect(release).toHaveBeenCalledTimes(1)
  await expect(read(reference, { source: 'native' }, { signal: controller.signal })).rejects.toBe(reason)
  expect(transport).toHaveBeenCalledTimes(1)
})
