import { readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, sessionHistoryMetadata } from '../src/agent-session-store.js'
import { DEFAULT_AGENT_CONTINUITY_POLICY, type AgentMuxContinuityOperation } from '../src/agent-session-recovery/continuity-contract.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'

const close: Array<() => unknown | Promise<unknown>> = []
const samples: unknown[] = []
afterEach(async () => {
  Reflect.deleteProperty(globalThis, '__amuxHistorySourceCost')
  for (const dispose of close.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
  if (process.env.AGENTMUX_HISTORY_SOURCE_SAMPLES) await writeFile(process.env.AGENTMUX_HISTORY_SOURCE_SAMPLES, JSON.stringify(samples, null, 2))
})
async function fixture() {
  const body = 'Original 中🙂 history body'
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'user', uuid: 'original-input', sessionId: 'native-main',
    timestamp: new Date(fixtureEpoch(0, 0, 1)).toISOString(), message: { role: 'user', content: body } }]))
  close.push(f.close)
  const nativeHandle = f.session.nativeHandle
  if (nativeHandle?.kind !== 'provider') throw Error('Fixture requires the original Provider source')
  const operation: AgentMuxContinuityOperation = { operationId: 'retained-recovery', agentSessionId: f.session.agentSessionId,
    trigger: 'startup', policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY, reminderAppend: 'Original recovery body '.repeat(128) },
    previousRun: f.session.run, nativeTarget: nativeHandle, kind: 'reattachable', reason: 'explicit-request',
    admittedAt: 1, observedAt: 1, rechecks: 0, evidence: { kind: 'run-running', observedAt: 1 } }
  const session = { ...f.session, nativeHandle, continuityOperations: { [operation.operationId]: operation },
    continuityExecutors: { original: { body: 'Original executor body '.repeat(128) } } }
  await f.store.compareAndSwap(f.session, session)
  const store = new AgentMuxFileAgentSessionStore(f.storePath)
  const client = new AgentMuxClient({ store }); close.push(() => client.dispose())
  const connect = vi.spyOn(client, 'connect')
  const kernel = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name as 'start'))
  const db = new DatabaseSync(f.storePath); close.push(() => db.close())
  const raw = () => String(db.prepare('SELECT json FROM sessions WHERE id=?').get(session.agentSessionId)!.json)
  const original = raw()
  const replace = (value: unknown) => db.prepare('UPDATE sessions SET json=? WHERE id=?').run(JSON.stringify(value), session.agentSessionId)
  return { ...f, store, client, session, body, raw, original, replace, assertNoControls: () => {
    expect(connect).not.toHaveBeenCalled()
    expect(controls).toHaveLength(6)
    for (const control of [...controls, ...f.controls]) expect(control).not.toHaveBeenCalled()
  } }
}
function observe() {
  const cost = { fullRecords: 0, continuityOperations: 0, executorBodies: 0 }
  Reflect.set(globalThis, '__amuxHistorySourceCost', cost)
  return cost
}

it('original public history consumes a nonempty durable source without normalizing recovery bodies', async () => {
  const f = await fixture(), read = f.store.readHistorySource.bind(f.store)
  const costs: ReturnType<typeof observe>[] = []
  const exact = vi.spyOn(f.store, 'readHistorySource').mockImplementation(async (...args) => {
    const cost = observe(); costs.push(cost)
    try { return await read(...args) } finally { Reflect.deleteProperty(globalThis, '__amuxHistorySourceCost') }
  })
  const descriptor = await f.store.readHistorySource(f.session.agentSessionId)
  expect(descriptor).toEqual({ agentSessionId: f.session.agentSessionId, hostId: 'local', state: 'active', history: sessionHistoryMetadata(f.session) })
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.items.map(item => [item.id, item.contentParts])).toEqual([['original-input', [{ kind: 'text', text: f.body, contentEligibility: 'unconfirmed' }]]])
  const conversation = await f.client.readAgentConversation({ hostId: 'local', agentSessionId: f.session.agentSessionId })
  expect(conversation.items.length).toBeGreaterThan(0)
  expect(JSON.stringify(conversation)).toContain(f.body)
  expect(exact.mock.calls.length).toBeGreaterThanOrEqual(3)
  expect(await readFile(f.path)).toEqual(f.before.native)
  expect(f.raw()).toBe(f.original)
  f.assertNoControls()
  const control = observe()
  expect(await f.store.readMetadata(f.session.agentSessionId)).toMatchObject({ continuityOperations: f.session.continuityOperations,
    continuityExecutors: f.session.continuityExecutors })
  Reflect.deleteProperty(globalThis, '__amuxHistorySourceCost')
  expect(control.fullRecords).toBeGreaterThan(0)
  expect(control.continuityOperations).toBeGreaterThan(0)
  expect(control.executorBodies).toBeGreaterThan(0)
  samples.push({ historyReads: costs.length, costs, fullMetadataControl: control, originalRowBytes: Buffer.byteLength(f.original) })
  for (const cost of costs) expect(cost, 'Exact history source must not normalize unrelated recovery bodies').toEqual({ fullRecords: 0, continuityOperations: 0, executorBodies: 0 })
})

it('only original current, observed and confirmed previous sources enter the read descriptor', async () => {
  const f = await fixture(), current = f.session.nativeHandle!
  const previous = { ...current, sessionId: 'original-previous', transcriptPath: f.path + '.previous' }
  const observed = { ...current, sessionId: 'observed-candidate', transcriptPath: f.path + '.candidate' }
  const session = { ...f.session, updatedAt: 3, observedNativeHandle: observed, nativeConfirmation: {
    operationId: 'confirmed-native', run: f.session.run, previousNativeHandle: previous, nativeHandle: current, observedAt: 3, candidateObservedAt: 2 } }
  await f.store.compareAndSwap(f.session, session)
  expect(await f.store.readHistorySource(session.agentSessionId)).toEqual({ agentSessionId: session.agentSessionId, hostId: 'local',
    state: 'active', history: sessionHistoryMetadata(session) })
  f.replace({ ...f.session, previousNativeHandle: previous })
  expect((await f.store.readHistorySource(session.agentSessionId))!.history).not.toHaveProperty('previousNativeHandle')
  f.replace({ ...f.session, nativeHandle: undefined })
  expect((await f.store.readHistorySource(session.agentSessionId))!.history).not.toHaveProperty('nativeHandle')
  await expect(f.client.sessionHistoryPage(session.agentSessionId)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
  expect(await f.store.readHistorySource('missing-original')).toBeNull()
  const abort = new AbortController(); abort.abort(new Error('original cancellation'))
  await expect(f.store.readHistorySource(session.agentSessionId, abort.signal)).rejects.toThrow('original cancellation')
  f.assertNoControls()
})

it('rejects malformed source authority while full metadata and writes still validate recovery bodies', async () => {
  const f = await fixture(), handle = f.session.nativeHandle!
  for (const invalid of [
    { kind: 'terminal' }, { agentSessionId: 'another-session' }, { hostId: '' }, { providerId: '' },
    { nativeHandle: { ...handle, providerId: 'codex' } }, { observedNativeHandle: { ...handle, providerId: 'codex' } },
    { nativeConfirmation: { operationId: 'confirm', run: f.session.run, previousNativeHandle: { ...handle, sessionId: 'previous' },
      nativeHandle: handle, observedAt: 2, candidateObservedAt: 1 } },
    { nativeConfirmation: { operationId: 'confirm', run: f.session.run, previousNativeHandle: { ...handle, providerId: 'codex', sessionId: 'previous' },
      nativeHandle: handle, observedAt: 1, candidateObservedAt: 1 } },
    { nativeConfirmation: { operationId: 'foreign-confirmation', run: f.session.run,
      previousNativeHandle: { ...handle, providerId: 'codex', sessionId: 'previous' },
      nativeHandle: { ...handle, providerId: 'codex' }, observedAt: 1, candidateObservedAt: 1 } }
  ]) {
    f.replace({ ...f.session, ...invalid })
    await expect(f.store.readHistorySource(f.session.agentSessionId)).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
  }
  const invalidRecovery = { ...f.session, continuityOperations: { broken: {} } }
  f.replace(invalidRecovery)
  expect(await f.store.readHistorySource(f.session.agentSessionId)).toMatchObject({ history: { nativeHandle: handle } })
  await expect(f.store.readMetadata(f.session.agentSessionId)).rejects.toThrow()
  f.replace(JSON.parse(f.original))
  await expect(f.store.compareAndSwap(f.session, invalidRecovery as unknown as typeof f.session)).rejects.toThrow()
  expect(f.raw()).toBe(f.original)
  f.assertNoControls()
})
