import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { observeAgent, parseGoalContinuationLoop } from '@agentmux/core'
import { openDemandStore } from '@agentmux/demand'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store'
import { rpcControlRequest, parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands'
let root: string, goals: ReturnType<typeof openDemandStore>, store: ContinuousProgressLoopStore, manager: ContinuousProgressLoopManager
let now: number, readsFail: boolean, confirmed: boolean, occupied: boolean, delayedObserve: boolean, runId: string, sent: string[]
const target = { hostId: 'local', agentSessionId: 'original', providerId: 'generic', workspacePath: _hygiene_fixturePath("original-work") }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ag-daily-goal-')); now = 1; readsFail = false; confirmed = false; occupied = false; delayedObserve = false; runId = 'original-run'; sent = []
  goals = openDemandStore({ root: join(root, 'goals') }); store = new ContinuousProgressLoopStore(join(root, 'loops.json'))
  await goals.create({ id: 'goal', title: 'Work', description: 'Original content', sessionIds: ['original'] })
  await goals.proposeAlignment('goal', { summary: 'Useful work', criteria: [{ id: 'result', text: 'Real result' }], openQuestions: [] }); await goals.confirmAlignment('goal', 1)
  manager = make()
})
function make() { return new ContinuousProgressLoopManager(store, async (_loop, op) => { sent.push(op); return 'unknown' }, () => now,
  async (_loop, tickId) => { if (delayedObserve) await new Promise(resolve => setTimeout(resolve, 20)); return ({ session: { ..._loop, run: { runId }, semanticStatus: { state: 'done', source: 'native-hook', observedAt: 1 } }, tickId, now, inputByte: 0, inputOccupied: occupied,
    observation: observeAgent({ process: 'running', status: { state: 'done', source: 'native-hook', observedAt: 1 }, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, now) }) },
  undefined, { read: id => readsFail ? Promise.reject(new Error('Original Goal owner is unreadable')) : goals.get(id), subscribe: listener => goals.subscribe(snapshot => listener(snapshot.demands)), inspectInitial: async () => confirmed ? 'confirmed' : 'unconfirmed' }) }
const begin = () => manager.prepareGoal({ ...target, goalId: 'goal', alignmentRevision: 1, intervalMs: 100, operationId: 'original-start', prompt: 'Original content' })
afterEach(async () => { await manager.stop(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
it('persisted initial unknown cannot be reconstructed from a missing original input receipt after cold load', async () => {
  const loop = await begin(); await manager.initialGoalInput(target, loop.loopId, 'original-start', 'begin')
  await manager.stop(); manager = make(); await manager.start()
  expect(manager.list()[0]).toMatchObject({ status: 'paused', creationOperationId: 'original-start', initialDelivery: { state: 'unknown' } })
  await expect(manager.initialGoalInput(target, loop.loopId, 'original-start', 'begin')).rejects.toThrow('No new operation')
  expect(sent).toEqual([])
  const saved = await begin(); expect(saved.loopId).toBe(loop.loopId)
  confirmed = true; expect(await manager.initialGoalInput(target, loop.loopId, 'original-start', 'confirm')).toMatchObject({ status: 'active', initialDelivery: { state: 'confirmed' } })
})
it('unknown continuation keeps the same pending transaction but fresh Goal changes reject its retry', async () => {
  const loop = await begin(); confirmed = true; await manager.initialGoalInput(target, loop.loopId, 'original-start', 'confirm')
  now = 101; await manager.check(now); const unknown = manager.list()[0]!
  expect(unknown).toMatchObject({ status: 'paused', lastOutcome: 'unknown', pendingCompletion: { operationId: sent[0] } })
  await goals.proposeAlignment('goal', { summary: 'New scope', criteria: [{ id: 'result', text: 'Different work' }], openQuestions: [] }); await goals.confirmAlignment('goal', 2)
  await expect(manager.goalAction('goal', loop.loopId, 'resume', 1, 'resume')).rejects.toThrow('scope changed')
  expect(manager.list()[0]!.pendingCompletion).toEqual(unknown.pendingCompletion); expect(sent).toHaveLength(1)
  expect(await manager.goalAction('goal', loop.loopId, 'stop', 1, 'stop-old')).toMatchObject({ status: 'stopped', pendingCompletion: unknown.pendingCompletion })
})
it.each([false, true])('the original stopped initial operation stays stopped on begin retry (confirmed=%s)', async confirmedInitial => {
  const loop = await begin(); await manager.initialGoalInput(target, loop.loopId, 'original-start', 'begin')
  if (confirmedInitial) { confirmed = true; await manager.initialGoalInput(target, loop.loopId, 'original-start', 'confirm') }
  await manager.goalAction('goal', loop.loopId, 'stop', 1, 'stop-original')
  await expect(manager.initialGoalInput(target, loop.loopId, 'original-start', 'begin')).rejects.toThrow()
  expect(manager.list()[0]).toMatchObject({ status: 'stopped', creationOperationId: 'original-start', initialDelivery: { state: confirmedInitial ? 'confirmed' : 'unknown' } })
  expect(sent).toEqual([])
  if (confirmedInitial) expect(await manager.initialGoalInput(target, loop.loopId, 'original-start', 'confirm')).toMatchObject({ status: 'stopped' })
})
it('a later pause or delayed original confirmation never revives a stopped Goal loop', async () => {
  const loop = await begin(); await manager.initialGoalInput(target, loop.loopId, 'original-start', 'begin')
  await manager.goalAction('goal', loop.loopId, 'stop', 1, 'stop-original')
  await expect(manager.goalAction('goal', loop.loopId, 'pause', 2, 'later-pause')).rejects.toThrow()
  expect(manager.list()[0]).toMatchObject({ status: 'stopped', revision: 2, lastMutation: { operationId: 'stop-original' } })
  await goals.update('goal', { status: 'blocked' }); confirmed = true
  expect(await manager.initialGoalInput(target, loop.loopId, 'original-start', 'confirm')).toMatchObject({ status: 'stopped', initialDelivery: { state: 'confirmed' } })
  expect(sent).toEqual([])
})
it('the original interval caller and a lost stop durability receipt retain the stopped Goal intent', async () => {
  const loop = await begin(); confirmed = true; await manager.initialGoalInput(target, loop.loopId, 'original-start', 'confirm')
  vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('Actual stop durability ACK lost'))
  await expect(manager.goalAction('goal', loop.loopId, 'stop', 1, 'stop-original')).rejects.toThrow('ACK lost')
  expect(manager.list()[0]).toMatchObject({ status: 'stopped', lastDecision: expect.stringContaining('persistence is unconfirmed'), lastMutation: { operationId: 'stop-original' } })
  expect(await manager.pause(loop.loopId)).toMatchObject({ status: 'stopped' })
  readsFail = true; await expect(manager.resume(loop.loopId)).resolves.toMatchObject({ status: 'stopped' })
  readsFail = false; expect(await manager.goalAction('goal', loop.loopId, 'stop', 1, 'stop-original')).toMatchObject({ status: 'stopped', revision: 2 })
  expect(sent).toEqual([])
})
it('one original business operation cannot create two loops across concurrent exact associated targets', async () => {
  await goals.linkSession('goal', 'another-original'); delayedObserve = true
  expect((await goals.get('goal'))?.sessionIds).toEqual(['original', 'another-original'])
  const results = await Promise.allSettled([begin(), manager.prepareGoal({ ...target, agentSessionId: 'another-original', goalId: 'goal', alignmentRevision: 1, intervalMs: 100, operationId: 'original-start', prompt: 'Original content' })])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  expect(manager.list()).toHaveLength(1); expect(manager.list()[0]!.creationOperationId).toBe('original-start')
  expect((await store.load())).toHaveLength(1); expect(sent).toEqual([])
  expect((await begin()).loopId).toBe(manager.list()[0]!.loopId)
})
it.each(['blocked', 'done', 'cancelled'] as const)('authoritative %s affects only this original loop and keeps its source', async status => {
  const loop = await begin(); confirmed = true; await manager.initialGoalInput(target, loop.loopId, 'original-start', 'confirm')
  await goals.update('goal', { status })
  expect(manager.list()[0]).toMatchObject({ status: status === 'blocked' ? 'paused' : 'stopped', taskSource: { goalId: 'goal', alignmentRevision: 1 } })
  now = 101; await manager.check(now); expect(sent).toEqual([])
})
it('source read unknown, changed Run and an occupied original composer all prevent continuation without replacing identity', async () => {
  const loop = await begin(); confirmed = true; await manager.initialGoalInput(target, loop.loopId, 'original-start', 'confirm')
  readsFail = true; now = 101; await manager.check(now); expect(manager.list()[0]).toMatchObject({ status: 'paused', lastDecision: expect.stringContaining('unreadable') }); expect(sent).toEqual([])
  readsFail = false; occupied = true; await expect(manager.goalAction('goal', loop.loopId, 'resume', 1, 'resume-draft')).rejects.toThrow('draft')
  occupied = false; runId = 'replacement-run'; await expect(manager.goalAction('goal', loop.loopId, 'resume', 1, 'resume-run')).rejects.toThrow('Run changed')
  expect(manager.list()[0]!.initialDelivery!.condition.expectedRun.runId).toBe('original-run')
})
it('a failed mutation durability retry joins the exact operation and does not silently lose its pause', async () => {
  const loop = await begin(); confirmed = true; await manager.initialGoalInput(target, loop.loopId, 'original-start', 'confirm')
  vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('Original durable ACK unavailable'))
  await expect(manager.goalAction('goal', loop.loopId, 'pause', 1, 'pause-op')).rejects.toThrow('ACK unavailable')
  expect(await manager.goalAction('goal', loop.loopId, 'pause', 1, 'pause-op')).toMatchObject({ status: 'paused', revision: 2, lastMutation: { operationId: 'pause-op', expectedRevision: 1 } })
  await expect(manager.goalAction('goal', loop.loopId, 'resume', 1, 'pause-op')).rejects.toThrow('different content')
  expect(sent).toEqual([])
})
it('public request and actual result codecs carry business operation and reject missing or foreign receipt facts', async () => {
  const loop = await begin()
  const request = rpcControlRequest('goal.start', { goalId: 'goal', sessionId: 'original', operationId: 'original-start', continuation: { intervalMs: 100, alignmentRevision: 1 } })
  expect(request.requestId).toBe('original-start')
  const caller = { agentSessionId: 'original', capability: 'original-private-capability' }
  expect(rpcControlRequest('goal.start', { goalId: 'goal', sessionId: 'original', operationId: 'original-start', continuation: { intervalMs: 100, alignmentRevision: 1 } }, caller)).toMatchObject({ caller })
  expect(rpcControlRequest('goal.continuation-action', { goalId: 'goal', loopId: loop.loopId, action: 'pause', expectedRevision: 1, operationId: 'pause-op' }, caller)).toMatchObject({ caller })
  const saved = (await goals.get('goal'))!; const { executorId, ...fields } = saved; const goal = { ...fields, assigneeExecutorId: executorId, source: 'default-topic', activityLog: [], decisionLog: [] }; const reply = { goal, receipt: { goalId: 'goal', sessionId: 'original', startedAt: 1 }, continuation: loop }
  expect(parseRpcControlResult('goal.start', reply, { goalId: 'goal', sessionId: 'original', operationId: 'original-start', continuation: { intervalMs: 100, alignmentRevision: 1 } })).toMatchObject({ continuation: { creationOperationId: 'original-start' } })
  const params = { goalId: 'goal', sessionId: 'original', operationId: 'original-start', continuation: { intervalMs: 100, alignmentRevision: 1 } }
  for (const continuation of [undefined, { ...loop, agentSessionId: 'foreign' }, { ...loop, creationOperationId: 'wire-is-different' }, { ...loop, taskSource: { kind: 'goal', goalId: 'foreign', alignmentRevision: 1 } }]) expect(() => parseRpcControlResult('goal.start', { ...reply, continuation }, params)).toThrow()
  expect(() => parseRpcControlResult('goal.inspect', { goal, goalContinuations: [loop] }, { goalId: 'foreign' })).toThrow()
  expect(() => parseGoalContinuationLoop({ ...loop, initialDelivery: undefined })).toThrow()
  await expect(parseAgentMuxCliInvocation(['goal', 'start', '--goal', 'goal', '--continue-ms', '100'])).rejects.toThrow()
})
