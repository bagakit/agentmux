import { afterEach, expect, it, vi } from 'vitest'
import { parseConnectionProfileObservation } from '@agentmux/core/connections'
import { profileFixture } from './fixtures/connection-profile.js'

const clean: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it('public SDK and compiled CLI preserve qualified creator identity and explicit unavailable observations', async () => {
  let native: unknown = { code: 0, data: { app: { app_id: 'cli_profile', creator_id: 'creator-in-this-app' } } }
  const f = await profileFixture(() => native); clean.push(f.close)
  const input = { connectionId: f.config.connectionId, expectedConnectionRevision: 1 }
  const online = await f.sdk.call('connection.profile.get', input)
  expect(online.creator).toEqual({ idType: 'open_id', userId: 'creator-in-this-app' })
  const cli = await f.cli(['get', '--connection', f.config.connectionId, '--revision', '1'])
  expect(cli.code, cli.stdout + cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result).toEqual(online)
  const help = await f.cli(['get', '--help'])
  expect(help.code, help.stderr).toBe(0)
  expect(help.stdout).toContain('qualified typed creator')
  expect(f.calls.filter(r => r.url?.includes('/applications/')).every(r => r.params?.user_id_type === 'open_id')).toBe(true)
  native = { code: 210508 }
  expect(await f.sdk.call('connection.profile.get', input)).toMatchObject({ creator: null, reason: 'permission-required', profile: { name: 'Online name' } })
  native = { code: 0, data: { app: { app_id: 'another-app', creator_id: 'not-this-creator' } } }
  expect(await f.sdk.call('connection.profile.get', input)).toMatchObject({ creator: null, reason: 'online-unconfirmed' })
  expect(f.calls.every(r => r.method === 'GET')).toBe(true)
  expect(f.calls.some(r => r.url?.includes('/contact/') || r.url?.includes('/scope/'))).toBe(false)
}, 30000)

it('the strict public parser preserves unrecorded snapshots and refuses ambiguous creator facts', () => {
  const original = { connectionId: 'original', connectionRevision: 1, application: { domain: 'example.invalid', appId: 'original-app' }, language: null, state: 'observed', profile: null, metadata: null, botId: null, onlineVersionId: null, reviewingVersionId: null, version: null }
  expect(parseConnectionProfileObservation(original)).toEqual(original)
  expect(parseConnectionProfileObservation({ ...original, creator: null })).toHaveProperty('creator', null)
  for (const creator of [{ userId: 'missing-type' }, { idType: 'open_id', userId: '' }, { idType: 'open_id', userId: 'owner', otherApp: 'foreign' }])
    expect(() => parseConnectionProfileObservation({ ...original, creator })).toThrow()
  expect(() => parseConnectionProfileObservation({ ...original, state: 'unknown', creator: { idType: 'open_id', userId: 'owner' } })).toThrow()
})

it('a creator response for an obsolete connection revision never qualifies the current selection', async () => {
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { entered = resolve })
  const f = await profileFixture(async () => { entered(); await gate; return { code: 0, data: { app: { app_id: 'cli_profile', creator_id: 'obsolete-creator' } } } }); clean.push(f.close)
  const pending = f.sdk.call('connection.profile.get', { connectionId: f.config.connectionId, expectedConnectionRevision: 1 })
  try {
    await reached
    await f.sdk.call('connection.configure', { operationId: 'profile-creator-revised', expectedRevision: 1, connection: { ...f.config, label: 'Revised bot' } })
  } finally { release() }
  expect(await pending).toMatchObject({ creator: null, state: 'unknown', reason: 'connection-revised' })
}, 30000)
