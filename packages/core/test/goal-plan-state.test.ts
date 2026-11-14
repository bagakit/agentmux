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
const refused = (detail: string) => expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR',
  message: expect.stringMatching(new RegExp(`does not describe its plan and delegations: .*${detail}.*read the Goal again instead of repeating the write`, 'u')) })

const mismatches: Array<[string, string, (state: GoalPlanState) => void]> = [
  ['it describes another plan revision', 'another plan revision', state => { state.revision = 2 }],
  ['a plan node is missing', 'every plan node', state => { state.nodes.pop() }],
  ['its nodes leave the plan order', 'plan node order', state => { [state.nodes[0]!.id, state.nodes[1]!.id] = [state.nodes[1]!.id, state.nodes[0]!.id] }],
  ['a node state is outside the set', 'invalid state', state => { Object.assign(state.nodes[1]!, { state: 'paused' }) }],
  ['an unknown node names no reason', 'exactly when it is unknown', state => { state.nodes[0]!.unknown = [] }],
  ['a reason is outside the set', 'exactly when it is unknown', state => { Object.assign(state.nodes[0]!, { unknown: ['dispatch-link', 'mood'] }) }],
  ['a known state names a reason', 'exactly when it is unknown', state => { state.nodes[0]!.state = 'working' }],
  ['the attempt names another source message', 'not one of its delegations', state => { state.nodes[0]!.attempt!.sourceMessageId = 'another-source' }],
  ['the attempt names another thread', 'not one of its delegations', state => { state.nodes[0]!.attempt!.threadId = 'another-thread' }],
  ['the attempt names another worker Host', 'not one of its delegations', state => { state.nodes[0]!.attempt!.workerHostId = 'another-host' }],
  ['the attempt names another worker Session', 'not one of its delegations', state => { state.nodes[0]!.attempt!.workerAgentSessionId = 'another-worker' }],
  ['the attempt is a delegation of another node', 'not one of its delegations', state => { state.nodes[0]!.attempt = { ...state.nodes[1]!.attempt! } }],
  ['the attempt names no delegation', 'not one of its delegations', state => { state.nodes[0]!.attempt!.delegationOperationId = 'delegate-elsewhere' }],
  ['it counts attempts beyond the delegations', 'attempts beyond its delegations', state => { state.nodes[0]!.attempts = 2 }],
  ['a current attempt comes without attempts', 'without attempts', state => { state.nodes[0]!.attempts = 0 }],
  ['its next nodes leave the plan', 'outside the plan', state => { state.next = ['elsewhere'] }],
  ['its counts exceed the nodes', 'exceed its nodes', state => { state.total = 3 }],
  ['a node carries an unknown field', 'unsupported or missing fields', state => { Object.assign(state.nodes[0]!, { note: 'derived elsewhere' }) }]]

describe('the plan state a Goal owner returns', () => {
  it('reaches readers as the derivation of the same plan, delegations and criteria', () => {
    expect(parse(owner()).planState!.nodes[0]).toEqual({ id: 'api', state: 'unknown', column: 0, attempts: 1, staleCriteria: [], unknown: ['dispatch-link'],
      attempt: { delegationOperationId: 'delegate-api', sourceMessageId: 'source-api', threadId: 'thread-api', workerHostId: 'local', workerAgentSessionId: 'worker', reported: false } })
  })

  it.each(mismatches)('is refused when %s', (_mismatch, detail, change) => {
    const value = owner(); change(value.planState)
    expect(() => parse(value)).toThrow(refused(detail))
  })

  it('is refused when it arrives without its plan, since a write in the request may already be saved', () => {
    const { plan: _orphan, ...orphan } = owner()
    expect(() => parse(orphan)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR', message: 'The Goal owner returned a plan state that comes without its plan. '
      + 'A write in this request may already be saved by the owner; read the Goal again instead of repeating the write.' }))
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

  it('is refused when its plan state does not describe its plan and delegations', () => {
    const planState = derived(); planState.nodes[0]!.attempt!.threadId = 'another-thread'
    expect(() => inspect(record({ planState }))).toThrow(refused('not one of its delegations'))
  })

  it('still reads without a derivation, and carries none', () => {
    const goal = inspect(record({}))
    expect(goal.plan).toEqual(plan)
    expect(goal).not.toHaveProperty('planState')
  })
})
