import { flushSync } from 'react-dom'
import { parseDemandDelegations, type DemandDelegation } from '@agentmux/demand/delegations'
import { parseGoalPlan, type GoalPlan, type GoalPlanNodeInput } from '@agentmux/demand/goal-plan'
import { demandExecutionReferences, demandResponsibilityScope } from '../../../../../packages/demand/src/responsibility'
import type { GoalResponsibilityObservation } from '@agentmux/core/goal-responsibility'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'

/** Preview facts only: product projection and presentation remain the actual implementation. */
export function goalPlanPreview(seed: (mode: string) => void, render: () => void) {
  const originalDelegation = api.demands.delegation
  return {
    seed() {
      seed('confirmed')
      const state = useAppStore.getState(), goal = state.demands[state.selectedDemandId!]!
      const agents = state.sessions.filter(session => session.kind === 'agent')
      const originalWorker = agents[0]!, owner = agents[1] ?? originalWorker
      const worker = { ...originalWorker, id: 'plan-worker-session', hostId: 'plan-worker', control: {
        ...originalWorker.control, hostId: 'plan-worker', agentSessionId: 'plan-worker-session', run: { runId: 'plan-worker-run' }
      } }
      const criterion = goal.alignment!.criteria[0]!
      const executor = { hostId: worker.control.hostId, agentSessionId: worker.control.agentSessionId }
      const node = (id: string, title: string, dependsOn: string[], outcome: string): GoalPlanNodeInput => ({
        id, title, dependsOn, outcome, criterionIds: [criterion.id], check: `pnpm test -- ${id}`, executor
      })
      const nodes = [
        node('outline', 'Agree on the recovery contract', [], 'Document the original identities and what must survive a restart.'),
        node('guide', 'Write the recovery guide', [], 'Give people a short, practical path back to the same work.'),
        node('workspace', 'Restore the whole workspace', ['outline'], 'Restore tabs, splits and the original selection.'),
        node('drafts', 'Keep every unsent draft', ['outline'], 'Read the original drafts after a process restart.'),
        node('history', 'Preserve terminal reading', ['outline'], 'Keep the reading position while the original Agent continues working.'),
        node('reconnect', 'Reconnect the remote Agent', ['outline'], 'Reattach the original remote Agent and retain its input.'),
        node('verify', 'Review the complete recovery', ['workspace', 'drafts', 'history', 'reconnect', 'guide'], 'Verify the complete workface and leave inspectable evidence.')
      ]
      const attempt = (nodeId: string, reported: boolean, linked = true): DemandDelegation => ({
        operationId: `attempt:${nodeId}`, sourceMessageId: `request:${nodeId}`, hostId: owner.control.hostId, workerHostId: executor.hostId,
        ownerAgentSessionId: owner.control.agentSessionId, workerAgentSessionId: executor.agentSessionId,
        ownerRunId: owner.control.run.runId, workerRunId: worker.control.run.runId, threadId: `thread:${nodeId}`,
        text: nodes.find(item => item.id === nodeId)!.outcome, alignmentRevision: goal.alignment!.revision,
        criterionIds: [criterion.id], capturedCriteria: [criterion], planNodeId: nodeId, preparedAt: 1,
        ...(linked ? { linkedAt: 2 } : {}),
        ...(reported ? { report: { operationId: `report:${nodeId}`, replyMessageId: `reply:${nodeId}`,
          authorAgentSessionId: executor.agentSessionId, submittedAt: 3,
          grounding: { alignmentRevision: goal.alignment!.revision, summary: nodeId === 'history' ? 'The draft survives; the reading anchor still moves during live output.' : 'The original identities and saved content match the recovery log.',
            checks: [{ criterionId: criterion.id, outcome: 'met' as const, evidence: [`artifacts/recovery/${nodeId}.log`], note: '' }] } } } : {})
      })
      const review = (nodeId: string, verdict: 'pass' | 'changes'): GoalPlan['reviews'][number] => ({
        operationId: `review:${nodeId}`, nodeId, delegationOperationId: `attempt:${nodeId}`, verdict,
        check: { command: `pnpm test -- ${nodeId}`, result: '12 checks passed', evidence: [`artifacts/recovery/${nodeId}-review.log`] },
        note: verdict === 'changes' ? 'Keep the original reading anchor while output continues, then repeat the live-session check.' : '',
        reviewer: { kind: 'agent', id: owner.control.agentSessionId }, reviewedAt: 4
      })
      const plan = parseGoalPlan({ revision: 2, alignmentRevision: goal.alignment!.revision, nodes,
        reviews: [review('outline', 'pass'), review('history', 'changes')],
        history: [1, 2].map(revision => ({ operationId: `plan:revision-${revision}`, revision, author: { kind: 'agent', id: owner.control.agentSessionId }, revisedAt: revision })) })
      const next = { ...goal, title: 'Return to the same work, without rebuilding it', plan,
        supervisorSessionId: owner.control.agentSessionId, sessionIds: [...new Set([...goal.sessionIds, executor.agentSessionId])], assigneeSessionIds: [executor.agentSessionId],
        delegations: parseDemandDelegations([attempt('outline', true), attempt('workspace', false), attempt('drafts', true), attempt('history', true), attempt('reconnect', false, false)]) }
      const references = demandExecutionReferences(next)
      // The private Electron probe validates these DTOs with the production parser outside the browser.
      const responsibility: GoalResponsibilityObservation = { scope: demandResponsibilityScope(next), observedAt: next.updatedAt,
        supervisor: { agentSessionId: owner.control.agentSessionId, hostId: owner.control.hostId, runId: owner.control.run.runId,
          state: 'available', reason: 'The preview Supervisor can review the original reports.' },
        executions: references.map(execution => {
          const delegation = next.delegations.find(item => item.operationId === execution.operationId)!
          return { execution, binding: delegation.linkedAt ? 'confirmed' : 'unconfirmed',
            phase: delegation.report ? 'report-review' : delegation.linkedAt ? 'executing' : 'unknown',
            reason: delegation.report ? 'The original worker report is ready for independent review.' : delegation.linkedAt ? 'The assigned Agent is working on this plan node.' : 'The original delivery is unconfirmed. Inspect it before another attempt.',
            nextOwner: { kind: delegation.report || !delegation.linkedAt ? 'manager' : 'worker',
              agentSessionId: delegation.report || !delegation.linkedAt ? owner.control.agentSessionId : executor.agentSessionId,
              action: delegation.report ? 'Review and collect the original report.' : delegation.linkedAt ? 'Complete the assigned node and report its evidence.' : 'Reconcile the original dispatch.' },
            alert: delegation.report ? 'manager-review' : delegation.linkedAt ? null : 'unknown',
            basis: { stateEnteredAt: null, activityRevision: null, inputSubmissionId: null } }
        }) }
      const observed = { ...next, responsibility }
      // Actual observation hooks read these original preview facts instead of clearing the fixture.
      api.demands.delegation = async (operation, input) => input.goalId === next.id && operation === 'goal.delegations'
        ? { goalId: next.id, goalUpdatedAt: next.updatedAt, diskDurability: 'confirmed' as const, delegations: next.delegations, observations: [], plan, responsibility }
        : originalDelegation(operation, input)
      flushSync(() => {
        useAppStore.setState({ demands: { [next.id]: observed },
          sessions: [...state.sessions.filter(session => session.id !== worker.id), worker],
          config: { ...state.config!, hosts: [...state.config!.hosts.filter(host => host.id !== 'plan-worker'),
            { id: 'plan-worker', kind: 'ssh', label: 'Recovery worker', hostname: 'plan-worker.invalid' }] },
          agentNames: { ...state.agentNames, [worker.id]: 'Atlas · Recovery engineer', [owner.id]: 'Mira · Independent review' } })
        render()
      })
    },
    facts() {
      const state = useAppStore.getState(), goal = state.demands[state.selectedDemandId!]!
      return { plan: goal.plan, delegations: goal.delegations, responsibility: goal.responsibility }
    }
  }
}
