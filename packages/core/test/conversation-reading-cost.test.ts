import { fixtureEpoch as _followupFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { consumeConversationWindowPage, type ConversationWindowAssembly, type ConversationWindowSnapshot } from '../src/conversation.js'
import type { AgentTimelineItem } from '../src/types.js'
const closes: Array<() => unknown | Promise<unknown>> = []
const samples: unknown[] = []
type Probe = { navigationCalls: number; locatorRecords: number; revisionCalls: number }
const probe = (): Probe => ({ navigationCalls: 0, locatorRecords: 0, revisionCalls: 0 })
afterEach(async () => {
  window.getSelection()?.removeAllRanges()
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks(); Reflect.deleteProperty(globalThis, '__amuxConversationCost')
  if (process.env.AGENTMUX_READING_COST_SAMPLES) await writeFile(process.env.AGENTMUX_READING_COST_SAMPLES, JSON.stringify(samples, null, 2) + '\n')
})
const native = (id: string, body = id) => ({ type: 'user', uuid: id, sessionId: 'native-main', message: { role: 'user', content: body } })
const captured = (sid: string, id: string): AgentTimelineItem => ({ id, agentSessionId: sid, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: id, content: id, createdAt: _followupFixtureEpoch(0, 0, 1), updatedAt: _followupFixtureEpoch(0, 0, 1) })
async function fixture(total: number, unrelated: number) {
  const half = total / 2, f = await nativeHistoryFixture('claude', jsonl(Array.from({ length: half }, (_, i) => native('native-' + i))))
  closes.push(f.close)
  for (let index = 0; index < half; index++) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: captured(f.session.agentSessionId, 'captured-' + index) })
  for (let index = 0; index < unrelated; index++) await f.store.compareAndSwap(null, { ...f.session, agentSessionId: 'unrelated-session-' + index,
    run: { runId: 'unrelated-run-' + index }, nativeHandle: { ...f.session.nativeHandle!, sessionId: 'unrelated-native-' + index } as typeof f.session.nativeHandle })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  let snapshot: ConversationWindowSnapshot | undefined, cursor: string | undefined
  for (let sourcePage = 0; sourcePage < 8; sourcePage++) {
    let assembly: ConversationWindowAssembly | undefined
    for (let fragment = 0; fragment < 200; fragment++) {
      const page = await rpc.call('agent.conversation.inspect', { ...ref, limit: 100, maxBytes: 4 * 1024 * 1024, ...(cursor ? { cursor } : {}) })
      const result = consumeConversationWindowPage(page, assembly)
      if (result.kind === 'complete') { snapshot = result.snapshot; break }
      assembly = result.pending; expect(page.nextCursor).toBeTruthy(); cursor = page.nextCursor!
    }
    expect(snapshot).toBeTruthy()
    if (!snapshot!.window.navigation.older) break
    cursor = snapshot!.window.navigation.older
  }
  expect(snapshot!.units.flatMap(unit => unit.records)).toHaveLength(total)
  return { ...f, rpc, ref, snapshot: snapshot! }
}
it.each([[12, 0], [12, 32], [1198, 32]] as const)('a %i-record public window with %i unrelated Sessions derives navigation once and admits only related source work', async (total, unrelated) => {
  const f = await fixture(total, unrelated), cost = probe()
  Reflect.set(globalThis, '__amuxConversationCost', cost)
  const map = Array.prototype.map
  vi.spyOn(Array.prototype, 'map').mockImplementation(function (this: unknown[], callback: any, context?: unknown) {
    const result = map.call(this, callback, context) as any[], value = result[0]
    if (value && typeof value === 'object' && typeof value.id === 'string' && 'reference' in value && 'revision' in value && 'order' in value &&
      (value.source === 'native' || value.source === 'captured') && !('original' in value)) cost.locatorRecords += result.length
    return result
  })
  const pageRead = vi.spyOn(f.client, 'sessionHistoryPage'), changes = vi.spyOn(f.client, 'readSessionHistoryChanges'), capturedRead = vi.spyOn(f.store, 'readCapturedHistory'), targets = vi.spyOn(f.store, 'readHistorySource'), all = vi.spyOn(f.store, 'load')
  await appendFile(f.path, jsonl([native('related-native-delta', 'Original delta body '.repeat(6000))]))
  const started = performance.now(); let assembly: ConversationWindowAssembly | undefined, cursor: string | undefined, accepted: ConversationWindowSnapshot | undefined, bytes = 0, pages = 0
  for (let fragment = 0; fragment < 200; fragment++) {
    const page = await f.rpc.call('agent.conversation.changes', { ...f.ref, view: f.snapshot.window.view!, checkpoint: f.snapshot.window.checkpoint,
      limit: 100, maxBytes: 64 * 1024, ...(cursor ? { cursor } : {}) })
    bytes += Buffer.byteLength(JSON.stringify(page)); pages++
    const result = consumeConversationWindowPage(page, assembly)
    if (result.kind === 'complete') { accepted = result.snapshot; break }
    assembly = result.pending; expect(page.nextCursor).toBeTruthy(); cursor = page.nextCursor!
  }
  const elapsedMs = performance.now() - started
  expect(accepted).toBeTruthy(); expect(pages).toBeGreaterThan(1)
  samples.push({ total, unrelated, retainedAfter: accepted!.units.flatMap(unit => unit.records).length, wirePages: pages, wireBytes: bytes, elapsedMs,
    ...cost, sourceCalls: { nativePage: pageRead.mock.calls.length, nativeChanges: changes.mock.calls.length, captured: capturedRead.mock.calls.length }, metadataTargets: [...new Set(targets.mock.calls.map(call => call[0]))], enumerations: all.mock.calls.length })
  const originalRecords = new Map(f.snapshot.units.flatMap(unit => unit.records).map(record => [record.id, record]))
  const afterRecords = accepted!.units.flatMap(unit => unit.records)
  expect(afterRecords).toHaveLength(total + 1)
  const delta = afterRecords.find(record => record.original.item.id === 'related-native-delta')!
  expect(delta).toBeTruthy()
  expect(delta.original.kind === 'native' && delta.original.item.contentParts).toEqual([{ kind: 'text', text: 'Original delta body '.repeat(6000), contentEligibility: 'unconfirmed' }])
  for (const record of afterRecords) if (record !== delta) expect(record).toEqual(originalRecords.get(record.id))
  expect(accepted!.window.id).toBe(f.snapshot.window.id); expect(accepted!.scope).toEqual(f.snapshot.scope)
  expect(pageRead).not.toHaveBeenCalled(); expect(changes).toHaveBeenCalledTimes(1); expect(capturedRead).toHaveBeenCalledTimes(2)
  expect(targets.mock.calls.every(call => call[0] === f.session.agentSessionId)).toBe(true); expect(all).not.toHaveBeenCalled()
  expect(cost.navigationCalls, 'An immutable Snapshot needs one adjacency derivation across all wire fragments').toBe(1)
  expect(cost.locatorRecords, 'Discarded Batch locator copies are not consumed by the public frame').toBe(0)
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
