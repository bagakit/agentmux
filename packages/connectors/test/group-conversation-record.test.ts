import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { appendFile, writeFile } from 'node:fs/promises'
import * as core from '@agentmux/core'
import { connectHostedAgentMux } from '../../core/dist/hosted.js'
import { AgentMuxHostedRuntimeService } from '../../core/dist/hosted-runtime-service.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { hostedTestOwner } from '../../core/test/helpers/hosted-runtime-port.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { createDesktopExternalInputAuthority } from '../../../apps/host/src/external-input-authority.js'
import { createHostedIngressCorePort, createPublicationConversationPort, type ConnectionAdapter } from '@agentmux/connectors'
import { signedRoomAdapter, type SignedRoomMessage } from './fixtures/signed-room-adapter.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture(running = false, updatePublications = false) {
  let bridge: ReturnType<typeof createDesktopExternalInputAuthority>
  class Owner extends core.AgentMuxClient {
    constructor(options: { store: core.AgentMuxAgentSessionStore }) {
      super({ ...options, externalConversationAuthority: { resolveConversationMessage: input => bridge.resolveConversationMessage!(input) } })
    }
  }
  const f = await rpcOwnerFixture(['original-agent'], { AgentMuxClient: Owner, AgentMuxFileAgentSessionStore: core.AgentMuxFileAgentSessionStore }, root => ({ providerId: 'claude', executorId: 'claude', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'group-native', transcriptPath: join(root, 'native.jsonl') } }))
  cleanup.push(() => f.close())
  await writeFile(join(f.root, 'native.jsonl'), JSON.stringify({ type: 'user', sessionId: 'group-native', uuid: 'before-link', message: { role: 'user', content: 'Existing conversation' } }) + '\n')
  f.inner.connected = running; f.inner.kernel.isConnected = () => running
  vi.spyOn(f.client, 'connect').mockResolvedValue()
  if (running) vi.spyOn(f.client.providers.get('claude'), 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [{ spaceId: 'space', kind: 'topic', name: 'Original', hostId: 'local', directoryPath: f.root, projectId: 'project' }], zones: [{ zoneId: 'zone', workspaceId: 'workspace', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }], tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'workspace', name: null, regionIds: ['region'] }], regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: f.root } }], bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { workspace: createWorkspaceLayout('group', ['tab']) }, tabLayouts: { tab: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' } }, resources: {} } })
  const desktopPath = join(f.root, 'desktop.sock')
  bridge = createDesktopExternalInputAuthority({ desktopSocketPath: desktopPath, executionHostId: 'local' })
  const runtime = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client), undefined, bridge)
  cleanup.push(() => runtime.dispose())
  const host = new core.AgentMuxControlServer({ socketPath: join(f.root, 'host.sock'), coreClients: f.coreClients, hostedRuntime: () => runtime })
  await host.start(); cleanup.push(() => host.stop())
  const hostRpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: host.path } }); cleanup.push(() => hostRpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc: hostRpc }); cleanup.push(() => hosted.dispose())
  const clients = () => [{ hostId: 'local', client: hosted }]
  const wire = signedRoomAdapter(), verify = wire.adapter.ingress!.verify
  if (updatePublications) {
    const original = wire.adapter.publication!.dispatch
    wire.adapter.publication!.dispatch = async (...args) => {
      const mapping = args[4]
      if (!mapping) return original(...args)
      // The controlled transport supports exact updates to its original platform message.
      wire.ledger.set(args[0].requestKey, mapping)
      return { state: 'confirmed', mapping }
    }
  }
  const adapter: ConnectionAdapter = { ...wire.adapter, ingress: { ...wire.adapter.ingress!, verify: async (...args) => ({ ...await verify(...args), conversationKind: 'group' }) } }
  let services: Awaited<ReturnType<typeof createDesktopConnections>>, desktop: core.AgentMuxControlServer, rpc: Awaited<ReturnType<typeof core.connectAgentMuxRpc>>
  async function open() {
    services = await createDesktopConnections({ directory: join(f.root, 'connectors'), adapters: [adapter],
      encryption: { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async value => Buffer.from(value), decryptStringAsync: async value => ({ result: value.toString(), shouldReEncrypt: false }) },
      bindings: { spatial, checkpoint: ref => hosted.conversationCheckpoint(ref) }, publication: createPublicationConversationPort(clients), ingress: { core: createHostedIngressCorePort(clients) } })
    desktop = new core.AgentMuxControlServer({ socketPath: desktopPath, connections: services.connections, spatialState: spatial, coreClients: clients })
    await desktop.start(); rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path } })
  }
  async function close() { await rpc?.dispose(); await desktop?.stop(); services?.close() }
  await open(); cleanup.push(close)
  const application = { domain: 'signed.example', appId: 'group-app' }, actor = { application, idType: 'email', userId: 'member@example.test' }
  const secret = await services!.secrets.store({ operationId: 'save-secret', secret: 'fixture-signing-key' })
  const config = { connectionId: 'group-bot', adapterId: adapter.adapterId, application, label: 'Group bot', enabled: true, credentialRef: secret.credentialRef }
  await rpc!.call('connection.configure', { operationId: 'configure-bot', expectedRevision: null, connection: config })
  const binding = { operationId: 'link-group', bindingId: 'group-binding', connectionId: config.connectionId, expectedConnectionRevision: 1, expectedSource: { providerId: 'claude', nativeSessionId: 'group-native' }, executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'region' }, externalConversationId: 'native-group', scope: { input: 'mentions-and-replies' as const, publication: 'future-shared-conversation' as const } }
  expect(await rpc!.call('connection.bind', binding)).toMatchObject({ state: 'applied' })
  await vi.waitFor(() => expect(wire.endpoint).toBeDefined())
  const message = (changes: Partial<SignedRoomMessage> = {}): SignedRoomMessage => ({ deliveryKey: 'event', recordKey: 'message', roomKey: 'native-group', person: actor.userId, text: 'Original group message', addressing: 'broadcast', ...changes })
  const receive = async (changes: Partial<SignedRoomMessage> = {}) => {
    const native = message(changes)
    expect(await wire.post(native)).toBe(202)
    let record: Awaited<ReturnType<NonNullable<typeof services.ingress>['list']>>['ingresses'][number] | undefined
    await vi.waitFor(async () => { record = (await services.ingress!.list({ connectionId: config.connectionId })).ingresses.find(record => record.kind !== 'action' && record.externalMessageId === native.recordKey); expect(record).toBeDefined() })
    return record!
  }
  const captured = async () => (await f.store.readCapturedHistory('original-agent')).records.filter(record => record.item.authorExternal)
  const cli = async (args: string[]) => { const result = await runCompiledObjectCli(['--endpoint', 'unix:' + desktopPath, ...args], objectCliEnvironment(f.root)); expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result }
  return { ...f, wire, actor, config, binding, message, receive, captured, cli, hosted, hostRpc, get services() { return services }, get rpc() { return rpc }, reopen: async () => { await close(); await open() } }
}

it('real Main receiver and Hosted Core record ordinary group messages once without an input grant or live Run', async () => {
  const f = await fixture(), submit = vi.spyOn(f.client, 'submitAgentMessage'), before = await f.store.readMetadata('original-agent'), received = await f.receive()
  await vi.waitFor(async () => expect(await f.captured()).toHaveLength(1))
  const [captured] = await f.captured()
  expect(captured!.item).toMatchObject({ content: 'Original group message', publicContent: 'confirmed', authorExternal: { actor: f.actor } })
  expect(captured!.item.authorExternal).not.toHaveProperty('grantId'); expect(captured!.item.inputRef).toBeUndefined()
  expect(submit).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(await f.store.readMetadata('original-agent')).toEqual(before)
  expect((await f.cli(['connection', 'ingress', 'ls', '--connection', f.config.connectionId, '--binding', f.binding.bindingId])).ingresses).toHaveLength(1)
  const page = await f.cli(['agent', 'conversation', 'inspect', '--host', 'local', '--session', 'original-agent'])
  expect(JSON.stringify(page)).toContain('Original group message')
  const receipt = await f.cli(['agent', 'conversation', 'record', '--host', 'local', '--session', 'original-agent', '--ingress', received.ingressId])
  expect(receipt.record.source.recordId).toBe(captured!.item.id)
  const diagnosis = await f.cli(['connection', 'diagnose', '--host', 'local', '--session', 'original-agent', '--binding', f.binding.bindingId])
  expect(diagnosis.groups.value.items[0].incoming.value.rows).toContainEqual(expect.objectContaining({ ingressId: received.ingressId, scope: 'current-binding', bindingId: f.binding.bindingId, recording: { state: 'recorded' }, inputOperationId: null, coreStatus: null }))
  expect(JSON.stringify(diagnosis)).not.toContain('Original group message'); expect(JSON.stringify(diagnosis)).not.toContain(f.actor.userId)
  await f.receive({ deliveryKey: 'redelivery' }); await f.reopen()
  await f.services.ingress!.dispatch(received.ingressId)
  expect(await f.captured()).toHaveLength(1)
  expect(submit).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  await vi.waitFor(async () => expect((await f.services.publication!.list({ connectionId: f.config.connectionId, bindingId: f.binding.bindingId, bindingRevision: 1 })).coverage?.origins).toHaveLength(1))
  expect(f.wire.effects).toHaveLength(0)
  await f.receive({ deliveryKey: 'distinct-event', recordKey: 'distinct-message' })
  await vi.waitFor(async () => expect(await f.captured()).toHaveLength(2))
  expect(submit).not.toHaveBeenCalled()
})

it('authorized group processing enriches the same captured record and retains an independent original input receipt', async () => {
  const f = await fixture(true)
  await f.rpc.call('connection.grant', { operationId: 'grant-member', bindingId: f.binding.bindingId, expectedBindingRevision: 1, grantId: 'member-grant', expectedRevision: null, actor: f.actor, capabilities: ['input'], state: 'active' })
  const received = await f.receive({ addressing: 'response' })
  await vi.waitFor(async () => expect((await f.captured())[0]?.item.inputRef?.kind).toBe('message'))
  const [record] = await f.captured()
  expect(await f.captured()).toHaveLength(1); expect(record!.item.content).toBe('Original group message')
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  const inspection = await f.services.ingress!.inspect({ ingressId: received.ingressId })
  expect(inspection.ingress?.input?.messageId).toBe(record!.item.inputRef?.kind === 'message' ? record!.item.inputRef.messageId : null)
  await f.receive({ deliveryKey: 'second-event', addressing: 'response' })
  expect(await f.captured()).toHaveLength(1); expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})

it('an ACK freezes the exact group relationship and cannot target a resumed or replacement binding', async () => {
  const f = await fixture(), native = f.message(), encoded = f.wire.encode(native)
  const received = await f.services.ingress!.receive({ connectionId: f.config.connectionId, ...encoded }, async () => {
    expect(await f.rpc.call('connection.binding.pause', { operationId: 'pause-original', bindingId: f.binding.bindingId, expectedRevision: 1 })).toMatchObject({ state: 'applied' })
    expect(await f.rpc.call('connection.binding.resume', { operationId: 'resume-original', bindingId: f.binding.bindingId, expectedRevision: 2 })).toMatchObject({ state: 'applied' })
  })
  expect(received.ingress.kind).toBeUndefined()
  const result = await f.services.ingress!.dispatch(received.ingress.ingressId)
  expect(result.ingress).toMatchObject({ state: 'refused', group: { target: { bindingRevision: 1 }, recording: { state: 'refused' } } })
  expect(await f.captured()).toHaveLength(0); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  const unlinked = await f.services.ingress!.receive({ connectionId: f.config.connectionId, ...f.wire.encode(f.message({ recordKey: 'unlinked-message', deliveryKey: 'unlinked-event', roomKey: 'unlinked-group' })) }, () => {})
  expect(unlinked.ingress).toMatchObject({ group: { target: null } })
  await f.rpc.call('connection.bind', { ...f.binding, operationId: 'link-later', bindingId: 'later-binding', externalConversationId: 'unlinked-group' })
  await f.services.ingress!.dispatch(unlinked.ingress.ingressId)
  expect(await f.captured()).toHaveLength(0)
})

it('wire callers cannot inject a body, author or record resolver and original source conflicts retain local capability', async () => {
  const f = await fixture(), received = await f.receive()
  await vi.waitFor(async () => expect(await f.captured()).toHaveLength(1))
  const input = { agentSessionId: 'original-agent', ingressId: received.ingressId }, identity = f.hosted.runtimeOwnerIdentity()!
  await expect(f.rpc.call('agent.conversation.record', { hostId: 'local', ...input, body: 'Injected body' } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(f.hostRpc.call('runtime.invoke', { consumerId: 'forged-record', fence: { runtimeId: identity.runtimeId, ownerInstanceId: identity.ownerInstanceId }, invocation: { method: 'recordExternalConversationMessage', args: [input, { resolveConversationMessage: true }] } } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(f.rpc.call('agent.conversation.record', { hostId: 'local', ...input, agentSessionId: 'other-agent' })).rejects.toMatchObject({ code: 'EXTERNAL_RECORD_TARGET_UNCONFIRMED' })
  expect(await f.captured()).toHaveLength(1); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('concurrent public records commit one original capture and return the same receipt', async () => {
  const f = await fixture(), received = await f.services.ingress!.receive({ connectionId: f.config.connectionId, ...f.wire.encode(f.message()) }, () => {})
  const apply = f.store.applyTimelineMutation.bind(f.store)
  let arrivals = 0, release!: () => void
  const both = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(f.store, 'applyTimelineMutation').mockImplementation(async (mutation, signal) => {
    if (mutation.type === 'append' && mutation.item.authorExternal) { if (++arrivals === 2) release(); await both }
    return apply(mutation, signal)
  })
  const input = { hostId: 'local', agentSessionId: 'original-agent', ingressId: received.ingress.ingressId }
  const receipts = await Promise.all([f.rpc.call('agent.conversation.record', input), f.rpc.call('agent.conversation.record', input)])
  expect(arrivals).toBe(2); expect(receipts[0]).toEqual(receipts[1]); expect(await f.captured()).toHaveLength(1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('recording failures cannot suppress authorized input and recover onto its original capture', async () => {
  const f = await fixture(true)
  await f.rpc.call('connection.grant', { operationId: 'grant-member', bindingId: f.binding.bindingId, expectedBindingRevision: 1, grantId: 'member-grant', expectedRevision: null, actor: f.actor, capabilities: ['input'], state: 'active' })
  const record = vi.spyOn(f.client, 'recordExternalConversationMessage').mockRejectedValue(new core.AgentMuxError('Original record owner unavailable', 'EXTERNAL_RECORD_AUTHORITY_UNAVAILABLE'))
  const received = await f.receive({ addressing: 'response' })
  await vi.waitFor(async () => expect((await f.captured())[0]?.item.inputRef?.kind).toBe('message'))
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).ingress).toMatchObject({ group: { recording: { state: 'unavailable' } } })
  const diagnosis = await f.cli(['connection', 'diagnose', '--host', 'local', '--session', 'original-agent', '--binding', f.binding.bindingId])
  expect(diagnosis.groups.value.items[0].incoming.value.rows).toContainEqual(expect.objectContaining({ ingressId: received.ingressId, recording: { state: 'unavailable', code: expect.stringMatching(/^EXTERNAL_RECORD_/) }, coreStatus: 'terminal-confirmed' }))
  record.mockRestore()
  await f.services.ingress!.dispatch(received.ingressId)
  expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).ingress).toMatchObject({ group: { recorded: { ingressId: received.ingressId } } })
  expect(await f.captured()).toHaveLength(1); expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})

it('failed capture enrichment reports an observation error without replacing the real input receipt', async () => {
  const f = await fixture(true), errors: string[] = []
  const subscription = f.client.onEvent(event => { if (event.type === 'agent-error') errors.push(event.code) }); cleanup.push(subscription)
  await f.rpc.call('connection.grant', { operationId: 'grant-member', bindingId: f.binding.bindingId, expectedBindingRevision: 1, grantId: 'member-grant', expectedRevision: null, actor: f.actor, capabilities: ['input'], state: 'active' })
  const apply = f.store.applyTimelineMutation.bind(f.store)
  vi.spyOn(f.store, 'applyTimelineMutation').mockImplementation(async (mutation, signal) => {
    if (mutation.type === 'upsert' && mutation.item.authorExternal) throw new Error('Capture unavailable after input')
    return apply(mutation, signal)
  })
  const received = await f.receive({ addressing: 'response' })
  await vi.waitFor(() => expect(errors).toContain('AGENT_TIMELINE_PERSIST_FAILED'))
  const inspection = await f.services.ingress!.inspect({ ingressId: received.ingressId })
  expect(inspection.inputReceipt?.status).toBe('terminal-confirmed')
  expect(await f.captured()).toHaveLength(1); expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a receiver alias for the same native application cannot create a second record or a publication echo', async () => {
  const f = await fixture()
  await f.rpc.call('connection.configure', { operationId: 'configure-alias', expectedRevision: null, connection: { ...f.config, connectionId: 'receiver-alias' } })
  const received = await f.services.ingress!.receive({ connectionId: 'receiver-alias', ...f.wire.encode(f.message()) }, () => {})
  await f.services.ingress!.dispatch(received.ingress.ingressId)
  expect((await f.captured())[0]?.item.authorExternal).toMatchObject({ connectionId: f.config.connectionId, bindingId: f.binding.bindingId })
  const duplicate = await f.services.ingress!.receive({ connectionId: f.config.connectionId, ...f.wire.encode(f.message({ deliveryKey: 'alias-redelivery' })) }, () => {})
  expect(duplicate.ingress.ingressId).toBe(received.ingress.ingressId)
  await f.services.ingress!.dispatch(duplicate.ingress.ingressId)
  expect(await f.captured()).toHaveLength(1)
  await vi.waitFor(async () => expect((await f.services.publication!.list({ connectionId: f.config.connectionId, bindingId: f.binding.bindingId, bindingRevision: 1 })).coverage?.origins).toHaveLength(1))
  expect(f.wire.effects).toHaveLength(0)
})

it('a visible message and a non-input member grant never authorize Agent execution', async () => {
  const f = await fixture(true)
  await f.rpc.call('connection.grant', { operationId: 'grant-member', bindingId: f.binding.bindingId, expectedBindingRevision: 1, grantId: 'member-grant', expectedRevision: null, actor: f.actor, capabilities: ['answer'], state: 'active' })
  const received = await f.receive({ addressing: 'response' })
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).ingress?.state).toBe('refused'))
  expect(await f.captured()).toHaveLength(1); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).ingress?.code).toBe('INGRESS_ACTOR_NOT_AUTHORIZED')
})


it('messages received during a pause stay outside the resumed conversation', async () => {
  const f = await fixture()
  await f.rpc.call('connection.binding.pause', { operationId: 'pause', bindingId: f.binding.bindingId, expectedRevision: 1 })
  const received = await f.services.ingress!.receive({ connectionId: f.config.connectionId, ...f.wire.encode(f.message()) }, () => {})
  expect(received.ingress).toMatchObject({ group: { target: null } })
  await f.rpc.call('connection.binding.resume', { operationId: 'resume', bindingId: f.binding.bindingId, expectedRevision: 2 })
  await f.services.ingress!.dispatch(received.ingress.ingressId)
  await f.reopen()
  await f.services.ingress!.dispatch(received.ingress.ingressId)
  expect(await f.captured()).toHaveLength(0); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})


it('an input grant does not turn an ordinary unaddressed group message into an Agent request', async () => {
  const f = await fixture(true)
  await f.rpc.call('connection.grant', { operationId: 'grant-member', bindingId: f.binding.bindingId, expectedBindingRevision: 1, grantId: 'member-grant', expectedRevision: null, actor: f.actor, capabilities: ['input'], state: 'active' })
  const received = await f.receive()
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).ingress?.state).toBe('refused'))
  expect(await f.captured()).toHaveLength(1); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.services.ingress!.inspect({ ingressId: received.ingressId })).ingress?.code).toBe('INGRESS_INPUT_OUTSIDE_SCOPE')
})


it('joined group conversation records once, reaches the original Agent and shares new speech with independent audiences without origin echoes', async () => {
  const f = await fixture(true, true)
  const second = { ...f.binding, operationId: 'join-second-group', bindingId: 'second-binding', externalConversationId: 'second-group' }
  // The original owner permits one audience per bot/Agent mapping; use an exact independent identity for the second group.
  const alias = { ...f.config, connectionId: 'second-bot' }
  expect(await f.rpc.call('connection.configure', { operationId: 'configure-second-bot', expectedRevision: null, connection: alias })).toMatchObject({ status: 'configured' })
  expect(await f.rpc.call('connection.bind', { ...second, connectionId: alias.connectionId })).toMatchObject({ state: 'applied' })
  expect(await f.rpc.call('connection.grant', { operationId: 'join-authorize', bindingId: f.binding.bindingId, expectedBindingRevision: 1, grantId: 'join-member', expectedRevision: null, actor: f.actor, capabilities: ['input'], state: 'active' })).toMatchObject({ state: 'applied' })
  const receive = async (deliveryKey: string) => {
    const intake = await f.services.ingress!.receive({ connectionId: f.config.connectionId, ...f.wire.encode(f.message({ deliveryKey, addressing: 'response' })) }, async () => {})
    await f.services.ingress!.dispatch(intake.ingress.ingressId)
  }
  await receive('join-original')
  await vi.waitFor(async () => expect((await f.captured())[0]?.item.inputRef?.kind).toBe('message'), { timeout: 5000 })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  const native = (id: string, text: string) => JSON.stringify({ type: 'assistant', sessionId: 'group-native', uuid: id, message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
  await appendFile(join(f.root, 'native.jsonl'), native('joint-reply', 'Public answer from original Agent'))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.wire.effects.filter(effect => effect.text.includes('Public answer from original Agent')).map(effect => effect.room).sort(), JSON.stringify({ operations: f.services.publication!.store.list({ bindingId: second.bindingId, revision: 1 }), coverage: f.services.publication!.store.coverage({ bindingId: second.bindingId, revision: 1 }), observation: f.services.publication!.observation(second.bindingId, 1) })).toEqual(['native-group', 'second-group']), { timeout: 5000 })
  expect(f.wire.effects.filter(effect => effect.room === 'native-group' && effect.text.includes('Original group message'))).toHaveLength(0)
  expect(f.wire.effects.filter(effect => effect.room === 'second-group' && effect.text.includes('Original group message'))).toHaveLength(1)
  await f.client.submitAgentPrompt({ agentSessionId: 'original-agent', ...core.agentPromptCondition((await f.client.readAgentSession('original-agent'))!), operationId: 'join-local-human', prompt: 'Local human conversation', authorHuman: true, allowUncertainTurn: true })
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.wire.effects.filter(effect => effect.text.includes('Local human conversation')).map(effect => effect.room).sort()).toEqual(['native-group', 'second-group']))
  expect(await f.captured()).toHaveLength(1)
  await receive('join-duplicate')
  expect(await f.captured()).toHaveLength(1)
  expect(f.wire.effects.filter(effect => effect.text.includes('Public answer from original Agent'))).toHaveLength(2)
  const detached = await f.rpc.call('connection.binding.detach', { operationId: 'join-detach-one', bindingId: f.binding.bindingId, expectedRevision: 1 })
  expect(detached).toMatchObject({ state: 'applied', binding: { state: 'detached' } })
  await appendFile(join(f.root, 'native.jsonl'), native('independent-reply', 'Other group keeps working'))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.wire.effects.filter(effect => effect.text.includes('Other group keeps working')).map(effect => effect.room)).toEqual(['second-group']))
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  await f.reopen()
  expect(await f.captured()).toHaveLength(1)
  await vi.waitFor(() => expect(f.wire.effects.filter(effect => effect.text.includes('Public answer from original Agent'))).toHaveLength(2))
}, 30_000)
