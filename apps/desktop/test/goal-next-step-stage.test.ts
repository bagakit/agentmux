import { describe, expect, it } from 'vitest'
import type { DemandAlignment, DemandGrounding } from '@agentmux/demand/goals'
import type { DemandDelegation, DemandDispatch, GoalStartObservation } from '@agentmux/demand'
import type { GoalDelegationObservation } from '@agentmux/core/goal-delegation'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { goalNextStep, goalNextStepFact, goalHasOriginalWork, GOAL_STAGES, type GoalStage } from '../src/renderer/src/lib/goal-presentation'
import { goalDelegationRows } from '../src/renderer/src/lib/goal-delegation-presentation'

/**
 * The Goals list groups and marks each Goal by whose turn it is. That stage must come from the same
 * domain branch that writes the visible next step, never from parsing the sentence.
 */
const base: DemandRecord = { id: 'goal', title: 'Original goal', description: '', status: 'in_progress', priority: 'normal', projectId: null,
  projectName: null, source: 'session', sessionIds: [], createdAt: 1, updatedAt: 1 }
const criteria = [{ id: 'a', text: 'First outcome' }, { id: 'b', text: 'Second outcome' }]
const alignment = (patch: Partial<DemandAlignment> = {}): DemandAlignment => ({ summary: 'Agreed direction', criteria, openQuestions: [], revision: 1, confirmedAt: 10, ...patch })
const grounding = (outcomes: Array<'met' | 'gap' | 'unknown'>, patch: Partial<DemandGrounding> = {}): DemandGrounding => ({
  alignmentRevision: 1, summary: 'Agent report', submissionId: 'report', acceptedAt: null,
  checks: outcomes.map((outcome, index) => ({ criterionId: criteria[index]!.id, outcome, evidence: ['result.md:1'], note: outcome === 'gap' ? 'Explained gap' : '' })), ...patch })
const delegation: DemandDelegation = { operationId: 'op', sourceMessageId: 'msg', hostId: 'host', ownerAgentSessionId: 'owner', workerAgentSessionId: 'worker',
  ownerRunId: 'owner-run', workerRunId: 'run', threadId: 'thread', text: 'Original task', alignmentRevision: 1, criterionIds: ['a'], preparedAt: 1, linkedAt: 2,
  capturedCriteria: [{ id: 'a', text: 'First outcome' }] }
const observed = (state: 'running' | 'exited' = 'running'): GoalDelegationObservation => ({ operationId: 'op', workerRun: { runId: 'run', state }, communication: {
  hostId: 'host', dispatch: { sourceMessageId: 'msg', ownerAgentSessionId: 'owner', workerAgentSessionId: 'worker', threadId: 'thread', openedAt: 2, originAwaits: false, events: [] },
  source: {} as never, replies: [], identityDiagnostics: [] } })
const start: DemandDispatch = { operationId: 'start', agentSessionId: 'worker', hostId: 'host', runId: 'run', execution: 'finite', prompt: 'Original start',
  stage: 'confirmed', preparedAt: 1, submittedAt: 2, receipt: { kind: 'core-prompt', itemId: 'prompt:start', createdAt: 3 } }
const startObserved: GoalStartObservation = { operationId: 'start', responsibility: 'working', originalRun: { runId: 'run', state: 'running' },
  input: { state: 'confirmed', proof: { kind: 'core-prompt', agentSessionId: 'worker', runId: 'run', operationId: 'start', acknowledged: true, prompt: 'Original start',
    inputKey: { kind: 'prompt', agentSessionId: 'worker', expectedRun: { runId: 'run' }, submissionId: 'start' } } } }

const cases: Array<[string, DemandRecord, GoalStage]> = [
  ['no proposal yet', base, 'define'],
  ['open decisions', { ...base, alignment: alignment({ confirmedAt: null, openQuestions: ['Which host?'] }) }, 'define'],
  ['no success criteria', { ...base, alignment: alignment({ confirmedAt: null, criteria: [] }) }, 'define'],
  ['proposal ready to confirm', { ...base, alignment: alignment({ confirmedAt: null }) }, 'you'],
  ['agreed, no report', { ...base, alignment: alignment() }, 'agents'],
  ['report ready for review', { ...base, alignment: alignment(), grounding: grounding(['met', 'met']) }, 'you'],
  ['report with explained gaps', { ...base, alignment: alignment(), grounding: grounding(['met', 'gap']) }, 'you'],
  ['report with unknown results', { ...base, alignment: alignment(), grounding: grounding(['met', 'unknown']) }, 'attention'],
  ['report for an earlier revision', { ...base, alignment: alignment({ revision: 2 }), grounding: grounding(['met', 'met']) }, 'attention'],
  ['done without a report', { ...base, status: 'done', alignment: alignment() }, 'attention'],
  ['accepted and open', { ...base, alignment: alignment(), grounding: grounding(['met', 'met'], { acceptedAt: 20 }) }, 'finished'],
  ['accepted and finished', { ...base, status: 'done', alignment: alignment(), grounding: grounding(['met', 'met'], { acceptedAt: 20 }) }, 'finished'],
  ['delegation working', { ...base, alignment: alignment(), delegations: [delegation], delegationObservations: [observed()] }, 'agents'],
  ['delegation report to collect', { ...base, alignment: alignment(), delegations: [{ ...delegation, report: { operationId: 'r', replyMessageId: 'reply',
    authorAgentSessionId: 'worker', submittedAt: 3, grounding: { alignmentRevision: 1, summary: 'Worker report', checks: [] } } }], delegationObservations: [observed()] }, 'agents'],
  ['delegation ended without report', { ...base, alignment: alignment(), delegations: [delegation], delegationObservations: [observed('exited')] }, 'attention'],
  ['delegation observation unknown', { ...base, alignment: alignment(), delegations: [delegation] }, 'unknown'],
  ['finite start working', { ...base, alignment: alignment(), dispatches: [start], startObservations: [startObserved] }, 'agents'],
  ['finite start unobserved', { ...base, alignment: alignment(), dispatches: [start] }, 'unknown']
]

describe('Goal next-step stage', () => {
  it.each(cases)('%s', (_label, goal, stage) => {
    const fact = goalNextStepFact(goal)
    expect(fact.stage).toBe(stage)
    // The sentence the person reads is the same one other surfaces already show.
    expect(fact.text).toBe(goalNextStep(goal))
  })

  it('covers every stage with a real case, so grouping is never derived from an empty set', () => {
    expect(GOAL_STAGES.length).toBeGreaterThan(4)
    expect(new Set(cases.map(([, , stage]) => stage))).toEqual(new Set(GOAL_STAGES))
  })

  it('does not let business status alone claim the human or finished stage', () => {
    for (const status of ['in_review', 'done'] as const) {
      expect(goalNextStepFact({ ...base, status }).stage).not.toBe('you')
      expect(goalNextStepFact({ ...base, status }).stage).not.toBe('finished')
    }
  })
})

describe('Goal work status labels', () => {
  it('names every status once, from the table that owns the status ids', async () => {
    const { DEMAND_STATUS_IDS, DEMAND_STATUS_LABELS } = await import('../src/renderer/src/lib/global-demand-board')
    expect(Object.keys(DEMAND_STATUS_LABELS).sort()).toEqual([...DEMAND_STATUS_IDS].sort())
    expect(DEMAND_STATUS_LABELS.in_progress).toBe('In progress')
  })
})


describe('the same typed current source and original work reading budget', () => {
  it('keeps exact original execution references instead of deriving an action from the sentence', () => {
    expect(goalNextStepFact({ ...base, dispatches: [start], startObservations: [startObserved] }).source).toEqual({ kind: 'start', operationId: start.operationId, hostId: start.hostId, agentSessionId: start.agentSessionId, runId: start.runId })
    expect(goalNextStepFact({ ...base, delegations: [delegation], delegationObservations: [observed()] }).source).toEqual({ kind: 'delegation', operationId: delegation.operationId, sourceMessageId: delegation.sourceMessageId, hostId: delegation.hostId, agentSessionId: delegation.workerAgentSessionId, runId: delegation.workerRunId })
  })
  it('retains original work when accepted results are the current focus and ignores another Goals local intent', () => {
    const accepted = { ...base, alignment: alignment(), grounding: grounding(['met', 'met'], { acceptedAt: 20 }), dispatches: [start] }
    expect(goalNextStepFact(accepted).source).toEqual({ kind: 'results', submissionId: 'report', revision: 1 })
    expect(goalHasOriginalWork(accepted)).toBe(true)
    const retained = { goalId: base.id, operationId: 'original-pending', sessionId: 'worker', expectedUpdatedAt: 1, phase: 'may-have-dispatched' as const }
    expect(goalNextStepFact(base, retained).source).toMatchObject({ kind: 'start', operationId: retained.operationId, agentSessionId: 'worker' })
    expect(goalHasOriginalWork(base, retained)).toBe(true)
    expect(goalHasOriginalWork({ ...base, id: 'another-goal' }, retained)).toBe(false)
    expect(goalNextStepFact({ ...base, id: 'another-goal' }, retained).source.kind).toBe('definition')
  })

  it('only the original current Ticket attempt can take priority over Goal result review', () => {
    const planNodeId = 'original-ticket', report = { operationId: 'r', replyMessageId: 'reply', authorAgentSessionId: 'worker',
      submittedAt: 3, grounding: grounding(['met']) }
    const original = { ...base, alignment: alignment(), grounding: grounding(['met', 'met']),
      delegations: [{ ...delegation, planNodeId, operationId: 'previous-attempt', report }, { ...delegation, planNodeId, report }] }
    const node = { id: planNodeId, state: 'review' as const, column: 0, attempts: 2, staleCriteria: [], unknown: [],
      attempt: { delegationOperationId: delegation.operationId, reported: true } }
    const planState = { revision: 1, done: 0, total: 1, next: [], nodes: [node] }
    expect(goalNextStepFact({ ...original, planState }).source).toMatchObject({ kind: 'delegation', operationId: delegation.operationId })
    const passed = { ...original, planState: { ...planState, done: 1, nodes: [{ ...node, state: 'done' as const }] } }
    expect(goalNextStepFact(passed)).toEqual({ stage: 'you', text: 'Results ready for review', source: { kind: 'results', submissionId: 'report', revision: 1 } })
    const { grounding: _report, ...unreported } = passed
    expect(goalNextStepFact(unreported)).toEqual({ stage: 'agents', text: 'Plan complete · Awaiting result report', source: { kind: 'goal' } })
    expect(goalDelegationRows(passed).map(row => row.delegation.operationId)).toEqual(['previous-attempt', delegation.operationId])
    expect(goalNextStepFact(original).source).toMatchObject({ kind: 'delegation', operationId: 'previous-attempt' })
  })
})
