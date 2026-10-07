import { afterEach, expect, it, vi } from 'vitest'
import type { RoomMember } from '@agentmux/core/connections'
import { creation, membership, feishuRoomsHttp } from './fixtures/feishu-rooms.js'

afterEach(() => vi.restoreAllMocks())
const member = (id: string, idType = 'open_id'): RoomMember => ({ idType, userId: id })

it('uses the original durable attempt as native UUID and creates only a private ordinary group', async () => {
  const f = feishuRoomsHttp(), result = await f.adapter.rooms.create(creation, 'private-fixture-credential')
  expect(result).toEqual({ kind: 'created', externalConversationId: 'original-created-room' })
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]).toMatchObject({ url: 'https://open.feishu.cn/open-apis/im/v1/chats', method: 'POST', params: { uuid: creation.attemptId },
    data: { name: creation.name, chat_mode: 'group', chat_type: 'private', group_message_type: 'chat' } })
  expect(f.calls[0]!.params!.uuid).not.toBe(creation.operationId)
  expect(f.calls[0]!.data).not.toHaveProperty('user_id_list'); expect(f.calls[0]!.data).not.toHaveProperty('owner_id')
})

it.each([
  [{ code: 232068 }, 'unknown'], [{ code: 232002 }, 'not-applied'], [{ code: '0', data: { chat_id: 'room' } }, 'unknown'],
  [{ code: 0, data: {} }, 'unknown'], [{ code: 0, data: { chat_id: 'room\nforeign' } }, 'unknown']
])('keeps the native creation outcome bounded without inventing a group: %j', async (response, kind) => {
  const f = feishuRoomsHttp(async () => response)
  expect(await f.adapter.rooms.create(creation, 'private-fixture-credential')).toEqual({ kind })
  expect(f.calls).toHaveLength(1)
})

it('contains an unconfirmed SDK creation and rejects an invalid UUID before the platform call', async () => {
  const f = feishuRoomsHttp(async () => { throw new Error('Unsafe credential and platform body') })
  expect(await f.adapter.rooms.create(creation, 'private-fixture-credential')).toEqual({ kind: 'unknown' })
  expect(f.calls).toHaveLength(1)
  expect(await f.adapter.rooms.create({ ...creation, attemptId: 'x'.repeat(51) }, 'private-fixture-credential')).toEqual({ kind: 'not-applied' })
  expect(f.calls).toHaveLength(1)
})

it('serializes original ID namespaces in native user and bot batch limits, preserving exact result order', async () => {
  let active = 0, highest = 0
  const f = feishuRoomsHttp(async () => { highest = Math.max(highest, ++active); await new Promise(resolve => setImmediate(resolve)); active--; return { code: 0, data: {} } })
  const members = [member('union-first', 'union_id'), ...Array.from({ length: 51 }, (_, index) => member(`user-${index}`)),
    ...Array.from({ length: 6 }, (_, index) => member(`bot-${index}`, 'app_id')), member('native-user', 'user_id'), member('opaque/unsupported', 'account_id')]
  const result = await f.adapter.rooms.addMembers(membership(members), 'private-fixture-credential')
  expect(highest).toBe(1)
  expect(f.calls.map(call => [call.params!.member_id_type, (call.data!.id_list as string[]).length])).toEqual([['union_id', 1], ['open_id', 50], ['open_id', 1], ['app_id', 5], ['app_id', 1], ['user_id', 1]])
  for (const call of f.calls) {
    expect(call.url).toBe('https://open.feishu.cn/open-apis/im/v1/chats/original-created-room/members')
    expect(call.params!.succeed_type).toBe(1)
  }
  expect(result.results).toEqual(members.map((member, index) => ({ member, state: index === members.length - 1 ? 'not-applied' : 'joined' })))
})

it('retains partial invalid, absent and approval results instead of declaring all invitations successful', async () => {
  const members = ['valid', 'invalid', 'absent', 'approval'].map(id => member(id))
  const f = feishuRoomsHttp(async () => ({ code: 0, data: { invalid_id_list: ['invalid'], not_existed_id_list: ['absent'], pending_approval_id_list: ['approval'] } }))
  expect((await f.adapter.rooms.addMembers(membership(members), 'private-fixture-credential')).results).toEqual(members.map((member, index) => ({ member, state: ['joined', 'not-applied', 'not-applied', 'unknown'][index] })))
})

it.each([
  { code: 0, data: { invalid_id_list: null } }, { code: 0, data: { invalid_id_list: ['foreign'] } },
  { code: 0, data: { invalid_id_list: ['user-50'], pending_approval_id_list: ['user-50'] } },
  { code: '0', data: {} }, { code: 0 }
])('preserves prior confirmations and stops later batches on an unconfirmed native member receipt: %j', async response => {
  let batch = 0
  const f = feishuRoomsHttp(async () => ++batch === 1 ? { code: 0, data: {} } : response)
  const members = Array.from({ length: 102 }, (_, index) => member(`user-${index}`))
  const result = await f.adapter.rooms.addMembers(membership(members), 'private-fixture-credential')
  expect(f.calls).toHaveLength(2)
  expect(result.results.map(item => item.state)).toEqual(members.map((_, index) => index < 50 ? 'joined' : 'unknown'))
})

it('does not start another member batch after cancellation and retains the completed original batch', async () => {
  const cancel = new AbortController(), f = feishuRoomsHttp(async () => { cancel.abort(); return { code: 0, data: {} } })
  const members = Array.from({ length: 51 }, (_, index) => member(`user-${index}`))
  const result = await f.adapter.rooms.addMembers(membership(members), 'private-fixture-credential', cancel.signal)
  expect(f.calls).toHaveLength(1); expect(f.calls[0]!.signal).toBe(cancel.signal)
  expect(result.results.map(item => item.state)).toEqual(members.map((_, index) => index < 50 ? 'joined' : 'unknown'))
})

it('passes cancellation through original SDK token acquisition and does not infer a failed creation was unapplied', async () => {
  const cancel = new AbortController(), f = feishuRoomsHttp()
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async input => {
    if (input.url?.includes('/auth/v3/')) { expect(input.signal).toBe(cancel.signal); cancel.abort() }
    return await original(input)
  })
  expect(await f.adapter.rooms.create(creation, 'private-fixture-credential', cancel.signal)).toEqual({ kind: 'unknown' })
  expect(f.calls).toHaveLength(0)
  expect(await f.adapter.rooms.create(creation, 'private-fixture-credential', cancel.signal)).toEqual({ kind: 'not-applied' })
})
