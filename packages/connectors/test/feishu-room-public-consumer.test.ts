import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { roomProvisioningFixture, core } from './fixtures/room-provisioning.js'
import { feishuConfig } from './fixtures/feishu.js'
import { feishuRoomsHttp, type RoomRequest } from './fixtures/feishu-rooms.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture(effect?: (request: RoomRequest) => Promise<unknown>) {
  const f = await roomProvisioningFixture(); cleanup.push(() => f.close())
  const platform = feishuRoomsHttp(effect)
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(platform.http.request)
  const directory = join(f.root, 'desktop-platform-rooms'), socketPath = join(f.root, 'platform-rooms.sock')
  const open = async () => {
    // Adapters are intentionally omitted: this is the original Desktop default lazy registration.
    const services = await createDesktopConnections({ directory, bindings: { spatial: f.spatial, checkpoint: f.checkpoint },
      encryption: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } })
    cleanup.push(() => services.close())
    const server = new core.AgentMuxControlServer({ socketPath, connections: services.connections, spatialState: f.spatial, coreClients: () => [{ hostId: 'local', client: f.client }] })
    await server.start(); cleanup.push(() => server.stop())
    const sdk = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanup.push(() => sdk.dispose())
    const env = objectCliEnvironment(f.root)
    const cli = async (args: string[], input?: unknown) => {
      const output = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', ...args], env, input === undefined ? '' : JSON.stringify(input))
      expect(output.code, output.stdout + output.stderr).toBe(0)
      return JSON.parse(output.stdout).result
    }
    return { services, server, sdk, cli }
  }
  const opened = await open()
  const credential = await opened.services.secrets.store({ operationId: 'platform-room-credential', secret: 'private-fixture-credential' })
  const config = { ...feishuConfig, credentialRef: credential.credentialRef }
  await opened.cli(['configure', '--input', '-'], { operationId: 'configure-platform-rooms', expectedRevision: null, connection: config })
  const input = { ...f.createInput, connectionId: config.connectionId, members: [{ idType: 'open_id', userId: 'original-member' }, { idType: 'app_id', userId: 'invited-bot' }] }
  return { ...f, ...opened, platform, bindingInput: f.input, input, config, open }
}

it('the original default Desktop owner and compiled CLI create a room using the durable attempt, then invite exact members independently', async () => {
  const f = await fixture(), saved = await f.cli(['room', 'create', '--input', '-'], f.input)
  expect(saved).toMatchObject({ input: f.input, application: f.config.application, adapterId: 'feishu', creation: { state: 'created', externalConversationId: 'original-created-room' }, membership: { state: 'settled', results: f.input.members.map(member => ({ member, state: 'joined' })) } })
  expect(f.platform.calls.map(call => call.url)).toEqual([
    'https://open.feishu.cn/open-apis/im/v1/chats',
    'https://open.feishu.cn/open-apis/im/v1/chats/original-created-room/members',
    'https://open.feishu.cn/open-apis/im/v1/chats/original-created-room/members'
  ])
  const wire = f.platform.calls[0]!, attempt = saved.creation.attemptId
  expect(attempt).not.toBe(f.input.operationId); expect(attempt.length).toBeLessThanOrEqual(50); expect(wire.params!.uuid).toBe(attempt)
  expect(wire.data).toEqual({ name: f.input.name, chat_mode: 'group', chat_type: 'private', group_message_type: 'chat' })
  expect(f.services.database!.prepare('SELECT attempt_id FROM room_provisioning_attempt WHERE phase=?').get('creation')!.attempt_id).toBe(attempt)
  expect(await f.sdk.call('connection.room.inspect', { operationId: f.input.operationId })).toEqual({ operation: saved })
  expect(await f.cli(['room', 'create', '--input', '-'], f.input)).toEqual(saved)
  expect(await f.cli(['room', 'inspect', '--operation-id', f.input.operationId])).toEqual({ operation: saved })
  expect(f.platform.calls).toHaveLength(3)
  const refused = await f.cli(['bind', '--input', '-'], { ...f.bindingInput, connectionId: f.config.connectionId, operationId: 'independent-platform-binding', expectedSource: { ...f.bindingInput.expectedSource, nativeSessionId: 'different-source' }, externalConversationId: 'original-created-room' })
  expect(refused).toMatchObject({ state: 'refused' })
  expect((await f.sdk.call('connection.room.inspect', { operationId: f.input.operationId })).operation).toEqual(saved)
  await f.unchanged()
  expect(JSON.stringify(saved)).not.toMatch(/private-fixture|tenant-access|credentialRef/)
  const path = '.bagakit/feature-tracker/features/f-2wr8fmvnv/artifacts'; await mkdir(path, { recursive: true })
  await writeFile(join(path, 'T-021-feishu-public-consumer.json'), JSON.stringify({
    scope: 'Actual compiled CLI and public Unix RPC through original Desktop RoomProvisioningHost/default lazy registry and pinned official SDK; platform HTTP and credential encryption controlled. No live group or message.',
    input: f.input, saved, nativeRequests: f.platform.calls.map(({ url, method, params, data }) => ({ url, method, params, data })),
    originalRoomPreservedAfterIndependentBindingFailure: true, originalAgentAndRunPreserved: true
  }, null, 2) + '\n')
}, 20_000)

it('a lost native creation receipt remains the same unknown attempt after actual Host reopen and never creates a second group', async () => {
  const f = await fixture(async request => {
    if (request.url?.endsWith('/members')) throw new Error('Unexpected invitation')
    throw new Error('Original group may already exist; unsafe platform body')
  })
  const saved = await f.cli(['room', 'create', '--input', '-'], f.input)
  expect(saved.creation).toMatchObject({ state: 'unknown' }); expect(saved.membership.state).toBe('pending')
  const attempt = saved.creation.attemptId
  expect(f.platform.calls[0]!.params!.uuid).toBe(attempt)
  await f.sdk.dispose(); await f.server.stop(); f.services.close()
  const restored = await f.open()
  expect(await restored.cli(['room', 'inspect', '--operation-id', f.input.operationId])).toEqual({ operation: saved })
  expect(await restored.cli(['room', 'create', '--input', '-'], f.input)).toEqual(saved)
  const blocked = await restored.cli(['room', 'create', '--input', '-'], { ...f.input, operationId: 'replacement-caller-key' })
  expect(blocked.creation).toEqual({ state: 'not-applied', reason: 'existing-operation', originalOperationId: f.input.operationId })
  expect(f.platform.calls).toHaveLength(1); await f.unchanged()
}, 20_000)

it('actual public RPC cancellation reaches the original SDK request and retains the created room plus confirmed and unknown member results', async () => {
  const entered = Promise.withResolvers<AbortSignal>(), finish = Promise.withResolvers<unknown>()
  let batches = 0
  const f = await fixture(async request => {
    if (!request.url?.endsWith('/members')) return { code: 0, data: { chat_id: 'original-created-room' } }
    if (++batches === 1) return { code: 0, data: {} }
    entered.resolve(request.signal!)
    return await finish.promise
  })
  const members = Array.from({ length: 101 }, (_, index) => ({ idType: 'open_id', userId: `member-${index}` })), input = { ...f.input, members }
  const cancel = new AbortController(), pending = f.sdk.call('connection.room.create', input, { signal: cancel.signal }).then(value => ({ value }), error => ({ error }))
  const nativeSignal = await entered.promise
  expect(nativeSignal).toBeInstanceOf(AbortSignal); expect(nativeSignal.aborted).toBe(false)
  cancel.abort()
  expect(await pending).toHaveProperty('error')
  await vi.waitFor(() => expect(nativeSignal.aborted).toBe(true))
  finish.reject(new Error('Cancelled native request; original effect may have applied'))
  await vi.waitFor(async () => expect((await f.services.rooms!.inspect({ operationId: input.operationId })).operation!.membership.state).toBe('settled'))
  const saved = (await f.services.rooms!.inspect({ operationId: input.operationId })).operation!
  expect(saved.creation).toMatchObject({ state: 'created', externalConversationId: 'original-created-room' })
  expect(saved.membership).toMatchObject({ state: 'settled', results: members.map((member, index) => ({ member, state: index < 50 ? 'joined' : 'unknown' })) })
  expect(batches).toBe(2)
  expect(await f.cli(['room', 'create', '--input', '-'], input)).toEqual(saved)
  expect(await f.cli(['room', 'inspect', '--operation-id', input.operationId])).toEqual({ operation: saved })
  expect(batches).toBe(2); await f.unchanged()
}, 20_000)

it('the direct original Core port preserves a creation cancelled after the native call as one unknown inspect-only attempt', async () => {
  const entered = Promise.withResolvers<AbortSignal>(), finish = Promise.withResolvers<unknown>()
  const f = await fixture(async request => { entered.resolve(request.signal!); return await finish.promise })
  const cancel = new AbortController(), port = f.services.connections.rooms!
  const pending = port.create(f.input, { actor: { kind: 'user', id: 'original-local-human' }, signal: cancel.signal })
  expect(await entered.promise).toBe(cancel.signal)
  const claimed = (await port.inspect({ operationId: f.input.operationId })).operation!
  expect(claimed.creation).toMatchObject({ state: 'dispatching' })
  cancel.abort(); finish.reject(new Error('Unsafe cancelled native result'))
  const saved = await pending
  expect(saved.creation).toEqual({ state: 'unknown', attemptId: (claimed.creation as { attemptId: string }).attemptId })
  expect(saved.membership.state).toBe('pending')
  expect(await f.cli(['room', 'inspect', '--operation-id', f.input.operationId])).toEqual({ operation: saved })
  expect(await port.create(f.input, { actor: { kind: 'user', id: 'original-local-human' } })).toEqual(saved)
  expect(f.platform.calls).toHaveLength(1); await f.unchanged()
}, 20_000)
