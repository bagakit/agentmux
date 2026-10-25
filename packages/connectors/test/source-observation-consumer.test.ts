import { appendFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import * as core from '../../core/src/index.js'
import type { ConversationObservation } from '../../core/src/conversation.js'
import { jsonl, nativeHistoryFixture } from '../../core/test/fixtures/native-history-session.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { agentPromptCondition } from '../../core/src/agent-prompt-condition.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createBuiltinConnectionAdapters } from '../src/index.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { feishuConfig } from './fixtures/feishu.js'
import { feishuPublicationHttp } from './fixtures/feishu-publication.js'

// A real OS watcher is retained. Only its failure/availability is controlled;
// Provider bytes, observation pool, original cursors and public readers are real.
const watched = vi.hoisted(() => ({ handles: [] as import('node:fs').FSWatcher[], unavailable: false, failOnOpen: false }))
vi.mock('node:fs', async originalImport => {
  const original = await originalImport<typeof import('node:fs')>()
  return { ...original, watch: (...args: Parameters<typeof original.watch>) => {
    if (watched.unavailable) throw Object.assign(new Error('Controlled watcher IO failure'), { code: 'EIO' })
    const handle = original.watch(...args); watched.handles.push(handle)
    if (watched.failOnOpen) queueMicrotask(() => handle.emit('error', Object.assign(new Error('Controlled opening watcher IO failure'), { code: 'EIO' })))
    return handle
  } }
})
const closes: Array<() => unknown | Promise<unknown>> = [], facts: unknown[] = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  watched.handles = []; watched.unavailable = false; watched.failOnOpen = false; vi.restoreAllMocks(); vi.unstubAllEnvs()
})
afterAll(async () => { if (process.env.AGENTMUX_TEST_SOURCE_OBSERVATION_FACTS) await writeFile(process.env.AGENTMUX_TEST_SOURCE_OBSERVATION_FACTS, JSON.stringify(facts, null, 2) + '\n') })
const claudeRow = (id: string, text = id, sessionId = 'native-main') => ({ uuid: id, type: 'assistant', sessionId, message: { role: 'assistant', content: [{ type: 'text', text }] } })
async function publicReader(f: { root: string; client: core.AgentMuxClient }) {
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'source.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const cli = async (args: string[], input?: unknown) => {
    const output = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, ...args], objectCliEnvironment(f.root), input === undefined ? '' : JSON.stringify(input))
    expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result
  }
  return { server, rpc, cli }
}

for (const provider of ['claude', 'pi'] as const) it(`${provider}: real watcher failure preserves the original cut across public readers and reacquisition`, async () => {
  const row = (id: string, parent: string | null) => provider === 'claude' ? claudeRow(id)
    : { id, type: 'message', parentId: parent, message: { role: 'assistant', content: [{ type: 'text', text: id }] } }
  const f = await nativeHistoryFixture(provider, root => jsonl([
    ...(provider === 'pi' ? [{ type: 'session', version: 3, id: 'native-main', cwd: root }] : []), row('before', null)
  ])); closes.push(f.close)
  const metadata = await f.store.loadMetadata(), { rpc, cli } = await publicReader(f)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const cut = await rpc.call('agent.conversation.checkpoint', ref)
  expect((await cli(['agent', 'conversation', 'checkpoint', '--host', ref.hostId, '--session', ref.agentSessionId])).checkpoint).toEqual(cut.checkpoint)
  const events: ConversationObservation[] = []
  const sub = await rpc.subscribe('agent.conversation.watch', ref, { onInitial() {}, onEvent: event => { if (event.type === 'snapshot') events.push(event.data) } }); closes.push(() => sub.dispose())
  expect(watched.handles).toHaveLength(1)
  watched.handles[0]!.emit('error', Object.assign(new Error('Controlled watcher IO failure'), { code: 'EIO' }))
  await vi.waitFor(() => expect(events.some(event => event.kind === 'unavailable')).toBe(true))
  await appendFile(f.path, jsonl([row('after', 'before')]))
  const input = { ...ref, checkpoint: cut.checkpoint, limit: 30 }
  const page = await rpc.call('agent.conversation.changes', input)
  expect(page.coverage.find(value => value.source.kind === 'native')).toMatchObject({ current: 'complete-through-cut', gaps: [] })
  expect(page.items.length).toBeGreaterThan(0)
  const cliPage = await cli(['agent', 'conversation', 'changes', '--input', '-'], input)
  expect(cliPage.items).toEqual(page.items); expect(cliPage.checkpoint).toEqual(page.checkpoint)
  const renewed: ConversationObservation[] = []
  const second = await rpc.subscribe('agent.conversation.watch', { ...ref, view: page.window.view! }, { onInitial: opening => expect(opening.scope).toEqual(cut.checkpoint.frontier.scope), onEvent: event => { if (event.type === 'snapshot') renewed.push(event.data) } }); closes.push(() => second.dispose())
  expect(watched.handles).toHaveLength(2)
  await appendFile(f.path, jsonl([row('later', 'after')]))
  await vi.waitFor(() => expect(renewed.some(event => event.kind === 'invalidated' && event.source.kind === 'native')).toBe(true))
  const resumed = await rpc.call('agent.conversation.changes', { ...ref, checkpoint: page.checkpoint })
  expect(resumed.coverage.find(value => value.source.kind === 'native')).toMatchObject({ current: 'complete-through-cut', gaps: [] })
  expect(resumed.items.length).toBeGreaterThan(0)
  expect(await f.store.loadMetadata()).toEqual(metadata)
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
  const codes = events.filter(event => event.kind === 'unavailable').map(event => event.code)
  facts.push({ case: provider, codes, originalCut: cut.checkpoint, continuedCut: page.checkpoint, resumedCut: resumed.checkpoint,
    originalMetadataUnchanged: true, runtimeControlCalls: 0, actualWatchers: watched.handles.length, strictRpcAndCompiledCliMatched: true, counts: [page.items.length, resumed.items.length] })
  expect(codes).toEqual(['AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE'])
})

it('opening retains the real watcher failure when acquisition closes before returning its handle', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([claudeRow('before')])); closes.push(f.close)
  const { rpc } = await publicReader(f), ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const cut = await rpc.call('agent.conversation.checkpoint', ref)
  watched.failOnOpen = true
  let opening: unknown
  const events: ConversationObservation[] = []
  const sub = await rpc.subscribe('agent.conversation.watch', ref, { onInitial: value => { opening = value }, onEvent: event => { if (event.type === 'snapshot') events.push(event.data) } }); closes.push(() => sub.dispose())
  watched.failOnOpen = false
  await appendFile(f.path, jsonl([claudeRow('after')]))
  const page = await rpc.call('agent.conversation.changes', { ...ref, checkpoint: cut.checkpoint })
  expect(page.coverage.find(value => value.source.kind === 'native')).toMatchObject({ current: 'complete-through-cut', gaps: [] })
  expect(page.items.length).toBeGreaterThan(0)
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
  facts.push({ case: 'opening-failure', opening, events, sameOriginalCutReadable: true, runtimeControlCalls: 0 })
  expect(opening).toMatchObject({ coverage: expect.arrayContaining([expect.objectContaining({ source: expect.objectContaining({ kind: 'native' }),
    current: 'unavailable', gaps: [expect.objectContaining({ code: 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE' })] })]) })
})

for (const change of ['replacement', 'truncation'] as const) it(`real native ${change} still rejects its original cut`, async () => {
  const f = await nativeHistoryFixture('claude', jsonl([claudeRow('before')])); closes.push(f.close)
  const { rpc } = await publicReader(f), ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const cut = await rpc.call('agent.conversation.checkpoint', ref), events: ConversationObservation[] = []
  const sub = await rpc.subscribe('agent.conversation.watch', ref, { onInitial() {}, onEvent: event => { if (event.type === 'snapshot') events.push(event.data) } }); closes.push(() => sub.dispose())
  if (change === 'replacement') { await rename(f.path, f.path + '.original'); await writeFile(f.path, jsonl([claudeRow('replacement')])) }
  else await writeFile(f.path, '')
  await vi.waitFor(() => expect(events.some(event => event.kind === 'unavailable' && event.code === 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')).toBe(true))
  const page = await rpc.call('agent.conversation.changes', { ...ref, checkpoint: cut.checkpoint })
  expect(page.coverage.find(value => value.source.kind === 'native')).toMatchObject({ current: 'unavailable', gaps: [expect.objectContaining({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })] })
  expect(page.checkpoint.frontier.cuts.find(value => value.kind === 'native')).toEqual(cut.checkpoint.frontier.cuts.find(value => value.kind === 'native'))
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
  facts.push({ case: change, originalCutRejected: true, originalNativeCutRetained: true, runtimeControlCalls: 0 })
})

it('default PublicationHost preserves watch failure while independent input delivers, then recovers the original binding through SDK and CLI', async () => {
  // Runtime byte transport is the existing deterministic rpcOwnerFixture seam;
  // actual Core input admission/recording, builtin Provider and default Host/SDK run.
  const f = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'claude', executorId: 'claude',
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-main', transcriptPath: join(root, 'native.jsonl') } })); closes.push(f.close)
  const path = join(f.root, 'native.jsonl'); await writeFile(path, jsonl([claudeRow('before')]))
  const ref = { hostId: 'local', agentSessionId: 'original-agent' }, originalRun = f.client.agentSession(ref.agentSessionId).run
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: f.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'tab', kind: 'agent', agentSessionId: ref.agentSessionId, runId: null, execution: { hostId: 'local', cwd: f.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } }, resources: {}
  } })
  const remote = await feishuPublicationHttp(); closes.push(remote.close)
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(options => {
    const { params, ...request } = options
    if (params !== undefined && (params === null || typeof params !== 'object')) throw Error('Expected original SDK query parameters')
    return remote.http.request({ ...request, ...(params === undefined ? {} : { params }) })
  })
  const services = await createConnectionServices({ directory: join(f.root, 'host'), adapters: createBuiltinConnectionAdapters(),
    bindings: { spatial, checkpoint: input => f.client.conversationCheckpoint(input) }, publication: createPublicationConversationPort(f.coreClients) }); closes.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'credential', secret: 'private-fixture-credential' })
  await services.connections.configure({ operationId: 'configure', expectedRevision: null, connection: { ...feishuConfig, credentialRef: credential.credentialRef } })
  const bound = await services.connections.bindings!.bind({ operationId: 'original-cut', bindingId: 'original-binding', connectionId: feishuConfig.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: ref.agentSessionId, regionAnchor: { regionId: 'original-region' },
    externalConversationId: 'original-room', expectedSource: { providerId: 'claude', nativeSessionId: 'native-main' }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } }, { actor: { kind: 'user', id: 'original-user' } })
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw Error('Original binding was not applied')
  const binding = structuredClone(bound.binding), host = services.publication!
  const list = () => host.list({ connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision })
  await vi.waitFor(async () => expect((await list()).sourceObservation?.state).toBe('ready'))
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'publication.sock'), connections: services.connections, spatialState: spatial, coreClients: f.coreClients })
  await server.start(); closes.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  watched.unavailable = true
  for (const watcher of [...watched.handles]) watcher.emit('error', Object.assign(new Error('Controlled watcher IO failure'), { code: 'EIO' }))
  await vi.waitFor(async () => expect((await list()).sourceObservation?.state).toBe('unavailable'))
  const failed = (await list()).sourceObservation
  const text = 'Independent authorized input while native observation is unavailable'
  await f.client.submitAgentPrompt({ ...agentPromptCondition(f.client.agentSession(ref.agentSessionId)), agentSessionId: ref.agentSessionId,
    operationId: 'independent-input', prompt: text, authorHuman: true, allowUncertainTurn: true })
  host.refresh()
  await vi.waitFor(() => expect(host.store.list(binding).some(operation => operation.payload.kind === 'speech' && operation.payload.text.includes(text) && operation.state === 'confirmed')).toBe(true), { timeout: 8000 })
  const afterIndependentInput = (await list()).sourceObservation
  facts.push({ case: 'default-host-independent-input', sourceObservation: afterIndependentInput, inputConfirmed: true,
    originalRunUnchanged: JSON.stringify(f.client.agentSession(ref.agentSessionId).run) === JSON.stringify(originalRun) })
  expect(afterIndependentInput).toMatchObject({ state: 'unavailable', code: 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE' })
  const report = await rpc.call('connection.diagnose', { executionHostId: 'local', agentSessionId: ref.agentSessionId })
  const source = report.groups.value!.items[0]!.outgoing.value!.sourceObservation
  expect(source).toMatchObject({ state: 'unavailable', code: 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE', codeRecorded: true })
  const output = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'diagnose', '--host', 'local', '--session', ref.agentSessionId], objectCliEnvironment(f.root))
  expect(output.code, output.stdout + output.stderr).toBe(0)
  expect(JSON.parse(output.stdout).result.groups.value.items[0].outgoing.value.sourceObservation).toEqual(source)
  expect(JSON.stringify(report)).not.toContain('Controlled watcher IO failure')
  watched.unavailable = false; host.refresh()
  await vi.waitFor(async () => expect((await list()).sourceObservation?.state).toBe('ready'), { timeout: 8000 })
  await appendFile(path, jsonl([claudeRow('after-recovery', 'Native reply after original observation recovery')]))
  await vi.waitFor(() => expect(host.store.list(binding).some(operation => operation.reference.source.kind === 'native' && operation.reference.source.recordId === 'after-recovery' && operation.state === 'confirmed')).toBe(true), { timeout: 8000 })
  expect(host.store.list(binding).filter(operation => operation.payload.kind === 'speech' && operation.payload.text.includes(text))).toHaveLength(1)
  expect(f.client.agentSession(ref.agentSessionId).run).toEqual(originalRun)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect(f.inner.kernel.input).toHaveBeenCalled()
  expect((await services.connections.bindings!.list({ connectionId: binding.connectionId })).bindings[0]).toEqual(binding)
  facts.push({ case: 'default-host', failed, publicSourceObservation: source, independentInputConfirmed: true, originalRun,
    originalBindingUnchanged: true, reacquiredObservationReady: true, nativeReplyConfirmed: true, actualWatchers: watched.handles.length,
    capturedCopies: 1, sdkMessageWrites: remote.messageCalls().filter(call => call.method === 'POST').length,
    boundary: 'Runtime byte I/O uses the existing deterministic port; remote platform uses SDK HTTP loopback. No live old binding repair is claimed.' })
})
