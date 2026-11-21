import { describe, expect, it } from 'vitest'
import type { DemandDelegation } from '@agentmux/demand/delegations'
import type { GoalPlan, GoalPlanNodeInput } from '@agentmux/demand/goal-plan'
import { decideGoalProgressSource, type GoalProgressRecord } from '../src/continuous-progress-task-source.js'

/**
 * Monitoring a Goal with a plan: the Supervisor's continuous progress keeps checking while any
 * node has work, keeps checking through unknown nodes (asking to reconcile), and pauses only for
 * human acceptance or a plan that cannot move. A Goal without a plan keeps its existing behavior.
 */
const source = { kind: 'goal' as const, goalId: 'goal', alignmentRevision: 1 }
const criteria = [{ id: 'api', text: 'API' }]
const node = (id: string, dependsOn: string[] = [], patch: Partial<GoalPlanNodeInput> = {}): GoalPlanNodeInput =>
  ({ id, title: id, outcome: id, dependsOn, criterionIds: ['api'], check: `check ${id}`, executor: null, ...patch })
const plan = (nodes: GoalPlanNodeInput[], reviews: GoalPlan['reviews'] = []): GoalPlan =>
  ({ revision: 3, alignmentRevision: 1, nodes, reviews, history: [1, 2, 3].map(revision => ({ operationId: `r${revision}`, revision, author: { kind: 'agent' as const, id: 'mote' }, revisedAt: revision })) })
const attempt = (nodeId: string, patch: Partial<DemandDelegation> = {}): DemandDelegation => ({
  operationId: `d-${nodeId}`, sourceMessageId: `s-${nodeId}`, hostId: 'local', ownerAgentSessionId: 'mote', workerAgentSessionId: 'worker', ownerRunId: 'mr', workerRunId: 'wr',
  threadId: 't', text: 'task', alignmentRevision: 1, criterionIds: ['api'], planNodeId: nodeId, preparedAt: 1, capturedCriteria: criteria, linkedAt: 2, ...patch })
const pass = (nodeId: string) => ({ operationId: `rv-${nodeId}`, nodeId, delegationOperationId: `d-${nodeId}`, verdict: 'pass' as const,
  check: { command: 'c', result: 'ok', evidence: ['e'] }, note: '', reviewer: { kind: 'agent' as const, id: 'reviewer' }, reviewedAt: 3 })
const goal = (patch: Partial<GoalProgressRecord> = {}): GoalProgressRecord => ({ id: 'goal', title: 'Goal', description: '', status: 'in_progress', sessionIds: ['mote'],
  assigneeSessionIds: ['mote'], supervisorSessionId: 'mote', alignment: { revision: 1, confirmedAt: 5, criteria, summary: 'Original scope', openQuestions: [] }, ...patch })

describe('Goal plan monitoring', () => {
  it('keeps a Goal without a plan on its existing decision', () => {
    expect(decideGoalProgressSource(source, goal())).toEqual({ action: 'continue', reason: 'Goal goal: confirmed scope r1; source checked.' })
  })

  it('continues while nodes are open and names each by state', () => {
    const decision = decideGoalProgressSource(source, goal({ plan: plan([node('a'), node('b'), node('c', ['a'])]), delegations: [attempt('b', { report: undefined })] }))
    expect(decision.action).toBe('continue')
    expect(decision.reason).toBe('Goal goal: plan r3 0/3 done; ready: a; working: b.')
  })

  it('keeps monitoring through unknown nodes and asks the Supervisor to reconcile them', () => {
    const { linkedAt: _linked, ...prepared } = attempt('a')
    const decision = decideGoalProgressSource(source, goal({ plan: plan([node('a')]), delegations: [prepared as DemandDelegation] }))
    expect(decision.action).toBe('continue')
    expect(decision.reason).toContain('unknown: a')
    expect(decision.reason).toContain('Reconcile unknown nodes from their original delegation receipts')
  })

  it('hands every unknown reason to management without replacing the original delegation identities', () => {
    const { linkedAt: _linked, ...prepared } = attempt('a', { capturedCriteria: [{ id: 'api', text: 'An earlier criterion' }] })
    const decision = decideGoalProgressSource(source, goal({ plan: plan([node('a')]), delegations: [prepared as DemandDelegation] }))
    expect(decision.action).toBe('continue')
    const handoff = JSON.parse(decision.continuation!.split('\n\n')[1]!)
    expect(handoff.nodes).toEqual([{ id: 'a', state: 'unknown', executor: null, unknown: ['criteria', 'dispatch-link'],
      next: { kind: 'reconcile', reasons: ['criteria', 'dispatch-link'] },
      attempt: { delegationOperationId: prepared.operationId, sourceMessageId: prepared.sourceMessageId, threadId: prepared.threadId,
        workerHostId: prepared.hostId, workerAgentSessionId: prepared.workerAgentSessionId } }])
  })

  it('continues verification when a passing verdict lacks the original completion proof', () => {
    const decision = decideGoalProgressSource(source, goal({ plan: plan([node('a'), node('b', [], { cancelled: true })], [pass('a')]), delegations: [attempt('a')] }))
    expect(decision.action).toBe('continue')
    expect(decision.reason).toContain('unknown: a')
  })

  it('pauses with the blocked nodes when the rest only wait on cancelled dependencies', () => {
    const decision = decideGoalProgressSource(source, goal({ plan: plan([node('a', [], { cancelled: true }), node('b', ['a'])]) }))
    expect(decision.action).toBe('pause')
    expect(decision.reason).toContain('remaining nodes wait on cancelled dependencies (b). Revise the plan to move them.')
  })

  it('still lets Goal status and scope changes win over the plan', () => {
    expect(decideGoalProgressSource(source, goal({ status: 'done', plan: plan([node('a')]) })).action).toBe('stop')
    expect(decideGoalProgressSource(source, goal({ alignment: { ...goal().alignment!, revision: 2 }, plan: plan([node('a')]) })).action).toBe('pause')
  })
})
