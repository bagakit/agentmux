// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { confirmAndCreateMote } from './fixtures/mote-connection-owner'
import { api } from '../src/renderer/src/lib/api'

let f: Awaited<ReturnType<typeof moteBotUi>>
beforeEach(async () => { f = await moteBotUi({ generic: true }) })
afterEach(async () => { await f?.close() })
async function ready() {
  const input = await f.input('profile-source')
  await f.client.call('space.mote.connection.create', input)
  await confirmAndCreateMote(f, input.operationId)
  await f.open()
  await vi.waitFor(() => expect(document.body.textContent).toContain('Sync Mote profile'))
}
const guide = () => {
  const node = document.querySelector('[data-profile-progress]')
  expect(node, 'Profile updates keep their own visible steps instead of sign-in and creation').not.toBeNull()
  return node!
}
async function synced() {
  await f.click('Sync Mote profile')
  await vi.waitFor(() => expect(document.querySelector('[data-profile-operation]')).not.toBeNull())
  const call = f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.sync')!
  const parent = (await f.client.call('space.mote.connection.inspect', { operationId: (call[1] as any).operationId })).operation!
  return parent
}
async function trace() {
  await act(async () => { const detail = document.querySelector<HTMLDetailsElement>('[data-profile-trace]')!; detail.open = true; detail.dispatchEvent(new Event('toggle')) })
  await vi.waitFor(() => expect(document.querySelector('[data-profile-trace] table')).not.toBeNull())
}

it('keeps prepare and exact unknown image upload in the profile task through Settings IPC and the original owner', async () => {
  await ready()
  expect(guide().textContent).not.toMatch(/Sign in|Create bot/)
  expect(guide().querySelector('[aria-current="step"]')?.getAttribute('data-step')).toBe('1')
  f.adapter.profile!.upload = async () => { f.counts.upload++; return { state: 'unknown', reason: 'effect-unconfirmed' } }
  const parent = await synced()
  expect(parent.profile?.upload.state).toBe('unknown')
  expect(parent.profile?.patch.state).toBe('not-dispatched')
  expect(guide().querySelector('[aria-current="step"]')?.getAttribute('data-step')).toBe('2')
  expect(guide().textContent).not.toMatch(/Sign in|Create bot/)
  expect(document.querySelector('[data-profile-operation]')?.textContent).toContain('The image upload is not confirmed')
  await trace()
  expect(document.querySelector('[data-profile-trace]')?.textContent).not.toContain('No request yet')
  expect(f.connectionCalls.mock.calls.find(([m]) => m === 'connection.profile.inspect')?.[1]).toEqual({ operationId: parent.profileOperationId })
  expect(document.querySelector('[data-profile-trace] table')?.textContent).toContain('Upload bot imageUnconfirmed')
  const counts = { ...f.counts }
  await f.click('Refresh trace'); await f.click('Check saved progress')
  expect(f.counts).toEqual(counts)
})

it('names unknown writes separately and keeps original receipts when a later inspect fails without replay', async () => {
  await ready()
  f.adapter.profile!.patch = async () => { f.counts.patch++; return { state: 'unknown', reason: 'effect-unconfirmed' } }
  const parent = await synced()
  expect(guide().querySelector('[aria-current="step"]')?.getAttribute('data-step')).toBe('3')
  expect(document.querySelector('[data-profile-operation]')?.textContent).toContain('The profile write is not confirmed')
  await trace()
  const copied = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  await f.click('Copy diagnosis')
  const diagnosis = JSON.parse(copied.mock.calls[0]![0])
  expect(diagnosis.operationId).toBe(parent.profileOperationId)
  expect(diagnosis.upload.state).toBe('confirmed')
  expect(diagnosis.patch.state).toBe('unknown')
  expect(diagnosis).not.toHaveProperty('desired')
  expect(diagnosis).not.toHaveProperty('online')
  const forward = f.connectionCalls.getMockImplementation()!
  f.connectionCalls.mockImplementation(async (method, input) => { if (method === 'connection.profile.inspect') throw new Error('Controlled receipt read failure'); return forward(method, input) })
  const counts = { ...f.counts }
  await f.click('Refresh trace')
  await vi.waitFor(() => expect(document.querySelector('[data-profile-trace]')?.textContent).toContain('Earlier results and the original request are kept'))
  expect(document.querySelector('[data-profile-trace] table')?.textContent).toContain('Write bot profileUnconfirmed')
  expect(f.counts).toEqual(counts)
})

it('does not equate a confirmed profile write with publication or the online observation', async () => {
  await ready()
  const parent = await synced()
  expect(parent.profile?.patch.state).toBe('confirmed')
  expect(guide().querySelector('[aria-current="step"]')?.getAttribute('data-step')).toBe('4')
  expect(guide().textContent).toContain('Platform action required')
  expect(guide().querySelector('[data-step="4"]')?.getAttribute('data-state')).toBe('current')
  expect(document.querySelector('[data-profile-operation]')?.textContent).toContain('Online profile not confirmed')
  expect(f.beginCount).toBe(1)
  expect(f.creationCount).toBe(1)
})

it('keeps effect dispatch unknown while the original sync reply is still unavailable', async () => {
  await ready()
  let release!: () => void
  const forward = f.parentCalls.getMockImplementation()!
  f.parentCalls.mockImplementation(async (method, input) => {
    const result = await forward(method, input)
    if (method === 'space.mote.connection.sync') await new Promise<void>(resolve => { release = resolve })
    return result
  })
  await f.click('Sync Mote profile')
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(guide().textContent).not.toMatch(/Sign in|Create bot/)
    expect(guide().querySelector('[data-step="3"]')?.textContent).toContain('Receipt not yet available')
    expect(document.querySelector('[data-profile-trace]')?.textContent).not.toContain('No request yet')
  } finally { await act(async () => release()) }
})

it('accepts a newer parent receipt before a later trace read fails', async () => {
  await ready()
  let release!: () => void, completed!: Promise<any>
  f.adapter.profile!.patch = async () => { f.counts.patch++; await new Promise<void>(resolve => { release = resolve }); return { state: 'confirmed' } }
  const forward = f.parentCalls.getMockImplementation()!
  f.parentCalls.mockImplementation(async (method, input) => {
    if (method !== 'space.mote.connection.sync') return forward(method, input)
    completed = forward(method, input)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    return (await f.client.call('space.mote.connection.inspect', { operationId: (input as any).operationId })).operation!
  })
  await f.click('Sync Mote profile')
  try {
    await vi.waitFor(() => expect(document.querySelector('[data-profile-trace] button:not(:disabled)')).not.toBeNull())
    await trace()
    expect(document.querySelector('[data-profile-trace] table')?.textContent).toContain('Write bot profileUnconfirmed')
    await act(async () => { document.querySelector<HTMLDetailsElement>('[data-profile-trace]')!.open = false; document.querySelector('[data-profile-trace]')!.dispatchEvent(new Event('toggle')) })
  } finally { release(); await completed }
  const connectionForward = f.connectionCalls.getMockImplementation()!
  f.connectionCalls.mockImplementation(async (method, input) => { if (method === 'connection.profile.inspect') throw new Error('Controlled later read gap'); return connectionForward(method, input) })
  await f.click('Check saved progress')
  await vi.waitFor(() => expect(document.querySelector('[data-profile-operation]')?.textContent).toContain('Profile written.'))
  await act(async () => { document.querySelector<HTMLDetailsElement>('[data-profile-trace]')!.open = true; document.querySelector('[data-profile-trace]')!.dispatchEvent(new Event('toggle')) })
  await vi.waitFor(() => expect(document.querySelector('[data-profile-trace]')?.textContent).toContain('Earlier results and the original request are kept'))
  const copied = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  await f.click('Copy diagnosis')
  expect(JSON.parse(copied.mock.calls[0]![0]).patch.state).toBe('confirmed')
})
