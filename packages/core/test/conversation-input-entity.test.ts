import { afterEach, expect, it, vi } from 'vitest'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paginatedFixture, user, source, turn, jsonl } from './helpers/codex-paginated.js'
import { createNativeInputCorrelation } from '../src/native-input-correlation.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { consumeConversationWindowPage, projectConversationWindow, projectConversationReading, retainConversationInputs,
  type AgentConversationReadPage, type ConversationTimelineReadInput, type ConversationWindowAssembly, type ConversationWindowSnapshot } from '../src/conversation.js'
import type { AgentPromptSubmissionRecord, AgentTimelineItem } from '../src/types.js'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function complete(read: (input: ConversationTimelineReadInput) => Promise<AgentConversationReadPage>, input: ConversationTimelineReadInput) {
  let assembly: ConversationWindowAssembly | undefined, cursor = input.cursor
  for (let count = 0; count < 30; count++) {
    const page = await read({ ...input, ...(cursor ? { cursor } : {}) }), result = consumeConversationWindowPage(page, assembly)
    if (result.kind === 'complete') return result.snapshot
    assembly = result.pending; cursor = page.nextCursor!
    expect(cursor, 'Every unfinished public frame must retain its original continuation').toBeTruthy()
  }
  throw Error('The original bounded conversation frame did not complete')
}

async function fixture() {
  const f = await paginatedFixture([]); closes.push(f.close)
  const key = { kind: 'prompt' as const, agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, submissionId: 'original-input' }
  const correlation = createNativeInputCorrelation(key), plan = { kind: 'native-rpc' as const, protocolId: 'original-protocol', actorId: 'original-actor',
    sourceId: JSON.stringify(['codex', source.nativeSessionId]), threadId: source.nativeSessionId, operation: 'start-or-steer' as const, clientCorrelation: correlation }
  const admission: NonNullable<AgentPromptSubmissionRecord['admission']> = { submissionId: key.submissionId, operationId: key.submissionId, inputKey: key,
    transport: 'native', acknowledged: true,
    intent: { run: f.session.run, ownerInstanceId: 'original-owner', prompt: 'Generated context\nOriginal user content', plan, execution: 'immediate',
      message: { userContent: 'Original user content', systemContext: 'Generated context', authorHuman: true }, admissionIntent: { kind: 'native-conversation', source, expectedRun: f.session.run } },
    native: { plan, outcome: 'admitted', turnId: turn } }
  const next = { ...f.session, promptCompletionAdmission: admission }
  await f.store.compareAndSwap(f.session, next); Object.assign(f.session, next)
  const captured: AgentTimelineItem = { id: 'original-captured', agentSessionId: f.session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete',
    title: 'Original input', content: 'Original user content', inputRef: key, publicContent: 'confirmed', authorHuman: true, createdAt: 1, updatedAt: 1 }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: captured })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'entity.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const reference = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const native = (id = 'canonical-input', qualified = true) => {
    const value = user(id, [{ type: 'text', text: admission.intent!.prompt }])
    value.payload.item.client_id = qualified ? correlation : 'unrelated-client-correlation'
    return value
  }
  const read = () => complete(input => rpc.call('agent.conversation.inspect', input), { ...reference, limit: 100 })
  const changes = (prior: ConversationWindowSnapshot) => complete(input => rpc.call('agent.conversation.changes', {
    ...input, view: prior.window.view!, checkpoint: prior.window.checkpoint
  }), { ...reference, limit: 100 })
  return { ...f, rpc, reference, key, captured, native, read, changes }
}

it('the public Reader projects one exact input entity after late adoption with canonical author and all original contributions', async () => {
  const f = await fixture(), before = await f.read(), initial = projectConversationWindow(before)
  expect(initial.inputs, 'Core must expose accepted input entities directly').toHaveLength(1)
  const prior = initial.inputs[0]!
  expect(prior.id, 'Input identity must be the accepted canonical event identity').toBe(initial.records[0]!.id)
  expect(prior).toMatchObject({ author: { kind: 'human' }, hostId: 'local', sourceHostId: 'local', publicContent: 'confirmed',
    content: 'Original user content', source: { kind: 'captured', submissionId: f.captured.id }, event: before.units[0]!.event, records: before.units[0]!.records })
  await appendFile(f.transcriptPath, jsonl([f.native()]))
  const after = await f.changes(before), reading = projectConversationWindow(after)
  expect(after.units).toHaveLength(1); expect(after.units[0]!.records).toHaveLength(2)
  expect(reading.inputs, 'Submission and exact native adoption must be one input entity').toHaveLength(1)
  const entity = reading.inputs[0]!
  expect(entity.id, 'Input identity must be the accepted canonical event identity').toBe(reading.records[0]!.id)
  expect(entity.event).toEqual(after.units[0]!.event); expect(entity.records).toEqual(after.units[0]!.records)
  expect(entity.author, 'Input entity attribution must consume the canonical event author').toEqual({ kind: 'human' })
  expect(entity.source.kind).toBe('native'); expect(entity.contentParts).toEqual(reading.records[0]!.input!.contentParts)
  expect(entity.publicContent, 'Captured qualification cannot upgrade native context').toBe('unknown')
  expect(entity.event.coalesces!.some(edge => edge.fromEventIds.includes(prior.event.id))).toBe(true)
  const original = entity.records.find(record => record.original.kind === 'captured')!
  expect(original.original.item).toEqual(f.captured)
  expect(entity.records.find(record => record.original.kind === 'native')!.original.item.conversation?.adoptedInput).toEqual({ key: f.key })
  expect(reading.records[0]!.input!.author).toEqual({ kind: 'unknown' })
  const retained = retainConversationInputs([prior], reading.inputs, 6)
  expect(retained, 'Pin admission must not append the adopted alias as another entity').toEqual([prior]); expect(retained[0]).toBe(prior)
})

it('the raw public history keeps separate source records and their original identities after entity adoption', async () => {
  const f = await fixture()
  await appendFile(f.transcriptPath, jsonl([f.native()]))
  const reading = projectConversationWindow(await f.read())
  expect(reading.inputs).toHaveLength(1)
  const captured = await f.rpc.call('agent.history', { ...f.reference, source: 'captured', kind: 'user-message', limit: 100 })
  const native = await f.rpc.call('agent.history', { ...f.reference, source: 'native', kind: 'user-message', limit: 100 })
  expect(captured.userMessages).toHaveLength(1); expect(native.userMessages).toHaveLength(1)
  expect(captured.userMessages![0]).toMatchObject({ id: 'captured:' + f.captured.id, rawId: f.captured.id, author: { kind: 'human' }, publicContent: 'confirmed' })
  expect(native.userMessages![0]).toMatchObject({ author: { kind: 'unknown' }, publicContent: 'unknown', source: { kind: 'native', ...source } })
  expect(native.userMessages![0]!.id).toMatch(/^native:/)
  expect(native.userMessages![0]!.id).not.toBe(reading.inputs[0]!.id)
  expect('event' in captured.userMessages![0]!).toBe(false); expect('records' in native.userMessages![0]!).toBe(false)
})

it('equal input text with an unrelated key or unqualified native correlation remains independent', async () => {
  const f = await fixture()
  const unrelated = { ...f.captured, id: 'unrelated-captured', inputRef: { ...f.key, submissionId: 'another-input' } }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: unrelated })
  await appendFile(f.transcriptPath, jsonl([f.native('native-unqualified', false)]))
  const reading = projectConversationWindow(await f.read())
  expect(reading.inputs, 'Equal bodies cannot establish input entity membership').toHaveLength(3)
  expect(new Set(reading.inputs.map(input => input.id)).size).toBe(3)
  expect(reading.inputs.every(input => input.records.length === 1 && !input.event.coalesces?.length)).toBe(true)
  const captured = reading.inputs.filter(input => input.source.kind === 'captured')
  expect(captured.map(input => input.content)).toEqual(['Original user content', 'Original user content'])
  expect(retainConversationInputs(captured.slice(0, 1), reading.inputs, 6)).toHaveLength(3)
})

it('later ambiguous native witnesses withdraw adoption without using shared original records to identify one entity', async () => {
  const f = await fixture()
  await appendFile(f.transcriptPath, jsonl([f.native('first-candidate')]))
  const before = await f.read(), previous = projectConversationWindow(before).inputs
  expect(previous).toHaveLength(1); expect(previous[0]!.records).toHaveLength(2)
  await appendFile(f.transcriptPath, jsonl([f.native('conflicting-candidate')]))
  const changed = await f.changes(before), current = projectConversationWindow(changed).inputs
  expect(current, 'Conflicting accurate native originals must remain independent input entities').toHaveLength(3)
  expect(current.every(input => input.records.length === 1 && !input.event.coalesces?.length)).toBe(true)
  expect(changed.coverage.flatMap(coverage => coverage.gaps).map(gap => gap.code)).toContain('CONVERSATION_INPUT_ADOPTION_AMBIGUOUS')
  const retained = retainConversationInputs(previous, current, 6)
  expect(retained, 'Shared raw contributions do not authorize entity coalescence after ambiguity').toHaveLength(3)
  expect(retained[0]).toBe(previous[0]); expect(previous[0]!.records).toHaveLength(2)
})

it('pin admission fences exact route, original Host and Session even when a current event carries an adopted alias', async () => {
  const f = await fixture(), previous = projectConversationWindow(await f.read()).inputs
  await appendFile(f.transcriptPath, jsonl([f.native()]))
  const snapshot = await f.read(), current = projectConversationWindow(snapshot).inputs
  for (const [field, value] of [['hostId', 'another-route'], ['sourceHostId', 'another-original-host'], ['agentSessionId', 'another-session']] as const) {
    const other = current.map(entity => ({ ...entity, [field]: value }))
    expect(retainConversationInputs(previous, other, 6), 'An adopted alias cannot cross the original input scope').toHaveLength(2)
  }
  const noRoutePrevious = previous.map(({ hostId: _hostId, ...entity }) => entity)
  const noRouteCurrent = current.map(({ hostId: _hostId, ...entity }) => entity)
  expect(retainConversationInputs(noRoutePrevious, noRouteCurrent, 6), 'Unknown routes cannot establish entity aliases').toHaveLength(2)
  const noSourcePrevious = previous.map(entity => ({ ...entity, sourceHostId: null }))
  const noSourceCurrent = current.map(entity => ({ ...entity, sourceHostId: null }))
  expect(retainConversationInputs(noSourcePrevious, noSourceCurrent, 6), 'Unknown original Hosts cannot establish entity aliases').toHaveLength(2)
  expect(retainConversationInputs(noSourcePrevious, noSourcePrevious, 6)).toEqual(noSourcePrevious)
  expect(retainConversationInputs(noSourcePrevious, noSourcePrevious, 6)[0]).toBe(noSourcePrevious[0])
  const route = projectConversationWindow({ ...snapshot, hostId: 'another-route', window: { ...snapshot.window, checkpoint: { ...snapshot.window.checkpoint, hostId: 'another-route' } } }).inputs
  expect(route[0]!.hostId).toBe('another-route'); expect(route[0]!.sourceHostId).toBe('local')
  expect(route[0]!.id).not.toBe(current[0]!.id)
  expect(retainConversationInputs(previous, route, 6)).toHaveLength(2)
  expect(retainConversationInputs(previous, current, previous.length)).toEqual(previous)
  const pure = projectConversationReading({ agentSessionId: snapshot.agentSessionId, routeHostId: snapshot.hostId, executionHostId: snapshot.sourceHostId,
    historyPage: projectConversationWindow(snapshot).historyPage, timeline: projectConversationWindow(snapshot).captured })
  expect(pure.inputs.map(entity => entity.event.id)).toEqual(current.map(entity => entity.event.id))
})
