import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { AgentSessionHistoryObservationHandle } from '@agentmux/core'
import { SessionHistoryObservationOwners } from '../src/main/session-history-observation'

const reference = { hostId: 'local', agentSessionId: 'native-reader' }
const source = { providerId: 'claude', nativeSessionId: 'native-id' }
function sender(id = 1) {
  return Object.assign(new EventEmitter(), { id, isDestroyed: vi.fn(() => false) })
}

it('only a main document replacement releases the exact sender/token owner', async () => {
  const dispose = vi.fn()
  const observe = vi.fn(async () => ({ source, dispose }))
  const owners = new SessionHistoryObservationOwners(observe)
  const webContents = sender()
  expect(await owners.acquire(webContents, 'token', reference, vi.fn())).toEqual({ source })
  expect(observe).toHaveBeenCalledTimes(1)
  webContents.emit('did-start-navigation', { url: 'https://frame.example/path', isSameDocument: false, isMainFrame: false, frame: null })
  webContents.emit('did-start-navigation', { url: 'https://app.example/path#anchor', isSameDocument: true, isMainFrame: true, frame: null })
  owners.release(2, 'token')
  owners.release(1, 'other-token')
  expect(dispose).toHaveBeenCalledTimes(0)
  webContents.emit('did-start-navigation', { url: 'https://app.example/new-document', isSameDocument: false, isMainFrame: true, frame: null })
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(webContents.listenerCount('destroyed')).toBe(0)
  expect(webContents.listenerCount('did-start-navigation')).toBe(0)
  owners.dispose()
  expect(dispose).toHaveBeenCalledTimes(1)
})

it.each(['destroyed', 'release', 'shutdown'] as const)('%s cancels pending and disposes a late handle once', async action => {
  let resolve!: (handle: AgentSessionHistoryObservationHandle) => void
  let signal!: AbortSignal
  const owners = new SessionHistoryObservationOwners(async (_reference, _listener, value) => {
    signal = value
    return await new Promise(done => { resolve = done })
  })
  const webContents = sender()
  const pending = owners.acquire(webContents, 'pending', reference, vi.fn())
  if (action === 'destroyed') webContents.emit('destroyed')
  else if (action === 'release') owners.release(webContents.id, 'pending')
  else owners.dispose()
  expect(signal.aborted).toBe(true)
  const dispose = vi.fn()
  resolve({ source, dispose })
  expect(await pending).toMatchObject({ error: { code: 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE' } })
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(webContents.eventNames()).toEqual([])
  owners.dispose()
  expect(dispose).toHaveBeenCalledTimes(1)
})

it('unavailable observation is reported once before releasing the live owner', async () => {
  let notify!: Parameters<ConstructorParameters<typeof SessionHistoryObservationOwners>[0]>[1]
  const dispose = vi.fn()
  const owners = new SessionHistoryObservationOwners(async (_reference, listener) => {
    notify = listener
    return { source, dispose }
  })
  const receive = vi.fn()
  await owners.acquire(sender(), 'token', reference, receive)
  const event = { kind: 'unavailable' as const, agentSessionId: reference.agentSessionId, code: 'source-changed', message: 'Refresh source.' }
  notify(event); notify(event)
  expect(receive).toHaveBeenCalledExactlyOnceWith(event)
  expect(dispose).toHaveBeenCalledTimes(1)
})

it('duplicate token is rejected without replacing its first resource', async () => {
  const dispose = vi.fn()
  const observe = vi.fn(async () => ({ source, dispose }))
  const owners = new SessionHistoryObservationOwners(observe)
  const webContents = sender()
  await owners.acquire(webContents, 'same', reference, vi.fn())
  await expect(owners.acquire(webContents, 'same', reference, vi.fn())).rejects.toThrow('active owner')
  expect(observe).toHaveBeenCalledTimes(1)
  owners.dispose()
  expect(dispose).toHaveBeenCalledTimes(1)
})
