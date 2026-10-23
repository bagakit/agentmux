import { appendFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '../../core/src/index.js'
import type { AgentProvider, AgentProviderPreparedNativeInput } from '../../core/src/agent-provider.js'
import { nativeInputCorrelationKey } from '../../core/src/native-input-correlation.js'
import { consumeConversationWindowPage } from '../../core/src/conversation-changes.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { source, turn, user, jsonl } from '../../core/test/helpers/codex-paginated.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createPublicationConversationPort } from '../dist/index.js'
import { context } from './fixtures/room-binding.js'
import { feishuConfig } from './fixtures/feishu.js'
import { feishuPublicationHttp } from './fixtures/feishu-publication.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Adopted relay cleanup failed')
})

/** Original Core, Provider normalizer, Reader and default Host; only native and platform network I/O are controlled. */
async function fixture() {
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
    await appendFile(transcript, jsonl([row]))
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
  const remote = await feishuPublicationHttp(); cleanup.push(remote.close)
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(options => {
    const { params, ...request } = options
    if (params !== undefined && (params === null || typeof params !== 'object')) throw new Error('Expected original SDK query parameters')
    return remote.http.request({ ...request, ...(params === undefined ? {} : { params }) })
  })
  const services = await createConnectionServices({ directory: join(h.root, 'relay-host'),
    bindings: { spatial, checkpoint: reference => h.client.conversationCheckpoint(reference) }, publication: createPublicationConversationPort(h.coreClients) })
  cleanup.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'relay-secret', secret: 'private-fixture-credential' })
  await services.connections.configure({ operationId: 'relay-configuration', expectedRevision: null, connection: { ...feishuConfig, credentialRef: credential.credentialRef } })
  const bound = await services.connections.bindings!.bind({ operationId: 'shared-original-source', bindingId: 'shared-binding', connectionId: feishuConfig.connectionId,
    expectedConnectionRevision: 1, executionHostId: ref.hostId, agentSessionId: ref.agentSessionId, regionAnchor: { regionId: 'original-region' },
    externalConversationId: 'original-room', expectedSource: source, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } }, context)
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw new Error('The explicit fresh shared Binding did not apply')
  const server = new core.AgentMuxControlServer({ socketPath: join(h.root, 'relay.sock'), connections: services.connections, spatialState: spatial, coreClients: h.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  return { ...h, session, ref, send, services, remote, rpc, binding: bound.binding, socketPath: server.path }
}

it('the original native input claim adopts canonical records and relays only the captured public span through the default Host, official SDK and compiled CLI', async () => {
  const f = await fixture(), body = '  Same public input 中文🙂\nEvery original line is retained.  ', privateContext = 'Private generated amux system context'
  const keys = ['first-original-input', 'second-original-input'].map(submissionId => ({ kind: 'prompt' as const, agentSessionId: f.ref.agentSessionId, expectedRun: f.session.run, submissionId }))
  for (const [index, key] of keys.entries()) {
    await f.client.submitAgentPrompt({ agentSessionId: key.agentSessionId, expectedRun: key.expectedRun, operationId: key.submissionId,
      admissionIntent: { kind: 'native-conversation', source }, execution: 'immediate', prompt: body, agentMuxNote: privateContext, ...(index === 0 ? { authorHuman: true } : {}) })
    await expect.poll(async () => (await f.client.inspectAgentInput({ key }))?.status).toBe('admitted')
  }
  // No test constructs adoptedInput: the built-in Provider and exact durable claim must produce it.
  // Input admission and the original captured history append have separate completion points.
  await expect.poll(async () => (await f.client.sessionTimeline(f.ref.agentSessionId)).items.filter(item => item.kind === 'user_message')).toHaveLength(2)
  const page = await f.client.readAgentConversation(f.ref), read = consumeConversationWindowPage(page)
  expect(read.kind).toBe('complete'); if (read.kind !== 'complete') throw new Error('The actual original Reader window is incomplete')
  const messages = read.snapshot.units.filter(unit => unit.event.role === 'message')
  expect(messages).toHaveLength(2)
  expect(read.snapshot.units.filter(unit => unit.event.role === 'notice')).toHaveLength(2)
  const acceptedKeys = []
  for (const unit of messages) {
    expect(unit.records).toHaveLength(2)
    const native = unit.records.find(record => record.original.kind === 'native')!, captured = unit.records.find(record => record.original.kind === 'captured')!
    expect(unit.event.anchorId).toBe(native.id)
    if (captured.original.kind !== 'captured') throw new Error('The original captured sibling is missing')
    const key = captured.original.item.inputRef
    acceptedKeys.push(key)
    expect(keys).toContainEqual(key)
    expect(native.original.kind === 'native' && native.original.item).toMatchObject({ kind: 'user-message', conversation: { nativeInput: { source, turnId: turn }, adoptedInput: { key } } })
    expect(captured.original.item).toMatchObject({ content: body, publicContent: 'confirmed' })
    expect(unit.event.author).toEqual(key?.kind === 'prompt' && key.submissionId === keys[0]!.submissionId ? { kind: 'human' } : { kind: 'unknown' })
  }
  expect(acceptedKeys).toEqual(expect.arrayContaining(keys))
  expect(new Set(f.send.mock.calls.map(([, plan]) => plan.clientCorrelation)).size).toBe(2)
  expect(f.send.mock.calls.every(([prompt]) => prompt.includes(privateContext) && prompt.includes(body))).toBe(true)
  f.services.publication!.refresh()
  await vi.waitFor(() => {
    const operations = f.services.publication!.store.list(f.binding)
    expect(operations).toHaveLength(2)
    expect(operations.every(operation => operation.state === 'confirmed')).toBe(true)
  }, { timeout: 10_000 })
  const operations = f.services.publication!.store.list(f.binding), posts = f.remote.messageCalls().filter(call => call.method === 'POST')
  // These are actual SDK/Axios loopback wire bytes, rather than only a DTO or prepared-request spy.
  expect(posts).toHaveLength(2)
  expect(JSON.stringify(posts)).not.toContain(privateContext)
  const rendered = []
  for (const call of posts) {
    const wire = JSON.parse(call.body), card = JSON.parse(wire.content)
    expect(wire.receive_id).toBe(f.binding.externalConversationId)
    expect(wire.msg_type).toBe('interactive')
    rendered.push(card.elements.map((element: { text: { content: string } }) => element.text.content).join('\n'))
  }
  expect(rendered).toEqual(expect.arrayContaining(['Human user · via amux\n' + body, 'Unknown author · via amux\n' + body]))
  const coverage = await f.rpc.call('connection.delivery.ls', { connectionId: f.binding.connectionId, bindingId: f.binding.bindingId, bindingRevision: f.binding.revision })
  expect(coverage.coverage!.gaps.filter(gap => gap.part?.record.source.kind === 'native')).toHaveLength(2)
  expect(coverage.coverage!.gaps.every(gap => gap.reason === 'public-content-unconfirmed')).toBe(true)
  expect(operations.map(operation => operation.relay!.sources[0]!.author)).toEqual(expect.arrayContaining([{ kind: 'human' }, { kind: 'unknown' }]))
  for (const operation of operations) {
    const observed = await f.rpc.call('connection.delivery.inspect', { operationId: operation.operationId })
    const output = await runCompiledObjectCli(['--endpoint', 'unix:' + f.socketPath, 'connection', 'delivery', 'inspect', '--operation-id', operation.operationId], objectCliEnvironment(f.root))
    expect(output.code, output.stderr).toBe(0)
    expect(JSON.parse(output.stdout).result).toEqual(observed)
    expect(observed.delivery!.state).toBe('confirmed')
    expect(observed.delivery!.relay).toMatchObject({ sender: 'application', sources: [{ author: operation.relay!.sources[0]!.author,
      part: { record: { hostId: f.ref.hostId, agentSessionId: f.ref.agentSessionId, source: { kind: 'captured' } }, selector: { kind: 'captured-field', field: 'content' } } }] })
    expect(posts.map(call => call.body)).toContain(operation.prepared!.request.body)
    expect(JSON.stringify(observed)).not.toMatch(/Private generated|private-fixture-credential|clientCorrelation|fixture-native-protocol/)
  }
  expect(f.send).toHaveBeenCalledTimes(2)
  expect(f.client.agentSession(f.ref.agentSessionId).run).toEqual(f.session.run)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
}, 25_000)
