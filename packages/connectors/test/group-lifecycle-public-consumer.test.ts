import { appendFile, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../../core/dist/public-rpc-server.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { createDesktopConnections, type DesktopConnectionServices } from '../../../apps/desktop/src/main/connector-host.js'
import { roomBindingFixture } from './fixtures/room-binding.js'
import { publicationPage } from './fixtures/publication-page.js'
import { feishuConfig } from './fixtures/feishu.js'
import { feishuPublicationHttp } from './fixtures/feishu-publication.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import type { RoomBindingOperation } from '../../core/src/connections.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const reply = (id: string, text: string) => JSON.stringify({ sessionId: 'original-native', uuid: id, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'

async function fixture() {
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const f = await roomBindingFixture(true, { config: feishuConfig }); cleanup.push(() => f.close())
  let rejectNotice = false, unknownNotice = false
  const remote = await feishuPublicationHttp(call => rejectNotice && call.method === 'POST' && call.path === '/open-apis/im/v1/messages'
    ? { status: 200, body: { code: 230001, msg: 'Known rejection' } } : unknownNotice && call.method === 'POST' && call.path === '/open-apis/im/v1/messages' ? { status: 200, body: { code: 230049 } } : undefined)
  cleanup.push(() => remote.close()); vi.spyOn(defaultHttpInstance, 'request').mockImplementation(remote.http.request)
  const originalStore = await readFile(f.storePath), originalTranscript = await readFile(f.transcript)
  const directory = join(f.root, 'lifecycle'), socketPath = join(f.root, 'lifecycle.sock')
  const open = () => createDesktopConnections({ directory,
    encryption: { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async value => Buffer.from(value), decryptStringAsync: async value => ({ result: value.toString(), shouldReEncrypt: false }) },
    bindings: { spatial: f.spatial, checkpoint: f.checkpoint }, publication: createPublicationConversationPort(() => [{ hostId: 'local', client: f.client }]) })
  let services = await open(), server = new AgentMuxControlServer({ socketPath, connections: services.connections, spatialState: f.spatial, coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanup.push(async () => { await server.stop(); services.close() })
  const env = objectCliEnvironment(f.root), cli = async (args: string[], input?: unknown) => {
    const output = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', ...args], env, input === undefined ? '' : JSON.stringify(input))
    expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result
  }
  const secret = await services.secrets.store({ operationId: 'credential', secret: 'fixture-secret' })
  await cli(['configure', '--input', '-'], { operationId: 'configure', expectedRevision: null, connection: { ...feishuConfig, credentialRef: secret.credentialRef } })
  const service = await services.connections.service.get()
  await services.connections.service.configure({ operationId: 'automatic-off', expectedRevision: service.revision, service: { enabled: false } })
  const notices = () => remote.messageCalls().filter(call => call.method === 'POST')
  const settled = async (operation: RoomBindingOperation, state = 'confirmed') => {
    expect(operation.state).toBe('applied'); if (operation.state !== 'applied') throw Error('Original lifecycle not applied')
    expect(operation.notices?.length).toBeGreaterThan(0)
    await vi.waitFor(async () => {
      for (const notice of operation.notices!) expect((await cli(['delivery', 'inspect', '--operation-id', notice.deliveryOperationId])).delivery.state).toBe(state)
    }, { timeout: 5_000 })
    return operation.notices!
  }
  return { ...f, cli, notices, settled, remote, originalStore, originalTranscript, get services(): DesktopConnectionServices { return services }, reject(value: boolean) { rejectNotice = value }, uncertain(value: boolean) { unknownNotice = value },
    async reopen(operationId?: string) {
      await server.stop(); services.close()
      let restored: unknown
      if (operationId) {
        const script = `import {ConnectionHost,RoomBindingHost,PublicationStore} from './packages/connectors/dist/index.js'; import {join} from 'node:path'; const [directory,id]=process.argv.slice(1); const connections=new ConnectionHost({databasePath:join(directory,'connections.sqlite'),secrets:{resolve:async()=>null}}); const bindings=new RoomBindingHost({connections,spatial:{read:async()=>null},checkpoint:async()=>{throw Error('Read cannot refresh a cut')}}); const operation=bindings.readOperation(id);const publication=new PublicationStore(connections.database);console.log(JSON.stringify({operation,notices:operation?.state==='applied'?operation.notices?.map(item=>publication.inspect(item.deliveryOperationId)):[]}));connections.close()`
        restored = JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, directory, operationId])).stdout)
      }
      services = await open(); server = new AgentMuxControlServer({ socketPath, connections: services.connections, spatialState: f.spatial, coreClients: () => [{ hostId: 'local', client: f.client }] }); await server.start()
      return restored
    }
  }
}

it('real CLI and Desktop owner keep lifecycle notices independent from paused traffic and preserve exact member intent', async () => {
  const f = await fixture(), first = await f.cli(['bind', '--input', '-'], f.input)
  await f.settled(first)
  expect(f.notices()).toHaveLength(1)
  expect(JSON.parse(JSON.parse(f.notices()[0]!.body).content)).toMatchObject({ header: { title: { content: 'Conversation connected' } } })
  expect(JSON.parse(f.notices()[0]!.body).content).toContain(`Group ${f.input.externalConversationId}`)
  expect(f.notices()[0]!.body).toContain('automatic synchronization is off')
  expect((await f.services.connections.service.get()).enabled).toBe(false)
  const actor = { application: feishuConfig.application, idType: 'open_id', userId: 'member' }
  for (const state of ['active', 'revoked'] as const) await f.cli(['grant', '--input', '-'], {
    operationId: `grant-${state}`, grantId: `member-${state}`, expectedRevision: null, bindingId: f.input.bindingId, expectedBindingRevision: 1,
    actor: { ...actor, userId: state }, capabilities: ['input'], state
  })
  const queued = publicationPage(first.binding, first.binding.sourceCheckpoints[0], [{ id: 'unsent', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Never dispatched', contentEligibility: 'public' }] }])
  const store = f.services.publication!.store
  store.commitPage(first.binding, store.checkpoint(first.binding, 'local'), queued.page, () => true, queued)
  const unsent = store.list(first.binding).find(item => item.reference.source.kind === 'native')!
  expect(unsent.state).toBe('pending')
  const pause = await f.cli(['binding', 'pause', '--input', '-'], { operationId: 'pause', bindingId: f.input.bindingId, expectedRevision: 1 }); await f.settled(pause)
  expect((await f.cli(['delivery', 'inspect', '--operation-id', unsent.operationId])).delivery).toMatchObject({ state: 'cancelled', reason: 'binding-revised' })
  await appendFile(f.transcript, reply('paused-speech', 'Not shared while paused'))
  const resume = await f.cli(['binding', 'resume', '--input', '-'], { operationId: 'resume', bindingId: f.input.bindingId, expectedRevision: 2 }); await f.settled(resume)
  expect(resume.binding.sourceCheckpoints).not.toEqual(first.binding.sourceCheckpoints)
  expect(await f.client.readSessionHistoryChanges(f.input.agentSessionId, { checkpoint: resume.binding.sourceCheckpoints[0] })).toMatchObject({ items: [] })
  const inspected = await f.cli(['binding', 'inspect', '--binding', f.input.bindingId])
  expect(inspected.grants).toEqual(expect.arrayContaining([
    expect.objectContaining({ grantId: 'member-active', revision: 3, bindingRevision: 3, state: 'active', capabilities: ['input'] }),
    expect.objectContaining({ grantId: 'member-revoked', revision: 3, bindingRevision: 3, state: 'revoked' })
  ]))
  expect(f.services.bindings!.readGrant('member-active', 1)?.bindingRevision).toBe(1)
  expect(f.notices()).toHaveLength(3)
  expect(f.notices().map(call => call.body).join('\n')).not.toContain('Not shared while paused')
  expect(await f.cli(['binding', 'resume', '--input', '-'], { operationId: 'resume', bindingId: f.input.bindingId, expectedRevision: 2 })).toEqual(resume)
  expect(await f.reopen('resume')).toMatchObject({ operation: resume, notices: [expect.objectContaining({ state: 'confirmed' })] })
  expect((await f.cli(['binding', 'inspect', '--operation-id', 'resume'])).operation).toEqual(resume)
  expect(f.notices()).toHaveLength(3)
  const exact = f.services.bindings!.readCurrent(f.input.bindingId)!
  f.services.publication!.store.queueBindingNotice('unapplied-operation', exact, 'connected', true)
  f.services.publication!.refresh()
  await new Promise(resolve => setTimeout(resolve, 80))
  expect(f.notices()).toHaveLength(3)
  expect(await readFile(f.storePath)).toEqual(f.originalStore)
  expect((await readFile(f.transcript)).toString()).toBe(f.originalTranscript.toString() + reply('paused-speech', 'Not shared while paused'))
  expect(f.client.connect).not.toHaveBeenCalled()
}, 30_000)

it('detach remains applied when its original card fails and recovery never retargets it to a new relationship', async () => {
  const f = await fixture(), first = await f.cli(['bind', '--input', '-'], f.input); await f.settled(first)
  f.reject(true)
  const input = { operationId: 'detach-original', bindingId: f.input.bindingId, expectedRevision: 1 }
  const ended = await f.cli(['binding', 'detach', '--input', '-'], input), [notice] = await f.settled(ended, 'not-applied')
  expect(ended.binding).toMatchObject({ revision: 2, state: 'detached', agentSessionId: f.input.agentSessionId })
  expect((await f.cli(['binding', 'ls', '--host', 'local', '--session', f.input.agentSessionId])).bindings).toEqual([])
  expect((await f.cli(['binding', 'inspect', '--binding', f.input.bindingId])).current).toEqual(ended.binding)
  expect((await f.cli(['binding', 'inspect', '--binding', f.input.bindingId, '--revision', '1'])).binding).toEqual(first.binding)
  expect(await f.cli(['binding', 'detach', '--input', '-'], input)).toEqual(ended)
  expect((await f.cli(['binding', 'resume', '--input', '-'], { operationId: 'cannot-resume', bindingId: f.input.bindingId, expectedRevision: 2 })).state).toBe('refused')
  f.reject(false)
  const next = await f.cli(['bind', '--input', '-'], { ...f.input, bindingId: 'new-relationship', operationId: 'new-bind', externalConversationId: 'another-group' }); await f.settled(next)
  expect(await f.reopen(input.operationId)).toMatchObject({ operation: ended, notices: [expect.objectContaining({ state: 'not-applied' })] })
  await f.cli(['delivery', 'retry', '--operation-id', notice!.deliveryOperationId])
  await f.settled(ended)
  const last = JSON.parse(f.notices().at(-1)!.body)
  expect(last.receive_id).toBe(f.input.externalConversationId)
  expect(last.content).toContain('Conversation disconnected')
  expect(last.content).toContain(`Group ${f.input.externalConversationId}`)
  expect(last.content).toContain('The Agent and its conversation are kept')
  expect((await f.services.connections.service.get()).enabled).toBe(false)
  expect((await f.cli(['binding', 'inspect', '--operation-id', input.operationId])).operation).toEqual(ended)
  expect(new Set(f.notices().map(call => JSON.parse(call.body).uuid)).size).toBe(3)
  await f.unchanged()
}, 30_000)


it('keeps an unknown original lifecycle effect inspect-only across owner restart', async () => {
  const f = await fixture(), first = await f.cli(['bind', '--input', '-'], f.input); await f.settled(first)
  f.uncertain(true)
  const input = { operationId: 'unknown-detach', bindingId: f.input.bindingId, expectedRevision: 1 }
  const ended = await f.cli(['binding', 'detach', '--input', '-'], input), [notice] = await f.settled(ended, 'unknown')
  const before = f.services.publication!.store.inspect(notice!.deliveryOperationId)!
  expect(await f.reopen(input.operationId)).toMatchObject({ operation: ended, notices: [expect.objectContaining({ state: 'unknown', prepared: before.prepared, attempt: 1 })] })
  f.uncertain(false)
  for (let i = 0; i < 3; i++) f.services.publication!.refresh()
  await expect(f.services.publication!.retry({ operationId: notice!.deliveryOperationId }, { actor: { kind: 'user', id: 'fixture-user' } })).rejects.toMatchObject({ code: 'PUBLICATION_RETRY_UNCONFIRMED' })
  expect(await f.cli(['binding', 'detach', '--input', '-'], input)).toEqual(ended)
  await f.settled(ended, 'unknown')
  expect(f.notices()).toHaveLength(2)
  expect(f.services.publication!.store.attempts(notice!.deliveryOperationId)).toHaveLength(1)
  expect(f.services.publication!.store.inspect(notice!.deliveryOperationId)!.prepared).toEqual(before.prepared)
  await f.unchanged()
}, 30_000)

it('keeps the original binding when its lifecycle outbox cannot commit and resumes the same operation after storage recovers', async () => {
  const f = await fixture(), first = await f.cli(['bind', '--input', '-'], f.input); await f.settled(first)
  const owner = f.services.bindings!, store = f.services.publication!.store
  const input = { operationId: 'storage-detach', bindingId: f.input.bindingId, expectedRevision: 1 }
  const originalQueue = store.queueBindingNotice.bind(store)
  const queue = vi.spyOn(store, 'queueBindingNotice').mockImplementation((...args) => { originalQueue(...args); throw Error('Fixture transaction interruption') })
  await expect(owner.detach(input, { actor: { kind: 'user', id: 'fixture-user' } })).rejects.toMatchObject({ code: 'ROOM_BINDING_OPERATION_UNCONFIRMED' })
  expect(owner.readCurrent(input.bindingId)).toEqual(first.binding)
  expect(owner.readOperation(input.operationId)).toMatchObject({ state: 'preparing' })
  expect(store.pendingBindingNotices()).toEqual([])
  queue.mockRestore()
  const ended = await owner.detach(input, { actor: { kind: 'user', id: 'fixture-user' } })
  f.services.publication!.refresh(); await f.settled(ended)
  expect(owner.readOperation(input.operationId)).toEqual(ended)
  expect(f.notices()).toHaveLength(2)
  await f.unchanged()
}, 30_000)
