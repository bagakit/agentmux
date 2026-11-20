import { goalTickets } from './helpers/goal-tickets.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'
import { projectGoalPlan, type GoalPlanNodeInput } from '../src/goal-plan.js'
import type { DemandDelegationIntent } from '../src/delegations.js'

let root: string, store: ReturnType<typeof openDemandStore>
let tickets: ReturnType<typeof goalTickets>
const author = { kind: 'agent' as const, id: 'supervisor' }
const executor = (agentSessionId: string) => ({ hostId: 'local', agentSessionId })
const node = (patch: Partial<GoalPlanNodeInput> = {}): GoalPlanNodeInput => ({ id: 'node', title: 'The original node', outcome: 'Deliver the original result',
  check: 'node --test checks/original.test.mjs', dependsOn: [], criterionIds: ['original'], executor: executor('worker-a'), ...patch })
const intent = (worker = 'worker-a', attempt = 1): DemandDelegationIntent => ({ operationId: `attempt-${attempt}`, sourceMessageId: `source-${attempt}`, threadId: `thread-${attempt}`,
  hostId: 'local', ownerAgentSessionId: 'supervisor', ownerRunId: 'supervisor-run', workerAgentSessionId: worker, workerRunId: worker + '-run', text: 'Original task',
  alignmentRevision: 1, criterionIds: ['original'], planNodeId: tickets.id('node') })
const revise = async (operationId: string, nodes = [node()]) => { const goal = (await store.get('goal'))!; return tickets.revise('goal', { operationId, nodes,
  expectedRevision: goal.plan?.revision ?? 0, alignmentRevision: goal.alignment!.revision }, author) }
const projected = async () => { const goal = (await store.get('goal'))!; return projectGoalPlan(goal.plan!, goal.delegations ?? [], goal.alignment!.criteria).nodes[0]! }
const delegate = async (worker = 'worker-a', attempt = 1, linked = true) => {
  const value = intent(worker, attempt); await store.prepareDelegation('goal', value, 'supervisor')
  if (linked) await store.linkDelegation('goal', value.operationId, value.sourceMessageId, 'supervisor')
  return value
}
const report = async (value: DemandDelegationIntent) => tickets.submit('goal', value.operationId, { operationId: `report-${value.operationId}`,
  replyMessageId: `reply-${value.operationId}`, authorAgentSessionId: value.workerAgentSessionId, grounding: { alignmentRevision: 1, summary: 'The original result',
    checks: [{ criterionId: 'original', outcome: 'met', evidence: ['checks/original.log'], note: '' }] } }, value.workerAgentSessionId)
const review = async (value: DemandDelegationIntent, verdict: 'pass' | 'changes' = 'pass') => tickets.review('goal', { operationId: `review-${value.operationId}`,
  nodeId: 'node', delegationOperationId: value.operationId, verdict, check: { command: 'node --test checks/original.test.mjs', result: 'passed', evidence: ['checks/original.log'] },
  note: verdict === 'changes' ? 'Fix the reviewed result' : '' }, { kind: 'agent', id: 'reviewer' })
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amux-revise-plan-')); tickets = goalTickets(root); store = tickets.store
  await store.create({ id: 'goal', title: 'Original Goal', status: 'in_progress', sessionIds: ['supervisor', 'worker-a', 'worker-b', 'reviewer'],
    assigneeSessionIds: ['supervisor', 'worker-a', 'worker-b', 'reviewer'], supervisorSessionId: 'supervisor' })
  await store.proposeAlignment('goal', { summary: 'Original scope', criteria: [{ id: 'original', text: 'Original criterion' }, { id: 'remaining', text: 'Remaining criterion' }], openQuestions: [] })
  await revise('plan-1')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it.each(['nodes', 'expectedRevision', 'alignmentRevision'] as const)('a revision replay refuses changed %s without altering the saved plan', async field => {
  const before = (await store.get('goal'))!
  const original = { operationId: 'plan-1', expectedRevision: 0, alignmentRevision: 1, nodes: [node()] }
  const changed = { ...original, ...(field === 'nodes' ? { nodes: [node({ title: 'Different content' })] } : { [field]: 7 }) }
  await expect(tickets.revise('goal', changed, author)).rejects.toThrow('already recorded with different content')
  expect(await store.get('goal')).toEqual(before)
  expect((await tickets.revise('goal', original, author)).replayed).toBe(true)
})

it('an older revision operation names where it already applied instead of pretending the current plan is its replay', async () => {
  await revise('plan-2', [node({ title: 'Newer title' })]); const before = (await store.get('goal'))!
  await expect(tickets.revise('goal', { operationId: 'plan-1', expectedRevision: 0, alignmentRevision: 1, nodes: [node()] }, author))
    .rejects.toThrow('already applied at plan revision 1; the current plan is revision 2')
  expect(await store.get('goal')).toEqual(before)
})

it('a closed Goal keeps its plan until explicitly reopened for an append', async () => {
  const earlier = (await store.get('goal'))!.plan!
  const append = { operationId: 'append-after-close', alignmentRevision: 1, appendNodes: [node({ id: 'follow-up', dependsOn: [tickets.id('node')] })] }
  await store.update('goal', { status: 'done' })
  await expect(store.revisePlan('goal', append, author)).rejects.toThrow('Reopen the original Goal explicitly')
  await expect(revise('replace-after-close', [node(), node({ id: 'follow-up' })])).rejects.toThrow('Reopen the original Goal explicitly')
  expect((await store.get('goal'))!.plan).toEqual(earlier)
  await store.update('goal', { status: 'in_progress' })
  await store.revisePlan('goal', append, author)
  const saved = (await store.get('goal'))!.plan!
  expect(saved.nodes[0]).toEqual(earlier.nodes[0])
  expect(saved.nodes[1]!.dependsOn).toEqual([earlier.nodes[0]!.id])
})

it.each([{ label: 'empty', criterionIds: [] }, { label: 'missing', criterionIds: ['removed'] }])('a newly written $label criterion set is refused while the original plan remains writable', async ({ criterionIds }) => {
  const before = (await store.get('goal'))!
  await expect(revise('bad-new-node', [node(), node({ id: 'new-node', criterionIds })])).rejects.toThrow('must write at least one success criterion, all from the current Goal proposal')
  expect(await store.get('goal')).toEqual(before)
  await expect(revise('bad-existing-set', [node({ criterionIds })])).rejects.toThrow('must write at least one success criterion')
  expect(await store.get('goal')).toEqual(before)
  await revise('valid-refinement', [node({ criterionIds: ['remaining'] })])
  expect((await store.get('goal'))!.plan!.revision).toBe(2)
})

it('changing only an executor retains unchanged stale criteria instead of making all old work a write prerequisite', async () => {
  await delegate(); await store.proposeAlignment('goal', { summary: 'Current scope', criteria: [{ id: 'remaining', text: 'Remaining criterion' }], openQuestions: [] })
  const saved = await revise('reassign-stale', [node({ executor: executor('worker-b') })]).then(() => 'saved', error => String(error))
  expect(saved).toBe('saved')
  expect(await projected()).toMatchObject({ state: 'unknown', unknown: ['criteria'], staleCriteria: ['original'], delegation: null, attempts: 1 })
  const before = (await store.get('goal'))!
  await expect(revise('new-stale-node', [...before.plan!.nodes, node({ id: 'new-node' })])).rejects.toThrow('current Goal proposal')
  expect(await store.get('goal')).toEqual(before)
})

it.each(['working', 'review', 'unknown'] as const)('an explicit executor revision supersedes an unreviewed %s attempt and permits the new worker', async state => {
  const first = await delegate('worker-a', 1, state !== 'unknown'); if (state === 'review') await report(first)
  expect((await projected()).state).toBe(state)
  await revise('reassign', [node({ executor: executor('worker-b') })])
  expect(await projected()).toMatchObject({ state: 'ready', delegation: null, attempts: 1 })
  const second = await delegate('worker-b', 2)
  expect(await projected()).toMatchObject({ state: 'working', delegation: { operationId: second.operationId }, attempts: 2 })
})

it('a superseded attempt keeps a late report but cannot become the current work or receive a node review', async () => {
  const first = await delegate(); await revise('reassign', [node({ executor: executor('worker-b') })])
  await report(first)
  expect(await projected()).toMatchObject({ state: 'ready', delegation: null, attempts: 1 })
  await expect(review(first)).rejects.toThrow("must judge the node's current attempt")
  const second = await delegate('worker-b', 2)
  const goal = (await store.get('goal'))!
  expect(goal.delegations![0]!.report).toMatchObject({ replyMessageId: 'reply-attempt-1' })
  expect(await projected()).toMatchObject({ state: 'working', delegation: { operationId: second.operationId }, attempts: 2 })
})

it('A to B to A restores A only before B receives its own delegation', async () => {
  const first = await delegate(); await revise('to-b', [node({ executor: executor('worker-b') })]); await revise('back-to-a')
  expect(await projected()).toMatchObject({ state: 'working', delegation: { operationId: first.operationId } })
  await revise('to-b-again', [node({ executor: executor('worker-b') })]); await delegate('worker-b', 2); await revise('back-to-a-after-b')
  expect(await projected()).toMatchObject({ state: 'ready', delegation: null, attempts: 2 })
  const third = await delegate('worker-a', 3)
  expect(await projected()).toMatchObject({ state: 'working', delegation: { operationId: third.operationId }, attempts: 3 })
})

it('clearing the planned executor preserves the original attempt and a passed node stays done after reassignment', async () => {
  const first = await delegate(); await revise('clear-executor', [node({ executor: null })])
  expect(await projected()).toMatchObject({ state: 'working', delegation: { operationId: first.operationId } })
  await report(first); await review(first); await revise('passed-to-b', [node({ executor: executor('worker-b') })])
  expect(await projected()).toMatchObject({ state: 'done', delegation: { operationId: first.operationId }, review: { verdict: 'pass' } })
})

it('a reviewed changes verdict follows the existing explicit reassignment rule', async () => {
  const first = await delegate(); await report(first); await review(first, 'changes')
  await revise('changes-to-b', [node({ executor: executor('worker-b') })]); await delegate('worker-b', 2)
  expect(await projected()).toMatchObject({ state: 'working', delegation: { operationId: 'attempt-2' }, attempts: 2 })
})

it('keeps claims explicit across full revisions, closures, delegation and ended Goals', async () => {
  const vacant = node({ executor: null }), claimant = { kind: 'agent' as const, id: 'worker-a', hostId: 'local', runtimeId: 'runtime-a' }
  const owner = tickets.owner
  const assign = (expectedRevision: number | string, operationId: string, kind: 'open' | 'close' | 'claim') =>
    store.changePlanAssignment('goal', expectedRevision, operationId, { nodeId: tickets.id('node'), assignment: { kind } }, claimant, () => {}, owner)
  await expect(revise('implicit-open', [{ ...vacant, claimOpen: true }])).rejects.toThrow('explicit plan assignment')
  await revise('vacant', [vacant])
  await assign(2, 'open', 'open')
  await expect(delegate()).rejects.toThrow('open for claim')
  await expect(revise('implicit-assign')).rejects.toThrow('explicit plan assignment')
  await assign(3, 'close', 'close')
  await expect(assign('expired', 'closed-claim', 'claim')).rejects.toThrow('node or its prerequisites changed')
  await assign(4, 'reopen', 'open')
  const current = (await store.get('goal'))!
  const token = projectGoalPlan(current.plan!, [], current.alignment!.criteria, { ...owner, goalId: current.id }).nodes[0]!.claimToken!
  expect(token).toBeTruthy()
  await store.update('goal', { status: 'cancelled' })
  await expect(assign(token, 'late-claim', 'claim')).rejects.toThrow('unfinished Goal')
  expect((await store.get('goal'))!.plan?.nodes[0]).toMatchObject({ executor: null, claimOpen: true })
  await store.update('goal', { status: 'in_progress' })
  await assign(5, 'close-for-delegation', 'close')
  await delegate('worker-a', 1, false)
  await expect(assign(6, 'unknown-open', 'open')).rejects.toThrow('unknown')
  await store.linkDelegation('goal', 'attempt-1', 'source-1', 'supervisor')
  await expect(assign(6, 'active-open', 'open')).rejects.toThrow('working')
  await revise('cancel', [{ ...vacant, cancelled: true }])
  await expect(assign(7, 'cancel-open', 'open')).rejects.toThrow('cancelled')
})
