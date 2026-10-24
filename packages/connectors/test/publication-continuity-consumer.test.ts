import { appendFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { DefaultRestOptions } from '@discordjs/rest'
import * as core from '../../core/src/index.js'
import { roomPublicationReference, type RoomBinding } from '@agentmux/core/connections'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment } from '../../core/test/helpers/object-cli-rpc.js'
import { runSourceObjectCli } from '../../core/test/helpers/source-object-cli.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { ConnectionSecrets } from '../src/connection-secrets.js'
import { feishuConfig, feishuPayload, feishuSdkTransport } from './fixtures/feishu.js'
import { feishuPublicationHttp } from './fixtures/feishu-publication.js'
import { discordConfig, discordRoomId, discordTransport } from './fixtures/discord.js'
import { permissionActionsFixture } from './fixtures/permission-actions.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('public RPC trigger edits in both directions retain pending and unread speech through Feishu and Discord without replaying original unknown effects', async () => {
  const feishuIngress = feishuSdkTransport()
  const f = await rpcOwnerFixture(['original-agent', 'other-agent'], core, () => ({ providerId: 'claude', executorId: 'claude' })); cleanup.push(f.close)
  for (const [id, nativeId, file] of [['original-agent', 'original-native', 'native.jsonl'], ['other-agent', 'other-native', 'other.jsonl']] as const) {
    const saved = (await f.store.readMetadata(id))!
    await f.store.compareAndSwapMetadata(saved, { ...saved, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: nativeId, transcriptPath: join(f.root, file) } })
  }
  await f.inner.registry.load('local')
  const transcript = join(f.root, 'native.jsonl'), ref = { hostId: 'local', agentSessionId: 'original-agent' }, run = f.client.agentSession(ref.agentSessionId).run
  const native = (id: string) => JSON.stringify({ type: 'assistant', sessionId: 'original-native', uuid: id, message: { role: 'assistant', content: [{ type: 'text', text: id }] } }) + '\n'
  await writeFile(transcript, native('before-sharing'))
  await writeFile(join(f.root, 'other.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 'other-native', uuid: 'other-before', message: { role: 'assistant', content: [{ type: 'text', text: 'Other private earlier reply' }] } }) + '\n')
  vi.spyOn(f.client.providers.get('claude'), 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: f.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['region', 'other-region'] }],
    regions: ['original-agent', 'other-agent'].map((id, index) => ({ regionId: index ? 'other-region' : 'region', tabId: 'tab', kind: 'agent', agentSessionId: id, runId: null, execution: { hostId: 'local', cwd: f.root } })),
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', regionId: 'region' }, second: { type: 'leaf', regionId: 'other-region' } }, activeRegionId: 'region' } }, resources: {}
  } })
  const unknownBody = 'original-unconfirmed-platform-effect'
  const feishu = await feishuPublicationHttp(call => call.method === 'POST' && call.path.endsWith('/messages') && call.body.includes(unknownBody) ? { status: 200, body: { code: 0, data: {} } } : undefined); cleanup.push(feishu.close)
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(feishu.http.request)
  const discord = await discordTransport(); cleanup.push(discord.close)
  vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(discord.http.makeRequest)
  let credentialHeld = false, sourceHeld = false
  const resolveCredential = ConnectionSecrets.prototype.resolve
  vi.spyOn(ConnectionSecrets.prototype, 'resolve').mockImplementation(function (reference) { return credentialHeld ? Promise.resolve(null) : resolveCredential.call(this, reference) })
  const port = createPublicationConversationPort(f.coreClients), changes = port.changes.bind(port)
  const sourceWaiters: Array<() => void> = []
  port.changes = async (input, signal) => {
    if (sourceHeld) await new Promise<void>((resolve, reject) => {
      const stop = () => reject(new Error('Original source observation closed'))
      signal.addEventListener('abort', stop, { once: true })
      sourceWaiters.push(() => { signal.removeEventListener('abort', stop); resolve() })
    })
    signal.throwIfAborted(); return await changes(input, signal)
  }
  const options: Parameters<typeof createConnectionServices>[0] = { directory: join(f.root, 'connections'), bindings: { spatial, checkpoint: input => f.client.conversationCheckpoint(input) }, ingress: { core: host => host === 'local' ? f.client : undefined }, publication: port }
  let services = await createConnectionServices(options); cleanup.push(() => services.close())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'continuity.sock'), connections: services.connections, coreClients: f.coreClients, spatialState: spatial })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const current: RoomBinding[] = [], original: RoomBinding[] = []
  for (const config of [feishuConfig, discordConfig]) {
    const credential = await services.secrets.store({ operationId: config.adapterId + '-secret', secret: 'synthetic-original-' + config.adapterId })
    await rpc.call('connection.configure', { operationId: config.adapterId + '-configure', expectedRevision: null, connection: { ...config, credentialRef: credential.credentialRef } })
    const value = await rpc.call('connection.bind', { operationId: config.adapterId + '-bind', bindingId: config.adapterId + '-binding', connectionId: config.connectionId,
      expectedConnectionRevision: 1, executionHostId: ref.hostId, agentSessionId: ref.agentSessionId, regionAnchor: { regionId: 'region' },
      externalConversationId: config.adapterId === 'feishu' ? 'original-room' : discordRoomId, expectedSource: { providerId: 'claude', nativeSessionId: 'original-native' },
      scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })
    expect(value.state).toBe('applied'); if (value.state !== 'applied') throw Error('Original group absent')
    current.push(value.binding); original.push(value.binding)
    expect(await rpc.call('connection.grant', { operationId: config.adapterId + '-member', bindingId: value.binding.bindingId,
      expectedBindingRevision: 1, grantId: config.adapterId + '-member', expectedRevision: null,
      actor: { application: config.application, idType: config.adapterId === 'feishu' ? 'open_id' : 'snowflake', userId: config.adapterId === 'feishu' ? 'original-external-user' : '400' },
      capabilities: ['input'], state: 'active' })).toMatchObject({ state: 'applied' })
  }
  await vi.waitFor(() => { services.publication!.refresh(); for (const binding of current) expect(services.publication!.store.list(binding).some(operation => operation.payload.kind === 'binding-lifecycle' && operation.state === 'confirmed')).toBe(true) })
  discord.loseNextMessageResponse(false)
  await appendFile(transcript, native(unknownBody)); services.publication!.refresh()
  await vi.waitFor(() => { for (const binding of original) expect(services.publication!.store.list(binding).find(operation => operation.payload.kind === 'speech' && operation.payload.text === unknownBody)?.state).toBe('unknown') }, { timeout: 8_000 })
  const unknown = original.map(binding => services.publication!.store.list(binding).find(operation => operation.payload.kind === 'speech' && operation.payload.text === unknownBody)!)
  const posts = () => ({ feishu: feishu.messageCalls().filter(call => call.method === 'POST').map(call => call.body), discord: discord.calls.filter(call => call.method === 'POST' && call.path === '/channels/300/messages').map(call => call.body) })
  const copies = (body: string) => Object.fromEntries(Object.entries(posts()).map(([channel, bodies]) => [channel, bodies.filter(value => value.includes(body)).length]))
  const submit = async (id: string) => await f.client.submitAgentPrompt({ agentSessionId: ref.agentSessionId, ...core.agentPromptCondition((await f.client.readAgentSession(ref.agentSessionId))!), operationId: id, prompt: id, authorHuman: true, allowUncertainTurn: true })
  const pendingOriginals: string[] = []
  for (const [index, trigger] of ['all-messages', 'mentions-and-replies'].entries()) {
    const pending = 'pending-original-' + index, unread = 'unread-original-' + index
    credentialHeld = true
    await submit(pending); services.publication!.refresh()
    await vi.waitFor(() => { for (const binding of original) {
      const operation = services.publication!.store.list(binding).find(operation => operation.payload.kind === 'speech' && operation.payload.text === pending)
      expect(operation?.state).toBe('pending'); expect(operation?.attempt).toBeUndefined()
      if (operation && !pendingOriginals.includes(operation.operationId)) pendingOriginals.push(operation.operationId)
    } }, { timeout: 5_000 })
    sourceHeld = true
    await submit(unread); services.publication!.refresh()
    await vi.waitFor(() => expect(sourceWaiters.length).toBeGreaterThan(0))
    for (const [position, binding] of current.entries()) {
      const next = await rpc.call('connection.binding.relink', { operationId: binding.connectionId + '-trigger-' + index, bindingId: binding.bindingId,
        connectionId: binding.connectionId, expectedRevision: binding.revision, expectedConnectionRevision: 1, executionHostId: binding.executionHostId,
        agentSessionId: binding.agentSessionId, regionAnchor: binding.regionAnchor, externalConversationId: binding.externalConversationId,
        expectedSource: { providerId: 'claude', nativeSessionId: 'original-native' }, scope: { input: trigger as 'all-messages' | 'mentions-and-replies', publication: 'future-shared-conversation' } })
      expect(next.state).toBe('applied'); if (next.state !== 'applied') throw Error('Trigger configuration absent')
      current[position] = next.binding
    }
    credentialHeld = false; sourceHeld = false; for (const release of sourceWaiters.splice(0)) release(); services.publication!.refresh()
    // The mutant takes a new cut and retires these originals: assert real missing messages first.
    await vi.waitFor(() => { expect(copies(pending)).toEqual({ feishu: 1, discord: 1 }); expect(copies(unread)).toEqual({ feishu: 1, discord: 1 }) }, { timeout: 8_000 })
    for (const binding of current) expect(binding.publicationBoundary).toEqual({ revision: 1 })
    for (const operation of unknown) expect(services.publication!.store.inspect(operation.operationId)).toEqual(operation)
  }
  for (const id of pendingOriginals) expect(services.publication!.store.inspect(id)?.state).toBe('confirmed')
  await vi.waitFor(() => { expect(feishuIngress.sockets).toHaveLength(1); expect(discord.sessions).toHaveLength(1) })
  const feishuBody = 'native-feishu-after-trigger', discordBody = 'native-discord-after-trigger'
  const nativeFeishu = feishuPayload({ message_id: 'continuity-native-feishu', content: JSON.stringify({ text: feishuBody }) })
  nativeFeishu.header.event_id = 'continuity-native-feishu-event'
  await feishuIngress.receive(nativeFeishu)
  await vi.waitFor(() => expect(copies(feishuBody)).toEqual({ feishu: 0, discord: 1 }), { timeout: 8_000 })
  discord.message('718', discordBody)
  await vi.waitFor(() => expect(copies(discordBody)).toEqual({ feishu: 1, discord: 0 }), { timeout: 8_000 })
  const captured = (await f.client.sessionTimeline(ref.agentSessionId)).items.filter(item => item.authorExternal)
  expect(captured.map(item => [item.content, item.authorExternal!.bindingRevision])).toEqual(expect.arrayContaining([[feishuBody, 3], [discordBody, 3]]))
  await vi.waitFor(() => expect(services.publication!.store.list(original[0]!)).toEqual(expect.arrayContaining([expect.objectContaining({ bindingRevision: 1, payload: expect.objectContaining({ kind: 'query-feedback', stage: 'received' }) })])))
  const diagnosed = await rpc.call('connection.diagnose', { executionHostId: ref.hostId, agentSessionId: ref.agentSessionId })
  expect(diagnosed.groups.value?.items.map(group => [group.target.bindingRevision, group.target.publicationRevision])).toEqual([[3, 1], [3, 1]])
  expect(diagnosed.groups.value?.items.every(group => group.outgoing.issue === null && group.outgoing.value!.deliveries.length > 0)).toBe(true)
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'binding', 'inspect', '--binding', current[0]!.bindingId], objectCliEnvironment(f.root,
    process.env.PUBLICATION_CONTINUITY_CLI_LOADED ? { AGENTMUX_RESUMED_INBOX_CLI_LOADED: process.env.PUBLICATION_CONTINUITY_CLI_LOADED } : {}), '', 20_000, pathToFileURL(resolve('packages/core/test/fixtures/a2a-resumed-inbox/source-loader.mjs')))
  expect(cli.code, cli.stdout + cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.binding.publicationBoundary).toEqual({ revision: 1 })
  await server.stop(); await services.close(); services = await createConnectionServices(options)
  await appendFile(transcript, native('after-owner-reopen')); services.publication!.refresh()
  await vi.waitFor(() => expect(copies('after-owner-reopen')).toEqual({ feishu: 1, discord: 1 }), { timeout: 8_000 })
  for (const operation of unknown) expect(services.publication!.store.inspect(operation.operationId)).toEqual(operation)
  expect(copies(unknownBody)).toEqual({ feishu: 1, discord: 1 })
  const reopenedServer = new core.AgentMuxControlServer({ socketPath: server.path, connections: services.connections, coreClients: f.coreClients, spatialState: spatial })
  await reopenedServer.start(); cleanup.push(() => reopenedServer.stop())
  const reopenedRpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: reopenedServer.path } }); cleanup.push(() => reopenedRpc.dispose())
  credentialHeld = true
  await submit('pending-before-real-target-change'); services.publication!.refresh()
  await vi.waitFor(() => { for (const binding of original) expect(services.publication!.store.list(binding).find(operation => operation.payload.kind === 'speech' && operation.payload.text === 'pending-before-real-target-change')?.state).toBe('pending') }, { timeout: 5_000 })
  const changed = await reopenedRpc.call('connection.binding.relink', { operationId: 'change-original-agent', bindingId: current[0]!.bindingId,
    connectionId: current[0]!.connectionId, expectedRevision: 3, expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'other-agent', regionAnchor: { regionId: 'other-region' },
    externalConversationId: current[0]!.externalConversationId, expectedSource: { providerId: 'claude', nativeSessionId: 'other-native' }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })
  expect(changed.state).toBe('applied'); if (changed.state !== 'applied') throw Error('Changed Agent absent')
  expect(changed.binding.publicationBoundary).toBeUndefined()
  expect(services.bindings!.publicationAuthority(original[0]!.bindingId, 1).authorized).toBe(false)
  expect(services.publication!.store.list(original[0]!).find(operation => operation.payload.kind === 'speech' && operation.payload.text === 'pending-before-real-target-change')?.state).toBe('cancelled')
  credentialHeld = false; services.publication!.refresh()
  await appendFile(join(f.root, 'other.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 'other-native', uuid: 'other-current', message: { role: 'assistant', content: [{ type: 'text', text: 'other-agent-current-reply' }] } }) + '\n')
  await vi.waitFor(() => expect(copies('other-agent-current-reply')).toEqual({ feishu: 1, discord: 0 }), { timeout: 8_000 })
  expect(copies('pending-before-real-target-change')).toEqual({ feishu: 0, discord: 1 })
  credentialHeld = true
  await submit('pending-before-pause'); services.publication!.refresh()
  await vi.waitFor(() => expect(services.publication!.store.list(original[1]!).find(operation => operation.payload.kind === 'speech' && operation.payload.text === 'pending-before-pause')?.state).toBe('pending'), { timeout: 5_000 })
  expect(await reopenedRpc.call('connection.binding.pause', { operationId: 'explicit-pause', bindingId: current[1]!.bindingId, expectedRevision: 3 })).toMatchObject({ state: 'applied' })
  expect(services.publication!.store.list(original[1]!).find(operation => operation.payload.kind === 'speech' && operation.payload.text === 'pending-before-pause')?.state).toBe('cancelled')
  const resumed = await reopenedRpc.call('connection.binding.resume', { operationId: 'explicit-resume', bindingId: current[1]!.bindingId, expectedRevision: 4 })
  expect(resumed.state).toBe('applied'); if (resumed.state !== 'applied') throw Error('Resumed original group absent')
  expect(resumed.binding.publicationBoundary).toBeUndefined()
  expect(services.bindings!.publicationAuthority(original[1]!.bindingId, 1).authorized).toBe(false)
  credentialHeld = false
  await appendFile(transcript, native('after-paused-interval')); services.publication!.refresh()
  await vi.waitFor(() => expect(copies('after-paused-interval')).toEqual({ feishu: 0, discord: 1 }), { timeout: 8_000 })
  expect(copies('pending-before-pause')).toEqual({ feishu: 0, discord: 0 })
  expect(copies(unknownBody)).toEqual({ feishu: 1, discord: 1 })
  expect(f.client.agentSession(ref.agentSessionId).run).toEqual(run)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
}, 60_000)

it.each([false, true])('an original native permission action retains exact current authority after a trigger edit (revoke=%s)', async revoke => {
  const f = await permissionActionsFixture(); cleanup.push(f.close)
  const originalGrant = await f.grant()
  expect(originalGrant.state).toBe('applied')
  const first = await f.open()
  await vi.waitFor(() => expect(f.buttons().length).toBeGreaterThan(0), { timeout: 8_000 })
  const action = f.buttons()[0]!.value.actionRef
  const source = f.binding.sourceCheckpoints[0]!.source
  expect(await f.rpc.call('connection.binding.relink', { operationId: 'permission-trigger', bindingId: f.binding.bindingId,
    expectedRevision: 1, expectedConnectionRevision: 1, connectionId: f.binding.connectionId, executionHostId: f.binding.executionHostId,
    agentSessionId: f.binding.agentSessionId, regionAnchor: f.binding.regionAnchor, externalConversationId: f.binding.externalConversationId,
    expectedSource: source, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })).toMatchObject({ state: 'applied', binding: { publicationBoundary: { revision: 1 } } })
  const respond = vi.spyOn(f.original.client, 'respondAgentInteraction')
  if (revoke) {
    const granted = f.services.bindings!.grants(f.binding.bindingId, 2)[0]!
    expect(await f.rpc.call('connection.grant', { operationId: 'revoke-native-action', bindingId: f.binding.bindingId, expectedBindingRevision: 2,
      grantId: granted.grantId, expectedRevision: granted.revision, actor: f.actor, state: 'revoked', capabilities: [] })).toMatchObject({ state: 'applied' })
  }
  await f.sdk.receive(f.action(action, 'original-action-after-trigger'))
  if (revoke) {
    await vi.waitFor(async () => expect((await f.services.ingress!.list({ connectionId: f.binding.connectionId })).ingresses.some(record => record.kind === 'action' && record.eventId === 'original-action-after-trigger' && record.state === 'refused' && record.code === 'INGRESS_ACTOR_NOT_AUTHORIZED')).toBe(true), { timeout: 5_000 })
    expect(respond).not.toHaveBeenCalled()
    expect(f.original.client.agentSession(f.binding.agentSessionId).pendingInteraction?.request.id).toBe(first.request.id)
  } else {
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce(), { timeout: 5_000 })
    await expect(first.callback).resolves.toBeDefined()
    expect(f.services.bindings!.readGrant(originalGrant.grant.grantId)).toEqual(originalGrant.grant)
    const diagnosis = await f.rpc.call('connection.diagnose', { executionHostId: f.binding.executionHostId, agentSessionId: f.binding.agentSessionId })
    expect(diagnosis.groups.value!.items[0]!.incoming.value!.rows).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'action', bindingRevision: 1, scope: 'current-binding', coreStatus: 'hook-written' })]))
  }
  expect(f.original.inner.kernel.input).not.toHaveBeenCalled(); expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)
