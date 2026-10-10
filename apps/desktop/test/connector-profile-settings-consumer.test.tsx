// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { moteBotUi } from './fixtures/mote-bot-ui'

let f: Awaited<ReturnType<typeof moteBotUi>>
beforeEach(async () => { f = await moteBotUi() })
afterEach(async () => { await f?.close() })
async function text(value: string) { await vi.waitFor(async () => { await f.settle(); expect(document.body.textContent).toContain(value) }, { timeout: 4000 }) }
async function seed(id = 'settings-original') {
  const pending = await f.client.call('space.mote.connection.create', await f.input(id))
  f.afterPollInterval()
  const saved = await f.client.call('space.mote.connection.advance', { operationId: pending.operationId })
  expect(saved.profile?.patch.state).toBe('confirmed')
  return saved
}
async function details(id: string) {
  await f.render(0, true)
  await vi.waitFor(async () => { await f.settle(); expect(document.querySelector('[data-connection="' + id + '"] button')).not.toBeNull() })
  await act(async () => (document.querySelector('[data-connection="' + id + '"] button') as HTMLElement).click())
  await f.click('Public bot profile')
}

it('reads the original selected application and exact online version through Settings IPC/public/default Host/official SDK', async () => {
  const original = await seed(), id = original.connection!.connectionId
  await details(id); await f.click('Read current profile')
  await text('Online bot'); await text('Original online description'); await text('Metadata only (not an online description)')
  expect(f.connectionCalls.mock.calls.some(([method, input]) => method === 'connection.profile.get' && (input as any).connectionId === id)).toBe(true)
  const observation = await f.client.call('connection.profile.get', { connectionId: id, expectedConnectionRevision: 1 })
  expect(observation.onlineVersionId).toBe('online-exact')
  expect(f.calls.some(r => r.url?.includes('/app_versions/online-exact'))).toBe(true)
  expect(f.calls.filter(r => r.method === 'PATCH')).toHaveLength(1)
  expect(f.calls.some(r => r.url?.endsWith('/publish'))).toBe(false)
})

it('recovers the exact original profile update while preserving written, pending publication and separate online observations', async () => {
  const original = await seed()
  await details(original.connection!.connectionId)
  await text('Saved public name · Written, publication separate')
  await f.click('Saved public name · Written, publication separate'); await text('Profile written. Check and publish it on the platform.')
  await f.click('Check update progress')
  await text('The original update is shown. Unconfirmed platform effects are not sent again.')
  expect(document.querySelector('[data-profile-operation]')?.getAttribute('data-profile-operation')).toBe(original.profileOperationId)
  expect(f.calls.filter(r => r.method === 'PATCH')).toHaveLength(1)
  expect(f.registration.mock.calls).toHaveLength(2)
})

it('keeps unknown effects inspectable and does not upload, patch or register again from Settings recovery', async () => {
  f.setUnknownPatch()
  const input = await f.input('settings-unknown')
  await f.client.call('space.mote.connection.create', input); f.afterPollInterval()
  const saved = await f.client.call('space.mote.connection.advance', { operationId: input.operationId })
  expect(saved.profile?.patch.state).toBe('unknown')
  await details(saved.connection!.connectionId); await text('Saved public name · Result not confirmed')
  await f.click('Saved public name · Result not confirmed'); await text('The profile write is not confirmed')
  await f.click('Check update progress'); await text('The original update is shown')
  expect(f.calls.filter(r => r.method === 'PATCH')).toHaveLength(1)
  expect(f.calls.filter(r => r.url?.endsWith('/app_avatar/upload'))).toHaveLength(1)
  expect(f.registration.mock.calls).toHaveLength(2)
})

it('rejects forged IPC methods and untrusted senders without creating a setup', async () => {
  await expect(f.handlers.get('moteConnections:call')!({ sender: {} }, 'space.mote.connection.create', await f.input())).rejects.toThrow('Untrusted')
  await expect(f.handlers.get('moteConnections:call')!({ sender: f.sender }, 'connection.enrollment.begin', {})).rejects.toThrow('Unsupported')
  expect(f.beginCount).toBe(0)
})

it('keeps a newer online read feedback when an earlier original-update query fails late', async () => {
  const original = await seed()
  await details(original.connection!.connectionId)
  await text('Saved public name · Written, publication separate')
  await f.click('Saved public name · Written, publication separate'); await text('The original update is shown')
  const forward = f.connectionCalls.getMockImplementation()!
  let release!: () => void
  f.connectionCalls.mockImplementation(async (method, input) => {
    const result = await forward(method, input)
    if (method === 'connection.profile.inspect') { await new Promise<void>(resolve => { release = resolve }); throw new Error('Controlled old update lookup failure') }
    return result
  })
  await f.click('View original update')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  await f.click('Read current profile'); await text('The current observation is shown below')
  await act(async () => release()); await f.settle()
  expect(document.body.textContent).not.toContain('Controlled old update lookup failure')
  expect(document.body.textContent).toContain('The current observation is shown below')
  expect(f.calls.filter(r => r.method === 'PATCH')).toHaveLength(1)
})
