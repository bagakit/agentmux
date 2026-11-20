import { goalTickets } from './helpers/goal-tickets.js'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'
import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import type { DemandDelegationIntent } from '../src/delegations.js'
import { goalPlanDelegationIssue, goalPlanState, projectGoalPlan, type GoalPlanNodeInput } from '../src/goal-plan.js'

/**
 * A Goal plan is a dependency graph inside one Goal. Node state comes only from the plan, this
 * Goal's delegations and review verdicts; execution and threads stay with the delegation owner.
 */
let root: string, store: ReturnType<typeof openDemandStore>
let tickets: ReturnType<typeof goalTickets>
const supervisor = { kind: 'agent' as const, id: 'mote' }
const criteria = [{ id: 'api', text: 'The API returns the plan' }, { id: 'ui', text: 'The graph shows every node' }]
const node = (id: string, dependsOn: string[] = [], patch: Partial<GoalPlanNodeInput> = {}): GoalPlanNodeInput =>
  ({ id, title: `Node ${id}`, outcome: `Outcome of ${id}`, dependsOn, criterionIds: ['api'], check: `pnpm test ${id}`, executor: null, ...patch })
const delegation = (nodeId: string, worker = 'worker-a', attempt = 1): DemandDelegationIntent => ({
  operationId: `delegate-${nodeId}-${attempt}`, sourceMessageId: `source-${nodeId}-${attempt}`, hostId: 'local', ownerAgentSessionId: 'mote', workerAgentSessionId: worker,
  ownerRunId: 'mote-run', workerRunId: `${worker}-run`, threadId: `thread-${nodeId}`, text: `Do ${nodeId}`, alignmentRevision: 1, criterionIds: ['api'], planNodeId: tickets.id(nodeId) })
const report = (task: DemandDelegationIntent) => ({ operationId: `report-${task.operationId}`, replyMessageId: `reply-${task.operationId}`, authorAgentSessionId: task.workerAgentSessionId,
  grounding: { alignmentRevision: task.alignmentRevision, summary: `Delivered ${task.planNodeId}`, checks: task.criterionIds.map(criterionId => ({ criterionId, outcome: 'met' as const, evidence: [`log/${task.planNodeId}.txt:3`], note: '' })) } })
const pass = (nodeId: string, delegationOperationId: string, operationId = `review-${delegationOperationId}`) => ({ operationId, nodeId, delegationOperationId, verdict: 'pass' as const,
  check: { command: `pnpm test ${nodeId}`, result: '12 passed', evidence: [`ci/${nodeId}.log:1`] }, note: '' })

async function deliver(task: DemandDelegationIntent) {
  await store.prepareDelegation('goal', task, 'mote')
  await store.linkDelegation('goal', task.operationId, task.sourceMessageId, 'mote')
  await tickets.submit('goal', task.operationId, report(task), task.workerAgentSessionId)
}
async function states() {
  const goal = (await store.get('goal'))!
  return Object.fromEntries(projectGoalPlan(goal.plan!, goal.delegations ?? [], goal.alignment!.criteria).nodes.map(item => [tickets.draft(item.node.id), item.state]))
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'goal-plan-'))
  tickets = goalTickets(root); store = tickets.store
  await seedStoredDemand(store, { id: 'goal', title: 'Ship the plan', description: 'A real outcome', status: 'in_progress',
    sessionIds: ['mote', 'worker-a', 'worker-b', 'reviewer'], assigneeSessionIds: ['mote', 'worker-a', 'worker-b', 'reviewer'], supervisorSessionId: 'mote' })
  await store.proposeAlignment('goal', { summary: 'Plan inside the Goal', criteria, openQuestions: [] })
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

describe('plan revision', () => {
  it('records each revision once, in order, with its author', async () => {
    await tickets.revise('goal', { operationId: 'plan-1', expectedRevision: 0, alignmentRevision: 1, nodes: [node('a'), node('b', ['a'])] }, supervisor)
    const replay = await tickets.revise('goal', { operationId: 'plan-1', expectedRevision: 0, alignmentRevision: 1, nodes: [node('a'), node('b', ['a'])] }, supervisor)
    expect(replay.replayed).toBe(true)
    await tickets.revise('goal', { operationId: 'plan-2', expectedRevision: 1, alignmentRevision: 1, nodes: [node('a'), node('b', ['a']), node('c', ['a'])] }, { kind: 'user', id: 'person' })
    const plan = (await store.get('goal'))!.plan!
    expect(plan.revision).toBe(2)
    expect(plan.history.map(record => [record.operationId, record.revision, record.author.id])).toEqual([['plan-1', 1, 'mote'], ['plan-2', 2, 'person']])
  })

  it('rejects a revision written against a plan the author has not read', async () => {
    await tickets.revise('goal', { operationId: 'plan-1', expectedRevision: 0, alignmentRevision: 1, nodes: [node('a')] }, supervisor)
    await expect(tickets.revise('goal', { operationId: 'late', expectedRevision: 0, alignmentRevision: 1, nodes: [node('x')] }, { kind: 'user', id: 'person' }))
      .rejects.toThrow('changed to revision 1 after you read revision 0')
    expect((await store.get('goal'))!.plan!.nodes.map(item => item.id)).toEqual([tickets.id('a')])
  })

  it('refuses cycles, self dependencies and dependencies outside the plan', async () => {
    const revise = (nodes: GoalPlanNodeInput[]) => tickets.revise('goal', { operationId: 'bad', expectedRevision: 0, alignmentRevision: 1, nodes }, supervisor)
    await expect(revise([node('a', ['b']), node('b', ['a'])])).rejects.toThrow('cycle')
    await expect(revise([node('a', ['a'])])).rejects.toThrow('cannot depend on itself')
    await expect(revise([node('a', ['ghost'])])).rejects.toThrow('not in this plan')
    expect((await store.get('goal'))!.plan).toBeUndefined()
  })

  it('keeps a node that has work: it can be cancelled, not removed', async () => {
    await tickets.revise('goal', { operationId: 'plan-1', expectedRevision: 0, alignmentRevision: 1, nodes: [node('a'), node('b')] }, supervisor)
    await store.prepareDelegation('goal', delegation('a'), 'mote')
    await expect(tickets.revise('goal', { operationId: 'drop', expectedRevision: 1, alignmentRevision: 1, nodes: [node('b')] }, supervisor)).rejects.toThrow('mark it cancelled')
    await tickets.revise('goal', { operationId: 'cancel', expectedRevision: 1, alignmentRevision: 1, nodes: [node('a', [], { cancelled: true }), node('b')] }, supervisor)
    expect(await states()).toEqual({ a: 'cancelled', b: 'ready' })
  })

  it('keeps a reviewed node bound to its original outcome, check and criteria while allowing names and reassignment', async () => {
    await tickets.revise('goal', { operationId: 'plan-1', expectedRevision: 0, alignmentRevision: 1, nodes: [node('a')] }, supervisor)
    const task = delegation('a')
    await deliver(task)
    await tickets.review('goal', pass('a', task.operationId), { kind: 'agent', id: 'reviewer' })
    const original = (await store.get('goal'))!
    for (const [field, patch] of Object.entries({ outcome: { outcome: 'An unrelated new outcome' }, check: { check: 'pnpm test unrelated' }, criteria: { criterionIds: ['ui'] } })) {
      await expect(tickets.revise('goal', { operationId: `replace-${field}`, expectedRevision: 1, alignmentRevision: 1, nodes: [node('a', [], patch)] }, supervisor))
        .rejects.toThrow('cancel it and add a new node')
    }
    await tickets.revise('goal', { operationId: 'rename-and-reassign', expectedRevision: 1, alignmentRevision: 1,
      nodes: [node('a', [], { title: 'A clearer name', executor: { hostId: 'local', agentSessionId: 'worker-b' } })] }, supervisor)
    const renamed = (await store.get('goal'))!
    expect(renamed.plan!.nodes[0]).toMatchObject({ title: 'A clearer name', executor: { agentSessionId: 'worker-b' } })
    expect(renamed.plan!.reviews).toEqual(original.plan!.reviews)
    expect(renamed.delegations).toEqual(original.delegations)
    expect(await states()).toEqual({ a: 'done' })
    await tickets.revise('goal', { operationId: 'replace-explicitly', expectedRevision: 2, alignmentRevision: 1,
      nodes: [{ ...renamed.plan!.nodes[0]!, cancelled: true }, node('new-task', [], { criterionIds: ['ui'] })] }, supervisor)
    expect(await states()).toEqual({ a: 'cancelled', 'new-task': 'ready' })
    expect((await store.get('goal'))!.plan!.reviews).toEqual(original.plan!.reviews)
  })

  it('allows work semantics to change before a node has recorded work, and criteria can be reordered afterward', async () => {
    await tickets.revise('goal', { operationId: 'plan-1', expectedRevision: 0, alignmentRevision: 1, nodes: [node('a')] }, supervisor)
    const revised = node('a', [], { outcome: 'A refined result', check: 'pnpm test refined', criterionIds: ['api', 'ui'] })
    await tickets.revise('goal', { operationId: 'refine', expectedRevision: 1, alignmentRevision: 1, nodes: [revised] }, supervisor)
    await store.prepareDelegation('goal', { ...delegation('a'), criterionIds: ['api', 'ui'] }, 'mote')
    await tickets.revise('goal', { operationId: 'reorder', expectedRevision: 2, alignmentRevision: 1, nodes: [{ ...revised, criterionIds: ['ui', 'api'] }] }, supervisor)
    expect((await store.get('goal'))!.plan!.nodes[0]!.criterionIds).toEqual(['ui', 'api'])
  })

  it('is written only through its own owner, never through a Goal update patch', async () => {
    await expect(store.update('goal', { plan: { revision: 1 } } as never)).rejects.toThrow('plan revision')
  })
})

describe('node delegation and review', () => {
  beforeEach(async () => {
    await tickets.revise('goal', { operationId: 'plan-1', expectedRevision: 0, alignmentRevision: 1,
      nodes: [node('a'), node('b'), node('c', ['a', 'b'], { executor: { hostId: 'remote-host', agentSessionId: 'worker-b' } })] }, supervisor)
  })

  it('derives every state from dependencies, delegation facts and verdicts', async () => {
    expect(await states()).toEqual({ a: 'ready', b: 'ready', c: 'waiting' })
    await store.prepareDelegation('goal', delegation('a'), 'mote')
    expect((await states()).a).toBe('unknown')
    await store.linkDelegation('goal', 'delegate-a-1', 'source-a-1', 'mote')
    expect((await states()).a).toBe('working')
    await tickets.submit('goal', 'delegate-a-1', report(delegation('a')), 'worker-a')
    expect((await states()).a).toBe('review')
    await tickets.review('goal', pass('a', 'delegate-a-1'), { kind: 'agent', id: 'reviewer' })
    expect(await states()).toEqual({ a: 'done', b: 'ready', c: 'waiting' })
  })

  it('refuses to delegate a node whose dependencies are not done', async () => {
    await expect(store.prepareDelegation('goal', { ...delegation('c', 'worker-b'), hostId: 'remote-host' }, 'mote')).rejects.toThrow('only a ready node')
  })

  it('refuses a second current attempt on the same node', async () => {
    await store.prepareDelegation('goal', delegation('a'), 'mote')
    await expect(store.prepareDelegation('goal', delegation('a', 'worker-b', 2), 'mote')).rejects.toThrow('only a ready node')
  })

  it('delegates exactly the node criteria, preventing a partial task report from completing the whole node', async () => {
    await tickets.revise('goal', { operationId: 'plan-2', expectedRevision: 1, alignmentRevision: 1,
      nodes: [node('a', [], { criterionIds: ['api', 'ui'] }), node('b', [], { cancelled: true }), node('c', ['a', 'b'], { cancelled: true })] }, supervisor)
    await expect(store.prepareDelegation('goal', delegation('a'), 'mote')).rejects.toThrow('same success criteria')
    expect((await store.get('goal'))!.delegations ?? []).toEqual([])
    await deliver({ ...delegation('a'), criterionIds: ['ui', 'api'] })
    await tickets.review('goal', pass('a', 'delegate-a-1'), { kind: 'agent', id: 'reviewer' })
    expect(await states()).toEqual({ a: 'done', b: 'cancelled', c: 'cancelled' })
  })

  it('sends a node only to the executor its plan names', async () => {
    for (const id of ['a', 'b']) {
      const task = delegation(id)
      await deliver(task)
      await tickets.review('goal', pass(id, task.operationId), { kind: 'agent', id: 'reviewer' })
    }
    await expect(store.prepareDelegation('goal', delegation('c', 'worker-a'), 'mote')).rejects.toThrow('names worker-b on remote-host')
    await store.prepareDelegation('goal', { ...delegation('c', 'worker-b'), hostId: 'remote-host' }, 'mote')
    expect((await states()).c).toBe('unknown')
  })

  it('never lets the executor review its own work, and a pass must show the check it ran', async () => {
    const task = delegation('a')
    await deliver(task)
    await expect(tickets.review('goal', pass('a', task.operationId), { kind: 'agent', id: 'worker-a' })).rejects.toThrow('cannot review its own work')
    await expect(tickets.review('goal', { ...pass('a', task.operationId), check: { command: '', result: '', evidence: [] } }, { kind: 'agent', id: 'reviewer' }))
      .rejects.toThrow('must record the check')
    expect((await states()).a).toBe('review')
  })

  it('sends requested changes back as a new attempt to the same executor, keeping the first', async () => {
    const first = delegation('a')
    await deliver(first)
    await tickets.review('goal', { ...pass('a', first.operationId), verdict: 'changes', note: 'The empty plan crashes the API' }, { kind: 'user', id: 'person' })
    expect((await states()).a).toBe('changes')
    await expect(store.prepareDelegation('goal', delegation('a', 'worker-b', 2), 'mote')).rejects.toThrow('original executor')
    const rework = delegation('a', 'worker-a', 2)
    await deliver(rework)
    expect((await states()).a).toBe('review')
    await tickets.review('goal', pass('a', rework.operationId), { kind: 'agent', id: 'reviewer' })
    const goal = (await store.get('goal'))!
    const [previous, current] = goal.delegations!
    expect(current?.planNodeId).toBe(previous?.planNodeId)
    expect(current?.dispatchProof?.hash).not.toBe(previous?.dispatchProof?.hash)
    expect(goal.plan!.reviews.at(-1)!.completion?.record).toMatchObject({ kind: 'completed', executionHash: current?.dispatchProof?.hash })
    const projection = projectGoalPlan(goal.plan!, goal.delegations!, goal.alignment!.criteria).nodes.find(item => item.node.id === tickets.id('a'))!
    expect([projection.state, projection.attempts, goal.plan!.reviews.map(review => review.verdict)]).toEqual(['done', 2, ['changes', 'pass']])
  })

  it('reviews only the current reported attempt, and replays the same verdict unchanged', async () => {
    const task = delegation('a')
    await store.prepareDelegation('goal', task, 'mote')
    await store.linkDelegation('goal', task.operationId, task.sourceMessageId, 'mote')
    await expect(tickets.review('goal', pass('a', task.operationId), { kind: 'agent', id: 'reviewer' })).rejects.toThrow('only a reported attempt')
    await tickets.submit('goal', task.operationId, report(task), 'worker-a')
    await expect(tickets.review('goal', pass('a', 'another-attempt'), { kind: 'agent', id: 'reviewer' })).rejects.toThrow('current attempt')
    await tickets.review('goal', pass('a', task.operationId), { kind: 'agent', id: 'reviewer' })
    expect((await tickets.review('goal', pass('a', task.operationId), { kind: 'agent', id: 'reviewer' })).replayed).toBe(true)
  })

  it('counts progress over live nodes and names the next runnable ones', async () => {
    const goal = (await store.get('goal'))!
    expect(projectGoalPlan(goal.plan!, [], goal.alignment!.criteria)).toMatchObject({ done: 0, total: 3, next: [tickets.id('a'), tickets.id('b')] })
  })

  it('places each node one column past its deepest dependency', async () => {
    const goal = (await store.get('goal'))!
    expect(projectGoalPlan(goal.plan!, [], goal.alignment!.criteria).nodes.map(item => [item.node.id, item.column])).toEqual([[tickets.id('a'), 0], [tickets.id('b'), 0], [tickets.id('c'), 1]])
  })

  it('names node criteria that the current proposal no longer has', async () => {
    const goal = (await store.get('goal'))!
    // A retained historical plan can name removed criteria; new revisions cannot write those references.
    const historicalPlan = { ...goal.plan!, nodes: [node('a', [], { criterionIds: ['api', 'gone'] })] }
    expect(projectGoalPlan(historicalPlan, [], goal.alignment!.criteria).nodes[0]!.staleCriteria).toEqual(['gone'])
  })

  it('names every reason a node needs reconciliation, and an unknown node cannot be delegated', async () => {
    await store.prepareDelegation('goal', delegation('a'), 'mote')
    await store.proposeAlignment('goal', { summary: 'Changed API requirement', criteria: [{ ...criteria[0]!, text: 'The API authenticates callers' }, criteria[1]!], openQuestions: [] })
    const goal = (await store.get('goal'))!
    expect(projectGoalPlan(goal.plan!, goal.delegations!, goal.alignment!.criteria).nodes[0])
      .toMatchObject({ state: 'unknown', unknown: ['criteria', 'dispatch-link'], staleCriteria: ['api'] })
    expect(goalPlanDelegationIssue(projectGoalPlan(goal.plan!, goal.delegations!, goal.alignment!.criteria).nodes[0], tickets.id('a'), { hostId: 'local', agentSessionId: 'worker-a' }))
      .toBe(`Plan node ${tickets.id('a')} is unknown (criteria, dispatch-link); only a ready node or one whose review requested changes can be delegated.`)
  })

  it('never offers a node that covers no success criterion, while a cancelled node needs no reconciliation', async () => {
    const goal = (await store.get('goal'))!
    // Old saved nodes remain readable even though a new revision must write valid nonempty criteria.
    const historicalPlan = { ...goal.plan!, nodes: [node('a', [], { criterionIds: [] }), node('b', [], { criterionIds: ['gone'], cancelled: true })] }
    const projection = projectGoalPlan(historicalPlan, [], goal.alignment!.criteria)
    expect(projection.nodes.map(item => [item.node.id, item.state, item.unknown])).toEqual([['a', 'unknown', ['criteria']], ['b', 'cancelled', []]])
    expect(projection).toMatchObject({ done: 0, total: 1, next: [] })
  })

  it('returns the derivation with each current attempt by its original identities', async () => {
    await deliver(delegation('a'))
    await store.prepareDelegation('goal', delegation('b', 'worker-b'), 'mote')
    const goal = (await store.get('goal'))!
    const attempt = (id: string, reported: boolean) => ({ delegationOperationId: `delegate-${id}-1`, reported })
    expect(goalPlanState(projectGoalPlan(goal.plan!, goal.delegations!, goal.alignment!.criteria))).toEqual({ revision: 1, done: 0, total: 3, next: [], nodes: [
      { id: tickets.id('a'), state: 'review', column: 0, attempts: 1, staleCriteria: [], unknown: [], attempt: attempt('a', true) },
      { id: tickets.id('b'), state: 'unknown', column: 0, attempts: 1, staleCriteria: [], unknown: ['dispatch-link'], attempt: attempt('b', false) },
      { id: tickets.id('c'), state: 'waiting', column: 1, attempts: 0, staleCriteria: [], unknown: [], attempt: null }] })
  })

  it('does not carry an old pass to changed or missing standards, while preserving work on unchanged standards', async () => {
    const nodes = [node('a'), node('b', [], { criterionIds: ['ui'] }), node('c', ['a'])]
    await tickets.revise('goal', { operationId: 'plan-2', expectedRevision: 1, alignmentRevision: 1, nodes }, supervisor)
    for (const task of [delegation('a'), { ...delegation('b'), criterionIds: ['ui'] }]) {
      await deliver(task)
      await tickets.review('goal', pass(task.planNodeId!, task.operationId), { kind: 'agent', id: 'reviewer' })
    }
    const original = (await store.get('goal'))!
    await store.proposeAlignment('goal', { summary: 'Same IDs, changed API requirement', criteria: [{ ...criteria[0]!, text: 'The API authenticates callers and returns the plan' }, criteria[1]!], openQuestions: [] })
    await tickets.revise('goal', { operationId: 'plan-3', expectedRevision: 2, alignmentRevision: 2, nodes }, supervisor)
    const changed = (await openDemandStore({ root }).get('goal'))!
    const projection = projectGoalPlan(changed.plan!, changed.delegations!, changed.alignment!.criteria)
    expect(projection.nodes.map(item => [tickets.draft(item.node.id), item.state, item.staleCriteria])).toEqual([
      ['a', 'unknown', ['api']], ['b', 'done', []], ['c', 'waiting', []]
    ])
    expect(projection).toMatchObject({ done: 1, total: 3, next: [] })
    expect(changed.plan!.reviews).toEqual(original.plan!.reviews)
    expect(changed.delegations).toEqual(original.delegations)
    await expect(store.prepareDelegation('goal', { ...delegation('c'), alignmentRevision: 2 }, 'mote')).rejects.toThrow('only a ready node')
    const missing = projectGoalPlan(changed.plan!, changed.delegations!, [criteria[1]!])
    expect(missing.nodes[0]).toMatchObject({ state: 'unknown', staleCriteria: ['api'] })
    expect(missing.nodes[1]).toMatchObject({ state: 'done', staleCriteria: [] })
  })

  it('survives a fresh store read with the same plan, reviews and history', async () => {
    const task = delegation('a')
    await deliver(task)
    await tickets.review('goal', pass('a', task.operationId), { kind: 'agent', id: 'reviewer' })
    const reread = (await openDemandStore({ root }).get('goal'))!
    expect(reread.plan).toEqual((await store.get('goal'))!.plan)
    expect(reread.delegations!.map(item => item.planNodeId)).toEqual([tickets.id('a')])
  })
})
