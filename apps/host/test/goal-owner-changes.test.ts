import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDemandStore, demandExecutionReferences, demandResponsibilityScope, type Demand, type DemandStoreChanges } from '@agentmux/demand'
import { observeAgent, type AgentMuxClientEvent } from '@agentmux/core'
import { GoalDelegationAttentionOwner } from '../src/goal-delegation-attention.js'
import { GoalStartResponsibilityOwner } from '../src/goal-start-responsibility.js'
import { GoalResponsibilityOwner } from '../src/goal-responsibility-owner.js'
import { GoalPatrolOwner } from '../src/goal-patrol-owner.js'
import { ContinuousProgressLoopManager } from '../src/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/continuous-progress-loop-store.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks()
  if (process.env.AGENTMUX_GOAL_OWNER_RECOVERY_FACTS) await appendFile(process.env.AGENTMUX_GOAL_OWNER_RECOVERY_FACTS,
    JSON.stringify({ case: expect.getState().currentTestName, cleanup: 'confirmed', scope: 'Actual Demand file mutations and scoped Goal event owners; controlled Runtime ports, no installed Runtime claim.' }) + '\n')
})
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
const kinds = ['attention', 'start', 'responsibility', 'patrol'] as const
type Kind = typeof kinds[number]
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'goal-owner-changes-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const demands = openDemandStore({ root: join(root, 'goals') })
  for (const id of ['goal-a', 'goal-b']) {
    await demands.create({ id, title: id, sessionIds: ['manager', 'worker'], assigneeSessionIds: ['manager', 'worker'], supervisorSessionId: 'manager', status: 'in_progress' })
    await demands.proposeAlignment(id, { summary: 'Original scope', criteria: [{ id: 'criterion', text: 'Observable result' }], openQuestions: [] })
    await demands.confirmAlignment(id, 1)
  }
  const pending = new Set<Promise<unknown>>()
  for (const method of ['get', 'snapshot', 'preparePatrol', 'prepareDelegationAttention', 'markDelegationAttentionAttempt', 'prepareDispatchAttention', 'markDispatchAttentionAttempt'] as const) {
    const original = demands[method].bind(demands)
    vi.spyOn(demands, method).mockImplementation(((...args: unknown[]) => {
      const result = (original as (...values: unknown[]) => Promise<unknown>)(...args)
      pending.add(result); result.then(() => pending.delete(result), () => pending.delete(result)); return result
    }) as never)
  }
  const settle = async () => {
    for (let quiet = 0; quiet < 3;) {
      await Promise.allSettled([...pending]); await new Promise<void>(yes => setImmediate(yes))
      quiet = pending.size ? 0 : quiet + 1
    }
  }
  let consume: ((host: string, event: AgentMuxClientEvent) => void) | undefined
  const status = (agentSessionId: string) => {
    const semanticStatus = { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 }
    const run = { runId: agentSessionId === 'manager' ? 'manager-run' : 'worker-run', state: 'running' as const }
    return { session: { agentSessionId, hostId: 'local', providerId: 'codex', workspacePath: root, run, semanticStatus }, run,
      observation: observeAgent({ process: 'running', status: semanticStatus, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, 1) }
  }
  const runtime = {
    observeCoreEvents: (_types: unknown, listener: typeof consume) => { consume = listener; return () => { consume = undefined } },
    observeInputOccupation: () => () => {},
    observeOriginalRun: vi.fn(async (_host: string, runId: string) => ({ runId, state: 'running' as const })),
    inspectGoalStart: vi.fn(async () => null),
    saveGoalAttention: vi.fn(async () => {}),
    inspectGoalAttention: vi.fn(async () => null),
    observeGoalAgent: vi.fn(async (_host: string, id: string) => status(id)),
    resolveGoalAgent: vi.fn(async (id: string) => ({ hostId: 'local', status: status(id) })),
    agentCreation: vi.fn(async (_host: string, agentSessionId: string) => ({ kind: 'agent', agentSessionId, hostId: 'local', providerId: 'codex', workspacePath: root, run: { runId: 'manager-run' } })),
    observeContinuousProgress: vi.fn(async (_target: unknown, tickId: string, now: number) => ({ session: { agentSessionId: 'manager', hostId: 'local', providerId: 'codex', workspacePath: root, run: { runId: 'manager-run' } },
      observation: observeAgent({ process: 'running', status: { state: 'working', source: 'native-hook', observedAt: now }, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, now), tickId, now, inputByte: 0 })),
    submitPrompt: vi.fn(async () => { throw new Error('Index changes must not introduce a Native input.') })
  }
  const read = vi.fn(async (goalId: string) => {
    const goal = (await demands.get(goalId))!
    return { goalId, goalUpdatedAt: goal.updatedAt, delegations: goal.delegations ?? [], dispatches: goal.dispatches ?? [], diskDurability: 'confirmed' as const }
  })
  const create = (kind: Kind) => {
    const changed = () => {}
    const owner = kind === 'attention' ? new GoalDelegationAttentionOwner(demands, runtime as never, { observeDelegation: async () => ({ workerRun: { state: 'running' } }) } as never, changed)
      : kind === 'start' ? new GoalStartResponsibilityOwner(demands, runtime as never, changed)
      : kind === 'responsibility' ? new GoalResponsibilityOwner(demands, runtime as never, read as never, changed)
      : new GoalPatrolOwner(demands, runtime as never, read as never, changed)
    cleanup.push(async () => { owner.dispose(); await settle() })
    return owner
  }
  const seed = async (kind: Kind) => {
    for (const goalId of ['goal-a', 'goal-b']) {
      if (kind === 'attention') await demands.prepareDelegation(goalId, { operationId: goalId + '-delegation', sourceMessageId: goalId + '-source', hostId: 'local', ownerAgentSessionId: 'manager', workerAgentSessionId: 'worker', ownerRunId: 'manager-run', workerRunId: 'worker-run', threadId: goalId + '-thread', text: 'Original delegated work', alignmentRevision: 1, criterionIds: ['criterion'] }, 'manager')
      else {
        await demands.prepareDispatch(goalId, { operationId: goalId + '-start', agentSessionId: 'worker', hostId: 'local', runId: 'worker-run', execution: 'finite', prompt: 'Original task' })
        if (kind === 'patrol') {
          const goal = (await demands.get(goalId))!
          await demands.preparePatrol(goalId, { operationId: goalId + '-patrol', expectedScope: demandResponsibilityScope(goal), executions: demandExecutionReferences(goal), supervisorAgentSessionId: 'manager', context: 'Frozen original scope', requestedBy: { kind: 'user', id: 'original-user' },
            attempt: { operationId: goalId + '-patrol-input', actionOperationId: goalId + '-patrol', intentId: goalId + '-patrol-input', target: { agentSessionId: 'manager', hostId: 'local', runId: 'manager-run', providerId: 'codex', workspacePath: root }, agentMuxNote: 'Original patrol packet' } })
        }
      }
    }
  }
  const emit = (kind: Kind) => {
    expect(consume).toEqual(expect.any(Function))
    consume!('local', kind === 'patrol' ? { type: 'agent-session', session: { agentSessionId: 'manager', run: { runId: 'manager-run' } } } as AgentMuxClientEvent
      : { type: 'process-state', run: { runId: 'worker-run' }, state: 'running', pid: null, evidence: { source: 'run-process', observedAt: 1 } } as AgentMuxClientEvent)
  }
  return { root, demands, create, seed, emit, settle, runtime }
}

it('publishes exact changed records and tombstones from the acknowledged Demand revision', async () => {
  const f = await fixture(), received: Array<{ revision: number; ids: readonly string[]; records: DemandStoreChanges }> = []
  const off = f.demands.subscribe((snapshot, ids, records) => { received.push({ revision: snapshot.revision, ids, records }) })
  try {
    const updated = await f.demands.update('goal-a', { description: 'Changed original work' })
    expect(received.at(-1)).toEqual({ revision: updated.revision, ids: ['goal-a'], records: new Map([['goal-a', updated.demand]]) })
    const removed = await f.demands.remove('goal-a')
    expect(received.at(-1)).toEqual({ revision: removed.revision, ids: ['goal-a'], records: new Map([['goal-a', null]]) })
    expect((await f.demands.get('goal-b'))!.title).toBe('goal-b')
  } finally { off() }
})

it.each(kinds)('%s updates one Goal without reading unrelated published history and preserves a shared execution index on removal', async kind => {
  const f = await fixture(); await f.seed(kind)
  let unrelatedReads = 0
  const originalSubscribe = f.demands.subscribe.bind(f.demands)
  vi.spyOn(f.demands, 'subscribe').mockImplementation(listener => originalSubscribe((snapshot, ids, changes) => {
    const demands = snapshot.demands.map(goal => goal.id === 'goal-b' ? new Proxy(goal, { get(target, field, receiver) {
      if (['delegations', 'dispatches', 'patrols', 'progressUpdates', 'grounding', 'alignment'].includes(String(field))) unrelatedReads++
      return Reflect.get(target, field, receiver)
    } }) : goal)
    listener({ ...snapshot, demands }, ids, changes)
  }))
  const owner = f.create(kind); await owner.start(); await f.settle()
  unrelatedReads = 0
  await f.demands.update('goal-a', { description: 'Related original change' }); await f.settle()
  expect(unrelatedReads).toBe(0)
  await f.demands.remove('goal-a'); await f.settle()
  expect(unrelatedReads).toBe(0)
  vi.mocked(f.demands.get).mockClear()
  f.emit(kind); await f.settle()
  expect(f.demands.get).toHaveBeenCalledWith('goal-b')
  expect(f.demands.get).not.toHaveBeenCalledWith('goal-a')
  expect(f.runtime.submitPrompt).not.toHaveBeenCalled()
})

it.each(kinds)('%s does not resurrect a removed Goal when its initial snapshot finishes after a newer mutation', async kind => {
  for (const result of ['snapshot', 'error'] as const) {
    const f = await fixture(); await f.seed(kind)
    const original = await f.demands.snapshot(), entered = deferred(), release = deferred()
    const failure = 'Original startup read failed late'
    vi.mocked(f.demands.snapshot).mockImplementationOnce(async () => { entered.resolve(); await release.promise; if (result === 'error') throw new Error(failure); return original })
    const owner = f.create(kind), starting = owner.start()
    await entered.promise
    await f.demands.remove('goal-a')
    release.resolve(); await starting; await f.settle()
    vi.mocked(f.demands.get).mockClear()
    f.emit(kind); await f.settle()
    expect(f.demands.get).toHaveBeenCalledWith('goal-b')
    expect(f.demands.get).not.toHaveBeenCalledWith('goal-a')
    expect(f.runtime.submitPrompt).not.toHaveBeenCalled()
    const goal = (await f.demands.get('goal-b'))!
    const observed = owner instanceof GoalDelegationAttentionOwner ? await owner.observe(goal.id, goal.delegations![0]!)
      : owner instanceof GoalStartResponsibilityOwner ? await owner.observe(goal, goal.dispatches![0]!)
      : owner instanceof GoalPatrolOwner ? await owner.observe(goal)
      : await owner.observe(goal, { goalId: goal.id, goalUpdatedAt: goal.updatedAt, dispatches: goal.dispatches ?? [], delegations: goal.delegations ?? [], diskDurability: 'confirmed' })
    expect(JSON.stringify(observed) ?? '').not.toContain(failure)
  }
})

it.each(kinds)('%s resynchronizes the same shared file on a real external revision gap without retaining the removed target', async kind => {
  const f = await fixture(); await f.seed(kind)
  const owner = f.create(kind); await owner.start(); await f.settle()
  const before = await f.demands.snapshot(), external = openDemandStore({ root: join(f.root, 'goals') })
  const events: Array<{ revision: number; ids: readonly string[] }> = []
  const off = f.demands.subscribe((snapshot, ids) => { events.push({ revision: snapshot.revision, ids }) })
  try {
    await external.remove('goal-a')
    expect(events).toEqual([])
    await f.demands.update('goal-b', { description: 'Original shared-file mutation' }); await f.settle()
    expect(events).toEqual([{ revision: before.revision + 2, ids: ['goal-b'] }])
    vi.mocked(f.demands.get).mockClear()
    f.emit(kind); await f.settle()
    expect(f.demands.get).toHaveBeenCalledWith('goal-b')
    expect(f.demands.get).not.toHaveBeenCalledWith('goal-a')
    expect(f.runtime.submitPrompt).not.toHaveBeenCalled()
  } finally { off() }
})

it.each(['local', 'external'] as const)('Goal progress reads only its changed Goal loops and cancels its pending original admission in the same %s mutation delivery', async origin => {
  const f = await fixture(), store = ContinuousProgressLoopStore.forUserData(f.root)
  const session = { agentSessionId: 'manager', hostId: 'local', providerId: 'codex', workspacePath: f.root, run: { runId: 'manager-run' } }
  const manager = new ContinuousProgressLoopManager(store, async () => 'skipped', () => 0,
    async (_loop, tickId, now) => ({ session, observation: observeAgent({ process: 'running', status: { state: 'done', source: 'native-hook', observedAt: 1 }, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, now), tickId, now, inputByte: 0 }), undefined,
    { read: id => f.demands.get(id), subscribe: listener => f.demands.subscribe((snapshot, _ids, changes) => listener(changes, snapshot.revision, snapshot.demands)), inspectInitial: async () => 'unconfirmed' })
  cleanup.push(() => manager.stop())
  const loop = await manager.prepareGoal({ ...session, goalId: 'goal-a', alignmentRevision: 1, intervalMs: 60_000, operationId: 'goal-a-start', prompt: 'goal-a' })
  const unrelated = await manager.create({ ...session, agentSessionId: 'unrelated-session', intervalMs: 60_000, operationId: 'unrelated-loop', prompt: 'Unrelated retained work' })
  const clone = vi.spyOn(globalThis, 'structuredClone')
  await f.demands.update('goal-a', { description: 'Related description' })
  expect(await manager.listGoals('goal-a')).toMatchObject([{ loopId: loop.loopId }])
  expect(clone.mock.calls.some(([value]) => value && typeof value === 'object' && 'loopId' in value && value.loopId === unrelated.loopId)).toBe(false)
  clone.mockRestore()
  const entered = deferred(), release = deferred()
  let signal: AbortSignal | undefined, synchronousCancellation: boolean | undefined, nativeInputs = 0
  const off = f.demands.subscribe(() => { if (signal) synchronousCancellation = signal.aborted })
  try {
    const sending = manager.submitGoalInitial({ hostId: session.hostId, agentSessionId: session.agentSessionId }, 'goal-a', loop.loopId, 'goal-a-start', loop.initialDelivery!.prompt, loop.initialDelivery!.condition,
      async (_current, originalSignal) => { signal = originalSignal; entered.resolve(); await release.promise; originalSignal.throwIfAborted(); nativeInputs++ })
    const outcome = sending.then(value => ({ value }), error => ({ error }))
    await entered.promise
    if (origin === 'local') await f.demands.update('goal-a', { status: 'blocked' })
    else {
      const external = openDemandStore({ root: join(f.root, 'goals') })
      await external.update('goal-a', { status: 'blocked' })
      expect(signal!.aborted).toBe(false)
      await f.demands.update('goal-b', { description: 'Local mutation after external source change' })
    }
    expect(synchronousCancellation).toBe(true)
    release.resolve()
    expect(await outcome).toMatchObject({ error: { name: 'AbortError' } })
    expect(nativeInputs).toBe(0)
    expect(await manager.listGoals('goal-a')).toMatchObject([{ loopId: loop.loopId, status: 'paused' }])
    expect(manager.list({ hostId: 'local', agentSessionId: 'unrelated-session' })).toMatchObject([{ loopId: unrelated.loopId, status: 'active' }])
  } finally { release.resolve(); off() }
})
