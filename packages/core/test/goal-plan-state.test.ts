import { describe, expect, it } from 'vitest'
import type { DemandDelegation } from '@agentmux/demand/delegations'
import { goalPlanState, projectGoalPlan, type GoalPlan, type GoalPlanState } from '@agentmux/demand/goal-plan'
import { parseGoalDelegationResult } from '../src/goal-delegation.js'
import { parseRpcControlResult } from '../src/rpc-business-codec.js'

const criteria = [{ id: 'AC-01', text: 'The plan is readable' }]
const alignment = { summary: 'A readable plan', criteria, openQuestions: [], revision: 1, confirmedAt: null }
const node = (id: string) => ({ id, title: `Plan ${id}`, outcome: 'The plan is readable', dependsOn: [], criterionIds: ['AC-01'], check: `pnpm test ${id}`, executor: null })
const plan: GoalPlan = { revision: 1, alignmentRevision: 1, reviews: [], history: [{ operationId: 'plan-1', revision: 1, author: { kind: 'agent', id: 'mote' }, revisedAt: 1 }],
  nodes: [node('api'), node('docs')] }
const delegation = (nodeId: string, patch: Partial<DemandDelegation> = {}): DemandDelegation => ({ operationId: `delegate-${nodeId}`, sourceMessageId: `source-${nodeId}`,
  hostId: 'local', ownerAgentSessionId: 'mote', workerAgentSessionId: 'worker', ownerRunId: 'mote-run', workerRunId: 'worker-run', threadId: `thread-${nodeId}`,
  text: `Do ${nodeId}`, alignmentRevision: 1, criterionIds: ['AC-01'], planNodeId: nodeId, preparedAt: 1, capturedCriteria: criteria, ...patch })
// The api attempt was prepared but never linked; the docs attempt is linked.
const delegations = [delegation('api'), delegation('docs', { linkedAt: 2 })]
const derived = (): GoalPlanState => goalPlanState(projectGoalPlan(plan, delegations, criteria))
/** An owner result derived the way the Goal owner derives it. */
const owner = () => ({ goalId: 'goal', goalUpdatedAt: 1, diskDurability: 'confirmed', delegations, plan, planState: derived(),
  goalState: { status: 'in_progress', supervisorSessionId: 'mote', alignment } })
const parse = (value: unknown) => parseGoalDelegationResult(value, { goalId: 'goal' })
const unavailable = (detail: string) => expect.objectContaining({ planStateIssue: expect.stringContaining(detail) })

const mismatches: Array<[string, string, (state: GoalPlanState) => void]> = [
  ['it describes another plan revision', 'another plan revision', state => { state.revision = 2 }],
  ['a plan node is missing', 'every plan node', state => { state.nodes.pop() }],
  ['its nodes leave the plan order', 'plan node order', state => { [state.nodes[0]!.id, state.nodes[1]!.id] = [state.nodes[1]!.id, state.nodes[0]!.id] }],
  ['a node state is outside the set', 'invalid state', state => { Object.assign(state.nodes[1]!, { state: 'paused' }) }],
  ['an unknown node names no reason', 'exactly when it is unknown', state => { state.nodes[0]!.unknown = [] }],
  ['a reason is outside the set', 'exactly when it is unknown', state => { Object.assign(state.nodes[0]!, { unknown: ['dispatch-link', 'mood'] }) }],
  ['a known state names a reason', 'exactly when it is unknown', state => { state.nodes[0]!.state = 'working' }],
  ['the attempt is a delegation of another node', 'not one of its delegations', state => { state.nodes[0]!.attempt = { ...state.nodes[1]!.attempt! } }],
  ['the attempt names no delegation', 'not one of its delegations', state => { state.nodes[0]!.attempt!.delegationOperationId = 'delegate-elsewhere' }],
  ['the reported observation is not a boolean', 'not one of its delegations', state => { Object.assign(state.nodes[0]!.attempt!, { reported: 'yes' }) }],
  ['it counts attempts beyond the delegations', 'attempts beyond its delegations', state => { state.nodes[0]!.attempts = 2 }],
  ['a current attempt comes without attempts', 'without attempts', state => { state.nodes[0]!.attempts = 0 }],
  ['its next nodes leave the plan', 'outside the plan', state => { state.next = ['elsewhere'] }],
  ['its counts exceed the nodes', 'exceed its nodes', state => { state.total = 3 }],
  ['a node carries an unknown field', 'unsupported or missing fields', state => { Object.assign(state.nodes[0]!, { note: 'derived elsewhere' }) }]]

describe('the plan state a Goal owner returns', () => {
  it('reaches readers as the derivation of the same plan, delegations and criteria', () => {
    expect(parse(owner()).planState!.nodes[0]).toEqual({ id: 'api', state: 'unknown', column: 0, attempts: 1, staleCriteria: [], unknown: ['dispatch-link'],
      attempt: { delegationOperationId: 'delegate-api', reported: false } })
  })

  it.each(mismatches)('isolates only the derivation when %s', (_mismatch, detail, change) => {
    const value = owner(); change(value.planState)
    const read = parse(value)
    expect(read).toMatchObject({ plan, delegations, diskDurability: 'confirmed' })
    expect(read).toEqual(unavailable(detail))
    expect(read).not.toHaveProperty('planState')
  })

  it('isolates orphan state while retaining the original operation result', () => {
    const { plan: _orphan, ...orphan } = owner()
    const read = parse(orphan)
    expect(read).toMatchObject({ goalId: 'goal', delegations, diskDurability: 'confirmed' })
    expect(read).toEqual(unavailable('without a plan'))
    expect(read).not.toHaveProperty('planState')
  })

  it('is kept as the owner derivation when the owner rules differ from this reader', () => {
    const value = owner(); Object.assign(value.planState.nodes[0]!, { state: 'working', unknown: [] })
    expect(() => parse(value)).not.toThrow()
    expect(parse(value).planState!.nodes[0]).toMatchObject({ state: 'working', unknown: [], attempts: 1 })
  })

  it('is absent from a result whose owner gave none, while its plan and delegations still read', () => {
    const { planState: _absent, ...older } = owner()
    expect(() => parse(older)).not.toThrow()
    const read = parse(older)
    expect(read).toMatchObject({ plan, delegations })
    expect(read).not.toHaveProperty('planState')
    expect(read.planStateIssue).toContain('owner returned no derivation')
  })

  it('preserves the specific reading issue across public decodes and clears it after a valid read', () => {
    const value = owner(); value.planState.revision = 2
    const first = parse(value), twice = parse(first)
    expect(twice.planStateIssue).toBe(first.planStateIssue)
    expect(twice.planStateIssue).toContain('another plan revision')
    expect(parse({ ...owner(), planStateIssue: first.planStateIssue })).not.toHaveProperty('planStateIssue')
    const { planState: _state, plan: _plan, ...withoutPlan } = owner()
    expect(parse(withoutPlan)).not.toHaveProperty('planStateIssue')
  })
})

describe('a Goal record from its owner', () => {
  const record = (extra: Record<string, unknown>) => ({ id: 'goal', title: 'Readable plan', description: '', status: 'in_progress', priority: 'normal', projectId: null,
    projectName: null, assigneeSessionIds: ['mote'], supervisorSessionId: 'mote', participations: [], sessionIds: ['mote'], createdAt: 1, updatedAt: 1, source: 'default-topic',
    alignment, delegations, plan, ...extra })
  const inspect = (goal: unknown) => parseRpcControlResult('goal.inspect', { goal, goalContinuations: [] }).goal as Record<string, unknown>

  it('carries the owner derivation with its plan', () => {
    expect(inspect(record({ planState: derived() })).planState).toEqual(derived())
  })

  it('keeps the Goal record when its derivation names another delegation', () => {
    const planState = derived(); planState.nodes[0]!.attempt!.delegationOperationId = 'another-delegation'
    const read = inspect(record({ planState }))
    expect(read).toMatchObject({ id: 'goal', plan, delegations })
    expect(read).toEqual(unavailable('not one of its delegations'))
    expect(read).not.toHaveProperty('planState')
  })

  it('still reads without a derivation, and carries none', () => {
    const goal = inspect(record({}))
    expect(goal.plan).toEqual(plan)
    expect(goal).not.toHaveProperty('planState')
  })
})
