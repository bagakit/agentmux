import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { ExecutionBindingReaders, type ExecutionBindingSender } from '../src/main/execution-binding-readers'
import type { AgentExecutionBindingWatch, AgentExecutionBindingWatchContext, AgentExecutionInspection } from '@agentmux/core'
const observation = (bindingId = 'original'): AgentExecutionInspection => ({ bindingId, agentHostId: 'B', resourceHostId: 'A', agentSessionId: 'original-agent', resourceWorkspacePath: '/project', state: 'connected' })
function sender() { return Object.assign(new EventEmitter(), { isDestroyed: vi.fn(() => false), send: vi.fn() }) as EventEmitter & ExecutionBindingSender & { send: ReturnType<typeof vi.fn>; isDestroyed: ReturnType<typeof vi.fn> } }
function fixture() {
  const sources = new Map<string, { send(value: AgentExecutionInspection): void; fail(error: Error): void; dispose: ReturnType<typeof vi.fn> }>()
  const watch = vi.fn(async (bindingId: string, send: (v: AgentExecutionInspection | null) => void | Promise<void>, context: AgentExecutionBindingWatchContext = {}) => {
    const dispose = vi.fn(); sources.set(bindingId, { send: value => { void send(value) }, fail: error => context.onError?.(error), dispose })
    return { initial: { bindingId, inspection: observation(bindingId) }, start: vi.fn(), dispose }
  })
  return { sources, watch, readers: new ExecutionBindingReaders({ watch }) }
}
it('opens one related Core subscription and releases the last viewer only, without visiting unrelated consumers', async () => {
  const f = fixture(), target = sender(), second = sender(), unrelated = sender()
  await f.readers.observe(target, 'target', 'original'); await f.readers.observe(second, 'second', 'original')
  await f.readers.observe(unrelated, 'other', 'other-binding'); expect(f.watch).toHaveBeenCalledTimes(2)
  target.send.mockClear(); second.send.mockClear(); unrelated.send.mockClear(); unrelated.isDestroyed.mockClear()
  const source = f.sources.get('original')!
  source.send(observation())
  expect(target.send).toHaveBeenCalledExactlyOnceWith('sessions:executionBindingChanged', { watchId: 'target', inspection: observation() })
  expect(unrelated.send).not.toHaveBeenCalled(); expect(unrelated.isDestroyed).not.toHaveBeenCalled()
  target.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  target.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  source.send(observation()); expect(target.send).toHaveBeenCalledTimes(2)
  target.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(source.dispose).not.toHaveBeenCalled()
  source.send(observation()); expect(target.send).toHaveBeenCalledTimes(2); expect(second.send).toHaveBeenCalledTimes(3)
  second.emit('render-process-gone'); await Promise.resolve(); expect(source.dispose).toHaveBeenCalledOnce()
  expect(target.listenerCount('destroyed')).toBe(0)
  f.readers.dispose(); expect(unrelated.listenerCount('did-start-navigation')).toBe(0)
})
it('preserves pushes before opening and suppresses delivery after reader release', async () => {
  let resolve!: (v: any) => void, push!: (v: AgentExecutionInspection) => void
  const dispose = vi.fn(), readers = new ExecutionBindingReaders({ watch: vi.fn((_id, send) => { push = send; return new Promise<AgentExecutionBindingWatch>(done => { resolve = done }) }) }), target = sender()
  const opening = readers.observe(target, 'id', 'original'); await Promise.resolve()
  const newer: AgentExecutionInspection = { ...observation(), state: 'unavailable', diagnostic: { code: 'ORIGINAL_UNKNOWN', message: 'Original operation outcome unknown' } }
  push(newer); readers.release(target, 'id'); resolve({ initial: { bindingId: 'original', inspection: observation() }, start: vi.fn(), dispose }); await opening
  expect(target.send).toHaveBeenCalledTimes(1); expect(target.send.mock.calls[0]![1].inspection).toEqual(newer)
  expect(dispose).toHaveBeenCalled(); readers.dispose()
})
it('reports stream failure without discarding the original view, and explicitly retries only the reader', async () => {
  const f = fixture(), target = sender(); await f.readers.observe(target, 'id', 'original')
  f.sources.get('original')!.fail(new Error('Core reader unavailable'))
  expect(target.send.mock.lastCall![1]).toEqual({ watchId: 'id', error: 'Core reader unavailable' })
  expect(target.listenerCount('destroyed')).toBe(1)
  await f.readers.observe(target, 'retry', 'original'); expect(f.watch).toHaveBeenCalledTimes(2)
  expect(target.send.mock.lastCall![1].inspection).toEqual(observation()); f.readers.dispose()
})
it('a failed or closing renderer cannot interrupt another healthy reader of the same binding', async () => {
  const f = fixture(), broken = sender(), healthy = sender()
  await f.readers.observe(broken, 'broken', 'original'); await f.readers.observe(healthy, 'healthy', 'original')
  broken.send.mockImplementation(() => { throw Error('renderer gone') }); healthy.send.mockClear()
  expect(() => f.sources.get('original')!.send(observation())).not.toThrow()
  expect(healthy.send).toHaveBeenCalledOnce(); expect(broken.listenerCount('destroyed')).toBe(0)
  f.sources.get('original')!.send(observation()); expect(healthy.send).toHaveBeenCalledTimes(2); f.readers.dispose()
})
it('an old opening or error cannot overwrite newer facts or a replacement reader', async () => {
  let finish!: (v: any) => void, oldError!: (e: unknown) => void, oldPush!: (v: AgentExecutionInspection) => void
  const dispose = vi.fn(), target = sender(), latest = { ...observation(), state: 'unavailable' as const, diagnostic: { code: 'LATEST', message: 'Latest original fact' } }
  const watch = vi.fn().mockImplementationOnce((_id, send, context) => { oldPush = send; oldError = context.onError; return new Promise(done => { finish = done }) })
    .mockImplementationOnce(async () => ({ initial: { bindingId: 'original', inspection: latest }, start: vi.fn(), dispose: vi.fn() }))
  const readers = new ExecutionBindingReaders({ watch })
  const original = readers.observe(target, 'first', 'original'); await Promise.resolve(); oldPush(latest)
  finish({ initial: { bindingId: 'original', inspection: observation() }, start: vi.fn(), dispose }); await original
  expect(target.send).toHaveBeenCalledOnce(); expect(target.send.mock.lastCall![1].inspection).toEqual(latest)
  readers.release(target, 'first'); await readers.observe(target, 'replacement', 'original'); target.send.mockClear()
  oldPush(observation()); oldError(Error('old reader ended'))
  expect(target.send).not.toHaveBeenCalled(); expect(watch).toHaveBeenCalledTimes(2); readers.dispose()
})
