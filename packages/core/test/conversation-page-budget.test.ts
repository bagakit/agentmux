import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { consumeConversationWindowPage, type ConversationWindowAssembly, type ConversationWindowSnapshot,
  type AgentConversationReadPage } from '../src/conversation.js'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'

const close: Array<() => unknown | Promise<unknown>> = []
const samples: unknown[] = []
afterEach(async () => {
  Reflect.deleteProperty(globalThis, '__amuxPageBudgetCost')
  for (const dispose of close.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
  if (process.env.AGENTMUX_PAGE_BUDGET_SAMPLES) await writeFile(process.env.AGENTMUX_PAGE_BUDGET_SAMPLES, JSON.stringify(samples, null, 2))
})
const row = (id: string, index: number, text = id) => ({ type: 'assistant', uuid: id, sessionId: 'native-main',
  timestamp: new Date(fixtureEpoch(0, 0, index)).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } })
async function fixture(rows: ReturnType<typeof row>[]) {
  const f = await nativeHistoryFixture('claude', jsonl(rows)); close.push(f.close)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'budget.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); close.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); close.push(() => rpc.dispose())
  return { ...f, rpc, ref: { hostId: 'local', agentSessionId: f.session.agentSessionId } }
}
async function collect(read: (cursor?: string) => Promise<AgentConversationReadPage>) {
  let cursor: string | undefined, pending: ConversationWindowAssembly | undefined
  let snapshot: ConversationWindowSnapshot | undefined
  const pages: AgentConversationReadPage[] = []
  for (let index = 0; index < 40; index++) {
    const page = await read(cursor); pages.push(page)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(page.budgetBytes)
    const result = consumeConversationWindowPage(page, pending)
    if (result.kind === 'complete') { snapshot = result.snapshot; break }
    pending = result.pending
    expect(page.nextCursor).toBeTruthy(); expect(page.nextCursor).not.toBe(cursor)
    cursor = page.nextCursor!
  }
  expect(snapshot).toBeTruthy()
  return { pages, snapshot: snapshot! }
}
function observe() {
  const cost = { trialEntries: 0, trials: 0, finalEntries: 0, finalChecks: 0 }
  Reflect.set(globalThis, '__amuxPageBudgetCost', cost)
  return cost
}
function expectLinearPages(label: string, pages: AgentConversationReadPage[], cost: ReturnType<typeof observe>) {
  const entries = pages.reduce((total, page) => total + page.items.length, 0)
  samples.push({ label, pages: pages.length, entries, ...cost })
  expect(cost.trialEntries, 'Budget trials must not re-encode the accepted page prefix').toBe(0)
  expect(cost.trials).toBeGreaterThanOrEqual(entries)
  // Public routing may re-read the same page to fit its larger route envelope.
  // Every original page attempt still performs its own final exact check.
  expect(cost.finalEntries).toBeGreaterThanOrEqual(entries)
  expect(cost.finalChecks).toBeGreaterThanOrEqual(pages.length)
}

it.each([4, 24])('an original public %i-unit page does not re-encode each accepted prefix', async count => {
  const f = await fixture(Array.from({ length: count }, (_, index) => row('record-' + index, index + 1)))
  const cost = observe()
  const result = await collect(cursor => f.rpc.call('agent.conversation.inspect', { ...f.ref, limit: 30,
    maxBytes: 1024 * 1024, ...(cursor ? { cursor } : {}) }))
  expect(result.pages).toHaveLength(1); expect(result.snapshot.units).toHaveLength(count)
  expect(result.pages[0]!.items.every(entry => entry.kind === 'item')).toBe(true)
  expectLinearPages('whole-' + count, result.pages, cost)
})

it('public inspect and changes preserve Unicode fragments after an already accepted mixed-source prefix', async () => {
  const body = 'Original 中🙂\\\"\n'.repeat(5000)
  const f = await fixture([row('large-original', 1, body), row('near-original', 2), row('latest-original', 3)])
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: {
    id: 'captured-prefix', agentSessionId: f.session.agentSessionId, kind: 'assistant_message', source: 'native-hook',
    status: 'complete', title: 'Original captured input', content: 'Original captured contribution',
    createdAt: fixtureEpoch(0, 0, 4), updatedAt: fixtureEpoch(0, 0, 4)
  } })
  const firstCost = observe()
  const first = await collect(cursor => f.rpc.call('agent.conversation.inspect', { ...f.ref, limit: 30, maxBytes: 32768, ...(cursor ? { cursor } : {}) }))
  expect(first.pages[0]!.items.filter(entry => entry.kind === 'item').length).toBeGreaterThanOrEqual(2)
  expect(first.pages[0]!.items.at(-1)!.kind).toBe('fragment')
  expect(first.snapshot.units.flatMap(unit => unit.records)).toHaveLength(4)
  const original = first.snapshot.units.flatMap(unit => unit.records).find(record => record.original.kind === 'native' && record.original.item.id === 'large-original')!
  expect(original.original).toMatchObject({ kind: 'native', item: { contentParts: [{ kind: 'text', text: body }] } })
  expectLinearPages('inspect-fragments', first.pages, firstCost)
  await appendFile(f.path, jsonl([row('large-change', 5, body), row('near-change', 6), row('latest-change', 7)]))
  const nextCost = observe()
  const next = await collect(cursor => f.rpc.call('agent.conversation.changes', { ...f.ref, view: first.snapshot.window.view!,
    checkpoint: first.snapshot.window.checkpoint, limit: 30, maxBytes: 32768, ...(cursor ? { cursor } : {}) }))
  expect(next.pages[0]!.items.filter(entry => entry.kind === 'item').length).toBeGreaterThanOrEqual(2)
  expect(next.pages[0]!.items.at(-1)!.kind).toBe('fragment')
  expect(next.snapshot.units.flatMap(unit => unit.records)).toHaveLength(7)
  expect(next.snapshot.window.id).toBe(first.snapshot.window.id)
  expect(next.snapshot.window.revision).toBeGreaterThan(first.snapshot.window.revision)
  expectLinearPages('changes-fragments', next.pages, nextCost)
  expect(f.controls.every(control => !control.mock.calls.length)).toBe(true)
})
