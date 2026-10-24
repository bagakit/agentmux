import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DefaultRestOptions } from '@discordjs/rest'
import * as core from '../../core/src/index.js'
import type { AgentProvider, AgentProviderPreparedNativeInput } from '../../core/src/agent-provider.js'
import { nativeInputCorrelationKey } from '../../core/src/native-input-correlation.js'
import { consumeConversationWindowPage } from '../../core/src/conversation-changes.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { source, turn, user, jsonl } from '../../core/test/helpers/codex-paginated.js'
import { objectCliEnvironment } from '../../core/test/helpers/object-cli-rpc.js'
import { runSourceObjectCli } from '../../core/test/helpers/source-object-cli.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { context } from './fixtures/room-binding.js'
import { feishuConfig, feishuSdkTransport } from './fixtures/feishu.js'
import { feishuMediaPlatform } from './fixtures/feishu-media-platform.js'
import { discordConfig, discordRoomId, discordTransport } from './fixtures/discord.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Adopted relay cleanup failed')
})

/** Original Core, Provider normalizer, Reader and default Host; only native and platform network I/O are controlled. */
async function fixture(deferNative = false) {
  const h = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: source.providerId, executorId: source.providerId,
    nativeHandle: { kind: 'provider', providerId: source.providerId, sessionId: source.nativeSessionId, transcriptPath: join(root, 'native.jsonl') } }))
  cleanup.push(h.close)
  const transcript = join(h.root, 'native.jsonl')
  await writeFile(transcript, jsonl([{ type: 'session_meta', payload: { id: source.nativeSessionId, cwd: h.root, history_mode: 'paginated' } }]))
  const actor = { protocolId: 'fixture-native-protocol', actorId: 'original-native-actor', lifecycleOperationId: 'original-launch', token: 'a'.repeat(64), launch: { command: 'fixture-cli', args: [] } }
  const original = (await h.store.readMetadata('original-agent'))!
  await h.store.compareAndSwap(original, { ...original, nativeActor: actor }); await h.inner.registry.load('local')
  h.inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), pid: 1234 }))
  const session = h.client.agentSession('original-agent'), ref = { hostId: 'local', agentSessionId: session.agentSessionId }
  const pendingNative: string[] = []
  const send = vi.fn<AgentProviderPreparedNativeInput['send']>(async (prompt, plan) => {
    const key = nativeInputCorrelationKey(plan.clientCorrelation!)
    expect(key).toBeTruthy(); if (!key) throw new Error('The actual native input correlation is missing')
    const claim = await h.store.readPromptAdmission(key.agentSessionId, key.expectedRun, key.kind === 'prompt' ? key.submissionId : key.messageId)
    expect(claim?.admission?.inputKey).toEqual(key)
    expect(claim?.admission?.intent?.plan).toEqual(plan)
    expect(claim?.admission?.intent?.admissionIntent).toEqual({ kind: 'native-conversation', source, expectedRun: session.run })
    expect(plan).toMatchObject({ actorId: actor.actorId, protocolId: actor.protocolId, threadId: source.nativeSessionId })
    const row = user('semantic-' + send.mock.calls.length, [{ type: 'text', text: prompt }])
    row.payload.item.client_id = plan.clientCorrelation!
    // The canonical native source records the original sent prompt and its original machine correlation.
    if (deferNative) pendingNative.push(jsonl([row]))
    else await appendFile(transcript, jsonl([row]))
    return { outcome: 'admitted', turnId: turn }
  })
  const provider = (h.client as unknown as { providers: { get(id: string): AgentProvider } }).providers.get(source.providerId)
  provider.prepareNativeInput = vi.fn<NonNullable<AgentProvider['prepareNativeInput']>>(async (input, selected) => {
    expect(input.nativeActor).toEqual(actor); expect(selected).toEqual(source)
    return { plan: { kind: 'native-rpc', protocolId: actor.protocolId, actorId: actor.actorId,
      sourceId: JSON.stringify([source.providerId, source.nativeSessionId]), threadId: source.nativeSessionId, operation: 'start-or-steer' }, assertCurrent: vi.fn(async () => {}), send, dispose: vi.fn() }
  })
  const spatial = new core.AgentMuxSpatialStateStore(join(h.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: h.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: h.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'tab', kind: 'agent', agentSessionId: session.agentSessionId, runId: null, execution: { hostId: 'local', cwd: h.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } }, resources: {}
  } })
  feishuSdkTransport()
  const remote = await feishuMediaPlatform(); cleanup.push(remote.close)
  const discord = await discordTransport(); cleanup.push(discord.close)
  vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(discord.http.makeRequest)
  const options = { directory: join(h.root, 'relay-host'), bindings: { spatial, checkpoint: (reference: core.ConversationRef) => h.client.conversationCheckpoint(reference) }, publication: createPublicationConversationPort(h.coreClients) }
  let services = await createConnectionServices(options)
  cleanup.push(() => services.close())
  const bindings: core.RoomBinding[] = []
  for (const config of [feishuConfig, discordConfig]) {
    const credential = await services.secrets.store({ operationId: config.adapterId + '-secret', secret: 'controlled-' + config.adapterId })
    await services.connections.configure({ operationId: config.adapterId + '-configuration', expectedRevision: null, connection: { ...config, credentialRef: credential.credentialRef } })
    const bound = await services.connections.bindings!.bind({ operationId: config.adapterId + '-shared-source', bindingId: config.adapterId + '-binding', connectionId: config.connectionId,
      expectedConnectionRevision: 1, executionHostId: ref.hostId, agentSessionId: ref.agentSessionId, regionAnchor: { regionId: 'original-region' },
      externalConversationId: config.adapterId === 'feishu' ? 'original-room' : discordRoomId, expectedSource: source, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } }, context)
    expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw new Error('Original shared Binding required')
    bindings.push(bound.binding)
  }
  const socketPath = join(h.root, 'relay.sock'), serverOptions = () => ({ socketPath, connections: services.connections, spatialState: spatial, coreClients: h.coreClients })
  let server = new core.AgentMuxControlServer(serverOptions())
  await server.start(); cleanup.push(() => server.stop())
  let rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const operations = (binding = bindings[0]!) => [...new Map(services.publication!.store.list(binding).filter(operation => operation.payload.kind === 'speech')
    .map(operation => [JSON.stringify([operation.projectionId, operation.fragment.ordinal]), operation])).values()]
  const refresh = () => services.publication!.refresh()
  const settled = async (count: number) => vi.waitFor(() => { refresh(); for (const binding of bindings) {
    expect(operations(binding)).toHaveLength(count); expect(operations(binding).every(operation => operation.state === 'confirmed')).toBe(true)
    expect(operations(binding).every(operation => operation.payload.kind === 'speech' && operation.payload.inputSubmission?.status === 'admitted')).toBe(true)
    expect(services.publication!.store.coverage(binding).gaps).toEqual([])
  } }, { timeout: 10_000 })
  return { ...h, session, ref, transcript, send, remote, discord, get rpc() { return rpc }, bindings, operations, refresh, settled, services: () => services,
    async flushNative() { await appendFile(transcript, pendingNative.splice(0).join('')); refresh() },
    async reopen() { rpc.dispose(); await server.stop(); services.close(); services = await createConnectionServices(options); server = new core.AgentMuxControlServer(serverOptions()); await server.start(); rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); refresh() },
    cli: (args: string[]) => runSourceObjectCli(['--endpoint', 'unix:' + server.path, ...args], objectCliEnvironment(h.root, process.env.PUBLIC_INPUT_ALIAS_CLI_LOADED ? { AGENTMUX_RESUMED_INBOX_CLI_LOADED: process.env.PUBLIC_INPUT_ALIAS_CLI_LOADED } : {}), '', 30_000, new URL('../../core/test/fixtures/a2a-resumed-inbox/source-loader.mjs', import.meta.url)) }
}

it.each(['native-first', 'captured-first'] as const)('accounts the actual %s public App input alias through both SDKs and original source CLI', async order => {
  const f = await fixture(order === 'captured-first'), body = 'Same public input 中文🙂\nEvery original line is retained.', privateContext = 'Private generated amux system context'
  const key = { kind: 'prompt' as const, agentSessionId: f.ref.agentSessionId, expectedRun: f.session.run, submissionId: 'original-public-input' }
  await f.client.submitAgentPrompt({ agentSessionId: key.agentSessionId, expectedRun: key.expectedRun, operationId: key.submissionId,
    admissionIntent: { kind: 'native-conversation', source }, execution: 'immediate', prompt: body, authorHuman: true, agentMuxNote: privateContext })
  await expect.poll(async () => (await f.client.inspectAgentInput({ key }))?.status, { timeout: 10_000 }).toBe('admitted')
  await expect.poll(async () => (await f.client.sessionTimeline(f.ref.agentSessionId)).items.filter(item => item.kind === 'user_message'), { timeout: 10_000 }).toHaveLength(1)
  await f.settled(1)
  const before = f.operations().map(operation => ({ operationId: operation.operationId, prepared: operation.prepared, payload: operation.payload }))
  if (order === 'captured-first') await f.flushNative()
  const read = consumeConversationWindowPage(await f.client.readAgentConversation(f.ref))
  expect(read.kind).toBe('complete'); if (read.kind !== 'complete') throw Error('Actual complete original page required')
  const input = read.snapshot.units.find(unit => unit.records.some(record => record.original.kind === 'captured' && record.original.item.inputRef?.kind === 'prompt'))!
  expect(input.records.some(record => record.original.kind === 'native' && record.original.item.conversation?.adoptedInput?.key.kind === 'prompt')).toBe(true)
  expect(f.send).toHaveBeenCalledOnce(); expect(f.send.mock.calls[0]![0]).toContain(privateContext)
  await f.settled(1)
  if (order === 'native-first') {
    const original = f.operations()[0]!, output = await f.cli(['connection', 'delivery', 'inspect', '--operation-id', original.operationId])
    expect(output.code, output.stderr + output.stdout).toBe(0)
    expect(JSON.parse(output.stdout).result.delivery.operationId).toBe(original.operationId)
  }
  await f.reopen(); await f.settled(1)
  expect(f.operations().map(operation => ({ operationId: operation.operationId, prepared: operation.prepared, payload: operation.payload }))).toEqual(before)
  const feishu = f.remote.calls.filter(call => call.method === 'POST' && call.path === '/open-apis/im/v1/messages' && JSON.stringify(call.body).includes('Same public input'))
  const discord = f.discord.calls.filter(call => call.method === 'POST' && call.path === '/channels/300/messages' && call.body.includes('Same public input'))
  expect(feishu).toHaveLength(1); expect(discord).toHaveLength(1)
  expect(JSON.stringify([...feishu, ...discord])).not.toContain(privateContext)
  for (const binding of f.bindings) {
    const observed = await f.rpc.call('connection.delivery.ls', { connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision })
    expect(observed.coverage!.gaps).toEqual([])
  }
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 60_000)

it('retains an unknown original request while its later native alias is accounted across reopen', async () => {
  const f = await fixture(true), binding = f.bindings[1]!, body = 'Unknown public input', note = 'Private original context'
  await vi.waitFor(() => { f.refresh(); for (const target of f.bindings) expect(f.services().publication!.store.list(target).every(operation => operation.state === 'confirmed')).toBe(true) })
  const posts = () => f.discord.calls.filter(call => call.method === 'POST' && call.path === '/channels/300/messages').length
  const priorPosts = posts(); f.discord.loseNextMessageResponse(false)
  await f.client.submitAgentPrompt({ agentSessionId: f.ref.agentSessionId, expectedRun: f.session.run, operationId: 'unknown-public-input',
    admissionIntent: { kind: 'native-conversation', source }, execution: 'immediate', prompt: body, authorHuman: true, agentMuxNote: note })
  let original!: ReturnType<typeof f.operations>[number]
  await vi.waitFor(() => { f.refresh(); original = f.services().publication!.store.list(binding).find(operation => operation.payload.kind === 'speech' && operation.state === 'unknown')!; expect(original).toBeTruthy() }, { timeout: 10_000 })
  const retained = { operationId: original.operationId, prepared: original.prepared, payload: original.payload }
  expect(retained.prepared).toBeTruthy(); expect(posts()).toBe(priorPosts + 1)
  await f.flushNative()
  const checkpoint = await f.client.conversationCheckpoint(f.ref), native = checkpoint.checkpoint.frontier.cuts.find(cut => cut.kind === 'native')
  await vi.waitFor(() => { f.refresh(); for (const target of f.bindings) {
    const store = f.services().publication!.store
    expect(store.retainedCheckpoint(target)?.frontier.cuts.find(cut => cut.kind === 'native')).toEqual(native)
    expect(store.coverage(target).gaps).toEqual([])
  } }, { timeout: 10_000 })
  await f.reopen()
  await vi.waitFor(() => {
    f.refresh(); const after = f.services().publication!.store.inspect(retained.operationId)!
    expect(after.state).toBe('unknown'); expect({ operationId: after.operationId, prepared: after.prepared, payload: after.payload }).toEqual(retained)
  }, { timeout: 10_000 })
  expect(posts()).toBe(priorPosts + 1); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 60_000)
