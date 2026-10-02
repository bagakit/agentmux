import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxPreloadApi, SessionHistoryObservationEvent, SessionHistoryObservationReady } from '../src/shared/contracts'
import { SESSION_HISTORY_OBSERVATION_CHANNEL } from '../src/shared/contracts'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(),
  listeners: new Map<string, (event: unknown, payload: SessionHistoryObservationEvent) => void>() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke,
    on: (channel: string, receive: (event: unknown, payload: SessionHistoryObservationEvent) => void) => bridge.listeners.set(channel, receive),
    removeListener: (channel: string) => bridge.listeners.delete(channel) },
  webFrame: { getZoomFactor: () => 1 }
}))
import '../src/preload/index'
const reference = { hostId: 'local', agentSessionId: 'native-reader' }
const source = { providerId: 'codex' as const, nativeSessionId: 'native-source' }
const event: SessionHistoryObservationEvent = { token: '', observation: { ...reference, source, kind: 'invalidated' } }
beforeEach(() => {
  bridge.listeners.clear(); bridge.invoke.mockReset()
  bridge.invoke.mockImplementation(async (channel: string) => channel === 'sessions:observeHistory' ? { source } : undefined)
})
function acquire(listener = vi.fn(), onAbort?: (abort: () => void) => () => void) {
  return bridge.api!.sessions.observeHistory(reference, listener, onAbort ? { onAbort } : undefined)
}
it('live cancellation releases the exact token, removes notifications and disposes once', async () => {
  const receive = vi.fn(), unsubscribe = vi.fn(); let abort!: () => void
  const handle = await acquire(receive, callback => { abort = callback; return unsubscribe })
  const token = bridge.invoke.mock.calls[0]![1] as string
  const deliver = bridge.listeners.get(SESSION_HISTORY_OBSERVATION_CHANNEL)!
  deliver(null, { ...event, token }); expect(receive).toHaveBeenCalledTimes(1)
  abort(); handle.dispose(); deliver(null, { ...event, token })
  expect(receive).toHaveBeenCalledTimes(1); expect(unsubscribe).toHaveBeenCalledTimes(1)
  expect(bridge.listeners.size).toBe(0)
  expect(bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:releaseHistoryObservation')).toEqual([['sessions:releaseHistoryObservation', token]])
})
it('pending cancellation releases the owner before a late ready response', async () => {
  let ready!: (value: SessionHistoryObservationReady) => void, abort!: () => void
  bridge.invoke.mockImplementation((channel: string) => channel === 'sessions:observeHistory' ? new Promise(resolve => { ready = resolve }) : Promise.resolve())
  const unsubscribe = vi.fn(), pending = acquire(vi.fn(), callback => { abort = callback; return unsubscribe })
  const rejected = expect(pending).rejects.toThrow('released before ready')
  abort(); expect(bridge.invoke.mock.calls.at(-1)![0]).toBe('sessions:releaseHistoryObservation')
  ready({ source }); await rejected
  expect(unsubscribe).toHaveBeenCalledTimes(1); expect(bridge.listeners.size).toBe(0)
})
it('synchronous cancellation during subscription never starts an acquisition', async () => {
  const unsubscribe = vi.fn()
  await expect(acquire(vi.fn(), abort => { abort(); return unsubscribe })).rejects.toThrow('cancelled before acquisition')
  expect(bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:observeHistory')).toHaveLength(0)
  expect(unsubscribe).toHaveBeenCalledTimes(1); expect(bridge.listeners.size).toBe(0)
})
it('failed acquisition releases its subscription and token', async () => {
  bridge.invoke.mockImplementation(async (channel: string) => channel === 'sessions:observeHistory' ? { error: { code: 'unavailable', message: 'Source unavailable' } } : undefined)
  const unsubscribe = vi.fn()
  await expect(acquire(vi.fn(), () => unsubscribe)).rejects.toMatchObject({ code: 'unavailable', message: 'Source unavailable' })
  expect(unsubscribe).toHaveBeenCalledTimes(1); expect(bridge.listeners.size).toBe(0)
  expect(bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:releaseHistoryObservation')).toHaveLength(1)
})
it('a throwing Renderer unsubscribe cannot block Main token release', async () => {
  const handle = await acquire(vi.fn(), () => () => { throw new Error('Renderer disappeared') })
  expect(() => handle.dispose()).toThrow('Renderer disappeared')
  expect(bridge.listeners.size).toBe(0)
  expect(bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:releaseHistoryObservation')).toHaveLength(1)
})
