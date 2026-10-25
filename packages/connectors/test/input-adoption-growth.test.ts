import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { PublicationStore } from '../src/publication-store.js'
import { projectQueryFeedback } from '../src/publication-query-feedback.js'
import { ConversationReaderState, readConversationChanges, type ConversationReaderPort } from '../../core/src/conversation-reader.js'
import { ConversationInputWitnessIndex } from '../../core/src/conversation-input-witness-index.js'
import { consumeConversationWindowPage, type ConversationCheckpoint, type ConversationWindowAssembly, type ConversationWindowSnapshot } from '../../core/src/conversation-changes.js'
import { conversationInputAdoptionEdges, mergeConversationInputAdoptionContexts } from '../../core/src/conversation-stream.js'
import type { AgentSessionHistoryItem } from '../../core/src/types.js'
import type { RoomBinding, ConnectionIngressMessage } from '../../core/src/connections.js'

const closes: (() => void)[] = []
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); vi.restoreAllMocks() })
const source = { providerId: 'claude', nativeSessionId: 'native-a' }
const nativeCut = (offset = 0) => ({ agentSessionId: 'session-a', source, cursor: 'cut-' + offset })
const binding: RoomBinding = {
  bindingId: 'binding-a', revision: 1, state: 'active', connectionId: 'connection-a', application: { domain: 'chat.example', appId: 'app-a' },
  executionHostId: 'host-a', agentSessionId: 'session-a', externalConversationId: 'room-a', sourceCheckpoints: [nativeCut()],
  scope: { input: 'mentions-and-replies', publication: 'future-native-user-facing' }, authorizedBy: { kind: 'user', id: 'fixture-user' }
}
const inputKey = (index: number) => ({ kind: 'message' as const, agentSessionId: binding.agentSessionId, expectedRun: { runId: 'run-a' }, messageId: 'message-' + index })
function nativeInput(index: number): AgentSessionHistoryItem {
  return { id: 'input-' + index, kind: 'user-message', turnId: 'turn-' + index,
    contentParts: [{ kind: 'text', text: 'Ordinary input ' + index, contentEligibility: 'public' }],
    conversation: { nativeInput: { source, turnId: 'turn-' + index, semanticItemId: 'input-' + index, clientCorrelation: 'amux-input-v1.' + index }, adoptedInput: { key: inputKey(index) } } }
}
function fixture() {
  const state = new ConversationReaderState(), database = new DatabaseSync(':memory:'), store = new PublicationStore(database)
  closes.push(() => state.dispose(), () => database.close())
  database.exec('CREATE TABLE connection_ingress_message(record_json TEXT)')
  const originals: AgentSessionHistoryItem[] = []
  // Controlled native transport; Core reading, wire parsing and durable feedback consumers are real.
  const port = { state, descriptor: {}, nativeChanges: async (cut: ReturnType<typeof nativeCut>, limit: number) => {
    const start = Number(cut.cursor.slice(4)), end = Math.min(originals.length, start + limit)
    return { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId, source, items: originals.slice(start, end), checkpoint: nativeCut(end), more: end < originals.length }
  } } as ConversationReaderPort
  let checkpoint: ConversationCheckpoint = { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId, sourceHostId: binding.executionHostId,
    frontier: { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId, scope: { sources: [{ kind: 'native', ...source }] }, cuts: [{ kind: 'native', checkpoint: nativeCut() }] } }
  let view: string | undefined
  async function read(maxBytes = 4 * 1024 * 1024) {
    let cursor: string | undefined, pending: ConversationWindowAssembly | undefined
    for (let pageCount = 0; pageCount < 100; pageCount++) {
      const page = await readConversationChanges({ hostId: binding.executionHostId, agentSessionId: binding.agentSessionId, checkpoint, limit: 100, maxBytes,
        ...(cursor ? { cursor } : {}), ...(view ? { view } : {}) }, port)
      const result = consumeConversationWindowPage(page, pending)
      if (result.kind === 'complete') { checkpoint = result.snapshot.window.checkpoint; view = result.snapshot.window.view; return result.snapshot }
      pending = result.pending; cursor = page.nextCursor!
    }
    throw Error('The original wire window did not finish')
  }
  function addQuery(index: number) {
    const query = { ingressId: 'ingress-' + index, state: 'claimed', conversationKind: 'group', connectionId: binding.connectionId, application: binding.application,
      externalConversationId: binding.externalConversationId, externalMessageId: 'external-' + index,
      group: { target: { bindingId: binding.bindingId, bindingRevision: binding.revision, connectionId: binding.connectionId, hostId: binding.executionHostId, agentSessionId: binding.agentSessionId } },
      input: { hostId: binding.executionHostId, ...inputKey(index) } } as ConnectionIngressMessage
    database.prepare('INSERT INTO connection_ingress_message VALUES (?)').run(JSON.stringify(query))
  }
  const feedback = (index: number) => store.list(binding).filter(operation => operation.queryFeedback?.ingressId === 'ingress-' + index).map(operation => operation.queryFeedback!.stage)
  const project = (snapshot: ConversationWindowSnapshot) => projectQueryFeedback(store, binding, snapshot.units, () => true)
  return { originals, state, read, addQuery, project, feedback }
}
function edges(snapshot: ConversationWindowSnapshot) {
  return conversationInputAdoptionEdges(snapshot.units.flatMap(unit => unit.records),
    mergeConversationInputAdoptionContexts(snapshot.units.map(unit => ({ records: unit.records, context: unit.event.inputAdoption }))))
}

it('normal growth preserves original query adoption and completion beyond the temporary body window', async () => {
  const f = fixture(), costs = new Map<number, number>()
  // Count actual evidence lookups on the production Reader path, not elapsed-machine timing.
  const lookups = vi.spyOn(ConversationInputWitnessIndex.prototype as unknown as { group(key: string): readonly unknown[] }, 'group')
  for (let total = 100; total <= 2400; total += 100) {
    f.originals.push(...Array.from({ length: 100 }, (_, index) => nativeInput(total - 100 + index)))
    const previousCalls = lookups.mock.calls.length, snapshot = await f.read()
    costs.set(total, lookups.mock.calls.length - previousCalls)
    if (total < 1100) continue
    const index = total - 1
    f.addQuery(index); f.project(snapshot)
    expect(edges(snapshot).unconfirmed).toBe(false)
    expect(snapshot.units.length).toBeLessThanOrEqual(1200)
    expect(f.feedback(index), 'The exact new input must remain usable after normal growth').toEqual(['received', 'started'])
  }
  expect(costs.get(2400), 'Unrelated accepted history must not expand current-window evidence work').toBe(costs.get(1400))
  f.originals.push({ id: 'original-completion', kind: 'assistant-message', turnId: 'turn-2399', contentParts: [], turnOutcome: { status: 'completed' } })
  f.project(await f.read())
  expect(f.feedback(2399)).toEqual(['received', 'started', 'completed'])
})

it('evicted conflicting originals still refuse their own input while an independent input completes', async () => {
  const f = fixture(), first = nativeInput(0), conflict = structuredClone(first)
  conflict.id = 'conflicting-original'; conflict.conversation!.nativeInput!.semanticItemId = conflict.id
  f.originals.push(first, conflict); await f.read()
  for (let start = 1; start < 1401; start += 100) {
    f.originals.push(...Array.from({ length: 100 }, (_, offset) => nativeInput(start + offset))); await f.read()
  }
  const late = structuredClone(first); late.id = 'late-qualified-original'; late.conversation!.nativeInput!.semanticItemId = late.id
  f.originals.push(late, nativeInput(1401)); f.addQuery(0); f.addQuery(1401)
  const snapshot = await f.read(65536)
  expect(snapshot.units.flatMap(unit => unit.records).some(record => ['input-0', 'conflicting-original'].includes(record.original.item.id))).toBe(false)
  f.project(snapshot)
  expect(f.feedback(0), 'Evicting bodies cannot erase already observed counterevidence').toEqual([])
  expect(f.feedback(1401)).toEqual(['received', 'started'])
  f.originals.push({ id: 'independent-completion', kind: 'assistant-message', turnId: 'turn-1401', contentParts: [], turnOutcome: { status: 'completed' } })
  f.project(await f.read()); expect(f.feedback(1401)).toEqual(['received', 'started', 'completed'])
})

it('one event with unknown adoption does not suppress other exact input feedback in its wire window', async () => {
  const f = fixture(); f.originals.push(nativeInput(0)); await f.read()
  const changed = nativeInput(0)
  changed.turnId = 'changed-original-turn'; changed.conversation!.nativeInput!.turnId = changed.turnId
  f.originals.push(changed, nativeInput(1))
  const snapshot = await f.read()
  expect(snapshot.units.find(unit => unit.records.some(record => record.original.item.id === 'input-0'))!.event.inputAdoption?.unconfirmed).toBe(true)
  f.addQuery(0); f.addQuery(1); f.project(snapshot)
  expect(f.feedback(0)).toEqual([]); expect(f.feedback(1)).toEqual(['received', 'started'])
})

it('a retained withdrawn witness cannot regain completion authority after its body leaves the window', async () => {
  const f = fixture(); f.originals.push(nativeInput(0)); f.addQuery(0); f.project(await f.read())
  expect(f.feedback(0)).toEqual(['received', 'started'])
  const withdrawn = nativeInput(0); delete withdrawn.conversation!.adoptedInput
  f.originals.push(withdrawn); await f.read()
  for (let start = 1; start < 1301; start += 100) {
    f.originals.push(...Array.from({ length: 100 }, (_, offset) => nativeInput(start + offset))); await f.read()
  }
  f.originals.push({ id: 'late-completion', kind: 'assistant-message', turnId: 'turn-0', contentParts: [], turnOutcome: { status: 'completed' } })
  const snapshot = await f.read()
  expect(snapshot.units.flatMap(unit => unit.records).some(record => record.original.item.id === 'input-0')).toBe(false)
  f.project(snapshot)
  expect(f.feedback(0), 'A native turn result cannot erase retained uncertainty on its original adopted input').toEqual(['received', 'started'])
})


it('a busy turn keeps conflicting inputs separate from its independent completion', async () => {
  const f = fixture()
  const inTurn = (index: number) => {
    const item = nativeInput(index)
    item.turnId = 'shared-turn'; item.conversation!.nativeInput!.turnId = item.turnId
    return item
  }
  // More than 400 relevant witnesses are legitimate evidence, bounded by the wire byte budget.
  for (let index = 0; index < 205; index++) {
    const first = inTurn(index), conflict = structuredClone(first)
    conflict.id += '-conflict'; conflict.conversation!.nativeInput!.semanticItemId = conflict.id
    f.originals.push(first, conflict)
  }
  for (let page = 0; page < 5; page++) await f.read()
  f.addQuery(0); f.addQuery(999); f.originals.push(inTurn(999))
  f.project(await f.read())
  expect(f.feedback(0)).toEqual([]); expect(f.feedback(999)).toEqual(['received', 'started'])
  f.originals.push({ id: 'shared-turn-completion', kind: 'assistant-message', turnId: 'shared-turn', contentParts: [], turnOutcome: { status: 'completed' } })
  const snapshot = await f.read(65536)
  const completion = snapshot.units.find(unit => unit.records.some(record => record.original.item.id === 'shared-turn-completion'))!
  expect(completion.event.inputAdoption!.witnesses).toHaveLength(410)
  f.project(snapshot)
  expect(f.feedback(0)).toEqual([]); expect(f.feedback(999)).toEqual(['received', 'started', 'completed'])
})
