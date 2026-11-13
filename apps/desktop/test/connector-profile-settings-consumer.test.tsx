// @vitest-environment happy-dom
import { act } from 'react'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseConnectionProfileOperation } from '@agentmux/core/connections'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { confirmAndCreateMote } from './fixtures/mote-connection-owner'

let f: Awaited<ReturnType<typeof moteBotUi>>
beforeEach(async () => { f = await moteBotUi() })
afterEach(async () => { await f?.close() })
async function text(value: string) { await vi.waitFor(async () => { await f.settle(); expect(document.body.textContent).toContain(value) }, { timeout: 4000 }) }
async function seed(id = 'settings-original', state: 'confirmed' | 'unknown' = 'confirmed') {
  const input = await f.input(id)
  const pending = await f.client.call('space.mote.connection.create', input)
  const created = await confirmAndCreateMote(f, pending.operationId)
  expect(created.profileOperationId).toBeNull(); expect(created.profile).toBeNull()
  const connection = created.enrollment!.configured!.connection, avatar = input.desired.avatar!.pngDataUrl
  const operation = parseConnectionProfileOperation({ operationId: id + '-profile', connectionId: connection.config.connectionId,
    connectionRevision: connection.revision, application: connection.config.application, language: 'zh_cn', fields: ['name', 'description', 'avatar'],
    desired: { name: input.desired.name, description: input.desired.description, avatarSha256: createHash('sha256').update(Buffer.from(avatar.slice(avatar.indexOf(',') + 1), 'base64')).digest('hex') },
    upload: { state: 'confirmed' }, patch: { state, ...(state === 'unknown' ? { diagnostic: { stage: 'patch', httpStatus: 502 } } : {}) },
    publication: state === 'confirmed' ? 'platform-review-required' : 'not-requested', online: null,
    ...(state === 'unknown' ? { reason: 'effect-unconfirmed' } : {}) })
  // Original historical receipt, as in the owning profile-history contract; no retired writer is invoked.
  const database = f.connections.database!
  database.exec('CREATE TABLE connection_profile_operation (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL UNIQUE,connection_id TEXT NOT NULL,input_json TEXT NOT NULL,config_json TEXT NOT NULL,actor_json TEXT NOT NULL,record_json TEXT NOT NULL,upload_wire TEXT,patch_wire TEXT,avatar_url TEXT)')
  database.prepare('INSERT INTO connection_profile_operation(operation_id,connection_id,input_json,config_json,actor_json,record_json) VALUES(?,?,?,?,?,?)').run(
    operation.operationId, operation.connectionId,
    JSON.stringify({ operationId: operation.operationId, connectionId: operation.connectionId, expectedConnectionRevision: connection.revision, desired: input.desired }),
    JSON.stringify(connection.config), JSON.stringify({ kind: 'user', id: 'original-profile-owner' }), JSON.stringify(operation))
  expect((await f.client.call('connection.profile.inspect', { operationId: operation.operationId })).operation).toEqual(operation)
  return { connection: created.connection!, operation }
}
async function details(id: string) {
  await f.render(0, true)
  await vi.waitFor(async () => { await f.settle(); expect(document.querySelector('[data-connection="' + id + '"] button')).not.toBeNull() })
  await act(async () => (document.querySelector('[data-connection="' + id + '"] button') as HTMLElement).click())
  await act(async () => { const panel = document.querySelector<HTMLDetailsElement>('[data-connection-profile="' + id + '"]')!; panel.open = true; panel.dispatchEvent(new Event('toggle')) })
  await f.settle()
}

it('reads the original selected application and exact online version through Settings IPC/public/default Host/official SDK', async () => {
  const original = await seed(), id = original.connection!.connectionId
  await details(id); await f.click('Read current profile')
  await text('Online bot'); await text('Original online description'); await text('Metadata only (not an online description)')
  expect(f.connectionCalls.mock.calls.some(([method, input]) => method === 'connection.profile.get' && (input as any).connectionId === id)).toBe(true)
  const observation = await f.client.call('connection.profile.get', { connectionId: id, expectedConnectionRevision: 1 })
  expect(observation.onlineVersionId).toBe('online-exact')
  expect(f.calls.some(r => r.url?.includes('/app_versions/online-exact'))).toBe(true)
  expect(f.calls.filter(r => r.method === 'PATCH')).toHaveLength(0)
  expect(f.calls.some(r => r.url?.endsWith('/publish'))).toBe(false)
})

it('recovers the exact original profile update while preserving written, pending publication and separate online observations', async () => {
  const original = await seed(), nativeRequests = f.registration.mock.calls.length
  await details(original.connection!.connectionId)
  await text('Saved public name · Written, publication separate')
  await f.click('Saved public name · Written, publication separate'); await text('Profile written. Check and publish it on the platform.')
  await f.click('View original update')
  await text('The original update is shown. Unconfirmed platform effects are not sent again.')
  expect(document.querySelector('[data-profile-operation]')?.getAttribute('data-profile-operation')).toBe(original.operation.operationId)
  expect(f.calls.filter(r => r.method === 'PATCH')).toHaveLength(0)
  expect(f.registration.mock.calls).toHaveLength(nativeRequests)
  expect(f.registration.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/developers/v1/manifest/upsert_by_template')).toHaveLength(1)
})

it('keeps unknown effects inspectable and does not upload, patch or register again from Settings recovery', async () => {
  const saved = await seed('settings-unknown', 'unknown')
  expect(saved.operation.patch.state).toBe('unknown')
  const nativeRequests = f.registration.mock.calls.length
  await details(saved.connection!.connectionId); await text('Saved public name · Result not confirmed')
  await f.click('Saved public name · Result not confirmed'); await text('The profile write is not confirmed')
  await f.click('View original update'); await text('The original update is shown')
  expect(document.querySelector('[data-profile-operation]')?.getAttribute('data-profile-operation')).toBe(saved.operation.operationId)
  expect((await f.client.call('connection.profile.inspect', { operationId: saved.operation.operationId })).operation).toEqual(saved.operation)
  expect(f.calls.filter(r => r.method === 'PATCH')).toHaveLength(0)
  expect(f.calls.filter(r => r.url?.endsWith('/app_avatar/upload'))).toHaveLength(0)
  expect(f.connectionCalls.mock.calls.map(([method]) => method)).not.toContain('connection.profile.sync')
  expect(f.connectionCalls.mock.calls.map(([method]) => method)).not.toContain('connection.profile.advance')
  expect(f.registration.mock.calls).toHaveLength(nativeRequests)
  expect(f.registration.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/developers/v1/manifest/upsert_by_template')).toHaveLength(1)
})

it('rejects forged IPC methods without creating a setup', async () => {
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
  f.connectionCalls.mockImplementation(async (method, input, target) => {
    const result = await forward(method, input, target)
    if (method === 'connection.profile.inspect') { await new Promise<void>(resolve => { release = resolve }); throw new Error('Controlled old update lookup failure') }
    return result
  })
  await f.click('View original update')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  await f.click('Read current profile'); await text('The current observation is shown below')
  await act(async () => release()); await f.settle()
  expect(document.body.textContent).not.toContain('Controlled old update lookup failure')
  expect(document.body.textContent).toContain('The current observation is shown below')
  expect(f.calls.filter(r => r.method === 'PATCH')).toHaveLength(0)
})
