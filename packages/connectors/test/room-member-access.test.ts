import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { roomDiscoveryFixture } from './fixtures/room-discovery.js'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES } from '@agentmux/core/control'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture(effect?: Parameters<typeof roomDiscoveryFixture>[0]) { const f = await roomDiscoveryFixture(effect); cleanup.push(f.close); return f }

it('native member pages larger than page_size remain complete without fabricating another cursor or creator', async () => {
  const entries = Array.from({ length: 103 }, (_, index) => ({ member_id_type: 'open_id', member_id: 'ou_member_' + index, name: 'Member ' + index }))
  const f = await fixture(async () => ({ code: 0, data: { items: entries, has_more: false } }))
  const members = await f.sdk.call('connection.room.members', { ...f.target, limit: 2 })
  expect(members.observation.state).toBe('ready'); expect(members.members).toHaveLength(103); expect(members.next).toBeNull()
  expect(members.members[102]!.userId).toBe('ou_member_102'); expect(members).not.toHaveProperty('creator'); expect(members).not.toHaveProperty('canChat')
  expect(f.calls).toHaveLength(1); expect(f.calls[0]!.params).toMatchObject({ member_id_type: 'open_id', page_size: 2 })
})

it('a bot-only group and partial get response never certify creator membership or access', async () => {
  const f = await fixture(async request => request.url?.endsWith('/members') ? { code: 0, data: { items: [], has_more: false } } : { code: 0, data: { name: 'Bot only' } })
  const group = await f.sdk.call('connection.room.get', f.target), members = await f.sdk.call('connection.room.members', f.target)
  expect(group.room).toEqual({ externalConversationId: 'oc_original', name: 'Bot only', state: 'unknown', mode: 'unknown', membershipApproval: 'unknown' })
  expect(members.members).toEqual([]); expect(group).not.toHaveProperty('canChat'); expect(group).not.toHaveProperty('creator')
  expect(f.services.database!.prepare('SELECT COUNT(*) AS count FROM connection_room_link_operation').get()!.count).toBe(0)
})

it('opaque room identities stay one exact SDK path segment, including reserved characters', async () => {
  const f = await fixture(), target = { ...f.target, externalConversationId: 'room/project?member=甲#fragment' }
  expect((await f.sdk.call('connection.room.get', target)).room?.externalConversationId).toBe(target.externalConversationId)
  await f.sdk.call('connection.room.members', target)
  await f.sdk.call('connection.room.link.create', { ...target, operationId: 'opaque-target-link' })
  const path = 'https://open.feishu.cn/open-apis/im/v1/chats/' + encodeURIComponent(target.externalConversationId)
  expect(f.calls.map(call => call.url)).toEqual([path, path + '/members', path + '/link'])
})

it('a native member response exceeding the original wire budget stays unconfirmed without clipping or inventing a cursor', async () => {
  const oversized = 'x'.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES + 1)
  const f = await fixture(async () => ({ code: 0, data: { items: [], has_more: false, unrecognized: oversized } }))
  expect(await f.sdk.call('connection.room.members', f.target)).toMatchObject({ observation: { state: 'unknown', reason: 'response-unconfirmed' }, members: [], next: null })
  expect(f.calls).toHaveLength(1)
})

it.each([{ permanent: ['true'] }, { permanent: 'false' }, { permanent: 0 }, { permanent: true }, { permanent: undefined }])('malformed or permanent joining-link metadata remains unknown: %j', async ({ permanent }) => {
  const f = await fixture(async () => ({ code: 0, data: { share_link: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=fixture', expire_time: String(_newTailFixtureEpoch(2) / 1_000), is_permanent: permanent } }))
  const op = await f.sdk.call('connection.room.link.create', { ...f.target, operationId: 'unconfirmed-link' })
  expect(op.state).toBe('unknown'); expect(op).not.toHaveProperty('link'); expect(f.calls).toHaveLength(1)
})

it('official lack-of-sharing permission is distinct from ambiguous platform failure and never leaks raw diagnostics', async () => {
  const f = await fixture(async request => request.url?.endsWith('/link') ? { code: 232064, msg: 'private-credential-do-not-expose' } : { code: 99991672, msg: 'private-credential-do-not-expose' })
  const page = await f.sdk.call('connection.room.ls', f.scope)
  expect(page).toMatchObject({ observation: { state: 'unavailable', reason: 'permission-denied' }, rooms: [], next: null })
  const op = await f.sdk.call('connection.room.link.create', { ...f.target, operationId: 'permission-link' })
  expect(op).toMatchObject({ state: 'refused', reason: 'permission-denied' })
  expect(JSON.stringify({ page, op })).not.toContain('private-credential')
  expect((await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection?.config.enabled).toBe(true)
})

it.each([500000, '232064', undefined])('unproven link error codes cannot certify no effect: %j', async code => {
  const f = await fixture(async () => ({ code, msg: 'unsafe native diagnostic' }))
  const op = await f.sdk.call('connection.room.link.create', { ...f.target, operationId: 'unknown-error-link' })
  expect(op.state).toBe('unknown'); expect(JSON.stringify(op)).not.toContain('unsafe'); expect(f.calls).toHaveLength(1)
})

it('trusted action rechecks current authority after credential resolution and preserves the refused original receipt', async () => {
  const f = await fixture(), input = { ...f.target, operationId: 'revoked-link' }
  const assertCurrent = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Private authority context'))
  const op = await f.services.connections.rooms!.createLink!(input, { actor: { kind: 'user', id: 'original-human' }, assertCurrent })
  expect(op).toMatchObject({ state: 'refused', reason: 'authority-unavailable' }); expect(f.calls).toHaveLength(0)
  expect((await f.sdk.call('connection.room.link.inspect', { operationId: input.operationId })).operation).toEqual(op)
})

it.each([{ status: ['normal'], more: false }, { status: 'normal', more: 'false' }])('malformed native pagination and room states are unknown: %j', async ({ status, more }) => {
  const f = await fixture(async () => ({ code: 0, data: { items: [{ chat_id: 'oc_original', chat_status: status }], has_more: more } }))
  expect(await f.sdk.call('connection.room.ls', f.scope)).toMatchObject({ observation: { state: 'unknown', reason: 'response-unconfirmed' }, rooms: [], next: null })
})
