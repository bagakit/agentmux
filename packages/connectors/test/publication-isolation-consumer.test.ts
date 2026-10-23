import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '../../core/src/index.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { feishuConfig } from './fixtures/feishu.js'
import { feishuPublicationHttp } from './fixtures/feishu-publication.js'
import { context } from './fixtures/room-binding.js'
import { permissionActionsFixture } from './fixtures/permission-actions.js'
import type { ConnectionHost } from '../src/connection-host.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it.each([false, true])('independent public final follows progress without replaying its original effect (lost create ACK: %s)', async lost => {
  const remote = await feishuPublicationHttp(); cleanup.push(remote.close)
  const progress = 'Controlled original public progress', final = 'Controlled independent public final'
  let lostOnce = false
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(async input => {
    // Original pinned SDK/Axios request reaches the existing platform HTTP fixture and applies first.
    const response = await remote.http.request(input)
    if (lost && !lostOnce && input.method?.toUpperCase() === 'POST' && remote.messageCalls().at(-1)?.body.includes(progress)) {
      lostOnce = true
      throw Error('Controlled lost create ACK after the platform applied its original message')
    }
    return response
  })
  const f = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'codex', executorId: 'codex', nativeHandle: {
    kind: 'provider', providerId: 'codex', sessionId: 'original-native', transcriptPath: join(root, 'native.jsonl')
  } })); cleanup.push(f.close)
  const transcript = join(f.root, 'native.jsonl')
  await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'original-native', cwd: f.root, history_mode: 'paginated' } }) + '\n')
  const native = (id: string, phase: string, text: string) => JSON.stringify({ timestamp: new Date(60_000).toISOString(), type: 'response_item', payload: {
    type: 'message', id, role: 'assistant', phase, content: [{ type: 'output_text', text }]
  } }) + '\n'
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: f.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['region'] }],
    regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: f.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' } }, resources: {}
  } })
  const options: Parameters<typeof createConnectionServices>[0] = { directory: join(f.root, 'connectors'), bindings: { spatial, checkpoint: input => f.client.conversationCheckpoint(input) }, publication: createPublicationConversationPort(f.coreClients) }
  let services = await createConnectionServices(options); cleanup.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'fixture-credential', secret: 'fixture-credential' })
  await services.connections.configure({ operationId: 'fixture-configure', expectedRevision: null, connection: { ...feishuConfig, credentialRef: credential.credentialRef } })
  const bound = await services.connections.bindings!.bind({ operationId: 'fixture-bind', bindingId: 'fixture-binding', connectionId: feishuConfig.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'region' }, externalConversationId: 'original-room',
    expectedSource: { providerId: 'codex', nativeSessionId: 'original-native' }, scope: { input: 'all-messages', publication: 'future-native-user-facing' } }, context)
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw Error('Fixture Binding was not applied')
  await vi.waitFor(() => expect(services.publication!.store.list(bound.binding).some(op => op.payload.kind === 'binding-lifecycle' && op.state === 'confirmed')).toBe(true))
  const operations = () => services.publication!.store.list(bound.binding).filter(op => op.payload.kind === 'speech')
  const posts = () => remote.messageCalls().filter(call => call.method === 'POST' && call.body.includes('Controlled'))
  await appendFile(transcript, native('original-progress', 'commentary', progress)); services.publication!.refresh()
  await vi.waitFor(() => expect(operations()[0]?.state).toBe(lost ? 'unknown' : 'confirmed'))
  const original = operations()[0]!
  expect(original.presentationTime).toBe(60_000)
  expect(JSON.parse(JSON.parse(posts()[0]!.body).content).config.summary.content).toBe(([0, 1].map(value => String(value).padStart(2, '0')).join(':') + " · Agent progress · ") + progress)
  expect([...remote.records.values()].some(message => JSON.stringify(message).includes(progress))).toBe(true)
  expect(JSON.parse(JSON.parse(posts()[0]!.body).content)).toMatchObject({ schema: '2.0', body: { elements: [{ tag: 'div', text_size: 'notation', text: { tag: 'plain_text', content: progress } }] } })
  expect(JSON.parse(JSON.parse(posts()[0]!.body).content).header).toBeUndefined()
  await appendFile(transcript, native('independent-final', 'final_answer', final)); services.publication!.refresh()
  await vi.waitFor(() => expect(operations()).toHaveLength(2))
  const next = operations()[1]!
  expect(next.projectionId).not.toBe(original.projectionId)
  expect(next.predecessorOperationId).toBeUndefined()
  if (lost) {
    expect(original.mapping).toBeUndefined()
    await appendFile(transcript, native('original-progress', 'commentary', 'Updated dependent progress')); services.publication!.refresh()
    await vi.waitFor(() => expect(operations().some(operation => operation.predecessorOperationId === original.operationId && operation.state === 'pending')).toBe(true))
    expect(remote.messageCalls().some(call => call.body.includes('Updated dependent progress'))).toBe(false)
    services.close(); services = await createConnectionServices(options)
    services.publication!.refresh()
    await vi.waitFor(() => expect(services.publication!.observation(bound.binding.bindingId, 1)).toEqual({ state: 'unknown', reason: 'effect-unconfirmed' }))
    expect(operations()[0]).toEqual(original)
    await vi.waitFor(() => expect(operations()[1]?.state).toBe('confirmed'))
    expect(posts().filter(call => call.body.includes(progress))).toHaveLength(1)
    expect(remote.messageCalls().filter(call => call.method === 'GET')).toHaveLength(0)
    expect(operations().find(operation => operation.predecessorOperationId === original.operationId)?.state).toBe('pending')
  } else await vi.waitFor(() => expect(operations()[1]?.state).toBe('confirmed'))
  const evidence = {
    lostCreateAck: lost, platformApplied: [...remote.records.values()].map(message => ({ messageId: message.message_id, content: (message.body as { content: string }).content })),
    original: { operationId: original.operationId, projectionId: original.projectionId, state: operations()[0]?.state, attempt: operations()[0]?.attempt, mapping: operations()[0]?.mapping ?? null },
    independent: { operationId: next.operationId, projectionId: next.projectionId, predecessorOperationId: next.predecessorOperationId ?? null, state: operations()[1]?.state },
    observation: services.publication!.observation(bound.binding.bindingId, 1), coverage: services.publication!.store.coverage(bound.binding),
    nativePosts: posts().map(call => ({ method: call.method, body: JSON.parse(call.body) })), nativeInspectionGets: remote.messageCalls().filter(call => call.method === 'GET').length,
    originalAgent: f.client.agentSession('original-agent').agentSessionId, stoppedAgent: (f.inner.kernel.stop as ReturnType<typeof vi.fn>).mock.calls.length
  }
  await mkdir('.local/channel-protocol/T-009/native', { recursive: true })
  await writeFile('.local/channel-protocol/T-009/native/' + (lost ? 'lost-ack' : 'baseline') + '.json', JSON.stringify(evidence, null, 2))
  // An independent final uses its retained operation while the original progress stays unconfirmed.
  await vi.waitFor(() => expect(posts().filter(call => call.body.includes(final))).toHaveLength(1), { timeout: 1_500 })
  expect(posts().filter(call => call.body.includes(progress))).toHaveLength(1)
  const publicResult = await services.connections.delivery!.list({ connectionId: feishuConfig.connectionId, bindingId: bound.binding.bindingId, bindingRevision: 1 })
  expect(publicResult.observation.state).toBe(lost ? 'unknown' : 'ready')
  expect(publicResult.deliveries.some(delivery => delivery.operationId === next.operationId && delivery.state === 'confirmed')).toBe(true)
  expect(JSON.stringify(publicResult)).not.toMatch(/Controlled original public progress|fixture-credential|prepared|presentationTime/)
  if (lost) {
    const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'diagnosis.sock'), connections: services.connections, spatialState: spatial, coreClients: f.coreClients })
    await server.start(); cleanup.push(() => server.stop())
    const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
    const diagnosis = await rpc.call('connection.diagnose', { executionHostId: 'local', agentSessionId: 'original-agent', bindingId: bound.binding.bindingId, bindingRevision: 1 })
    const outgoing = diagnosis.groups.value!.items[0]!.outgoing.value!
    expect(outgoing.observation).toEqual({ state: 'unknown', reason: 'effect-unconfirmed' })
    expect(outgoing.deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: original.operationId, state: 'unknown' }),
      expect.objectContaining({ operationId: next.operationId, state: 'confirmed' })
    ]))
    expect(JSON.stringify(diagnosis)).not.toMatch(/Controlled original public progress|fixture-credential|prepared/)
  }
}, 15_000)

it('the exact permission grant is rechecked after asynchronous credential work before any native disclosure effect', async () => {
  const f = await permissionActionsFixture(); cleanup.push(f.close)
  await f.grant(['permission'])
  const owner = Reflect.get(f.services.publication!, 'options').connections as ConnectionHost
  const resolve = owner.resolveCredential.bind(owner)
  let held = false, release!: () => void
  const gate = new Promise<void>(done => { release = done })
  vi.spyOn(owner, 'resolveCredential').mockImplementation(async id => {
    const credential = await resolve(id)
    if (!held && f.services.publication!.store.list(f.binding).some(op => op.payload.kind === 'permission' && op.payload.disclosure === 'shared' && op.state === 'pending')) {
      held = true; await gate
    }
    return credential
  })
  await f.open('publication-grant-revocation', 'PRIVATE exact permission context')
  await vi.waitFor(() => expect(held).toBe(true))
  await f.grant(['input'], 1); release()
  await appendFile(join(f.original.root, 'native.jsonl'), JSON.stringify({ type: 'response_item', payload: {
    type: 'message', id: 'after-revocation', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Public reply after grant revocation' }]
  } }) + '\n')
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(JSON.stringify(f.effects)).toContain('Public reply after grant revocation'))
  expect(JSON.stringify(f.effects)).not.toContain('PRIVATE exact permission context')
  expect(f.original.client.agentSession('original-agent').pendingInteraction?.request.id).toBe('publication-grant-revocation')
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)
