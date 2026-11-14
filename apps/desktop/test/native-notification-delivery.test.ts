import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({ instances: [] as any[], supported: true, constructorError: false, showError: false }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { Notification: class extends EventEmitter {
    static isSupported() { return native.supported }
    close = vi.fn(() => this.emit('close', { reason: 'applicationHidden' }))
    show = vi.fn(() => { if (native.showError) throw new Error('native show rejected') })
    constructor(readonly options: unknown) { super(); if (native.constructorError) throw new Error('native creation rejected'); native.instances.push(this) }
  } }
})
import { createAgentNotifier } from '../src/main/agent-notifier'

const owners: ReturnType<typeof createAgentNotifier>[] = []
function fixture(platform = 'darwin') {
  const window = { isDestroyed: () => false, isMinimized: () => true, restore: vi.fn(), focus: vi.fn() }
  const activate = vi.fn()
  const owner = createAgentNotifier({ window: window as never, onActivate: activate, platform })
  owners.push(owner)
  return { owner, window, activate }
}
const request = { sessionId: 'original-recipient', title: 'Sender → Recipient', body: 'Original message', mode: 'standard' as const, sound: true }
beforeEach(() => { vi.useFakeTimers(); native.instances = []; native.supported = true; native.constructorError = false; native.showError = false })
afterEach(() => { for (const owner of owners.splice(0)) owner.dispose(); vi.clearAllTimers(); vi.useRealTimers() })

it('returns shown only after the original native show and preserves sound and presentation', async () => {
  const { owner } = fixture()
  const finished = vi.fn(), delivery = owner.notify(request).then(result => { finished(result); return result })
  await vi.advanceTimersByTimeAsync(0)
  expect(finished).not.toHaveBeenCalled()
  expect(native.instances[0].options).toEqual({ title: 'Sender → Recipient', body: 'Original message', silent: false, timeoutType: 'default' })
  native.instances[0].emit('show')
  expect(await delivery).toEqual({ status: 'shown', presentation: 'as-requested' })
  expect(vi.getTimerCount()).toBe(1)
})

it('reports the exact native failure rather than claiming show or inferring permission', async () => {
  const { owner } = fixture()
  const delivery = owner.notify(request), note = native.instances[0]
  note.emit('failed', {}, 'UNErrorDomain error 1')
  expect(await delivery).toEqual({ status: 'failed', reason: 'UNErrorDomain error 1' })
  expect(note.eventNames()).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})

it('treats a bounded observation gap as unknown, retains original click and never resends', async () => {
  const { owner, activate } = fixture()
  const delivery = owner.notify(request), note = native.instances[0]
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await delivery).toMatchObject({ status: 'unknown' })
  expect(note.show).toHaveBeenCalledOnce()
  expect(note.close).not.toHaveBeenCalled()
  note.emit('show')
  note.emit('click')
  expect(activate).toHaveBeenCalledWith('original-recipient')
  expect(note.eventNames()).toEqual([])
})

it('starts dwell at native show once and clears its timers on native closure', async () => {
  const { owner } = fixture()
  const delivery = owner.notify({ ...request, mode: 'brief' }), note = native.instances[0]
  await vi.advanceTimersByTimeAsync(1_000)
  expect(note.close).not.toHaveBeenCalled()
  note.emit('show')
  await delivery
  const count = vi.getTimerCount()
  note.emit('show')
  expect(vi.getTimerCount()).toBe(count)
  note.emit('close')
  expect(vi.getTimerCount()).toBe(0)
  expect(note.eventNames()).toEqual([])
})

it('keeps the exact Windows Action Center click after banner timeout, without later dwell dismissal', async () => {
  const { owner, activate, window } = fixture('win32')
  const delivery = owner.notify(request), note = native.instances[0]
  note.emit('show'); await delivery
  note.emit('close', { reason: 'timedOut' })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(note.close).not.toHaveBeenCalled()
  note.emit('click')
  expect(window.restore).toHaveBeenCalledOnce(); expect(window.focus).toHaveBeenCalledOnce()
  expect(activate).toHaveBeenCalledExactlyOnceWith('original-recipient')
  expect(note.eventNames()).toEqual([])
})

it.each([undefined, { reason: 'userCanceled' }, { reason: 'applicationHidden' }])('cleans terminal Windows closes without treating missing reasons as timeout: %j', async details => {
  const { owner, activate } = fixture('win32')
  const delivery = owner.notify(request), note = native.instances[0]
  note.emit('show'); await delivery
  note.emit('close', details)
  note.emit('click')
  expect(activate).not.toHaveBeenCalled()
  expect(note.eventNames()).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})

it('settles pending observations on disposal and retires original callbacks', async () => {
  const { owner, activate } = fixture()
  const delivery = owner.notify(request), note = native.instances[0]
  owner.dispose()
  expect(await delivery).toMatchObject({ status: 'unknown' })
  expect(note.close).toHaveBeenCalledOnce()
  expect(note.eventNames()).toEqual([])
  note.emit('click')
  expect(activate).not.toHaveBeenCalled()
  expect(await owner.notify(request)).toMatchObject({ status: 'unknown' })
  expect(native.instances).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('distinguishes platform support, creation failure, and show failure', async () => {
  const { owner } = fixture()
  native.supported = false
  expect(await owner.notify(request)).toMatchObject({ status: 'unsupported' })
  native.supported = true; native.constructorError = true
  expect(await owner.notify(request)).toEqual({ status: 'failed', reason: 'native creation rejected' })
  native.constructorError = false; native.showError = true
  expect(await owner.notify(request)).toEqual({ status: 'failed', reason: 'native show rejected' })
  expect(native.instances[0].eventNames()).toEqual([])
})

it('preserves platform persistence downgrade after native confirmation', async () => {
  const { owner } = fixture()
  const delivery = owner.notify({ ...request, mode: 'until-acknowledged' })
  native.instances[0].emit('show')
  expect(await delivery).toEqual({ status: 'shown', presentation: 'downgraded' })
  expect(vi.getTimerCount()).toBe(0)
})
