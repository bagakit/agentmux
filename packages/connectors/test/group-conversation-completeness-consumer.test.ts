import { bridge, owningBridge } from '../../../apps/desktop/test/helpers/first-execution-ipc-bridge'
import { appendFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
// The real preload exposes its API into this inert Renderer global; Host/SDK Web APIs stay Node-owned.
vi.hoisted(() => vi.stubGlobal('window', {}))
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { DefaultRestOptions } from '@discordjs/rest'
import * as core from '../../core/src/index.js'
import { AgentMuxControlServer } from '../../core/src/public-rpc-server.js'
import { AgentMuxNotebookStore } from '../../core/src/notebook-store.js'
import { nativeInputCorrelationKey } from '../../core/src/native-input-correlation.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { source, user, turn, jsonl } from '../../core/test/helpers/codex-paginated.js'
import { runSourceObjectCli } from '../../core/test/helpers/source-object-cli.js'
import { objectCliEnvironment } from '../../core/test/helpers/object-cli-rpc.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { DEFAULT_CONFIG } from '../../../apps/desktop/src/main/config-store'
import { createConnectionServices } from '../src/connection-services.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { feishuConfig } from './fixtures/feishu.js'
import { feishuPublicationHttp } from './fixtures/feishu-publication.js'
import { discordConfig, discordRoomId, discordTransport } from './fixtures/discord.js'
import { roomBindingFixture, config as sampleConfig, context as originalContext } from './fixtures/room-binding.js'
import { recordedGroupBinding } from './fixtures/recorded-room-binding.js'
import type { PublicationAdapter } from '../src/publication-adapter.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('actual trusted Desktop IPC publishes one public App input to both Channels before native adoption and retains that representation after aliases and reopen', async () => {
  const f = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: source.providerId, executorId: source.providerId,
    nativeHandle: { kind: 'provider', providerId: source.providerId, sessionId: source.nativeSessionId, transcriptPath: join(root, 'native.jsonl') } })); cleanup.push(f.close)
  const transcript = join(f.root, 'native.jsonl')
  await writeFile(transcript, jsonl([{ type: 'session_meta', payload: { id: source.nativeSessionId, cwd: f.root, history_mode: 'paginated' } }]))
  const actor = { protocolId: 'original-input-protocol', actorId: 'original-native-actor', lifecycleOperationId: 'original-launch', token: 'a'.repeat(64), launch: { command: 'fixture-cli', args: [] } }
  const metadata = (await f.store.readMetadata('original-agent'))!
  await f.store.compareAndSwapMetadata(metadata, { ...metadata, nativeActor: actor,
    nativeBinding: { source: 'user-selected', run: metadata.run, observedAt: metadata.updatedAt } }); await f.inner.registry.load('local')
  f.inner.kernel.status = vi.fn(async (id: string) => ({ ...f.run(id), pid: 1234 }))
  const run = f.client.agentSession('original-agent').run, ref = { hostId: 'local', agentSessionId: 'original-agent' }
  f.client.providers.get('codex').readPromptExecutionEvidence = async () => ({ state: 'idle', sourceId: 'original-idle-source', id: 'original-idle' })
  const pending: unknown[] = []
  const nativeSend = vi.fn(async (prompt: string, plan: { clientCorrelation?: string }) => {
    const key = nativeInputCorrelationKey(plan.clientCorrelation!)
    expect(key).toEqual({ kind: 'prompt', agentSessionId: ref.agentSessionId, expectedRun: run, submissionId: 'desktop-original-input' })
    const original = await f.store.readPromptAdmission(ref.agentSessionId, run, 'desktop-original-input')
    expect(original?.admission?.inputKey).toEqual(key)
    const row = user('canonical-original-input', [{ type: 'text', text: prompt }]); row.payload.item.client_id = plan.clientCorrelation!
    pending.push(row)
    return { outcome: 'admitted' as const, turnId: turn }
  })
  f.client.providers.get('codex').prepareNativeInput = async () => ({ plan: { kind: 'native-rpc', protocolId: actor.protocolId, actorId: actor.actorId,
    sourceId: JSON.stringify([source.providerId, source.nativeSessionId]), threadId: source.nativeSessionId, operation: 'start-or-steer' },
    assertCurrent: async () => {}, send: nativeSend, dispose() {} })
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: f.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['region'] }],
    regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: ref.agentSessionId, runId: null, execution: { hostId: 'local', cwd: f.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' } }, resources: {}
  } })
  const feishu = await feishuPublicationHttp(); cleanup.push(feishu.close)
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(feishu.http.request)
  const discord = await discordTransport(); cleanup.push(discord.close)
  vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(discord.http.makeRequest)
  const options: Parameters<typeof createConnectionServices>[0] = { directory: join(f.root, 'connections'),
    bindings: { spatial, checkpoint: input => f.client.conversationCheckpoint(input) }, publication: createPublicationConversationPort(f.coreClients) }
  let services = await createConnectionServices(options); cleanup.push(() => services.close())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'original.sock'), coreClients: f.coreClients, connections: services.connections, spatialState: spatial,
    notebookStore: new AgentMuxNotebookStore(join(f.root, 'notebooks.root.json')) })
  await server.start(); cleanup.push(() => server.stop())
  const cli = (args: string[], input?: unknown) => runSourceObjectCli(['--endpoint', 'unix:' + server.path, ...args], objectCliEnvironment(f.root,
    process.env.COMPLETE_SHARING_CLI_LOADED ? { AGENTMUX_RESUMED_INBOX_CLI_LOADED: process.env.COMPLETE_SHARING_CLI_LOADED } : {}), input === undefined ? '' : JSON.stringify(input), 20_000, pathToFileURL(resolve('packages/core/test/fixtures/a2a-resumed-inbox/source-loader.mjs')))
  const bindings: import('@agentmux/core/connections').RoomBinding[] = []
  for (const config of [feishuConfig, discordConfig]) {
    const credential = await services.secrets.store({ operationId: config.adapterId + '-secret', secret: 'synthetic-' + config.adapterId + '-credential' })
    await services.connections.configure({ operationId: config.adapterId + '-configure', expectedRevision: null, connection: { ...config, credentialRef: credential.credentialRef } })
    const input = { operationId: config.adapterId + '-bind', bindingId: config.adapterId + '-binding', connectionId: config.connectionId,
      expectedConnectionRevision: 1, executionHostId: ref.hostId, agentSessionId: ref.agentSessionId, regionAnchor: { regionId: 'region' },
      externalConversationId: config.adapterId === 'feishu' ? 'original-room' : discordRoomId, expectedSource: source,
      scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } }
    if (config.adapterId === 'feishu') {
      const rejected = await cli(['connection', 'bind', '--input', '-'], { ...input, operationId: config.adapterId + '-rejected', scope: { ...input.scope, publication: 'future-native-user-facing' } })
      expect(rejected.code).not.toBe(0); expect(services.bindings!.readCurrent(input.bindingId)).toBeNull()
    }
    const applied = await cli(['connection', 'bind', '--input', '-'], input)
    expect(applied.code, applied.stderr + applied.stdout).toBe(0)
    const result = JSON.parse(applied.stdout).result
    expect(result).toMatchObject({ state: 'applied', binding: { scope: input.scope } }); bindings.push(result.binding)
    if (config.adapterId === 'feishu') {
      const relink = await cli(['connection', 'binding', 'relink', '--input', '-'], { ...input, operationId: config.adapterId + '-rejected-relink', expectedRevision: 1, scope: { ...input.scope, publication: 'future-native-user-facing' } })
      expect(relink.code).not.toBe(0); expect(services.bindings!.readCurrent(input.bindingId)?.revision).toBe(1)
    }
  }
  const config = { ...structuredClone(DEFAULT_CONFIG), executors: { codex: { providerId: 'codex', label: 'Codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } } }
  const ipc = await owningBridge({ client: f.client, store: f.store, config }); cleanup.push(ipc.dispose)
  const body = 'Exact App user message 中文🙂', privateNote = 'PRIVATE generated runtime context'
  const control = { kind: 'agent' as const, hostId: ref.hostId, agentSessionId: ref.agentSessionId, run }
  const condition = { expectedRun: run, admissionIntent: { kind: 'native-conversation' as const, source } }
  const submitted = await bridge.api!.sessions.submitPrompt(control, body, 'desktop-original-input', condition, { execution: 'immediate' }, true, privateNote, 'message-tool')
  expect(submitted).toMatchObject({ ok: true })
  await vi.waitFor(async () => expect(nativeSend, JSON.stringify(await f.client.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: ref.agentSessionId, expectedRun: run, submissionId: 'desktop-original-input' } }))).toHaveBeenCalledOnce(), { timeout: 10_000 })
  const posts = () => ({ feishu: feishu.messageCalls().filter(call => call.method === 'POST').map(call => call.body),
    discord: discord.calls.filter(call => call.method === 'POST' && call.path === '/channels/300/messages').map(call => call.body) })
  const copies = () => Object.fromEntries(Object.entries(posts()).map(([platform, bodies]) => [platform, bodies.filter(value => value.includes(body)).length]))
  await vi.waitFor(() => { services.publication!.refresh(); expect(copies(), JSON.stringify(bindings.map(binding => services.publication!.store.list(binding).map(operation => ({ state: operation.state, reason: operation.reason, kind: operation.payload.kind, target: operation.target, prepared: operation.prepared }))))).toEqual({ feishu: 1, discord: 1 }) }, { timeout: 10_000 })
  const original = bindings.map(binding => services.publication!.store.list(binding).filter(operation => operation.relay))
  expect(original.every(operations => operations.some(operation => operation.state === 'confirmed'))).toBe(true)
  const captured = (await f.client.sessionTimeline(ref.agentSessionId)).items.find(item => item.content === body)!
  expect(captured).toMatchObject({ authorHuman: true, publicContent: 'confirmed', sourceChannel: 'message-tool', inputRef: { kind: 'prompt', submissionId: 'desktop-original-input' }, inputOrigin: { sequence: expect.any(Number) } })
  expect(pending).toHaveLength(1)
  await appendFile(transcript, jsonl(pending))
  await vi.waitFor(async () => {
    const read = core.consumeConversationWindowPage(await f.client.readAgentConversation(ref))
    expect(read.kind).toBe('complete'); if (read.kind !== 'complete') return
    expect(read.snapshot.units.some(unit => unit.records.length === 2 && unit.records.some(record => record.original.kind === 'native' && record.original.item.conversation?.adoptedInput?.key.kind === 'prompt'))).toBe(true)
    services.publication!.refresh()
    const latest = (await f.client.conversationCheckpoint(ref)).checkpoint
    for (const binding of bindings) expect(services.publication!.store.retainedCheckpoint(binding)?.frontier).toEqual(latest.frontier)
    for (const binding of bindings) expect(new Set(services.publication!.store.list(binding).filter(operation => operation.relay).map(operation => operation.projectionId)).size).toBe(1)
  }, { timeout: 10_000 })
  expect(copies()).toEqual({ feishu: 1, discord: 1 })
  await server.stop(); await services.close(); services = await createConnectionServices(options)
  await vi.waitFor(async () => { services.publication!.refresh(); const latest = (await f.client.conversationCheckpoint(ref)).checkpoint
    for (const binding of bindings) expect(services.publication!.store.retainedCheckpoint(binding)?.frontier).toEqual(latest.frontier)
    for (const operations of original) for (const operation of operations) expect(services.publication!.store.inspect(operation.operationId)?.prepared).toEqual(operation.prepared) })
  expect(copies()).toEqual({ feishu: 1, discord: 1 })
  expect(JSON.stringify(posts())).not.toContain(privateNote)
  expect(f.client.agentSession(ref.agentSessionId).run).toEqual(run)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
}, 60_000)

it('actual CLI reads a recorded narrow operation and confirms full sharing while retaining original member decisions and unknown effects', async () => {
  const f = await roomBindingFixture(); cleanup.push(f.close)
  const dispatch = vi.fn<PublicationAdapter['dispatch']>(async prepared => prepared.request.body === 'retained-unknown'
    ? { state: 'unknown', reason: 'effect-unconfirmed' } : { state: 'confirmed', mapping: { messageId: 'message-' + prepared.requestKey } })
  const adapter: PublicationAdapter = { adapterId: 'sample', renderVersion: 'original-sharing-fixture', supportedRenderVersions: ['original-sharing-fixture'], fragmentBytes: 8192,
    prepare: operation => ({ adapterId: 'sample', renderVersion: 'original-sharing-fixture', requestKey: operation.operationId,
      request: { method: 'POST', path: '/messages', ...(operation.reference.source.kind === 'native' ? { body: operation.reference.source.recordId } : {}) } }), dispatch,
    inspect: async () => null }
  const services = await createConnectionServices({ directory: join(f.root, 'recorded-connections'), adapters: [{ adapterId: 'sample', publication: adapter,
    test: async () => ({ authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown' }, delivery: { state: 'unknown' } }) }],
    bindings: { spatial: f.spatial, checkpoint: f.checkpoint }, publication: createPublicationConversationPort(() => [{ hostId: 'local', client: f.client }]) }); cleanup.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'recorded-secret', secret: 'synthetic-original-credential' })
  await services.connections.configure({ operationId: 'recorded-configure', expectedRevision: null, connection: { ...sampleConfig, credentialRef: credential.credentialRef } })
  const input = { ...f.input, scope: { ...f.input.scope, publication: 'future-native-user-facing' as const } }
  const prior = recordedGroupBinding(services.database!, input, await f.checkpoint({ hostId: input.executionHostId, agentSessionId: input.agentSessionId }), sampleConfig.application, originalContext.actor)
  expect(prior.state).toBe('applied'); if (prior.state !== 'applied') throw Error('Recorded original Binding missing')
  services.publication!.refresh()
  const row = (id: string) => JSON.stringify({ type: 'assistant', sessionId: 'original-native', uuid: id, message: { role: 'assistant', content: [{ type: 'text', text: id }] } }) + '\n'
  await appendFile(f.transcript, row('retained-unknown'))
  await vi.waitFor(() => expect(services.publication!.store.list(prior.binding).find(operation => operation.reference.source.kind === 'native')?.state).toBe('unknown'), { timeout: 6000 })
  const original = services.publication!.store.list(prior.binding).find(operation => operation.reference.source.kind === 'native')!
  const member = { application: sampleConfig.application, idType: 'account_id', userId: 'original-member' }
  const grant = await services.bindings!.grant({ operationId: 'original-access', bindingId: prior.binding.bindingId, expectedBindingRevision: 1,
    grantId: 'original-member', expectedRevision: null, actor: member, state: 'active', capabilities: ['input', 'answer', 'permission'] }, originalContext)
  expect(grant.state).toBe('applied')
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'recorded.sock'), connections: services.connections, spatialState: f.spatial,
    notebookStore: new AgentMuxNotebookStore(join(f.root, 'notebooks.root.json')),
    coreClients: () => [{ hostId: 'local', client: f.client }] }); await server.start(); cleanup.push(() => server.stop())
  const cli = (args: string[], value?: unknown) => runSourceObjectCli(['--endpoint', 'unix:' + server.path, 'connection', ...args], objectCliEnvironment(f.root,
    process.env.COMPLETE_SHARING_CLI_LOADED ? { AGENTMUX_RESUMED_INBOX_CLI_LOADED: process.env.COMPLETE_SHARING_CLI_LOADED } : {}), value === undefined ? '' : JSON.stringify(value), 20_000, pathToFileURL(resolve('packages/core/test/fixtures/a2a-resumed-inbox/source-loader.mjs')))
  const inspected = await cli(['binding', 'inspect', '--operation-id', input.operationId])
  expect(inspected.code, inspected.stdout + inspected.stderr).toBe(0)
  expect(JSON.parse(inspected.stdout).result.operation).toEqual(prior)
  const full = await cli(['binding', 'relink', '--input', '-'], { ...input, operationId: 'explicit-complete-sharing', expectedRevision: 1,
    scope: { ...input.scope, publication: 'future-shared-conversation' } })
  expect(full.code, full.stdout + full.stderr).toBe(0)
  const current = JSON.parse(full.stdout).result.binding
  expect(current).toMatchObject({ bindingId: prior.binding.bindingId, revision: 2, scope: { publication: 'future-shared-conversation' } })
  expect(services.bindings!.grants(current.bindingId, 2)).toMatchObject([{ grantId: 'original-member', actor: member, capabilities: ['input', 'answer', 'permission'], state: 'active' }])
  expect(services.publication!.store.inspect(original.operationId)).toEqual(original)
  const oldEffect = await cli(['delivery', 'inspect', '--operation-id', original.operationId])
  expect(oldEffect.code, oldEffect.stdout + oldEffect.stderr).toBe(0)
  expect(JSON.parse(oldEffect.stdout).result.delivery).toMatchObject({ operationId: original.operationId, state: 'unknown' })
  await appendFile(f.transcript, row('new-qualified-reply')); services.publication!.refresh()
  await vi.waitFor(() => expect(services.publication!.store.list(current).find(operation => operation.reference.source.kind === 'native')?.state).toBe('confirmed'), { timeout: 6000 })
  expect(dispatch.mock.calls.filter(([prepared]) => prepared.request.body === 'retained-unknown')).toHaveLength(1)
  expect(services.publication!.store.inspect(original.operationId)).toEqual(original)
}, 35_000)
