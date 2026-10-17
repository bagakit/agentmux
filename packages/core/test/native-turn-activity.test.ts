import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { ObjectCliProbe } from './helpers/object-cli-rpc.js'
import type { AgentMuxRpcMethod, AgentMuxRpcParams } from '../src/public-rpc.js'
import { loadAgentSessions } from '../src/agent-session-store.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { observeCodexSessionStatus } from '../src/providers/codex-session-status.js'
import { readCodexPromptExecutionEvidence } from '../src/providers/codex-prompt-execution-evidence.js'
import type { AgentProviderSessionStatus } from '../src/types.js'

const NATIVE = 'original-native', TURN = 'original-turn', SID = 'caller'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const line = (value: unknown) => JSON.stringify(value) + '\n'
const record = (ordinal: number, type: string, turn = TURN, time: number | undefined = Date.now(), extra = {}) => ({
  ordinal, type: 'event_msg', ...(time === undefined ? {} : { timestamp: new Date(time).toISOString() }),
  payload: { type, turn_id: turn, ...(type === 'item_completed' ? { thread_id: NATIVE, item: { type: 'CommandExecution' } } : {}), ...extra }
})

async function fixture(records: unknown[]) {
  const f = await rpcOwnerFixture([SID, 'neighbor']); cleanups.push(f.close)
  for (const name of ['start', 'connect']) f.inner.kernel[name] = vi.fn(() => { throw new Error('Unexpected Runtime lifecycle action') })
  const file = join(f.root, 'original-rollout.jsonl')
  await writeFile(file, line({ type: 'session_meta', payload: { id: NATIVE, source: 'cli' } }) + records.map(line).join(''))
  const before = (await loadAgentSessions(f.store)).find(item => item.agentSessionId === SID)!
  const nativeHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: NATIVE, transcriptPath: file }
  const session = { ...before, nativeHandle }
  await f.store.compareAndSwap(before, session); await f.client.refreshAgentSession(SID, session.run)
  const semantic = () => f.client.agentSession(SID).semanticStatus
  const stored = async () => (await loadAgentSessions(f.store)).find(item => item.agentSessionId === SID)!
  const context = { args: [], workspacePath: f.root, nativeHandle, signal: new AbortController().signal }
  const service = new AgentMuxRpcService({ coreClients: f.coreClients }); cleanups.push(() => service.dispose())
  const inspect = () => service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: SID } })
  const waitSequence = (sequence: number) => vi.waitFor(() =>
    expect(Reflect.get(f.client, 'nativeStatusWatches').get(SID).sequence).toBe(sequence))
  return { ...f, file, session, context, semantic, stored, service, inspect, waitSequence }
}

it('renews a long native turn through real file watch and public inspection without restarting its state duration', async () => {
  const old = Date.now() - 20 * 60_000, f = await fixture([record(1, 'task_started', TURN, old)])
  const neighbor = f.client.agentSession('neighbor')
  await vi.waitFor(async () => expect((await f.inspect()).status?.observation).toMatchObject({ process: 'running', semantic: 'unknown', reason: 'activity-stale' }))
  expect(f.semantic()).toMatchObject({ observedAt: old, stateEnteredAt: old })
  const fresh = Date.now()
  await appendFile(f.file, line(record(2, 'item_completed', TURN, fresh)))
  await vi.waitFor(() => expect(f.semantic()?.observedAt).toBe(fresh))
  expect((await f.inspect()).status?.observation).toMatchObject({ process: 'running', semantic: 'active', stale: false })
  expect(f.semantic()).toMatchObject({ state: 'working', nativeTurnId: TURN, stateEnteredAt: old })
  expect(f.client.agentSession('neighbor')).toEqual(neighbor)
  expect(f.client.agentSession(SID).run).toEqual(f.session.run)
  await f.waitSequence(2)
  expect((await f.stored()).nativeTurnEnds).toBeUndefined()
  const commit = (await f.stored()).activityCommit
  const newer = fresh + 1
  await appendFile(f.file, line(record(3, 'item_completed', TURN, newer)))
  await vi.waitFor(() => expect(f.semantic()?.observedAt).toBe(newer))
  await f.waitSequence(3)
  expect((await f.stored()).activityCommit).toEqual(commit)
  expect((await f.inspect()).status?.session.semanticStatus?.observedAt).toBe(newer)
  const probe = new ObjectCliProbe(request => f.service.call(request.method as AgentMuxRpcMethod,
    request.params as AgentMuxRpcParams<AgentMuxRpcMethod>))
  await probe.start(); cleanups.push(() => probe.stop())
  const inspected = await probe.run(['agent', 'inspect', '--session', SID])
  expect(inspected.code, inspected.stderr).toBe(0)
  expect(JSON.parse(inspected.stdout).result.status.observation).toMatchObject({ process: 'running', semantic: 'active', observedAt: newer })
  const listed = await probe.run(['agent', 'ls', '--session', SID, '--semantic', 'active'])
  expect(listed.code, listed.stderr).toBe(0)
  expect(JSON.parse(listed.stdout).result.sessions).toHaveLength(1)
  expect(probe.requests.map(request => request.method)).toEqual(['agent.inspect', 'agent.ls'])
  for (const name of ['start', 'connect', 'stop', 'attach', 'input']) expect(f.inner.kernel[name]).not.toHaveBeenCalled()
})

it('does not turn delayed records or missing native clocks into current activity', async () => {
  const old = Date.now() - 20 * 60_000, f = await fixture([record(1, 'task_started', TURN, old)])
  await f.inspect(); await vi.waitFor(() => expect(f.semantic()?.observedAt).toBe(old))
  const missing = record(2, 'item_completed'); delete (missing as { timestamp?: string }).timestamp
  await appendFile(f.file, line(missing)); await f.waitSequence(2)
  expect(f.semantic()?.observedAt).toBe(old)
  const delayed = old + 1
  await appendFile(f.file, line(record(3, 'item_completed', TURN, delayed))); await f.waitSequence(3)
  expect(f.semantic()?.observedAt).toBe(delayed)
  expect((await f.inspect()).status?.observation).toMatchObject({ semantic: 'unknown', reason: 'activity-stale' })
  await appendFile(f.file, line(record(4, 'item_completed', TURN, old))); await f.waitSequence(4)
  expect(f.semantic()?.observedAt).toBe(delayed)
  expect(f.semantic()?.stateEnteredAt).toBe(old)
})

it('uses the same native ordering and turn boundaries in retained and live readers', async () => {
  const old = Date.now() - 20 * 60_000, f = await fixture([record(1, 'task_started', TURN, old)])
  const seen: AgentProviderSessionStatus[] = [], unavailable: string[] = []
  const watch = await observeCodexSessionStatus({ ...f.context, onStatus: status => seen.push(status), onUnavailable: code => unavailable.push(code) })
  cleanups.push(async () => watch.dispose())
  const batches = [
    { rows: [record(2, 'item_completed', TURN)], turn: TURN, state: 'working', sequence: 2 },
    { rows: [record(3, 'item_completed', 'old-turn'), record(4, 'item_completed', TURN, undefined, { thread_id: 'child-native' }),
      record(1, 'task_started', 'old-turn')], turn: TURN, state: 'working', sequence: 2 },
    { rows: [record(5, 'task_complete', TURN), record(6, 'item_completed', TURN)], turn: TURN, state: 'done', sequence: 5 },
    { rows: [record(7, 'task_started', 'next-turn'), record(8, 'item_completed', TURN), record(9, 'item_completed', 'next-turn')],
      turn: 'next-turn', state: 'working', sequence: 9 }
  ]
  for (const batch of batches) {
    await appendFile(f.file, batch.rows.map(line).join(''))
    const retained = await readCodexPromptExecutionEvidence(f.context)
    expect(retained).toMatchObject({ nativeTurnId: batch.turn, nativeOrdinal: batch.sequence,
      state: batch.state === 'done' ? 'ended' : 'working' })
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ nativeTurnId: batch.turn, state: batch.state, sequence: batch.sequence }))
  }
  expect(seen.map(status => status.sequence)).toEqual([1, 2, 5, 7, 9])
  expect(unavailable).toEqual([])
})

it('keeps a missing native working clock and state entry unknown', async () => {
  const f = await fixture([]); await f.inspect()
  await vi.waitFor(() => expect(Reflect.get(f.client, 'nativeStatusWatches').get(SID).observer).toBeDefined())
  const missing = record(1, 'task_started'); delete (missing as { timestamp?: string }).timestamp
  await appendFile(f.file, line(missing)); await f.waitSequence(1)
  expect(f.semantic()).toMatchObject({ state: 'working', observedAt: 0 })
  expect(f.semantic()?.stateEnteredAt).toBeUndefined()
  expect((await f.inspect()).status?.observation.semantic).toBe('unknown')
})

it.each(['idle', 'unknown'] as const)('preserves the authoritative current main activity %s during a native working refresh', async state => {
  const old = Date.now() - 20 * 60_000, f = await fixture([record(1, 'task_started', TURN, old)])
  await f.inspect(); await vi.waitFor(() => expect(f.semantic()?.observedAt).toBe(old))
  await Reflect.get(f.client, 'nativeStatusWatches').get(SID).pending
  const before = await f.stored()
  const currentActivity = { state, source: 'native-hook' as const, run: before.run, hookReceiptId: 'original-activity',
    observedAt: Date.now(), nativeSessionId: NATIVE, nativeTurnId: TURN, sourceId: 'original-source', sequence: 1 }
  // Provider activity is a live Core observation, separate from the durable semantic status.
  Reflect.get(f.client, 'nativeCurrentActivities').set(SID, { runId: before.run.runId, event: currentActivity,
    fact: currentActivity, conflicted: false, invalidated: false })
  const fresh = Date.now() + 1
  await appendFile(f.file, line(record(2, 'item_completed', TURN, fresh))); await f.waitSequence(2)
  expect(f.semantic()?.observedAt).toBe(fresh)
  const inspected = await f.inspect()
  expect(inspected.status?.session.currentActivity).toEqual(currentActivity)
  expect(inspected.status?.observation).toMatchObject({ process: 'running', semantic: state, source: 'native-hook' })
})

it('retains a resumed predecessor terminal fence while suppressing its display', async () => {
  const f = await fixture([record(1, 'task_complete')])
  const predecessor = (await readCodexPromptExecutionEvidence(f.context))!
  const context = { ...f.context, nativePromptPredecessor: { run: { runId: 'resumed-run' }, previousRun: f.session.run,
    sourceId: predecessor.sourceId, evidenceId: predecessor.id } }
  const seen: AgentProviderSessionStatus[] = [], unavailable: string[] = []
  const watch = await observeCodexSessionStatus({ ...context, onStatus: status => seen.push(status), onUnavailable: code => unavailable.push(code) })
  cleanups.push(async () => watch.dispose())
  await appendFile(f.file, line(record(2, 'item_completed')) + line(record(3, 'task_started', 'next-turn')))
  await vi.waitFor(() => expect(seen.at(-1)?.nativeTurnId).toBe('next-turn'))
  expect(seen.map(status => status.sequence)).toEqual([3])
  expect(await readCodexPromptExecutionEvidence(context)).toMatchObject({ state: 'working', nativeTurnId: 'next-turn', nativeOrdinal: 3 })
  expect(unavailable).toEqual([])
})

it('does not let delayed same-turn activity overwrite a newer Hook waiting fact', async () => {
  const old = Date.now() - 20 * 60_000, f = await fixture([record(1, 'task_started', TURN, old)])
  await f.inspect(); await vi.waitFor(() => expect(f.semantic()?.observedAt).toBe(old))
  await Reflect.get(f.client, 'nativeStatusWatches').get(SID).pending
  const before = await f.stored(), now = Date.now()
  const semanticStatus = { state: 'waiting' as const, source: 'native-hook' as const,
    observedAt: now, stateEnteredAt: now, nativeTurnId: TURN }
  await f.store.compareAndSwap(before, { ...before, semanticStatus, updatedAt: now }); await f.client.refreshAgentSession(SID, before.run)
  await appendFile(f.file, line(record(2, 'item_completed', TURN, now - 1))); await f.waitSequence(2)
  expect(f.semantic()).toEqual(semanticStatus)
  expect((await f.inspect()).status?.observation).toMatchObject({ process: 'running', semantic: 'awaiting-input' })
})
