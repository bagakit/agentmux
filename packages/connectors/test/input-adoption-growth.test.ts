import { afterEach, expect, it, vi } from 'vitest'
import { ConversationReaderState, readConversationChanges, type ConversationReaderPort } from '../../core/src/conversation-reader.js'
import { ConversationInputWitnessIndex } from '../../core/src/conversation-input-witness-index.js'
import { consumeConversationWindowPage, type ConversationCheckpoint, type ConversationWindowAssembly, type ConversationWindowSnapshot } from '../../core/src/conversation-changes.js'
import { conversationInputAdoptionEdges, conversationInputIdentity, mergeConversationInputAdoptionContexts } from '../../core/src/conversation-stream.js'
import type { AgentSessionHistoryItem } from '../../core/src/types.js'
import type { RoomBinding } from '../../core/src/connections.js'

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
  const state = new ConversationReaderState()
  closes.push(() => state.dispose())
  const originals: AgentSessionHistoryItem[] = []
  // Controlled native transport; production Core reading, wire parsing and adoption evidence are real.
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
  return { originals, state, read }
}
function edges(snapshot: ConversationWindowSnapshot) {
  return conversationInputAdoptionEdges(snapshot.units.flatMap(unit => unit.records),
    mergeConversationInputAdoptionContexts(snapshot.units.map(unit => ({ records: unit.records, context: unit.event.inputAdoption }))))
}
function key(index: number): string { return conversationInputIdentity(binding.executionHostId, inputKey(index)) }
function exactAdoption(snapshot: ConversationWindowSnapshot, index: number, turnId = 'turn-' + index): void {
  const relation = edges(snapshot), identity = key(index)
  expect(relation.unconfirmed).toBe(false)
  expect(relation.unconfirmedKeys.has(identity)).toBe(false)
  expect(relation.ambiguous.has(identity)).toBe(false)
  expect(relation.byKey.get(identity)).toHaveLength(1)
  expect(relation.byKey.get(identity)![0]).toMatchObject({ key: inputKey(index), turnId,
    record: { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId,
      source: { kind: 'native', ...source } } })
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
    expect(edges(snapshot).unconfirmed).toBe(false)
    expect(snapshot.units.length).toBeLessThanOrEqual(1200)
    exactAdoption(snapshot, index)
  }
  expect(costs.get(2400), 'Unrelated accepted history must not expand current-window evidence work').toBe(costs.get(1400))
  f.originals.push({ id: 'original-completion', kind: 'assistant-message', turnId: 'turn-2399', contentParts: [], turnOutcome: { status: 'completed' } })
  const completed = await f.read()
  exactAdoption(completed, 2399)
  expect(completed.units.flatMap(unit => unit.records).find(record => record.original.item.id === 'original-completion')?.original.item.turnOutcome).toEqual({ status: 'completed' })
})

it('evicted conflicting originals still refuse their own input while an independent input completes', async () => {
  const f = fixture(), first = nativeInput(0), conflict = structuredClone(first)
  conflict.id = 'conflicting-original'; conflict.conversation!.nativeInput!.semanticItemId = conflict.id
  f.originals.push(first, conflict); await f.read()
  for (let start = 1; start < 1401; start += 100) {
    f.originals.push(...Array.from({ length: 100 }, (_, offset) => nativeInput(start + offset))); await f.read()
  }
  const late = structuredClone(first); late.id = 'late-qualified-original'; late.conversation!.nativeInput!.semanticItemId = late.id
  f.originals.push(late, nativeInput(1401))
  const snapshot = await f.read(65536)
  expect(snapshot.units.flatMap(unit => unit.records).some(record => ['input-0', 'conflicting-original'].includes(record.original.item.id))).toBe(false)
  expect(edges(snapshot).ambiguous.has(key(0)), 'Evicting bodies cannot erase already observed counterevidence').toBe(true)
  expect(edges(snapshot).byKey.get(key(0))).toHaveLength(2)
  exactAdoption(snapshot, 1401)
  f.originals.push({ id: 'independent-completion', kind: 'assistant-message', turnId: 'turn-1401', contentParts: [], turnOutcome: { status: 'completed' } })
  const completed = await f.read()
  exactAdoption(completed, 1401)
  expect(completed.units.flatMap(unit => unit.records).find(record => record.original.item.id === 'independent-completion')?.original.item.turnOutcome).toEqual({ status: 'completed' })
  expect(edges(completed).ambiguous.has(key(0))).toBe(true)
})

it('one event with unknown adoption does not suppress other exact input evidence in its wire window', async () => {
  const f = fixture(); f.originals.push(nativeInput(0)); await f.read()
  const changed = nativeInput(0)
  changed.turnId = 'changed-original-turn'; changed.conversation!.nativeInput!.turnId = changed.turnId
  f.originals.push(changed, nativeInput(1))
  const snapshot = await f.read()
  expect(snapshot.units.find(unit => unit.records.some(record => record.original.item.id === 'input-0'))!.event.inputAdoption?.unconfirmed).toBe(true)
  expect(edges(snapshot).unconfirmedKeys.has(key(0))).toBe(true)
  exactAdoption(snapshot, 1)
})

it('a retained withdrawn witness cannot regain completion authority after its body leaves the window', async () => {
  const f = fixture(); f.originals.push(nativeInput(0)); exactAdoption(await f.read(), 0)
  const withdrawn = nativeInput(0); delete withdrawn.conversation!.adoptedInput
  f.originals.push(withdrawn); await f.read()
  for (let start = 1; start < 1301; start += 100) {
    f.originals.push(...Array.from({ length: 100 }, (_, offset) => nativeInput(start + offset))); await f.read()
  }
  f.originals.push({ id: 'late-completion', kind: 'assistant-message', turnId: 'turn-0', contentParts: [], turnOutcome: { status: 'completed' } })
  const snapshot = await f.read()
  expect(snapshot.units.flatMap(unit => unit.records).some(record => record.original.item.id === 'input-0')).toBe(false)
  expect(edges(snapshot).unconfirmedKeys.has(key(0)), 'A native turn result cannot erase retained uncertainty on its original adopted input').toBe(true)
  expect(snapshot.units.flatMap(unit => unit.records).find(record => record.original.item.id === 'late-completion')?.original.item.turnOutcome).toEqual({ status: 'completed' })
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
  f.originals.push(inTurn(999))
  const adopted = await f.read()
  expect(edges(adopted).ambiguous.has(key(0))).toBe(true)
  exactAdoption(adopted, 999, 'shared-turn')
  f.originals.push({ id: 'shared-turn-completion', kind: 'assistant-message', turnId: 'shared-turn', contentParts: [], turnOutcome: { status: 'completed' } })
  const snapshot = await f.read(65536)
  const completion = snapshot.units.find(unit => unit.records.some(record => record.original.item.id === 'shared-turn-completion'))!
  expect(completion.event.inputAdoption!.witnesses).toHaveLength(410)
  expect(edges(snapshot).ambiguous.has(key(0))).toBe(true)
  expect(edges(snapshot).byKey.get(key(0))).toHaveLength(2)
  exactAdoption(snapshot, 999, 'shared-turn')
  expect(completion.records.find(record => record.original.item.id === 'shared-turn-completion')?.original.item.turnOutcome).toEqual({ status: 'completed' })
})
