import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { ExecutionBindingReaders, type ExecutionBindingSender } from '../src/main/execution-binding-readers'
import type { AgentExecutionInspection } from '@agentmux/core'
const observation = (bindingId = 'original'): AgentExecutionInspection => ({ bindingId, agentHostId: 'B', resourceHostId: 'A', agentSessionId: 'original-agent', resourceWorkspacePath: '/project', state: 'connected' })
function sender() { return Object.assign(new EventEmitter(), { isDestroyed: vi.fn(() => false), send: vi.fn() }) as EventEmitter & ExecutionBindingSender & { send: ReturnType<typeof vi.fn>; isDestroyed: ReturnType<typeof vi.fn> } }
it('only visits consumers of this binding and releases the exact sender on navigation/crash/destruction', async () => {
  const readers = new ExecutionBindingReaders(async id => observation(id)), target = sender(), unrelated = sender()
  await readers.observe(target, 'target', 'original')
  await readers.observe(unrelated, 'other', 'other-binding')
  target.send.mockClear(); unrelated.send.mockClear(); unrelated.isDestroyed.mockClear()
  readers.publish(observation())
  expect(target.send).toHaveBeenCalledExactlyOnceWith('sessions:executionBindingChanged', { watchId: 'target', inspection: observation() })
  expect(unrelated.send).not.toHaveBeenCalled(); expect(unrelated.isDestroyed).not.toHaveBeenCalled()
  target.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  target.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  readers.publish(observation()); expect(target.send).toHaveBeenCalledTimes(2)
  target.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  readers.publish(observation()); expect(target.send).toHaveBeenCalledTimes(2)
  expect(target.listenerCount('destroyed')).toBe(0)
  for (const event of ['render-process-gone', 'destroyed']) {
    const current = sender(); await readers.observe(current, 'id', 'original'); current.send.mockClear()
    current.emit(event); readers.publish(observation()); expect(current.send).not.toHaveBeenCalled()
  }
  readers.dispose(); expect(unrelated.listenerCount('did-start-navigation')).toBe(0)
})
it('does not overwrite a newer pushed fact with the initial read or deliver after original reader release', async () => {
  let resolve!: (value: AgentExecutionInspection) => void
  const readers = new ExecutionBindingReaders(() => new Promise(done => { resolve = done })), target = sender()
  const first = readers.observe(target, 'id', 'original')
  const newer: AgentExecutionInspection = { ...observation(), state: 'unavailable', diagnostic: { code: 'ORIGINAL_UNKNOWN', message: 'Original operation outcome unknown' } }
  readers.publish(newer); resolve(observation()); await first
  expect(target.send).toHaveBeenCalledTimes(1)
  expect(target.send.mock.calls[0]![1].inspection).toEqual(newer)
  const second = readers.observe(target, 'id', 'original')
  readers.release(target, 'id'); resolve(observation()); await second
  expect(target.send).toHaveBeenCalledTimes(1)
})
it('releases a failed initial read, permits an explicit retry, and never cancels any Core binding', async () => {
  const inspect = vi.fn().mockRejectedValueOnce(new Error('read unavailable')).mockResolvedValue(observation())
  const readers = new ExecutionBindingReaders(inspect), target = sender()
  await expect(readers.observe(target, 'id', 'original')).rejects.toThrow('read unavailable')
  expect(target.listenerCount('destroyed')).toBe(0)
  readers.publish(observation()); expect(target.send).not.toHaveBeenCalled()
  await readers.observe(target, 'id', 'original'); expect(target.send).toHaveBeenCalledTimes(1)
  readers.dispose()
})

it('a closing reader cannot interrupt another healthy reader of the same binding', async () => {
  const readers = new ExecutionBindingReaders(async id => observation(id)), broken = sender(), healthy = sender()
  await readers.observe(broken, 'broken', 'original'); await readers.observe(healthy, 'healthy', 'original')
  broken.send.mockImplementation(() => { throw new Error('renderer gone after the check') }); healthy.send.mockClear()
  expect(() => readers.publish(observation())).not.toThrow()
  expect(healthy.send).toHaveBeenCalledTimes(1)
  expect(broken.listenerCount('destroyed')).toBe(0)
  readers.publish(observation()); expect(healthy.send).toHaveBeenCalledTimes(2)
  readers.dispose()
})
