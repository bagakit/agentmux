import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { expect, it, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { parseConnectionParams, parseConnectionResult } from '@agentmux/core/connections'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { roomDiscoveryFixture } from './fixtures/room-discovery.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture(effect?: Parameters<typeof roomDiscoveryFixture>[0]) { const f = await roomDiscoveryFixture(effect); cleanup.push(f.close); return f }
async function trace(name: string, value: unknown) { const directory = '.bagakit/feature-tracker/features/f-2wr8fmvnv/artifacts/T-024'; await mkdir(directory, { recursive: true }); await writeFile(join(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n') }

it('default Desktop, original SDK, RPC and compiled CLI discover exact rooms without a Runtime or hidden link effect', async () => {
  const f = await fixture(), args = ['--connection', f.scope.connectionId, '--revision', '1']
  const listed = await f.cli(['ls', ...args, '--limit', '2', '--cursor', 'earlier-page'])
  expect(listed.code, listed.stderr).toBe(0)
  expect(listed.receipt).toEqual({ connectionId: f.config.connectionId, connectionRevision: 1, application: f.config.application, observation: { state: 'ready' }, rooms: [{ externalConversationId: 'oc_original', name: 'Original group', state: 'active' }], next: 'original-native-page' })
  const searched = await f.cli(['search', ...args, '--query', 'Original', '--limit', '2'])
  expect(searched.code, searched.stderr).toBe(0); expect(searched.receipt.rooms).toEqual(listed.receipt.rooms)
  const got = await f.cli(['get', ...args, '--room', f.target.externalConversationId])
  expect(got.code, got.stderr).toBe(0); expect(got.receipt.room).toMatchObject({ externalConversationId: 'oc_original', mode: 'group', membershipApproval: 'required' })
  const members = await f.cli(['members', ...args, '--room', f.target.externalConversationId])
  expect(members.code, members.stderr).toBe(0); expect(members.receipt.members).toEqual([{ idType: 'open_id', userId: 'ou_original', name: 'Original member' }])
  expect(await f.sdk.call('connection.room.ls', { ...f.scope, limit: 2, cursor: 'earlier-page' })).toEqual(listed.receipt)
  expect(f.calls.map(call => call.url)).toEqual([
    'https://open.feishu.cn/open-apis/im/v1/chats', 'https://open.feishu.cn/open-apis/im/v1/chats/search',
    'https://open.feishu.cn/open-apis/im/v1/chats/oc_original', 'https://open.feishu.cn/open-apis/im/v1/chats/oc_original/members', 'https://open.feishu.cn/open-apis/im/v1/chats'
  ])
  expect(f.calls[0]!.params).toMatchObject({ page_size: 2, page_token: 'earlier-page', user_id_type: 'open_id' })
  expect(f.calls[1]!.params!.query).toBe('Original'); expect(f.calls.some(call => call.url?.endsWith('/link'))).toBe(false)
  expect(f.services.database!.prepare('SELECT COUNT(*) AS count FROM connection_room_link_operation').get()!.count).toBe(0)
  expect(JSON.stringify(listed.receipt)).not.toContain('credential'); expect(f.services.bindings).toBeNull()
  const help = await runCompiledObjectCli(['connection', '--help'], objectCliEnvironment(f.root))
  expect(help.code).toBe(0)
  for (const command of ['ls', 'search', 'get', 'members', 'link create', 'link inspect']) expect(help.stdout).toContain('connection room ' + command)
  await trace('public-discovery', { listed: listed.receipt, searched: searched.receipt, got: got.receipt, members: members.receipt, calls: f.calls })
})

it('a late original SDK page cannot certify a rotated connection revision or retarget the old selection', async () => {
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<unknown>()
  const f = await fixture(async () => { started.resolve(); return await finish.promise })
  const pending = f.sdk.call('connection.room.ls', f.scope); await started.promise
  await f.sdk.call('connection.configure', { operationId: 'disable-original-rooms', expectedRevision: 1, connection: { ...f.config, enabled: false } })
  finish.resolve({ code: 0, data: { items: [{ chat_id: 'oc_original', name: 'Original group', chat_status: 'normal' }], has_more: false } })
  expect(await pending).toMatchObject({ connectionRevision: 1, observation: { state: 'unavailable', reason: 'connection-revised' }, rooms: [], next: null })
  const link = await f.sdk.call('connection.room.link.create', { ...f.target, operationId: 'old-selection-link' })
  expect(link).toMatchObject({ state: 'refused', input: f.target }); expect(f.calls).toHaveLength(1)
  expect((await f.sdk.call('connection.room.link.inspect', { operationId: link.operationId })).operation).toEqual(link)
})

it('the original same-database link claim precedes one SDK effect and compiled CLI only reads its durable receipt', async () => {
  let claimed = false, f: Awaited<ReturnType<typeof fixture>>
  f = await fixture(async request => {
    expect(request.url).toBe('https://open.feishu.cn/open-apis/im/v1/chats/oc_original/link')
    const db = new DatabaseSync(join(f.directory, 'connections.sqlite'))
    try { const row = db.prepare('SELECT operation_json FROM connection_room_link_operation WHERE operation_id=?').get('one-original-link'); claimed = !!row && JSON.parse(String(row.operation_json)).state === 'dispatching' } finally { db.close() }
    return { code: 0, data: { share_link: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=fixture-join', expire_time: String(_newTailFixtureEpoch(2) / 1_000), is_permanent: false } }
  })
  const input = { ...f.target, operationId: 'one-original-link' }, created = await f.cli(['link', 'create', '--input', '-'], input)
  expect(created.code, created.stderr).toBe(0); expect(created.receipt.state).toBe('confirmed'); expect(claimed).toBe(true)
  expect(created.receipt.input).toEqual(input); expect(created.receipt.link.expiresAtUnixSeconds).toBe((_newTailFixtureEpoch(2) / 1_000))
  expect(f.calls[0]!.data).toEqual({ validity_period: 'week' }); expect(f.calls[0]!.method).toBe('POST')
  expect((await f.cli(['link', 'inspect', '--operation-id', input.operationId])).receipt).toEqual({ operation: created.receipt })
  expect((await f.cli(['link', 'create', '--input', '-'], input)).receipt).toEqual(created.receipt)
  await f.sdk.call('connection.configure', { operationId: 'disable-after-link', expectedRevision: 1, connection: { ...f.config, enabled: false } })
  expect(await f.sdk.call('connection.room.link.inspect', { operationId: input.operationId })).toEqual({ operation: created.receipt })
  expect(f.calls).toHaveLength(1)
  await trace('link-original-claim', { input, receipt: created.receipt, claimedBeforeSdkEffect: claimed, platformCalls: f.calls })
})

it('a lost link response remains the original inspect-only operation after restart, with no replay or changed room', async () => {
  const f = await fixture(async () => { throw new Error('Unsafe credential or private platform diagnostic') }), input = { ...f.target, operationId: 'unknown-original-link' }
  const original = await f.sdk.call('connection.room.link.create', input)
  expect(original.state).toBe('unknown'); expect(f.calls).toHaveLength(1)
  expect(await f.sdk.call('connection.room.link.create', input)).toEqual(original)
  await f.closeOwner(); await f.reopen()
  expect(await f.sdk.call('connection.room.link.inspect', { operationId: input.operationId })).toEqual({ operation: original })
  expect(await f.sdk.call('connection.room.link.create', input)).toEqual(original)
  const changed = await f.cli(['link', 'create', '--input', '-'], { ...input, externalConversationId: 'oc_replacement' })
  expect(changed.code).not.toBe(0); expect(changed.stderr + changed.stdout).not.toContain('private platform diagnostic')
  expect(f.calls).toHaveLength(1)
  await trace('link-unknown-restart', { original, effects: f.calls.length, changedTargetRefused: changed.code !== 0 })
})

it('public DTOs retain opaque targets and reject wrong rooms, hidden fields and unbounded queries', () => {
  const target = { connectionId: 'original', expectedConnectionRevision: 1, externalConversationId: 'room/project-甲' }
  expect(parseConnectionParams('connection.room.members', target)).toEqual(target)
  expect(() => parseConnectionParams('connection.room.search', { connectionId: 'original', expectedConnectionRevision: 1, query: 'x'.repeat(65) })).toThrow()
  expect(() => parseConnectionParams('connection.room.get', { ...target, authenticated: true })).toThrow()
  const result = { connectionId: 'original', connectionRevision: 1, application: null, observation: { state: 'unavailable', reason: 'permission-denied' }, externalConversationId: 'room/other', members: [], next: null }
  expect(() => parseConnectionResult('connection.room.members', result, target)).toThrow()
  expect(() => parseConnectionResult('connection.room.members', { ...result, externalConversationId: target.externalConversationId, secret: 'private' }, target)).toThrow()
})
