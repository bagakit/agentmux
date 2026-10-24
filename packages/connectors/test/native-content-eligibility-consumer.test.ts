import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { appendFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { PublicationStore } from '../dist/publication-store.js'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '../../core/dist/index.js'
import * as conversation from '../../core/dist/conversation.js'
import type { ConnectionDeliveryGap } from '../../core/dist/connections.js'
import { publicationContent } from '../dist/publication-content.js'
import { PublicationHost } from '../dist/publication-host.js'
import { ConnectionSecrets } from '../dist/connection-secrets.js'
import type { ResolvedPublicationPart } from '../dist/publication-resource.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { agentPromptCondition } from '../../core/src/agent-prompt-condition.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createBuiltinConnectionAdapters, createPublicationConversationPort } from '../dist/index.js'
import { context } from './fixtures/room-binding.js'
import { feishuConfig } from './fixtures/feishu.js'
import { feishuPublicationHttp } from './fixtures/feishu-publication.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const closes: Array<() => unknown | Promise<unknown>> = []
const contentOperations = (store: PublicationStore, ...args: Parameters<PublicationStore['list']>) =>
  store.list(...args).filter(operation => operation.payload.kind !== 'binding-lifecycle')
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of closes.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Native content consumer cleanup failed')
})
const source = { providerId: 'codex', nativeSessionId: 'original-native-content' }
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
const response = (id: string, role: string, text: string) => ({ type: 'response_item', payload: {
  id, type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }]
} })
async function fixture(providerId: 'codex' | 'claude' | 'droid' = 'codex') {
  const nativeSource = { ...source, providerId }
  const original = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId, executorId: providerId,
    nativeHandle: { kind: 'provider', providerId, sessionId: source.nativeSessionId, transcriptPath: join(root, 'native.jsonl') } }))
  closes.push(original.close)
  const transcript = join(original.root, 'native.jsonl')
  await writeFile(transcript, providerId === 'codex' ? jsonl([{ type: 'session_meta', payload: { id: source.nativeSessionId, cwd: original.root, history_mode: 'paginated' } }]) : providerId === 'droid' ? jsonl([{ type: 'session_start', id: source.nativeSessionId }]) : '')
  const spatial = new core.AgentMuxSpatialStateStore(join(original.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: original.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: original.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: original.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } }, resources: {}
  } })
  const remote = await feishuPublicationHttp(); closes.push(remote.close)
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(options => {
    const { params, ...request } = options
    if (params !== undefined && (params === null || typeof params !== 'object')) throw new Error('Expected original SDK query parameters')
    return remote.http.request({ ...request, ...(params === undefined ? {} : { params }) })
  })
  const port = createPublicationConversationPort(original.coreClients)
  const adapters = createBuiltinConnectionAdapters(), adapter = adapters.find(adapter => adapter.adapterId === 'feishu')!
  let credentialReadable = true
  const originalCredential = ConnectionSecrets.prototype.resolve
  vi.spyOn(ConnectionSecrets.prototype, 'resolve').mockImplementation(function (reference) {
    return credentialReadable ? originalCredential.call(this, reference) : Promise.resolve(null)
  })
  let activeServices: Awaited<ReturnType<typeof createConnectionServices>>
  const openServices = async () => activeServices = await createConnectionServices({ directory: join(original.root, 'host'), adapters,
    bindings: { spatial, checkpoint: ref => original.client.conversationCheckpoint(ref) }, publication: port })
  const services = await openServices()
  closes.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'original-credential', secret: 'private-fixture-credential' })
  await services.connections.configure({ operationId: 'original-config', expectedRevision: null, connection: { ...feishuConfig, credentialRef: credential.credentialRef } })
  const bound = await services.connections.bindings!.bind({ operationId: 'original-shared-cut', bindingId: 'original-binding', connectionId: feishuConfig.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'original-region' },
    externalConversationId: 'original-room', expectedSource: nativeSource, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } }, context)
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw new Error('Original shared Binding not applied')
  const server = new core.AgentMuxControlServer({ socketPath: join(original.root, 'content.sock'), connections: services.connections, spatialState: spatial, coreClients: original.coreClients })
  await server.start(); closes.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const cli = async (args: string[], input?: unknown) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, ...args], objectCliEnvironment(original.root), input === undefined ? '' : JSON.stringify(input))
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  return { ...original, transcript, spatial, remote, services, rpc, cli, port, nativeSource, adapter, openServices, credentials: (readable: boolean) => { credentialReadable = readable }, binding: bound.binding,
    ref: { hostId: 'local', agentSessionId: 'original-agent' }, posts: () => remote.messageCalls().filter(call => call.method === 'POST' &&
      contentOperations(activeServices.publication!.store, bound.binding, 100).some(operation => operation.prepared?.request.body === call.body)) }
}

it('current native coverage failure leaves an independently confirmed App user message publishable', async () => {
  const f = await fixture('claude'), text = 'A confirmed App message while native history is temporarily unreadable'
  const provider = (f.client as unknown as { providers: core.AgentProviderRegistry }).providers.get('claude')
  const nativeChanges = provider.readConversationChanges!.bind(provider)
  const read = vi.spyOn(provider, 'readConversationChanges').mockImplementation(input => input.after !== undefined
    ? Promise.reject(new core.AgentMuxError('PRIVATE native details', 'AGENT_SESSION_HISTORY_TIMEOUT')) : nativeChanges(input))
  await f.client.submitAgentPrompt({ ...agentPromptCondition(f.client.agentSession(f.ref.agentSessionId)), agentSessionId: f.ref.agentSessionId,
    operationId: 'independent-public-input-during-native-gap', prompt: text, authorHuman: true, allowUncertainTurn: true })
  f.services.publication!.refresh()
  await vi.waitFor(async () => {
    expect(JSON.stringify(f.posts())).toContain(text)
    const page = await f.services.publication!.list({ connectionId: f.binding.connectionId, bindingId: f.binding.bindingId, bindingRevision: f.binding.revision })
    expect(page.sourceObservation).toMatchObject({ state: 'unavailable', code: 'AGENT_SESSION_HISTORY_TIMEOUT' })
    expect(contentOperations(f.services.publication!.store, f.binding)).toMatchObject([{ state: 'confirmed' }])
  }, { timeout: 8_000 })
  expect(read).toHaveBeenCalled()
  const report = await f.rpc.call('connection.diagnose', { executionHostId: f.ref.hostId, agentSessionId: f.ref.agentSessionId })
  expect(report.groups.value!.items[0]!.outgoing.value!.sourceObservation).toMatchObject({ state: 'unavailable', code: 'AGENT_SESSION_HISTORY_TIMEOUT' })
  expect(JSON.stringify(report)).not.toContain('PRIVATE native details')
  expect(f.client.agentSession(f.ref.agentSessionId).run).toEqual({ runId: 'run-original-agent' })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('original saved context and native input copies stay locally complete while the default Host publishes only independent allowed content', async () => {
  const f = await fixture(), privateContext = 'Private generated context sentinel', publicInput = '  Exact public input 中文🙂\nAll original spacing remains.  '
  const mixed = privateContext + '\n\n' + publicInput
  await appendFile(f.transcript, jsonl([
    response('raw-user-copy', 'user', mixed),
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: source.nativeSessionId, turn_id: 'original-turn',
      item: { type: 'UserMessage', id: 'canonical-input', content: [{ type: 'text', text: mixed }] } } },
    { type: 'event_msg', payload: { type: 'user_message', message: mixed } },
    response('original-developer-context', 'developer', privateContext), response('original-system-context', 'system', privateContext),
    response('original-agent-reply', 'assistant', 'Independent public Agent reply'),
    { type: 'response_item', payload: { id: 'opaque-assistant-content', type: 'message', role: 'assistant', content: { secret: 'Opaque original native envelope' } } },
    { type: 'response_item', payload: { id: 'opaque-assistant-block', type: 'message', role: 'assistant', content: [{ type: 'unrecognized', secret: 'Opaque original native envelope' }] } },
    { type: 'response_item', payload: { id: 'opaque-reasoning', type: 'reasoning', summary: [{ type: 'unrecognized', secret: 'Opaque original native envelope' }] } },
    { type: 'response_item', payload: { id: 'original-tool-result', type: 'function_call_output', call_id: 'original-call', output: 'Independent permitted tool output' } }
  ]))
  await f.client.submitAgentPrompt({ ...agentPromptCondition(f.client.agentSession(f.ref.agentSessionId)), agentSessionId: f.ref.agentSessionId,
    operationId: 'original-public-input', prompt: publicInput, agentMuxNote: privateContext, authorHuman: true, allowUncertainTurn: true })
  f.services.publication!.refresh()
  await vi.waitFor(() => {
    const operations = contentOperations(f.services.publication!.store, f.binding)
    expect(operations.some(operation => operation.relay && operation.state === 'confirmed')).toBe(true)
    expect(operations.every(operation => operation.state === 'confirmed')).toBe(true)
  }, { timeout: 10_000 })
  expect(f.posts().length).toBeGreaterThan(0)
  expect(JSON.stringify(f.posts())).not.toContain(privateContext)
  expect(JSON.stringify(f.posts())).not.toContain('Opaque original native envelope')
  expect(JSON.stringify(f.posts())).toContain('Independent public Agent reply')
  expect(JSON.stringify(f.posts())).not.toContain('Independent permitted tool output')
  const page = await f.rpc.call('agent.conversation.inspect', f.ref), assembled = core.consumeConversationWindowPage(page)
  expect(assembled.kind).toBe('complete'); if (assembled.kind !== 'complete') throw new Error('Original source window incomplete')
  const native = assembled.snapshot.units.flatMap(unit => unit.records).filter(record => record.original.kind === 'native')
  expect(native).toHaveLength(10)
  expect(JSON.stringify(native)).toContain(privateContext); expect(JSON.stringify(native)).toContain('Opaque original native envelope')
  const cliWindow = core.consumeConversationWindowPage(await f.cli(['agent', 'conversation', 'inspect', '--input', '-'], f.ref))
  expect(cliWindow.kind).toBe('complete'); if (cliWindow.kind === 'complete') expect(cliWindow.snapshot.units).toEqual(assembled.snapshot.units)
  const listed = await f.rpc.call('connection.delivery.ls', { connectionId: f.binding.connectionId, bindingId: f.binding.bindingId, bindingRevision: f.binding.revision })
  expect(listed.coverage!.gaps.length).toBeGreaterThan(0)
  expect(await f.cli(['connection', 'delivery', 'ls', '--connection', f.binding.connectionId, '--binding', f.binding.bindingId, '--binding-revision', String(f.binding.revision)])).toEqual(listed)
  const agent = native.find(record => record.original.kind === 'native' && record.original.item.id === 'original-agent-reply')!
  const exactInput = { ...f.ref, record: agent.reference! }
  const exact = await f.rpc.call('agent.conversation.inspect', exactInput), exactWindow = core.consumeConversationWindowPage(exact)
  expect(exactWindow.kind).toBe('complete'); if (exactWindow.kind === 'complete') expect(exactWindow.snapshot.units.flatMap(unit => unit.records).map(record => record.reference)).toEqual([agent.reference])
  const cliExact = core.consumeConversationWindowPage(await f.cli(['agent', 'conversation', 'inspect', '--input', '-'], exactInput))
  expect(cliExact.kind).toBe('complete'); if (exactWindow.kind === 'complete' && cliExact.kind === 'complete') expect(cliExact.snapshot.units).toEqual(exactWindow.snapshot.units)
  await expect(f.rpc.call('agent.conversation.inspect', { ...exactInput, record: { ...agent.reference!, hostId: 'foreign-original-host' } })).rejects.toBeDefined()
  const originalSource = agent.reference!.source
  if (originalSource.kind !== 'native') throw new Error('Expected original native source')
  await expect(f.rpc.call('agent.conversation.inspect', { ...exactInput, record: { ...agent.reference!, source: { ...originalSource, nativeSessionId: 'foreign-native' } } })).rejects.toBeDefined()
  expect(() => conversation.parseConversationTimelineReadInput({ ...exactInput, anchor: exact.window.anchor })).toThrow()
  const oldAnchor = { ...exact.window.anchor!, revision: '0'.repeat(64) }
  const unavailable = await f.rpc.call('agent.conversation.inspect', { ...f.ref, anchor: oldAnchor })
  expect(unavailable.items).toEqual([]); expect(unavailable.coverage.flatMap(value => value.gaps).some(gap => gap.code === 'AGENT_CONVERSATION_VERSION_UNAVAILABLE')).toBe(true)
  const rawInput = { ...f.ref, source: 'native' as const }, raw = await f.rpc.call('agent.history', rawInput)
  const corrupt = structuredClone(raw), row = corrupt.items.find(value => value.kind === 'item')!
  if (row.kind === 'item') (row.item as core.AgentSessionHistoryItem).contentParts[0]!.contentEligibility = 'visible' as never
  expect(() => conversation.parseAgentSessionHistoryReadPage(corrupt, rawInput)).toThrow()
  expect(conversation.parseAgentSessionHistoryReadPage(raw, rawInput)).toEqual(raw)
  // A nonempty exact record cannot discard its anchor and smuggle another original through fragments.
  const foreign = assembled.snapshot.units.find(unit => unit.records.some(record => record.original.kind === 'native' && record.original.item.id === 'raw-user-copy'))!
  const foreignBytes = Buffer.from(JSON.stringify(foreign))
  const forged = structuredClone(exact); delete forged.window.anchor
  forged.items = [{ kind: 'fragment', itemId: foreign.event.id, encoding: 'json-utf8-base64', sha256: createHash('sha256').update(foreignBytes).digest('hex'), offsetBytes: 0, totalBytes: foreignBytes.length, dataBase64: foreignBytes.toString('base64') }]
  vi.spyOn(f.client, 'readAgentConversation').mockResolvedValueOnce(forged)
  await expect(f.rpc.call('agent.conversation.inspect', exactInput)).rejects.toHaveProperty('code', 'CONTROL_PROTOCOL_ERROR')
  expect(f.client.agentSession(f.ref.agentSessionId).run).toEqual({ runId: 'run-original-agent' })
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(2)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
}, 25_000)

it.each(['claude'] as const)('%s mixed native tool results cannot qualify adjacent user or generated context', async provider => {
  const f = await fixture(provider), hidden = 'Unqualified mixed native user context', tool = 'Independent mixed typed tool result', answer = 'Original independent Agent answer'
  const blocks = [{ type: 'text', text: hidden }, { type: 'tool_result', tool_use_id: 'original-tool', content: tool }]
  const record = (id: string, role: string, content: unknown, extra: Record<string, unknown> = {}) => provider === 'claude'
    ? { sessionId: source.nativeSessionId, uuid: id, type: role, message: { role, content }, ...extra }
    : { session_id: source.nativeSessionId, id, type: 'message', message: { role, content, ...extra } }
  await appendFile(f.transcript, jsonl([
    record('mixed-tool', 'user', blocks, provider === 'claude' ? { toolUseResult: { original: true } } : {}),
    record('mixed-tool-no-marker', 'user', blocks),
    record('generated-tool', 'assistant', blocks, provider === 'claude' ? { isCompactSummary: true } : { visibility: 'llm_only' }),
    record('generated-unknown', 'assistant', hidden, provider === 'claude' ? { isSynthetic: true } : { visibility: 'llm_only' }),
    record('allowed-agent', 'assistant', answer)
  ]))
  f.services.publication!.refresh()
  await vi.waitFor(() => {
    const operations = contentOperations(f.services.publication!.store, f.binding)
    expect(operations).toHaveLength(1); expect(operations.every(operation => operation.state === 'confirmed')).toBe(true)
  }, { timeout: 10_000 })
  expect(JSON.stringify(f.posts())).not.toContain(hidden)
  expect(JSON.stringify(f.posts())).not.toContain(tool); expect(JSON.stringify(f.posts())).toContain(answer)
  const read = core.consumeConversationWindowPage(await f.rpc.call('agent.conversation.inspect', f.ref))
  expect(read.kind).toBe('complete'); if (read.kind !== 'complete') throw new Error('Original native mixed window incomplete')
  const originals = read.snapshot.units.flatMap(unit => unit.records).filter(value => value.original.kind === 'native')
  const mixed = originals.find(value => value.original.kind === 'native' && value.original.item.id === 'mixed-tool')!
  expect(mixed.original.kind).toBe('native'); if (mixed.original.kind !== 'native') throw new Error('Original mixed record missing')
  expect(mixed.original.item.contentParts.map(part => part.contentEligibility)).toEqual(['unconfirmed', 'public'])
  const noMarker = originals.find(value => value.original.kind === 'native' && value.original.item.id === 'mixed-tool-no-marker')!
  if (noMarker.original.kind !== 'native') throw new Error('Original unmarked native mixed record missing')
  expect(noMarker.original.item.kind).toBe('user-message'); expect(noMarker.original.item.contentParts.map(part => part.contentEligibility)).toEqual(['unconfirmed', 'public'])
  expect(JSON.stringify(originals)).toContain(hidden)
  expect(f.services.publication!.store.coverage(f.binding).gaps.some(gap => gap.reason === 'public-content-unconfirmed')).toBe(true)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('Claude typed API error containers stay locally complete without publishing their body or wrapped tool output', async () => {
  const f = await fixture('claude'), hidden = 'Private API error canary', hiddenTool = 'Private wrapped API error tool canary'
  const falseReply = 'Independent Agent reply with a false API marker', absentReply = 'Independent Agent reply without an API marker'
  const failedTool = 'Ordinary failed tool output remains available', reference = 'data:image/png;base64,cGlj'
  const record = (uuid: string, role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
    sessionId: source.nativeSessionId, uuid, type: role, message: { role, content }, ...extra
  })
  const errorContent = [{ type: 'text', text: hidden }, { type: 'tool_result', tool_use_id: 'wrapped-error-tool', content: hiddenTool }]
  await appendFile(f.transcript, jsonl([
    record('original-api-error', 'assistant', errorContent, { isApiErrorMessage: true, error: 'unknown', apiErrorStatus: 400, user_message_uuid: 'original-api-error-turn',
      message: { role: 'assistant', model: '<synthetic>', content: errorContent, usage: { input_tokens: 5, output_tokens: 2 } } }),
    record('original-api-error-resource', 'assistant', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cGlj' } }], { isApiErrorMessage: true }),
    record('ordinary-false-marker', 'assistant', falseReply, { isApiErrorMessage: false, apiErrorStatus: 400 }),
    record('ordinary-absent-marker', 'assistant', absentReply),
    record('ordinary-failed-tool', 'user', [{ type: 'tool_result', tool_use_id: 'ordinary-failed-call', content: failedTool, is_error: true }])
  ]))
  f.services.publication!.refresh()
  await vi.waitFor(() => {
    const wire = JSON.stringify(f.posts())
    expect(wire).toContain(falseReply); expect(wire).toContain(absentReply)
    expect(contentOperations(f.services.publication!.store, f.binding).every(operation => operation.state === 'confirmed')).toBe(true)
  }, { timeout: 10_000 })
  // This assertion reaches actual SDK HTTP message bodies, not merely an internal projection.
  expect(JSON.stringify(f.posts())).not.toContain(hidden)
  expect(JSON.stringify(f.posts())).not.toContain(hiddenTool)
  expect(JSON.stringify(f.posts())).not.toContain(failedTool)
  const read = core.consumeConversationWindowPage(await f.rpc.call('agent.conversation.inspect', f.ref))
  expect(read.kind).toBe('complete'); if (read.kind !== 'complete') throw new Error('Original Claude error window incomplete')
  const originals = read.snapshot.units.flatMap(unit => unit.records).filter(record => record.original.kind === 'native')
  const error = originals.find(record => record.original.kind === 'native' && record.original.item.id === 'original-api-error')!
  if (error.original.kind !== 'native') throw new Error('Original API error record missing')
  expect(error.original.item).toMatchObject({ id: 'original-api-error', kind: 'activity', turnId: 'original-api-error-turn',
    metrics: { scope: 'response', usage: { inputTokens: 5, outputTokens: 2 } } })
  expect(error.original.item.contentParts).toEqual([
    { kind: 'text', text: hidden, contentEligibility: 'unconfirmed' },
    { kind: 'tool-result', callId: 'wrapped-error-tool', output: hiddenTool, contentEligibility: 'unconfirmed' }
  ])
  const resource = originals.find(record => record.original.kind === 'native' && record.original.item.id === 'original-api-error-resource')!
  if (resource.original.kind !== 'native') throw new Error('Original API error resource missing')
  expect(resource.original.item.contentParts).toEqual([{ kind: 'resource', resourceType: 'image', reference, contentEligibility: 'unconfirmed' }])
  const listed = await f.cli(['connection', 'delivery', 'ls', '--connection', f.binding.connectionId, '--binding', f.binding.bindingId,
    '--binding-revision', String(f.binding.revision)])
  expect(listed.coverage).toMatchObject({ state: 'complete', gaps: [] })
  expect(f.client.agentSession(f.ref.agentSessionId).run).toEqual({ runId: 'run-original-agent' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('the actual Droid Reader preserves deferred tool purpose before common publication resource resolution', async () => {
  const f = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'droid', executorId: 'droid',
    nativeHandle: { kind: 'provider', providerId: 'droid', sessionId: source.nativeSessionId, transcriptPath: join(root, 'droid.jsonl') } }))
  closes.push(f.close)
  const ref = { hostId: 'local', agentSessionId: 'original-agent' }, nativeSource = { ...source, providerId: 'droid' }
  const port = createPublicationConversationPort(f.coreClients), readResource = vi.spyOn(port, 'resource')
  const allowed = 'Original Droid assistant speech', hidden = ['Raw tool input canary', 'Tool metadata canary', 'Reasoning metadata canary', 'Raw reasoning canary']
  const toolMetadata = (hidden[1] + ' ').repeat(125000)
  await writeFile(join(f.root, 'droid.jsonl'), jsonl([{ type: 'session_start', id: source.nativeSessionId },
    { type: 'message', id: 'droid-mixed-assistant', message: { role: 'assistant', content: [
      { type: 'text', text: allowed },
      { type: 'tool_use', id: 'original-tool', name: 'image_tool', input: hidden[0], thought_signature: toolMetadata },
      { type: 'thinking', thinking: hidden[3], signature: hidden[2] },
      { type: 'tool_result', tool_use_id: 'original-tool', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cGlj' } }] }
    ] } }]))
  const page = await f.client.readAgentConversation(ref), local = core.consumeConversationWindowPage(page)
  expect(local.kind).toBe('complete'); if (local.kind !== 'complete') throw new Error('Original Droid mixed conversation incomplete')
  const binding = { scope: { publication: 'future-shared-conversation' } } as never
  const adapter = createBuiltinConnectionAdapters().find(adapter => adapter.adapterId === 'feishu')!.publication!
  // Droid has no incremental source capability. Exercise its actual Reader and the production resolver without inventing a live Binding.
  const resolved: Map<string, ResolvedPublicationPart> = await Reflect.get(PublicationHost.prototype, 'resolve').call(
    { options: { conversation: port } }, ref, local.snapshot.units, new AbortController().signal, binding, adapter)
  const plans = local.snapshot.units.map(unit => publicationContent(unit, binding, page.window.checkpoint, { resolved, origin: () => undefined }))
  expect(plans.map(plan => plan.text).join('\n')).toContain(allowed)
  expect(readResource).not.toHaveBeenCalled()
  for (const value of hidden) expect(JSON.stringify(plans)).not.toContain(value)
  expect(plans.flatMap(plan => plan.gaps)).toEqual([])
  for (const value of [hidden[0], hidden[2], hidden[3]]) expect(JSON.stringify(local.snapshot.units)).toContain(value)
  expect(JSON.stringify(local.snapshot.units)).toContain('data:image/png;base64,cGlj')
  const original = local.snapshot.units.flatMap(unit => unit.records).find(record => record.original.kind === 'native' && record.original.item.id === 'droid-mixed-assistant')!
  if (original.original.kind !== 'native') throw new Error('Original Droid mixed record missing')
  const partIndex = original.original.item.contentParts.findIndex(part => part.kind === 'resource' && part.resourceType === 'text' && part.contentRole === 'tool')
  expect(partIndex).toBeGreaterThanOrEqual(0)
  const part = original.original.item.contentParts[partIndex]!
  if (part.kind !== 'resource') throw new Error('Original deferred tool metadata missing')
  const complete = await core.readSessionHistoryTextResource(part, partIndex, { source: nativeSource, recordId: original.original.item.id }, input => f.client.sessionHistoryResource(ref.agentSessionId, input))
  expect(complete).toMatchObject({ kind: 'text', contentRole: 'tool' })
  expect(JSON.stringify(complete)).toContain(toolMetadata)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('unattributed Hook snapshots remain local while canonical speech and confirmed human content are shared', async () => {
  const f = await fixture('claude'), providers = new core.AgentProviderRegistry()
  const hidden = 'Unconfirmed Hook failure canary', privateBody = 'Private captured body canary'
  const normal = 'Independent normal Stop reply', other = 'Independent other Provider reply'
  const tool = 'Independent marked item tool output', user = 'Original confirmed captured user input'
  const hook = async (providerId: 'claude' | 'cursor', eventName: string, receiptId: string, payload: Record<string, unknown>) => {
    const normalized = providers.get(providerId).normalizeHook({ receiptId, agentSessionId: f.ref.agentSessionId,
      runId: 'run-original-agent', providerId, eventName, payload: { session_id: source.nativeSessionId, ...payload } }, {})
    for (const mutation of normalized.timeline) await f.store.applyTimelineMutation(mutation)
    return normalized.timeline
  }
  const failure = await hook('claude', 'StopFailure', 'original-failure-hook', { error: 'unknown', last_assistant_message: hidden })
  const captured = failure.find(mutation => mutation.type !== 'update' && mutation.item.kind === 'assistant_message')
  if (!captured || captured.type === 'update') throw new Error('Original Hook assistant record missing')
  await f.store.applyTimelineMutation({ type: 'update', agentSessionId: f.ref.agentSessionId, itemId: captured.item.id,
    updatedAt: captured.item.updatedAt + 1, content: hidden + '\nOriginal updated diagnostic' })
  await hook('claude', 'Stop', 'original-normal-stop', { last_assistant_message: normal })
  await hook('cursor', 'afterAgentResponse', 'original-other-provider', { text: other, conversation_id: source.nativeSessionId })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.ref.agentSessionId, item: {
    id: 'private-body-with-tool', agentSessionId: f.ref.agentSessionId, kind: 'tool_call', source: 'native-hook',
    status: 'complete', title: 'Original independent tool', content: privateBody, contentEligibility: 'private', toolOutput: tool,
    createdAt: captured.item.createdAt, updatedAt: captured.item.updatedAt
  } })
  await appendFile(f.transcript, jsonl([{ sessionId: source.nativeSessionId, uuid: 'independent-native-hook-sibling',
    type: 'assistant', message: { role: 'assistant', content: 'Independent native public reply beside captured failure' } }]))
  await f.client.submitAgentPrompt({ ...agentPromptCondition(f.client.agentSession(f.ref.agentSessionId)), agentSessionId: f.ref.agentSessionId,
    operationId: 'original-hook-positive-input', prompt: user, authorHuman: true, allowUncertainTurn: true })
  f.services.publication!.refresh()
  await vi.waitFor(() => {
    const wire = JSON.stringify(f.remote.messageCalls())
    for (const text of [user, 'Independent native public reply beside captured failure']) expect(wire).toContain(text)
    for (const text of [normal, other]) expect(wire).not.toContain(text)
    expect(contentOperations(f.services.publication!.store, f.binding).every(operation => operation.state === 'confirmed')).toBe(true)
  }, { timeout: 10_000 })
  const wire = JSON.stringify(f.remote.messageCalls())
  expect(wire).not.toContain(hidden); expect(wire).not.toContain(privateBody); expect(wire).not.toContain(tool)
  const reopened = new core.AgentMuxFileAgentSessionStore(join(f.root, 'sessions.json'))
  const saved = (await reopened.loadTimeline(f.ref.agentSessionId)).items.find(item => item.id === captured.item.id)
  expect(saved).toMatchObject({ content: hidden + '\nOriginal updated diagnostic', contentEligibility: 'unconfirmed' })
  const read = core.consumeConversationWindowPage(await f.rpc.call('agent.conversation.inspect', f.ref))
  expect(read.kind).toBe('complete'); if (read.kind !== 'complete') throw new Error('Original Hook conversation incomplete')
  const original = read.snapshot.units.flatMap(unit => unit.records).find(record => record.original.kind === 'captured' && record.original.item.id === captured.item.id)
  expect(original?.original).toMatchObject({ kind: 'captured', item: saved })
  const delivery = await f.cli(['connection', 'delivery', 'ls', '--connection', f.binding.connectionId, '--binding', f.binding.bindingId, '--binding-revision', String(f.binding.revision)])
  expect(delivery.coverage.gaps.some((gap: ConnectionDeliveryGap) =>
    gap.part?.record.source.kind === 'captured' && gap.part.record.source.recordId === captured.item.id &&
    gap.part.selector.kind === 'captured-field' && gap.part.selector.field === 'content')).toBe(false)
  expect(delivery.coverage.gaps.some((gap: ConnectionDeliveryGap) => gap.part?.record.source.kind === 'captured' && gap.part.record.source.recordId === 'private-body-with-tool')).toBe(false)
  expect(f.client.agentSession(f.ref.agentSessionId).run).toEqual({ runId: 'run-original-agent' })
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(2); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)

it('known model context is an accounted scope exclusion rather than a permanent synchronization failure', async () => {
  const f = await fixture()
  const privateResource = vi.spyOn(f.port, 'resource'), privateText = 'Private model context only '.repeat(90000)
  await appendFile(f.transcript, jsonl([response('system-private-only', 'system', privateText), response('developer-private-only', 'developer', 'Private developer context only')]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.observation(f.binding.bindingId, f.binding.revision)).toEqual({ state: 'ready' }), { timeout: 10_000 })
  expect(f.posts()).toEqual([]); expect(f.services.publication!.store.coverage(f.binding)).toMatchObject({ state: 'complete', gaps: [] })
  const scopes = f.services.database!.prepare("SELECT decision_json FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind')='scope'").all()
  expect(scopes.map(row => JSON.parse(String(row.decision_json))).flatMap(row => row.excluded)).toHaveLength(2)
  expect(privateResource).not.toHaveBeenCalled()
  const page = await f.rpc.call('agent.conversation.inspect', f.ref), read = core.consumeConversationWindowPage(page)
  if (read.kind !== 'complete') throw new Error('Original private window incomplete')
  const unit = read.snapshot.units.find(unit => unit.records.some(record => record.original.kind === 'native' && record.original.item.id === 'system-private-only'))!
  const original = unit.records.find(record => record.original.kind === 'native')!
  if (original.original.kind !== 'native') throw new Error('Original private resource missing')
  expect(original.original.item.contentParts[0]).toMatchObject({ kind: 'resource', resourceType: 'text', contentEligibility: 'private' })
  const part = original.original.item.contentParts[0]!
  if (part.kind !== 'resource') throw new Error('Original deferred private part required')
  const complete = await core.readSessionHistoryTextResource(part, 0, { source: f.nativeSource, recordId: 'system-private-only' }, input => f.client.sessionHistoryResource(f.ref.agentSessionId, input))
  expect(complete).toEqual({ kind: 'text', text: privateText, contentEligibility: 'private' })
  const resolved = new Map([[JSON.stringify([core.conversationRecordId(original.reference!), { kind: 'native-part', partIndex: 0 }]), { kind: 'text' as const, text: 'Resolved body cannot upgrade purpose', contentEligibility: 'public' as const }]])
  const plan = publicationContent(unit, f.binding, page.window.checkpoint, { resolved, origin: () => undefined })
  expect(plan.text).toBe(''); expect(plan.gaps).toEqual([]); expect(plan.excluded).toHaveLength(1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 15_000)

it('the physical OpenCode mixed record preserves separate original part purposes through the common Reader', async () => {
  const original = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'opencode', executorId: 'opencode',
    nativeHandle: { kind: 'provider', providerId: 'opencode', sessionId: 'original-mixed-native', transcriptPath: join(root, 'original.db') } }))
  closes.push(original.close)
  const db = new DatabaseSync(join(original.root, 'original.db'))
  db.exec(`CREATE TABLE session(id TEXT, directory TEXT,title TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);`)
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('original-mixed-native', original.root, 'Original', 1, 1)
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('mixed-record', 'original-mixed-native', 1, 1, JSON.stringify({ role: 'assistant' }))
  const parts = [{ type: 'text', text: 'Allowed original mixed answer' }, { type: 'text', text: 'Unknown synthetic mixed context', synthetic: true },
    { type: 'text', text: 'Unknown ignored mixed context', ignored: true }, { type: 'compaction' },
    { type: 'tool', tool: 'original-tool', callID: 'original-call', state: { status: 'completed', input: 'original argument', output: 'Allowed original mixed tool' } }]
  for (const [index, part] of parts.entries()) db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('part-' + index, 'mixed-record', 'original-mixed-native', index, index, JSON.stringify(part))
  db.close()
  const page = await original.client.readAgentConversation({ hostId: 'local', agentSessionId: 'original-agent' }), consumed = core.consumeConversationWindowPage(page)
  expect(consumed.kind).toBe('complete'); if (consumed.kind !== 'complete') throw new Error('Original SQLite window incomplete')
  const unit = consumed.snapshot.units.find(unit => unit.records.some(record => record.original.kind === 'native' && record.original.item.id === 'mixed-record'))!
  const record = unit.records.find(record => record.original.kind === 'native')!
  if (record.original.kind !== 'native') throw new Error('Original SQLite record missing')
  expect(record.original.item.contentParts.map(part => part.contentEligibility)).toEqual(['public', 'unconfirmed', 'unconfirmed', 'private', 'public', 'public'])
  expect(JSON.stringify(record.original)).toContain('Unknown synthetic mixed context')
  const plan = publicationContent(unit, { scope: { publication: 'future-shared-conversation' } } as never, page.window.checkpoint, { resolved: new Map(), origin: () => undefined })
  expect(plan.text).toContain('Allowed original mixed answer'); expect(plan.text).not.toContain('Allowed original mixed tool')
  expect(plan.text).not.toContain('Unknown'); expect(plan.excluded).toHaveLength(3); expect(plan.gaps).toHaveLength(2)
  expect(original.inner.kernel.input).not.toHaveBeenCalled(); expect(original.inner.kernel.stop).not.toHaveBeenCalled()
})

it('accepted native part evidence survives a Host restart and more than one bounded drain without exact-record capability', async () => {
  const f = await fixture('claude'), original = 'Original public page-only reply '.repeat(2500)
  f.credentials(false)
  await appendFile(f.transcript, jsonl([{ sessionId: source.nativeSessionId, uuid: 'page-only-original', type: 'assistant', message: { role: 'assistant', content: original } }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => {
    const operations = contentOperations(f.services.publication!.store, f.binding, 100)
    expect(operations.length).toBeGreaterThan(16); expect(operations.every(operation => operation.state === 'pending')).toBe(true)
  }, { timeout: 10_000 })
  const before = contentOperations(f.services.publication!.store, f.binding, 100).map(operation => operation.operationId)
  const inspect = vi.spyOn(f.port, 'inspect').mockRejectedValue(new core.AgentMuxError('Original page-only Provider has no exact-record lookup.', 'AGENT_SESSION_HISTORY_RECORD_UNSUPPORTED'))
  f.services.close(); f.credentials(true)
  const restarted = await f.openServices(); closes.push(() => restarted.close())
  await vi.waitFor(() => {
    const operations = contentOperations(restarted.publication!.store, f.binding, 100)
    expect(operations.map(operation => operation.operationId)).toEqual(before)
    expect(operations.every(operation => !['pending', 'dispatching'].includes(operation.state))).toBe(true)
  }, { timeout: 15_000 })
  expect(contentOperations(restarted.publication!.store, f.binding, 100).every(operation => operation.state === 'confirmed')).toBe(true)
  expect(f.posts()).toHaveLength(before.length); expect(inspect).not.toHaveBeenCalled()
  expect([...f.remote.records.values()].map(record => String(record.body && (record.body as { content: string }).content)).join('')).toContain('Original public page-only')
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)

it('an old never-claimed private pending request is cancelled precisely while another allowed original request continues', async () => {
  const f = await fixture(), hidden = 'Old frozen private model input', allowed = 'Independent queued public reply'
  f.credentials(false)
  await appendFile(f.transcript, jsonl([response('old-pending-record', 'assistant', hidden), response('independent-pending-record', 'assistant', allowed)]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(contentOperations(f.services.publication!.store, f.binding)).toHaveLength(2), { timeout: 10_000 })
  f.services.publication!.close()
  const pending = contentOperations(f.services.publication!.store, f.binding), old = pending.find(operation => operation.reference.source.kind === 'native' && operation.reference.source.recordId === 'old-pending-record')!
  expect(old.state).toBe('pending'); expect(old.attempt).toBeUndefined()
  // Restore the original pre-qualification decision shape. The native record and frozen request keep their exact identities.
  for (const row of f.services.database!.prepare("SELECT rowid,decision_json FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind')='representation' AND json_extract(decision_json,'$.projectionId')=?").all(old.projectionId)) {
    const value = JSON.parse(String(row.decision_json)); delete value.contentEligibility; delete value.purpose
    f.services.database!.prepare('UPDATE connector_publication_decision SET decision_json=? WHERE rowid=?').run(JSON.stringify(value), Number(row.rowid))
  }
  await writeFile(f.transcript, jsonl([{ type: 'session_meta', payload: { id: source.nativeSessionId, cwd: f.root, history_mode: 'paginated' } },
    response('old-pending-record', 'developer', hidden), response('independent-pending-record', 'assistant', allowed)]))
  f.services.close(); f.credentials(true)
  const active = await f.openServices(); closes.push(() => active.close())
  await vi.waitFor(() => expect(active.publication!.store.inspect(old.operationId)?.state).not.toBe('pending'), { timeout: 10_000 })
  expect(active.publication!.store.inspect(old.operationId)).toMatchObject({ state: 'cancelled', reason: 'private-content' })
  await vi.waitFor(() => expect(active.publication!.store.inspect(pending.find(value => value.operationId !== old.operationId)!.operationId)?.state).toBe('confirmed'), { timeout: 10_000 })
  expect(JSON.stringify(f.posts())).not.toContain(hidden); expect(JSON.stringify(f.posts())).toContain(allowed)
  expect(await active.connections.delivery!.inspect({ operationId: old.operationId }, context)).toMatchObject({ delivery: { operationId: old.operationId, state: 'cancelled', reason: 'private-content' } })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('an old mixed frozen representation recovers ordinary conversation after excluding its public tool part', async () => {
  const f = await fixture('claude'), hidden = 'Old public tool output stays local', allowed = 'Original ordinary reply survives cancellation'
  f.credentials(false)
  let active = f.services
  await appendFile(f.transcript, jsonl([{ sessionId: source.nativeSessionId, uuid: 'old-mixed', type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: allowed }, { type: 'tool_result', tool_use_id: 'old-tool', content: hidden }
  ] } }]))
  const captured = core.agentTimelineMutationFromAcpEvent(f.ref.agentSessionId, { type: 'activity', operation: 'append', activityId: 'same-event-captured-public',
    kind: 'assistant_message', status: 'complete', title: 'Original captured output', content: 'Allowed original captured contribution survives cancellation' },
  { source: 'acp', acpAdapterId: 'original-acp-adapter', acpSessionId: 'original-acp-session', run: { runId: 'run-original-agent' }, observedAt: _historyFixtureEpoch(0, 0, 1) })
  if (!captured || captured.type === 'update') throw Error('Original ACP assistant contribution required')
  await f.store.applyTimelineMutation({ ...captured, item: { ...captured.item, conversation: { sameEvent: {
    ...f.ref, source: { kind: 'native', providerId: 'claude', nativeSessionId: source.nativeSessionId, recordId: 'old-mixed' } } } } })
  active.publication!.refresh()
  await vi.waitFor(() => {
    const pending = contentOperations(active.publication!.store, f.binding).filter(value => value.state === 'pending')
    expect(pending).toHaveLength(1)
    expect(active.database!.prepare("SELECT rowid FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind')='representation' AND json_extract(decision_json,'$.projectionId')=? AND json_extract(decision_json,'$.part.record.source.kind')='captured'").all(pending[0]!.projectionId)).toHaveLength(1)
  }, { timeout: 10_000 })
  active.publication!.close()
  const old = contentOperations(active.publication!.store, f.binding).find(value => value.state === 'pending')!, db = active.database!
  expect(old.attempt).toBeUndefined()
  const read = core.consumeConversationWindowPage(await f.rpc.call('agent.conversation.inspect', f.ref))
  if (read.kind !== 'complete') throw new Error('Original mixed window incomplete')
  const unit = read.snapshot.units.find(unit => unit.records.some(record => record.original.kind === 'native' && record.original.item.id === 'old-mixed'))!
  const record = unit.records.find(record => record.original.kind === 'native')!
  const originalRow = db.prepare("SELECT rowid,record_id,decision_json FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind')='representation' AND json_extract(decision_json,'$.projectionId')=? AND json_extract(decision_json,'$.part.record.source.kind')='native'").get(old.projectionId)!
  const allowedPiece = JSON.parse(String(originalRow.decision_json)); delete allowedPiece.purpose
  const unqualifiedPiece = { ...allowedPiece, part: { record: record.reference, recordRevision: record.revision, selector: { kind: 'native-part', partIndex: 1 } }, text: hidden }
  const privateKey = JSON.stringify([core.conversationRecordId(record.reference!), unqualifiedPiece.part.selector])
  const privateId = 'part-' + createHash('sha256').update(JSON.stringify(privateKey)).digest('base64url')
  db.prepare('UPDATE connector_publication_decision SET record_id=?,decision_json=? WHERE rowid=?').run(privateId, JSON.stringify(unqualifiedPiece), Number(originalRow.rowid))
  db.prepare('INSERT INTO connector_publication_decision(binding_id,binding_revision,source_key,record_id,source_revision,reason,decision_json) VALUES(?,?,?,?,?,?,?)')
    .run(f.binding.bindingId, f.binding.revision, 'unified', String(originalRow.record_id), 'current', 'content-accounted', JSON.stringify(allowedPiece))
  expect(unit.records.some(value => value.original.kind === 'captured' && value.original.item.id === captured.item.id)).toBe(true)
  const restoredRows = db.prepare("SELECT decision_json FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind')='representation' AND json_extract(decision_json,'$.projectionId')=? ORDER BY rowid").all(old.projectionId)
  const payload = { kind: 'speech', text: restoredRows.map(row => JSON.parse(String(row.decision_json)).text).join('\n\n') }
  const encoded = JSON.stringify(payload, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)
  const restored = { ...old, sourceRevision: createHash('sha256').update(encoded).digest('base64url'), payload }
  db.prepare('UPDATE connector_publication_operation SET source_revision=?,operation_json=? WHERE operation_id=?').run(restored.sourceRevision, JSON.stringify(restored), old.operationId)
  active.close(); f.credentials(true); active = await f.openServices(); closes.push(() => active.close())
  await vi.waitFor(() => expect(active.publication!.store.inspect(old.operationId)).toMatchObject({ state: 'cancelled', reason: 'outside-conversation-scope' }), { timeout: 10_000 })
  const accounted = active.database!.prepare("SELECT decision_json FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind')='gap'").all().map(row => JSON.parse(String(row.decision_json)).gap) as ConnectionDeliveryGap[]
  expect(accounted.find(gap => gap.reason === 'version-unavailable' && gap.part?.selector.kind === 'native-part' && gap.part.selector.partIndex === 0)?.anchor).toBeDefined()
  expect(accounted.find(gap => gap.reason === 'version-unavailable' && gap.part?.record.source.kind === 'captured')?.anchor).toBeDefined()
  // The original owner uses its existing exact recoverPart path; no new input or transcript append.
  active.publication!.refresh()
  await vi.waitFor(() => expect(contentOperations(active.publication!.store, f.binding).some(operation => operation.state === 'confirmed')).toBe(true), { timeout: 10_000 })
  await vi.waitFor(() => expect(JSON.stringify(f.remote.messageCalls())).toContain('Allowed original captured contribution survives cancellation'), { timeout: 10_000 })
  expect(JSON.stringify(f.remote.messageCalls())).toContain(allowed); expect(JSON.stringify(f.remote.messageCalls())).not.toContain(hidden)
  expect(active.publication!.store.inspect(old.operationId)?.state).toBe('cancelled')
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)

it.each(['dispatching', 'unknown'] as const)('%s original effects are inspected without reading new qualification or replaying prepared bytes', async state => {
  const f = await fixture(), text = 'Original possibly applied public reply'
  f.credentials(false)
  await appendFile(f.transcript, jsonl([response('effect-original', 'assistant', text)])); f.services.publication!.refresh()
  await vi.waitFor(() => expect(contentOperations(f.services.publication!.store, f.binding)).toHaveLength(1), { timeout: 10_000 })
  for (const row of f.services.database!.prepare("SELECT rowid,decision_json FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind')='representation'").all()) {
    const value = JSON.parse(String(row.decision_json)); delete value.contentEligibility
    f.services.database!.prepare('UPDATE connector_publication_decision SET decision_json=? WHERE rowid=?').run(JSON.stringify(value), Number(row.rowid))
  }
  const prepared = f.services.publication!.store.claimNext(f.binding, f.services.publication!.store.next(f.binding)?.operationId ?? '', () => true, f.adapter.publication!)!
  if (state === 'unknown') f.services.publication!.store.settle(prepared.operationId, prepared.attempt!, { state: 'unknown', reason: 'effect-unconfirmed' })
  const inspect = vi.spyOn(f.port, 'inspect'), platformInspect = vi.spyOn(f.adapter.publication!, 'inspect')
  f.credentials(true); f.services.publication!.refresh()
  await vi.waitFor(() => expect(platformInspect).toHaveBeenCalled(), { timeout: 10_000 })
  expect(inspect).not.toHaveBeenCalled(); expect(f.posts()).toEqual([])
  expect(f.services.publication!.store.inspect(prepared.operationId)).toMatchObject({ operationId: prepared.operationId, attempt: prepared.attempt, prepared: prepared.prepared, state: 'unknown' })
  expect(contentOperations(f.services.publication!.store, f.binding)).toHaveLength(1)
}, 20_000)

it('the original Droid Reader assigns a mixed user tool block separately before the common publication consumer', async () => {
  const original = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'droid', executorId: 'droid',
    nativeHandle: { kind: 'provider', providerId: 'droid', sessionId: source.nativeSessionId, transcriptPath: join(root, 'droid.jsonl') } }))
  closes.push(original.close)
  await writeFile(join(original.root, 'droid.jsonl'), jsonl([{ type: 'session_start', id: source.nativeSessionId },
    { type: 'message', id: 'droid-mixed', message: { role: 'user', content: [{ type: 'text', text: 'Unknown Droid user context' },
      { type: 'tool_result', tool_use_id: 'droid-tool', content: 'Allowed Droid typed result' }] } },
    { type: 'message', id: 'droid-public-user', message: { role: 'user', visibility: 'user_only', content: [{ type: 'text', text: 'Original visible Droid user message' }] } },
    { type: 'message', id: 'droid-pure-image', message: { role: 'assistant', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cGlj' } }] } },
    { type: 'message', id: 'droid-private', message: { role: 'assistant', visibility: 'llm_only', content: [{ type: 'text', text: 'Private Droid context' },
      { type: 'tool_result', tool_use_id: 'droid-hidden-tool', content: 'Private Droid hidden result' }] } },
    { type: 'message', id: 'droid-unknown-block', message: { role: 'assistant', content: [{ type: 'unrecognized', secret: 'Unknown Droid opaque block' }, 42] } },
    { type: 'message', id: 'droid-unknown-content', message: { role: 'assistant', content: { secret: 'Unknown Droid opaque content' } } },
    { type: 'message', id: 'droid-private-unknown', message: { role: 'assistant', visibility: 'llm_only', content: { secret: 'Private Droid opaque content' } } }]))
  const page = await original.client.readAgentConversation({ hostId: 'local', agentSessionId: 'original-agent' }), read = core.consumeConversationWindowPage(page)
  if (read.kind !== 'complete') throw new Error('Original Droid window incomplete')
  const plans = read.snapshot.units.map(unit => publicationContent(unit, { scope: { publication: 'future-shared-conversation' } } as never, page.window.checkpoint, { resolved: new Map(), origin: () => undefined }))
  const text = plans.map(plan => plan.text).join('\n')
  expect(text).not.toContain('Allowed Droid typed result'); expect(text).not.toContain('Unknown Droid'); expect(text).not.toContain('Private Droid')
  expect(text).not.toContain('Original visible Droid user message')
  const items = read.snapshot.units.flatMap(unit => unit.records).flatMap(record => record.original.kind === 'native' ? [record.original.item] : [])
  expect(items.find(item => item.id === 'droid-mixed')?.contentParts.map(part => part.contentEligibility)).toEqual(['unconfirmed', 'public'])
  expect(items.find(item => item.id === 'droid-public-user')).toMatchObject({ kind: 'activity', contentParts: [{ kind: 'text', contentEligibility: 'public' }] })
  expect(items.find(item => item.id === 'droid-pure-image')).toMatchObject({ kind: 'assistant-message', contentParts: [{ kind: 'resource', contentEligibility: 'public', resourceType: 'image' }] })
  expect(items.find(item => item.id === 'droid-private')?.contentParts.map(part => part.contentEligibility)).toEqual(['private', 'private'])
  expect(JSON.stringify(items)).toContain('Private Droid hidden result')
  expect(text).not.toContain('Unknown Droid opaque'); expect(text).not.toContain('Private Droid opaque')
  expect(items.find(item => item.id === 'droid-unknown-block')?.contentParts.map(part => part.contentEligibility)).toEqual(['unconfirmed', 'unconfirmed'])
  expect(items.find(item => item.id === 'droid-unknown-content')?.contentParts.map(part => part.contentEligibility)).toEqual(['unconfirmed'])
  expect(items.find(item => item.id === 'droid-private-unknown')?.contentParts.map(part => part.contentEligibility)).toEqual(['private'])
  expect(JSON.stringify(items)).toContain('Unknown Droid opaque content'); expect(JSON.stringify(items)).toContain('Unknown Droid opaque block')
  expect(original.inner.kernel.input).not.toHaveBeenCalled(); expect(original.inner.kernel.stop).not.toHaveBeenCalled()
})

it('an old native pending record without eligibility or exact-reader support leaves a precise gap without blocking another qualified reply', async () => {
  const f = await fixture()
  f.credentials(false)
  await appendFile(f.transcript, jsonl([response('old-unknown-source', 'assistant', 'Old unconfirmed source body'), response('new-known-source', 'assistant', 'New independently qualified source body')]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(contentOperations(f.services.publication!.store, f.binding)).toHaveLength(2), { timeout: 10_000 })
  f.services.publication!.close()
  const old = contentOperations(f.services.publication!.store, f.binding).find(value => value.reference.source.kind === 'native' && value.reference.source.recordId === 'old-unknown-source')!
  expect(old.attempt).toBeUndefined()
  for (const row of f.services.database!.prepare("SELECT rowid,decision_json FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind')='representation' AND json_extract(decision_json,'$.projectionId')=?").all(old.projectionId)) {
    const value = JSON.parse(String(row.decision_json)); delete value.contentEligibility
    f.services.database!.prepare('UPDATE connector_publication_decision SET decision_json=? WHERE rowid=?').run(JSON.stringify(value), Number(row.rowid))
  }
  vi.spyOn(f.port, 'inspect').mockRejectedValue(new core.AgentMuxError('Original Provider cannot read the exact old record.', 'AGENT_SESSION_HISTORY_RECORD_UNSUPPORTED'))
  // Restart retains the saved cut without replaying the previous temporary accepted window as a new fact.
  f.services.close(); f.credentials(true)
  const restarted = await f.openServices(); closes.push(() => restarted.close())
  await vi.waitFor(() => expect(contentOperations(restarted.publication!.store, f.binding).some(value => value.state === 'confirmed')).toBe(true), { timeout: 10_000 })
  expect(restarted.publication!.store.inspect(old.operationId)).toMatchObject({ state: 'cancelled', reason: 'version-unavailable' })
  expect(restarted.publication!.store.coverage(f.binding).gaps.some(gap => gap.reason === 'version-unavailable' && gap.part?.record.source.recordId === 'old-unknown-source' && gap.anchor)).toBe(true)
  expect(JSON.stringify(f.posts())).not.toContain('Old unconfirmed source body'); expect(JSON.stringify(f.posts())).toContain('New independently qualified source body')
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
}, 20_000)

it('an exact old record can assemble more than a fixed count of small legal fragments before one original effect', async () => {
  const f = await fixture()
  f.credentials(false)
  await appendFile(f.transcript, jsonl([response('small-fragment-original', 'assistant', 'Original public small fragment message')]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(contentOperations(f.services.publication!.store, f.binding)).toHaveLength(1), { timeout: 10_000 })
  f.services.publication!.close()
  const old = contentOperations(f.services.publication!.store, f.binding)[0]!
  expect(old.attempt).toBeUndefined()
  if (old.reference.source.kind !== 'native') throw new Error('Original native reference required')
  const reference = { hostId: old.reference.hostId, agentSessionId: old.reference.agentSessionId, source: old.reference.source }
  const page = await f.client.readAgentConversation({ ...f.ref, record: reference, maxBytes: 128 * 1024 }), read = core.consumeConversationWindowPage(page)
  if (read.kind !== 'complete' || read.snapshot.units.length !== 1) throw new Error('Original exact Core unit required')
  const bytes = Buffer.from(JSON.stringify(read.snapshot.units[0]!)), sha256 = createHash('sha256').update(bytes).digest('hex')
  expect(bytes.length).toBeGreaterThan(1024)
  for (const row of f.services.database!.prepare("SELECT rowid,decision_json FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind')='representation'").all()) {
    const value = JSON.parse(String(row.decision_json)); delete value.contentEligibility
    f.services.database!.prepare('UPDATE connector_publication_decision SET decision_json=? WHERE rowid=?').run(JSON.stringify(value), Number(row.rowid))
  }
  f.services.close()
  let offset = 0
  const inspect = vi.spyOn(f.port, 'inspect').mockImplementation(async input => {
    expect(input.record).toEqual(reference); expect(input.cursor).toBe(offset ? 'part-' + offset : undefined)
    const start = offset++, complete = offset === bytes.length
    return { ...page, items: [{ kind: 'fragment', itemId: read.snapshot.units[0]!.event.id, encoding: 'json-utf8-base64',
      sha256, offsetBytes: start, totalBytes: bytes.length, dataBase64: bytes.subarray(start, offset).toString('base64') }],
      nextCursor: complete ? null : 'part-' + offset, window: { ...page.window, complete, view: complete ? page.window.view : null } }
  })
  f.credentials(true); const restarted = await f.openServices(); closes.push(() => restarted.close())
  await vi.waitFor(() => expect(restarted.publication!.store.inspect(old.operationId)?.state).toBe('confirmed'), { timeout: 10_000 })
  expect(inspect).toHaveBeenCalledTimes(bytes.length); expect(f.posts()).toHaveLength(1)
  expect(JSON.stringify(f.posts())).toContain('Original public small fragment message')
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it.each(['requested-record', 'unrelated-record'] as const)('exact current record anchors use the original post-read cut when %s arrives after the opening cut', async incoming => {
  const f = await fixture(); f.services.publication!.close()
  const body = 'Original requested public record', record = { ...f.ref, source: { kind: 'native' as const, ...source, recordId: 'after-opening-cut' } }
  if (incoming === 'unrelated-record') await appendFile(f.transcript, jsonl([response('after-opening-cut', 'assistant', body)]))
  const cut = f.client.sessionHistoryCheckpoint.bind(f.client)
  let inserted = false
  vi.spyOn(f.client, 'sessionHistoryCheckpoint').mockImplementation(async (agentSessionId, options = {}) => {
    const before = await cut(agentSessionId, options)
    if (!inserted) { inserted = true; await appendFile(f.transcript, jsonl([response(incoming === 'requested-record' ? 'after-opening-cut' : 'independent-after-cut', 'assistant', incoming === 'requested-record' ? body : 'Independent append must not block the requested record')])) }
    return before
  })
  const page = await f.rpc.call('agent.conversation.inspect', { ...f.ref, record }), consumed = core.consumeConversationWindowPage(page)
  expect(consumed.kind).toBe('complete'); if (consumed.kind !== 'complete') throw new Error('Exact current unit incomplete')
  expect(consumed.snapshot.units).toHaveLength(1); expect(JSON.stringify(consumed.snapshot.units)).toContain(body)
  const native = page.window.anchor!.frontier.frontier.cuts.find(cut => cut.kind === 'native')
  expect(native?.kind).toBe('native'); if (native?.kind !== 'native') throw new Error('Original post-read cut missing')
  expect(native.checkpoint).toEqual(await cut(f.ref.agentSessionId))
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
