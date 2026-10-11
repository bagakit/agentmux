// @vitest-environment node
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../packages/core/test/fixtures/native-history-session.js'
import { unifiedConversationOriginals } from '../packages/core/test/helpers/conversation-unified-originals.js'
import { savedQuestionJsonl, savedQuestionSource } from '../packages/core/test/helpers/codex-saved-question.js'
import { AgentMuxControlServer } from '../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../packages/core/src/public-rpc-client.js'
import { AgentMuxSpatialStateStore } from '../packages/core/src/spatial-state.js'
import { createWorkspaceLayout } from '../packages/core/src/spatial-layout.js'
import { consumeConversationWindowPage, projectConversationReading, conversationRecordId,
  type AgentConversationReadPage, type ConversationContentRef, type ConversationTimelineReadInput, type ConversationUnit, type ConversationWindowAssembly } from '../packages/core/src/conversation.js'
import type { AgentMuxStoredAgentSession, AgentTimelineItem } from '../packages/core/src/types.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../packages/core/test/helpers/object-cli-rpc.js'
import { ConnectionHost } from '../packages/connectors/src/connection-host.js'
import { RoomBindingHost } from '../packages/connectors/src/room-binding.js'
import { PublicationHost } from '../packages/connectors/src/publication-host.js'
import { createPublicationConversationPort } from '../packages/connectors/src/core-conversation-port.js'
import { renderToStaticMarkup } from 'react-dom/server'
import { conversationSourcePresenter } from '@agentmux/client-ui/conversation-sources'
import { ConversationToolTrace } from '@agentmux/client-ui/components/ConversationToolTrace'
import { conversationInvocationId } from '../packages/core/src/conversation.js'
import { FeishuAdapter } from '../packages/connectors/src/adapters/feishu/index.js'
import { feishuConfig } from '../packages/connectors/test/fixtures/feishu.js'
import { feishuPublicationHttp } from '../packages/connectors/test/fixtures/feishu-publication.js'
import { fixtureEpoch as _historyFixtureEpoch } from './fixture-values.mjs'


const closes: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function collect(read: (input: ConversationTimelineReadInput) => Promise<AgentConversationReadPage>, reference: { hostId: string; agentSessionId: string }, limit: number, maxBytes?: number) {
  let units: ConversationUnit[] = []
  const pages: AgentConversationReadPage[] = []
  let cursor: string | undefined, pending: ConversationWindowAssembly | undefined
  for (let count = 0; count < 100; count++) {
    const page = await read({ ...reference, limit, ...(maxBytes ? {maxBytes} : {}), ...(cursor ? { cursor } : {}) }); pages.push(page)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(page.budgetBytes)
    const result = consumeConversationWindowPage(page, pending)
    if (result.kind === 'pending') pending = result.pending
    else { pending = undefined; units = [...result.snapshot.units].reverse() }
    if (!page.nextCursor) { expect(pending).toBeUndefined(); return { units, pages } }
    expect(page.nextCursor).not.toBe(cursor); cursor = page.nextCursor
  }
  throw Error('Original joint source did not make bounded progress')
}
function ledger(units: ConversationUnit[]) {
  // Page witnesses and indexes describe each read's physical page. Event order,
  // exact references, versions and complete originals must agree across limits.
  return units.map(({ event, records }) => ({ event, records: records.map(({ order, ...record }) => ({ ...record,
    order: order.kind === 'native-page' ? { kind: order.kind, source: order.source } : order })) }))
}

it('one original inventory is conserved across SDK, RPC, compiled CLI and the actual publication adapter', async () => {
  const original = unifiedConversationOriginals()
  const f = await nativeHistoryFixture('claude', '', { nativeSessionId: original.source.nativeSessionId, agentSessionId: original.agentSessionId }); closes.push(f.close)
  const reference = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  // Re-encode the retained bounded public text/usage as declared native IO, not as
  // an alleged full original vendor transcript or an inferred native/Hook join.
  const usage = original.native.metrics!.usage!
  const native = { sessionId: original.source.nativeSessionId, uuid: original.native.id, type: 'assistant',
    timestamp: new Date(original.native.startedAt!).toISOString(), message: { role: 'assistant',
      content: original.native.contentParts.map(part => { if (part.kind !== 'text') throw Error('Bounded original changed shape'); return { type: 'text', text: part.text } }),
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cache_read_input_tokens: usage.cachedInputTokens } } }
  const remote = await feishuPublicationHttp(); closes.push(remote.close)
  const connections = new ConnectionHost({ databasePath: join(f.root, 'connections.sqlite'), secrets: { resolve: async () => 'isolated-joint-credential' }, adapters: [new FeishuAdapter({ http: remote.http })] }); closes.push(() => connections.close())
  await connections.configure({ operationId: 'joint-configure', expectedRevision: null, connection: feishuConfig })
  const spatial = new AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'joint-space', kind: 'topic', name: 'Joint source', hostId: 'local', directoryPath: f.root, projectId: 'joint-project' }],
    zones: [{ zoneId: 'joint-zone', workspaceId: 'joint-workspace', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId: 'joint-tab', zoneId: 'joint-zone', workspaceId: 'joint-workspace', name: null, regionIds: ['joint-region'] }],
    regions: [{ regionId: 'joint-region', tabId: 'joint-tab', kind: 'agent', agentSessionId: reference.agentSessionId, runId: f.session.run.runId, execution: { hostId: 'local', cwd: f.root } }],
    bindings: [{ zoneId: 'joint-zone', spaceId: 'joint-space' }], layouts: { 'joint-workspace': createWorkspaceLayout('joint-group', ['joint-tab']) },
    tabLayouts: { 'joint-tab': { root: { type: 'leaf', regionId: 'joint-region' }, activeRegionId: 'joint-region' } }, resources: {}
  } })
  const port = createPublicationConversationPort(() => [{ hostId: 'local', client: f.client }])
  const bindings = new RoomBindingHost({ connections, spatial, checkpoint: input => port.checkpoint(input, new AbortController().signal) }); connections.bindings = bindings
  const bound = await bindings.bind({ operationId: 'joint-binding', bindingId: 'joint-binding', connectionId: feishuConfig.connectionId, expectedConnectionRevision: 1,
    executionHostId: 'local', agentSessionId: reference.agentSessionId, regionAnchor: { regionId: 'joint-region' }, externalConversationId: 'joint-room',
    scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' }, expectedSource: original.source }, { actor: { kind: 'user', id: 'joint-user' } })
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw Error('Exact original binding was not applied')
  const publication = new PublicationHost({ connections, bindings, conversation: port }); closes.push(() => publication.close())
  const checkpoint = await f.client.conversationCheckpoint(reference)
  await appendFile(f.path, jsonl([native, original.claudeTool]))
  for (const item of [original.captured, original.capturedTool]) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: reference.agentSessionId, item })
  const gapItem: AgentTimelineItem = { id: 'joint-unread-observation', agentSessionId: reference.agentSessionId, kind: 'tool_call', source: 'native-hook', status: 'complete',
    title: 'Original target remains unread', content: 'Readable observation with an unread exact target', createdAt: _historyFixtureEpoch(0, 0, 400), updatedAt: _historyFixtureEpoch(0, 0, 400),
    conversation: { observes: { ...reference, source: { kind: 'native', ...original.source, recordId: 'joint-unread-target' } } } }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: reference.agentSessionId, item: gapItem })
  const historyPage = await f.client.sessionHistoryPage(reference.agentSessionId), timeline = await f.client.sessionTimeline(reference.agentSessionId)
  expect(historyPage.items.find(item => item.id === original.native.id)).toMatchObject(original.native)
  const projected = projectConversationReading({ ...reference, executionHostId: 'local', historyPage, timeline })
  const sdkRead = collect(input => f.client.readAgentConversation(input), reference, 1)
  await expect(sdkRead).resolves.toHaveProperty('units')
  const sdk = await sdkRead
  const sdkWide = await collect(input => f.client.readAgentConversation(input), reference, 100)
  if (process.env.AGENTMUX_JOINT_EVIDENCE) await writeFile(join(process.env.AGENTMUX_JOINT_EVIDENCE, 'relation-diagnosis.json'), JSON.stringify({ reference, historyPage, timeline, projected, sdk, sdkWide }))
  expect(sdk.units.map(unit => unit.event)).toEqual(sdkWide.units.map(unit => unit.event))
  expect(sdk.units.map(unit => unit.event)).toEqual(projected.timeline.events)
  const members = sdk.units.flatMap(unit => unit.event.relations).filter(relation => relation.kind === 'invocation-member')
  expect(members).toHaveLength(2)
  expect(new Set(members.map(member => conversationInvocationId(member.invocation))).size).toBe(1)
  expect(members.map(member => member.part.selector)).toEqual(expect.arrayContaining([{kind:'native-part', partIndex:1},{kind:'captured-field', field:'toolInput'}]))
  const publicTimeline = {...projected.timeline, events:sdk.units.map(unit => unit.event), records:sdk.units.flatMap(unit => unit.records)}
  const present = conversationSourcePresenter(publicTimeline)
  const nativeRecord = projected.records.find(record => record.rawId === original.claudeTool.uuid)!
  const part = nativeRecord.contentParts[1]!
  if (part.kind !== 'tool-call') throw Error('The original native tool part is required')
  const markup = renderToStaticMarkup(<ConversationToolTrace part={part} sources={present(nativeRecord).parts[1]}/> )
  expect(markup).toContain('data-conversation-source="native"')
  expect(markup).toContain('data-conversation-source="native-hook"')
  expect(markup).toContain('原生对话'); expect(markup).toContain('Hook')
  expect(sdk.units.flatMap(unit => unit.records).map(record => record.original.item.id).sort()).toEqual([original.native.id, original.claudeTool.uuid, original.captured.id, original.capturedTool.id, gapItem.id].sort())
  expect(sdk.units.filter(unit => unit.records.some(record => record.original.item.id === original.native.id))).toHaveLength(1)
  expect(sdk.units.find(unit => unit.records.some(record => record.original.item.id === original.captured.id))?.event.role).toBe('observation')
  expect(projected.timeline.coverage.flatMap(source => source.gaps).some(gap => gap.code === 'CONVERSATION_OBSERVED_TARGET_UNREAD')).toBe(true)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] }); await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const routed = await collect(input => rpc.call('agent.conversation.inspect', input), reference, 100)
  expect(ledger(routed.units)).toEqual(ledger(sdk.units))
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'agent', 'conversation', 'inspect', '--host', 'local', '--session', reference.agentSessionId, '--limit', '100'], objectCliEnvironment(f.root))
  expect(cli.code, cli.stderr).toBe(0)
  const cliPage = JSON.parse(cli.stdout).result as AgentConversationReadPage
  const fromCli = await collect(async input => input.cursor ? rpc.call('agent.conversation.inspect', input) : cliPage, reference, 100)
  expect(ledger(fromCli.units)).toEqual(ledger(sdk.units))
  publication.refresh()
  await vi.waitFor(() => {
    expect(publication.store.list(bound.binding).length).toBeGreaterThan(0)
    expect(publication.store.list(bound.binding).every(operation => operation.state === 'confirmed')).toBe(true)
  }, { timeout: 10_000 })
  const posted = remote.messageCalls().filter(call => call.method === 'POST')
  expect(posted.length).toBeGreaterThan(0)
  const text = JSON.stringify([...remote.records.values()])
  expect(text).toContain('Original surrounding speech'); expect(text).toContain('pwd')
  expect(publication.store.coverage(bound.binding).gaps.some(gap => gap.code === 'CONVERSATION_OBSERVED_TARGET_UNREAD')).toBe(true)
  const decisions = connections.database.prepare('SELECT decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? ORDER BY rowid')
    .all(bound.binding.bindingId, bound.binding.revision).map(row => JSON.parse(String(row.decision_json)))
  const partKey = (part: ConversationContentRef) => JSON.stringify([conversationRecordId(part.record), part.recordRevision,
    part.selector.kind, part.selector.kind === 'native-part' ? part.selector.partIndex : part.selector.field])
  const expectedParts = sdk.units.flatMap(unit => unit.event.content.map(slot => {
    const record = unit.records.find(record => record.id === slot.recordId)!
    return { record: record.reference!, recordRevision: record.revision, selector: slot.selector }
  }))
  expect(expectedParts).toHaveLength(6)
  const dispositions = decisions.flatMap(decision => {
    if (decision.kind === 'representation') return [{ kind: 'represented', part: decision.part as ConversationContentRef }]
    if (decision.kind === 'origin') return [{ kind: 'origin', part: decision.representation.part as ConversationContentRef }]
    if (decision.kind === 'scope') return (decision.excluded as ConversationContentRef[]).map(part => ({ kind: 'excluded', part }))
    if (decision.kind === 'gap' && decision.state === 'unresolved' && decision.gap.part && decision.gap.reason !== 'source-gap')
      return [{ kind: 'gap', part: decision.gap.part as ConversationContentRef }]
    return []
  })
  expect(dispositions.map(disposition => partKey(disposition.part)).sort()).toEqual(expectedParts.map(partKey).sort())
  expect(dispositions.every(disposition => disposition.kind === 'represented')).toBe(true)
  expect((await f.client.readConversationChanges({ ...reference, checkpoint: checkpoint.checkpoint })).items.length).toBeGreaterThan(0)
  expect(f.controls.every(control => !control.mock.calls.length)).toBe(true)
  if (process.env.AGENTMUX_JOINT_EVIDENCE) {
    await mkdir(process.env.AGENTMUX_JOINT_EVIDENCE, { recursive: true })
    const capturedPage = await f.client.readAgentSessionHistory({ ...reference, source: 'captured', limit: 100 })
    await writeFile(join(process.env.AGENTMUX_JOINT_EVIDENCE, 'original-inventory.json'), JSON.stringify({ reference, historyPage, timeline, capturedPage, sdk, rpc: routed, cli: { code: cli.code, page: cliPage },
      publication: { operations: publication.store.list(bound.binding), coverage: publication.store.coverage(bound.binding), platform: [...remote.records.values()],
        contentLedger: { expectedParts, dispositions, sourceGaps: decisions.filter(decision => decision.kind === 'gap' && decision.gap.reason === 'source-gap') } } }))
  }
  const updated = { ...gapItem, content: 'Readable observation after an exact source update', updatedAt: gapItem.updatedAt + 1 }
  await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: reference.agentSessionId, item: updated })
  const after = await collect(input => f.client.readAgentConversation(input), reference, 1)
  const afterRpc = await collect(input => rpc.call('agent.conversation.inspect', input), reference, 100)
  expect(ledger(after.units)).toEqual(ledger(afterRpc.units))
  expect(after.units.map(unit => unit.event.id)).toEqual(sdk.units.map(unit => unit.event.id))
  const priorEvent = sdk.units.find(unit => unit.records.some(record => record.original.item.id === gapItem.id))!.event
  const updatedEvent = after.units.find(unit => unit.records.some(record => record.original.item.id === gapItem.id))!.event
  expect(updatedEvent.revision).not.toBe(priorEvent.revision)
  expect(after.units.flatMap(unit => unit.records)).toHaveLength(5)
  if (process.env.AGENTMUX_JOINT_EVIDENCE) await writeFile(join(process.env.AGENTMUX_JOINT_EVIDENCE, 'upsert-inventory.json'), JSON.stringify({ reference,
    historyPage: await f.client.sessionHistoryPage(reference.agentSessionId), timeline: await f.client.sessionTimeline(reference.agentSessionId),
    capturedPage: await f.client.readAgentSessionHistory({ ...reference, source: 'captured', limit: 100 }), sdk: after, rpc: afterRpc,
    update: { recordId: gapItem.id, priorEvent, updatedEvent } }))
}, 30_000)
