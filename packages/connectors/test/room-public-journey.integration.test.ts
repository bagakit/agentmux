// @vitest-environment happy-dom
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '../../core/dist/index.js'
import { AgentMuxHostedRuntimeService } from '../../core/dist/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../../core/dist/hosted.js'
import { hostedTestOwner } from '../../core/test/helpers/hosted-runtime-port.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { createDesktopExternalInputAuthority } from '../../../apps/host/src/external-input-authority.js'
import { startAgentMuxHost } from '../../../apps/host/src/host.js'
import { externalIngressMailbox } from '../../../apps/desktop/test/helpers/external-ingress-mailbox.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { createHostedIngressCorePort } from '../src/core-ingress-port.js'
import { signedRoomAdapter, type SignedRoomMessage } from './fixtures/signed-room-adapter.js'

const mailbox = externalIngressMailbox(), cleanup: Array<() => void | Promise<void>> = []
const evidencePath = process.env.AGENTMUX_CONNECTOR_JOURNEY_RECEIPT
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const native = (id: string, text: string, type: 'user' | 'assistant' = 'assistant') => JSON.stringify({ sessionId: 'journey-native', uuid: id, type,
  message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] } }) + '\n'
async function fixture(coreAvailable = true, execution: 'direct' | 'hosted' | 'node-host' = 'direct') {
  const original = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'claude', executorId: 'claude', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'journey-native', transcriptPath: join(root, 'native.jsonl') } }))
  cleanup.push(() => original.close())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const transcript = join(original.root, 'native.jsonl')
  await writeFile(transcript, native('history/before-binding', 'Existing private work', 'user'))
  const spatial = new core.AgentMuxSpatialStateStore(join(original.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: original.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: original.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: original.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } }, resources: {}
  } })
  const semanticPath = join(original.root, 'semantic.sock')
  let nodeHost: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined
  if (execution === 'node-host') {
    const runtime = original.inner.kernel
    // Fixture bootstrap owns no semantic endpoint. Dispose it before the actual product Host takes the original Store.
    await original.client.dispose()
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
      const inner = this as unknown as typeof original.inner
      await inner.registry.load('local')
      for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = runtime[name]
      inner.connected = true
    })
    nodeHost = await startAgentMuxHost({ store: original.store, socketPath: semanticPath, desktopSocketPath: join(original.root, 'journey.sock'), mobileBuildDirectory: join(original.root, 'absent-mobile-assets') })
    cleanup.push(() => nodeHost!.dispose())
    original.client = nodeHost.client; original.inner = nodeHost.client as unknown as typeof original.inner
    original.coreClients = () => [{ hostId: 'local', client: original.client }]
    await vi.waitFor(() => expect(original.inner.connected).toBe(true)); connect.mockRestore()
  }
  const provider = (original.client as unknown as { providers: { get(id: string): { planPromptInput(text: string): unknown } } }).providers.get('claude')
  // Original Core journal and ordered Runtime I/O; this deterministic leaf does not claim native CLI ACK.
  vi.spyOn(provider, 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const hostedOwner = execution === 'hosted' ? new AgentMuxHostedRuntimeService(original.client, original.store.path, () => hostedTestOwner(original.client)) : undefined
  if (hostedOwner) cleanup.push(() => hostedOwner.dispose())
  const semantic = hostedOwner ? new core.AgentMuxControlServer({ socketPath: semanticPath, hostedRuntime: () => hostedOwner, coreClients: original.coreClients }) : undefined
  if (semantic) { await semantic.start(); cleanup.push(() => semantic.stop()) }
  const semanticRpc = semantic || nodeHost ? await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: semanticPath } }) : undefined
  if (semanticRpc) cleanup.push(() => semanticRpc.dispose())
  const hosted = semanticRpc ? await connectHostedAgentMux({ rpc: semanticRpc }) : undefined
  if (hosted) cleanup.push(() => hosted.dispose())
  const executionClients = () => [{ hostId: 'local', client: hosted ?? original.client }]
  const inputCore = hosted ? createHostedIngressCorePort(executionClients) : () => original.client
  const coreResolver = vi.fn((host: string) => coreAvailable && host === 'local' ? inputCore(host) : undefined)
  const wire = signedRoomAdapter()
  const services = await createDesktopConnections({ directory: join(original.root, 'connectors'), adapters: [wire.adapter],
    encryption: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    bindings: { spatial, checkpoint: async ref => ({ ...ref, checkpoint: await (hosted ?? original.client).conversationCheckpoint(ref.agentSessionId) }) },
    publication: createPublicationConversationPort(executionClients), ingress: { core: coreResolver } })
  cleanup.push(() => services.close())
  const server = new core.AgentMuxControlServer({ socketPath: join(original.root, 'journey.sock'), connections: services.connections, spatialState: spatial, coreClients: original.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const sdk = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => sdk.dispose())
  const cli = async (args: string[], input = '') => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, ...args], objectCliEnvironment(original.root), input)
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  const credential = await services.secrets.store({ operationId: 'journey-credential', secret: 'fixture-signing-key' })
  const config = { connectionId: 'signed-room-connection', adapterId: 'signed-room', application: { domain: 'signed.example', appId: 'signed-team-app' }, label: 'Signed team', enabled: true, credentialRef: credential.credentialRef }
  await sdk.call('connection.configure', { operationId: 'journey-configure', expectedRevision: null, connection: config })
  const bound = await cli(['connection', 'bind', '--input', '-'], JSON.stringify({ operationId: 'journey-bind', bindingId: 'journey-binding', connectionId: config.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'original-region' }, externalConversationId: 'room/project-α',
    expectedSource: { providerId: 'claude', nativeSessionId: 'journey-native' }, scope: { input: 'all-messages', publication: 'future-native-user-facing' } }))
  expect(bound.state).toBe('applied')
  const actor = { application: config.application, idType: 'email', userId: 'writer@example.test' }
  const grant = { operationId: 'journey-grant', grantId: 'journey-actor', bindingId: bound.binding.bindingId, expectedBindingRevision: bound.binding.revision,
    expectedRevision: null, actor, capabilities: ['input'], state: 'active' }
  expect(await sdk.call('connection.grant', grant)).toMatchObject({ state: 'applied' })
  await vi.waitFor(() => expect(wire.endpoint, 'Original Desktop composition must start the registered transport').toBeDefined(), { timeout: 3_000 })
  const message = (suffix = 'α'): SignedRoomMessage => ({ deliveryKey: 'delivery/' + suffix, recordKey: 'post/' + suffix, roomKey: 'room/project-α', person: actor.userId,
    text: 'External question\n保留完整原文', addressing: 'broadcast' })
  return { ...original, services, wire, transcript, spatial, sdk, cli, config, binding: bound.binding, grant, actor, message, hosted, coreResolver, setCoreAvailable: (value: boolean) => { coreAvailable = value } }
}

it('signed transport follows public configuration, original Hosted Core input, mounted Desktop reading and automatic replay publication back to the same room', async () => {
  const f = await fixture(true, 'node-host'), metadata = await f.store.readMetadata('original-agent')
  const submit = f.client.submitAgentMessage.bind(f.client)
  vi.spyOn(f.client, 'submitAgentMessage').mockImplementation((...args) => { f.wire.trace.push('core-submit'); return submit(...args) })
  expect(await f.wire.post(f.message(), false)).toBe(401)
  expect((await f.cli(['connection', 'ingress', 'ls', '--connection', f.config.connectionId])).ingresses).toEqual([])
  f.wire.trace.length = 0
  expect(await f.wire.post(f.message())).toBe(202)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(f.wire.trace.slice(0, 4)).toEqual(['callback', 'ack', 'callback-returned', 'core-submit'])
  const ingress = (await f.cli(['connection', 'ingress', 'ls', '--connection', f.config.connectionId])).ingresses[0]
  const inspected = await f.cli(['connection', 'ingress', 'inspect', '--ingress', ingress.ingressId])
  expect(inspected.inputReceipt.originalControlOperationId).toBe(ingress.input.operationId)
  expect(ingress.input).toMatchObject({ hostId: 'local', agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' }, author: { actor: f.actor, externalMessageId: 'post/α' } })
  const queued = await new core.DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).readByOperationId(ingress.input.operationId)
  expect(queued!.envelope.body).toBe(f.message().text)
  expect(queued!.envelope.sender).toEqual(ingress.input.author)
  let timeline = await f.client.sessionTimeline('original-agent')
  await vi.waitFor(async () => { timeline = await f.client.sessionTimeline('original-agent'); expect(timeline.items.find(item => item.id === 'prompt:' + ingress.input.messageId)?.authorExternal).toEqual(ingress.input.author) })
  const recorded = timeline.items.find(item => item.id === 'prompt:' + ingress.input.messageId)!
  const read = await mailbox(f.client.agentSession('original-agent'), timeline, recorded.id)
  expect(read.detail.dataset.speakerRole).toBe('external')
  expect(read.detail.textContent).toContain(f.actor.userId)
  expect(read.detail.textContent).toContain(f.message().roomKey)
  expect(read.detail.dataset.conversationItemRef).toBe(JSON.stringify({ hostId: 'local', agentSessionId: 'original-agent', source: { kind: 'captured', recordId: recorded.id } }))
  await read.copyOriginal(); expect(read.copy).toHaveBeenCalledWith(recorded.content)
  await appendFile(f.transcript, native('reply/α', 'Original answer 中文🙂'))
  await vi.waitFor(() => expect(f.wire.effects).toHaveLength(1), { timeout: 5_000 })
  expect(f.wire.effects[0]).toMatchObject({ room: f.message().roomKey, text: 'Original answer 中文🙂' })
  const delivered = await f.cli(['connection', 'delivery', 'ls', '--connection', f.config.connectionId, '--binding', f.binding.bindingId, '--binding-revision', '1'])
  expect(delivered.deliveries).toHaveLength(1)
  expect(delivered.deliveries[0]).toMatchObject({ state: 'confirmed', reference: { hostId: 'local', agentSessionId: 'original-agent', source: { kind: 'native', recordId: 'reply/α' } }, mapping: { messageId: 'replay/message/1' } })
  expect(JSON.stringify(delivered)).not.toMatch(/fixture-signing-key|Original answer|prepared|x-room-signature/)
  expect(await f.wire.post(f.message())).toBe(202)
  expect(await f.wire.post({ ...f.message(), deliveryKey: 'redelivery/α' })).toBe(202)
  expect(await f.wire.post(f.message('β'))).toBe(202)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(2))
  const after = await f.cli(['connection', 'ingress', 'ls', '--connection', f.config.connectionId])
  expect(after.ingresses).toHaveLength(2)
  expect(after.ingresses[0].input).toEqual(ingress.input)
  expect(after.ingresses[1].input.agentSessionId).toBe('original-agent')
  expect(after.ingresses[1].input.operationId).not.toBe(ingress.input.operationId)
  await appendFile(f.transcript, native('reply/β', 'Same room follow-up'))
  await vi.waitFor(() => expect(f.wire.effects).toHaveLength(2), { timeout: 5_000 })
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.observation(f.binding.bindingId, 1).state).toBe('ready'))
  expect(f.wire.effects).toHaveLength(2)
  const current = await f.store.readMetadata('original-agent')
  expect(current).toMatchObject({ agentSessionId: metadata!.agentSessionId, run: metadata!.run, nativeHandle: metadata!.nativeHandle, workspacePath: metadata!.workspacePath })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
  if (evidencePath) {
    await mkdir(dirname(evidencePath), { recursive: true })
    await writeFile(evidencePath, JSON.stringify({ schema: 'agentmux.room-journey-receipt.v1', execution: 'original Hosted semantic service and Desktop authority adapter; deterministic Runtime I/O, signed HTTP and replay adapter test leaves',
      trace: f.wire.trace, ingress: inspected, originalQueue: { operationId: queued!.envelope.operationId, messageId: queued!.envelope.messageId, body: queued!.envelope.body, sender: queued!.envelope.sender },
      mountedReader: { speakerRole: read.detail.dataset.speakerRole, itemRef: read.detail.dataset.conversationItemRef, copiedOriginal: recorded.content },
      delivery: delivered, followUp: after, replayEffects: f.wire.effects, originalSessionId: current!.agentSessionId, originalRun: current!.run, agentLifecycleCalls: { stop: 0, attach: 0 } }, null, 2) + '\n')
  }
}, 20_000)

it('source gaps retain the original cut and published identities while later authorized external input remains available', async () => {
  const f = await fixture(), checkpoint = f.services.publication!.store.checkpoint(f.binding, f.binding.sourceCheckpoints[0])
  await rename(f.transcript, join(f.root, 'retained-native.jsonl'))
  await writeFile(f.transcript, native('replacement/α', 'Not silently adopted'))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.observation(f.binding.bindingId, 1)).toEqual({ state: 'unavailable', reason: 'source-gap' }), { timeout: 5_000 })
  const result = await f.cli(['connection', 'delivery', 'ls', '--connection', f.config.connectionId, '--binding', f.binding.bindingId, '--binding-revision', '1'])
  expect(result).toMatchObject({ deliveries: [], observation: { state: 'unavailable', reason: 'source-gap' } })
  expect(f.services.publication!.store.checkpoint(f.binding, f.binding.sourceCheckpoints[0])).toEqual(checkpoint)
  expect(await f.wire.post(f.message())).toBe(202)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(f.wire.effects).toEqual([])
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 12_000)

it('a stale registered receiver cannot ACK or retarget intake and closing it preserves the original local Agent capability', async () => {
  const f = await fixture(), receive = f.wire.receive!, accepted = f.wire.encode(f.message())
  const connection = (await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection!
  await f.sdk.call('connection.configure', { operationId: 'disable-original-receiver', expectedRevision: connection.revision, connection: { ...connection.config, enabled: false } })
  const acknowledge = vi.fn()
  await expect(receive(accepted, acknowledge)).rejects.toMatchObject({ code: 'INGRESS_CONNECTION_REVISED' })
  expect(acknowledge).not.toHaveBeenCalled()
  expect((await f.cli(['connection', 'ingress', 'ls', '--connection', f.config.connectionId])).ingresses).toEqual([])
  await f.cli(['agent', 'send', '--to-session', 'original-agent', '--text', 'Original local input remains available', '--execution', 'immediate', '--operation-id', 'original-local-input'])
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  f.services.close()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.detach).not.toHaveBeenCalled()
}, 12_000)

it('bounded recovery continues past one slow received page without copying the original Core queue or claiming unknown intake', async () => {
  const f = await fixture(false)
  for (let index = 0; index < 26; index++) expect(await f.wire.post(f.message('recovery-' + index))).toBe(202)
  const retained = (await f.cli(['connection', 'ingress', 'ls', '--connection', f.config.connectionId, '--limit', '100'])).ingresses
  expect(retained).toHaveLength(26); expect(retained.every((record: { state: string }) => record.state === 'received')).toBe(true)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  let release!: () => void, reads = 0, completed = 0
  const paused = new Promise<void>(resolve => { release = resolve }), read = f.client.readAgentSessions.bind(f.client)
  vi.spyOn(f.client, 'readAgentSessions').mockImplementation(async () => { if (++reads <= 25) await paused; const sessions = await read(); completed++; return sessions })
  f.setCoreAvailable(true)
  // Existing administration wakes the same receiver owner; no synthetic recovery queue or direct dispatch call.
  await f.sdk.call('connection.grant', f.grant)
  await vi.waitFor(() => expect(reads).toBe(25))
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await f.sdk.call('connection.grant', f.grant)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const last = await f.cli(['connection', 'ingress', 'inspect', '--ingress', retained[25].ingressId])
  expect(last.ingress).toMatchObject({ state: 'claimed', externalMessageId: 'post/recovery-25', input: { agentSessionId: 'original-agent' } })
  expect(f.services.ingress!.received(f.config.connectionId).ingressIds).toEqual(retained.slice(0, 25).map((record: { ingressId: string }) => record.ingressId))
  const current = (await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection!
  await f.sdk.call('connection.configure', { operationId: 'close-recovery-admission', expectedRevision: current.revision, connection: { ...current.config, enabled: false } })
  release()
  await vi.waitFor(() => expect(completed).toBe(26))
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 15_000)

it('the actual Hosted wire cannot adopt private author authority from a client callback or replay an unconfirmed original claim', async () => {
  const f = await fixture(true, 'hosted')
  expect(await f.wire.post(f.message())).toBe(202)
  let record: Awaited<ReturnType<NonNullable<typeof f.services.ingress>['list']>>['ingresses'][number] | undefined
  await vi.waitFor(async () => { record = (await f.services.ingress!.list({ connectionId: f.config.connectionId })).ingresses[0]; expect(record?.state).toBe('claimed') })
  const inspect = await f.cli(['connection', 'ingress', 'inspect', '--ingress', record!.ingressId])
  expect(inspect.ingress.input).toEqual(record!.input)
  expect(inspect.inputReceipt).toBeNull()
  expect(await new core.DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).readByOperationId(record!.input!.operationId)).toBeNull()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(await f.wire.post(f.message())).toBe(202)
  await new Promise(resolve => setImmediate(resolve))
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await f.hosted!.submitAgentPrompt({ agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' }, operationId: 'hosted-local-input', prompt: 'Healthy local Hosted input',
    admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: true })
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect((await f.services.ingress!.inspect({ ingressId: record!.ingressId })).ingress!.input).toEqual(record!.input)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 15_000)

it('public authority reads only the original claim and current grant, and the execution adapter checks every frozen input field', async () => {
  const f = await fixture()
  expect(await f.wire.post(f.message())).toBe(202)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const record = (await f.services.ingress!.list({ connectionId: f.config.connectionId })).ingresses[0]!, input = record.input!
  // Join the already claimed original dispatch before isolating authority's no-Core-read contract.
  await f.services.ingress!.dispatch(record.ingressId)
  f.coreResolver.mockClear()
  const result = await f.cli(['connection', 'ingress', 'authority', '--operation-id', input.operationId])
  expect(result).toEqual({ ingress: record, authority: 'current' }); expect(f.coreResolver).not.toHaveBeenCalled()
  const authority = createDesktopExternalInputAuthority({ desktopSocketPath: join(f.root, 'journey.sock'), executionHostId: 'local' })
  const intent = { agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, operationId: input.operationId, messageId: input.messageId, body: record.body }
  await expect(authority.assertCurrent(input.author, intent)).resolves.toBeUndefined()
  for (const change of [{ agentSessionId: 'replacement-agent' }, { expectedRun: { runId: 'replacement-run' } }, { operationId: 'replacement-operation' }, { messageId: 'replacement-message' }, { body: 'Replacement body' }]) {
    await expect(authority.assertCurrent(input.author, { ...intent, ...change })).rejects.toMatchObject({ code: 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED' })
  }
  await expect(authority.assertCurrent({ ...input.author, externalMessageId: 'replacement/message' }, intent)).rejects.toMatchObject({ code: 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED' })
  await expect(createDesktopExternalInputAuthority({ desktopSocketPath: join(f.root, 'journey.sock'), executionHostId: 'another-host' }).assertCurrent(input.author, intent)).rejects.toMatchObject({ code: 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED' })
  await f.sdk.call('connection.grant', { ...f.grant, operationId: 'revoke-current-authority', expectedRevision: 1, state: 'revoked' })
  expect(await f.cli(['connection', 'ingress', 'authority', '--operation-id', input.operationId])).toEqual({ ingress: record, authority: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' })
  await expect(authority.assertCurrent(input.author, intent)).rejects.toMatchObject({ code: 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED' })
  const failedRead = vi.spyOn(f.services.bindings!, 'findGrant').mockImplementation(() => { throw new Error('private connector diagnostic') })
  const unknown = await f.cli(['connection', 'ingress', 'authority', '--operation-id', input.operationId])
  expect(unknown).toEqual({ ingress: record, authority: 'unavailable', code: 'INGRESS_STORAGE_UNCONFIRMED' })
  expect(JSON.stringify(unknown)).not.toContain('private connector diagnostic'); failedRead.mockRestore()
  expect(await f.cli(['connection', 'ingress', 'authority', '--operation-id', 'unknown-original-operation'])).toEqual({ ingress: null, authority: 'refused', code: 'INGRESS_CLAIM_UNAVAILABLE' })
  const { parseIngressResult, parseIngressParams } = await import('../../core/dist/connections.js')
  for (const invalid of [{ ...result, authority: 'current', ingress: null }, { ...result, authority: ['current'] }, { ...result, code: 'private diagnostic' }, { ...result, authority: 'refused', code: ['INGRESS_ACTOR_NOT_AUTHORIZED'] }, { ...result, ingress: { ...record, state: ['claimed'] } }, { ...result, ingress: { ...record, input: { ...input, operationId: 'different-operation' } } }]) {
    expect(() => parseIngressResult('connection.ingress.authority', invalid, { operationId: input.operationId })).toThrow()
  }
  expect(() => parseIngressParams('connection.ingress.authority', { operationId: input.operationId, authenticated: true })).toThrow()
  expect(f.coreResolver).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 15_000)
