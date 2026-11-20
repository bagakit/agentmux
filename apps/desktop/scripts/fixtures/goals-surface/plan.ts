import { flushSync } from 'react-dom'
import { parseDemandDispatch } from '../../../../../packages/demand/src/dispatch'
import { parseDemandDelegations, type DemandDelegation } from '@agentmux/demand/delegations'
import { parseGoalPlan, type GoalPlan, type GoalPlanNodeInput } from '@agentmux/demand/goal-plan'
import { demandExecutionReferences, demandResponsibilityScope } from '../../../../../packages/demand/src/responsibility'
import type { GoalResponsibilityObservation } from '@agentmux/core/goal-responsibility'
import type { GoalDelegationObservation } from '@agentmux/core/goal-delegation'
import { parseDemandPatrols, demandPatrolScope } from '../../../../../packages/demand/src/goal-patrol'
import { formatGoalAddress } from '@agentmux/core/sharing'
import { parseGoalPatrolObservations } from '@agentmux/core/goal-patrol'
import { hostGoalPlan } from '@agentmux/host/goal-projection'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'

/** Preview facts only: product projection and presentation remain the actual implementation. */
export function goalPlanPreview(seed: (mode: string) => void, render: () => void) {
  const originalDelegation = api.demands.delegation
  const originalInteraction = api.sessions.inspectInteraction
  return {
    /** `withoutDerivation` previews a Host that returns the plan without node states, as an older version does. */
    seed(withoutDerivation = false, openGuide = false, awaitingConfirmation = false, workflowState?: 'prepared' | 'confirmed', timelineDurationMs?: number, participation = false, approval = false) {
      seed('confirmed')
      const state = useAppStore.getState(), goal = state.demands[state.selectedDemandId!]!
      const agents = state.sessions.filter(session => session.kind === 'agent')
      const originalWorker = agents[0]!, originalSupervisor = agents[1] ?? originalWorker
      const owner: typeof originalSupervisor = awaitingConfirmation ? { ...originalSupervisor, processState: 'running',
        status: { state: 'running', source: 'run-process', observedAt: goal.updatedAt }, currentActivity: {
          state: 'idle', source: 'native-hook', providerId: originalSupervisor.providerId, run: originalSupervisor.control.run,
          nativeSessionId: 'preview-supervisor-session', nativeTurnId: 'preview-supervisor-turn', sourceId: 'preview-supervisor-source',
          sequence: 1, hookReceiptId: 'preview-supervisor-idle', observedAt: goal.updatedAt
        } } : originalSupervisor
      const worker = { ...originalWorker, id: 'plan-worker-session', hostId: 'plan-worker', control: {
        ...originalWorker.control, hostId: 'plan-worker', agentSessionId: 'plan-worker-session', run: { runId: 'plan-worker-run' }
      } }
      const previousWorker = { ...originalWorker, id: 'plan-previous-worker-session', hostId: 'plan-worker', control: {
        ...originalWorker.control, hostId: 'plan-worker', agentSessionId: 'plan-previous-worker-session', run: { runId: 'plan-previous-worker-run' }
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
      if (openGuide) {
        const guide = nodes.find(item => item.id === 'guide')!
        guide.executor = null
        guide.claimOpen = true
      }
      const at = (minute: number) => openGuide ? goal.createdAt + minute * 60_000 : minute
      const attempt = (nodeId: string, reported: boolean, linked = true): DemandDelegation => ({
        operationId: `attempt:${nodeId}`, sourceMessageId: `request:${nodeId}`, hostId: owner.control.hostId, workerHostId: executor.hostId,
        ownerAgentSessionId: owner.control.agentSessionId, workerAgentSessionId: executor.agentSessionId,
        ownerRunId: owner.control.run.runId, workerRunId: worker.control.run.runId, threadId: `thread:${nodeId}`,
        text: nodes.find(item => item.id === nodeId)!.outcome, alignmentRevision: goal.alignment!.revision,
        criterionIds: [criterion.id], capturedCriteria: [criterion], planNodeId: nodeId, preparedAt: at(1),
        ...(linked ? { linkedAt: at(2) } : {}),
        ...(reported ? { report: { operationId: `report:${nodeId}`, replyMessageId: `reply:${nodeId}`,
          authorAgentSessionId: executor.agentSessionId, submittedAt: at(nodeId === 'history' && timelineDurationMs !== undefined ? 2 : 3),
          grounding: { alignmentRevision: goal.alignment!.revision, summary: nodeId === 'history' ? 'The draft survives; the reading anchor still moves during live output.' : 'The original identities and saved content match the recovery log.',
            checks: [{ criterionId: criterion.id, outcome: 'met' as const, evidence: [`artifacts/recovery/${nodeId}.log`], note: '' }] } } } : {})
      })
      const review = (nodeId: string, verdict: 'pass' | 'changes'): GoalPlan['reviews'][number] => ({
        operationId: `review:${nodeId}`, nodeId, delegationOperationId: `attempt:${nodeId}`, verdict,
        check: { command: `pnpm test -- ${nodeId}`, result: '12 checks passed', evidence: [`artifacts/recovery/${nodeId}-review.log`] },
        note: verdict === 'changes' ? 'Keep the original reading anchor while output continues, then repeat the live-session check.' : '',
        reviewer: { kind: 'agent', id: owner.control.agentSessionId }, reviewedAt: at(4)
      })
      const person = { kind: 'user' as const, id: 'recovery-owner' }
      const historyReview = review('history', 'changes')
      const plan = parseGoalPlan({ revision: participation ? 3 : 2, alignmentRevision: goal.alignment!.revision, nodes,
        reviews: workflowState ? [] : [review('outline', 'pass'), participation ? { ...historyReview, reviewer: person } : historyReview],
        history: [...[1, 2].map(revision => ({ operationId: `plan:revision-${revision}`, revision, author: { kind: 'agent', id: owner.control.agentSessionId }, revisedAt: at(revision) })),
          ...(participation ? [{ operationId: 'original-assignment', revision: 3, author: person, revisedAt: at(2),
            change: { nodeId: 'workspace', assignment: { kind: 'assign', executor } } }] : [])] })
      const previousGuide = attempt('guide', true)
      previousGuide.workerAgentSessionId = previousWorker.control.agentSessionId
      previousGuide.workerRunId = previousWorker.control.run.runId
      previousGuide.report = { ...previousGuide.report!, authorAgentSessionId: previousWorker.control.agentSessionId,
        grounding: { ...previousGuide.report!.grounding, summary: 'The earlier guide result is retained after reassignment.' } }
      const outline = attempt('outline', true)
      const observations: GoalDelegationObservation[] = []
      if (workflowState) {
        const hash = 'a'.repeat(64), collectedAt = at(4), operationId = 'preview-independent-review'
        outline.report!.delivery = { schema: 'agentmux.ticket-delivery.v2', hash, authorRuntimeId: 'plan-worker-runtime' }
        outline.collection = { operationId: 'preview-collected-delivery', replyMessageId: outline.report!.replyMessageId, collectedAt,
          collector: { kind: 'agent', id: owner.control.agentSessionId },
          workflowReview: { operationId, deliveryHash: hash, reviewer: { hostId: owner.control.hostId, runtimeId: 'workbench-preview-runtime', agentSessionId: owner.control.agentSessionId },
            ...(workflowState === 'confirmed' ? { input: { runId: owner.control.run.runId, agentMuxNote: 'Verify the original delivery.', attemptedAt: collectedAt + 1 } } : {}) } }
        observations.push({ operationId: outline.operationId, workflowReview: { state: workflowState,
          reason: workflowState === 'confirmed' ? 'The independent reviewer received the original delivery. Its verdict remains separate.'
            : 'Waiting for the original independent reviewer to accept input.' } })
      }
      const alignment = timelineDurationMs === undefined ? goal.alignment! : { ...goal.alignment!, confirmedAt: at(1),
        confirmedBy: participation ? person : { kind: 'agent' as const, id: owner.control.agentSessionId, hostId: owner.control.hostId, runtimeId: 'workbench-preview-runtime' } }
      const patrols = participation ? parseDemandPatrols([{ purpose: 'confirmation', operationId: 'original-continue-request',
        expectedScope: JSON.stringify([goal.id, owner.control.agentSessionId, alignment.revision, alignment.confirmedAt]), executions: [], alignment,
        supervisorAgentSessionId: owner.control.agentSessionId, recipientHostId: owner.control.hostId, context: 'Continue the original recovery.',
        requestedBy: { kind: 'device', id: 'workspace-console' }, requestedAt: at(2), attempts: [] }]) : undefined
      const authoredStart = participation ? parseDemandDispatch({ operationId: 'authored-recovery-start', stage: 'confirmed', execution: 'finite',
        target: { kind: 'space-member', source: { runtimeId: 'workbench-preview-runtime', spaceId: 'workspace-recovery',
          regionId: 'recovery-worker', admission: { kind: 'creation', operationId: 'original-recovery-agent' } },
          execution: { runtimeId: 'plan-worker-runtime', agentSessionId: executor.agentSessionId } },
        runId: worker.control.run.runId, prompt: 'Check that the original workspace and unsent drafts are still available.',
        request: { requestedBy: person, requestedAt: at(2), goalUpdatedAt: goal.updatedAt }, preparedAt: at(3), submittedAt: at(3),
        receipt: { kind: 'core-input', inputKey: { kind: 'prompt', expectedRun: worker.control.run,
          agentSessionId: executor.agentSessionId, submissionId: 'authored-recovery-start' }, outcome: 'admitted', observedAt: at(4) }
      }) : undefined
      const inputKey = authoredStart?.receipt?.kind === 'core-input' ? authoredStart.receipt.inputKey : undefined
      const attribution = approval && inputKey ? { kind: 'explicit-goal-selection' as const, goalId: goal.id,
        dispatchOperationId: inputKey.submissionId, inputKey, actor: { kind: 'device' as const, id: 'workspace-console' }, at: at(4) + 30_000 } : undefined
      const observation = attribution ? { operationId: 'review-original-access', requestId: 'permission-read-workspace', attribution,
        decision: 'approved' as const, delivery: 'unknown' as const, nativeCompleted: false } : undefined
      api.sessions.inspectInteraction = async (control, operationId) => {
        if (!observation || operationId !== observation.operationId || control.kind !== 'agent' || control.hostId !== 'local' ||
            control.agentSessionId !== observation.attribution.inputKey.agentSessionId || control.run.runId !== observation.attribution.inputKey.expectedRun.runId)
          return originalInteraction(control, operationId)
        const { requestId, attribution, delivery } = observation
        return { operationId, agentSessionId: control.agentSessionId, run: control.run, goalApproval: attribution, delivery, nativeAdoption: 'unknown' as const,
          response: { kind: 'permission', requestId, decision: { outcome: 'selected', optionId: 'allow-once' } },
          expectedRequest: { kind: 'permission', id: requestId, agentSessionId: control.agentSessionId, title: 'Read the original workspace',
            options: [{ id: 'allow-once', kind: 'allow-once', label: 'Allow once' }],
            evidence: { source: 'acp', run: control.run, observedAt: at(4) } } }
      }
      const next = { ...goal, alignment, ...(authoredStart ? { dispatches: [authoredStart] } : {}),
        ...(observation ? { approvalObservations: [observation] } : {}), ...(patrols ? { patrols } : {}), ...(openGuide ? { address: formatGoalAddress(goal.id, 'workbench-preview-runtime', 'workspace-recovery') } : {}), title: 'Return to the same work, without rebuilding it',
        ...(timelineDurationMs === undefined ? {} : { plannedStartAt: at(1), targetAt: at(4) }),
        ...(awaitingConfirmation ? { alignment: { ...goal.alignment!, confirmedAt: null }, plan: { ...plan, reviews: [] } } : { plan }),
        activities: Array.from({ length: 8 }, (_, index) => ({ id: `original-note:${index}`, kind: 'Progress',
          message: index === 7 ? 'The original checks are ready for independent review.' : 'Kept the original workspace and recorded the recovery evidence.',
          createdAt: goal.createdAt + index * 60000, actorId: worker.control.agentSessionId })),
        decisions: [{ id: 'original-decision', question: 'Which work should the next check use?', decision: 'Continue from the same original workspace.',
          rationale: 'The existing Sessions, reading anchors and unsent drafts belong to this work.', actorId: owner.control.agentSessionId, createdAt: goal.createdAt + 9 * 60000 }],
        supervisorSessionId: owner.control.agentSessionId, sessionIds: [...new Set([...goal.sessionIds, executor.agentSessionId, previousWorker.control.agentSessionId])], assigneeSessionIds: [owner.control.agentSessionId, executor.agentSessionId],
        delegations: awaitingConfirmation ? [] : parseDemandDelegations([outline, attempt('workspace', false), attempt('drafts', true), attempt('history', true), attempt('reconnect', false, false), ...(openGuide ? [] : [previousGuide])]) }
      const references = demandExecutionReferences(next)
      // The private Electron probe validates these DTOs with the production parser outside the browser.
      const responsibility: GoalResponsibilityObservation = { scope: demandResponsibilityScope(next), observedAt: next.updatedAt,
        supervisor: { agentSessionId: owner.control.agentSessionId, hostId: owner.control.hostId, runId: owner.control.run.runId,
          state: 'available', reason: 'The preview Supervisor can review the original reports.' },
        executions: references.filter(execution => execution.kind === 'delegation').map(execution => {
          const delegation = next.delegations.find(item => item.operationId === execution.operationId)!
          return { execution, binding: delegation.linkedAt ? 'confirmed' : 'unconfirmed',
            phase: delegation.report ? 'report-review' : delegation.linkedAt ? 'executing' : 'unknown',
            reason: delegation.report ? 'The original worker report is ready for independent review.' : delegation.linkedAt ? 'The assigned Agent is working on this plan node.' : 'The original delivery is unconfirmed. Inspect it before another attempt.',
            nextOwner: { kind: delegation.report || !delegation.linkedAt ? 'manager' : 'worker',
              agentSessionId: delegation.report || !delegation.linkedAt ? owner.control.agentSessionId : executor.agentSessionId,
              action: delegation.report ? 'Review and collect the original report.' : delegation.linkedAt ? 'Complete the assigned node and report its evidence.' : 'Reconcile the original dispatch.' },
            alert: delegation.report ? 'manager-review' : delegation.linkedAt ? null : 'unknown',
            ...(delegation.operationId === 'attempt:workspace' && delegation.linkedAt ? {
              stateSince: delegation.linkedAt + 10_000,
              observation: { process: 'running' as const, semantic: 'active' as const, source: 'native-hook' as const,
                readiness: 'ready' as const, observedAt: delegation.linkedAt + 10_000 + (timelineDurationMs ?? 85_000), stale: false }
            } : {}),
            basis: { stateEnteredAt: null, activityRevision: null, inputSubmissionId: null } }
        }) }
      const owned = withoutDerivation ? { plan } : hostGoalPlan(next), observed = { ...next, ...owned, responsibility, delegationObservations: observations }
      // Actual observation hooks read these original preview facts instead of clearing the fixture.
      api.demands.delegation = async (operation, input) => input.goalId === next.id && operation === 'goal.delegations'
        ? { goalId: next.id, goalUpdatedAt: next.updatedAt, diskDurability: 'confirmed' as const, delegations: next.delegations, observations, ...owned, responsibility, ...(patrols ? { patrols } : {}), ...(authoredStart ? { dispatches: [authoredStart] } : {}) }
        : originalDelegation(operation, input)
      flushSync(() => {
        useAppStore.setState({ demands: { [next.id]: observed },
          sessions: [...state.sessions.filter(session => session.id !== worker.id && session.id !== previousWorker.id)
            .map(session => session.id === owner.id ? owner : session), worker, previousWorker],
          config: { ...state.config!, hosts: [...state.config!.hosts.filter(host => host.id !== 'plan-worker'),
            { id: 'plan-worker', kind: 'ssh', label: 'Recovery worker', hostname: 'plan-worker.invalid' }] },
          agentNames: { ...state.agentNames, [worker.id]: 'Atlas · Recovery engineer', [owner.id]: 'Mira · Independent review', [previousWorker.id]: 'Earlier guide author' } })
        render()
      })
    },
    activeTickets(unavailable = false) {
      seed('many')
      const { demands } = useAppStore.getState()
      const [first, second] = Object.values(demands)
      const owner = { runtimeId: 'preview-ticket-runtime', namespace: 'preview-ticket-store' }
      const node = (id: string, title: string, state: import('@agentmux/demand').GoalActiveNode['state']): import('@agentmux/demand').GoalActiveNode =>
        ({ nodeId: id.repeat(43), title, state, unknown: state === 'unknown' ? ['dispatch-link'] : [], predecessors: [] })
      const goals = [
        { goalId: first!.id, goalUpdatedAt: first!.updatedAt, nodes: [
          node('A', 'Verify workspace recovery after restart', 'review'),
          node('B', 'Publish the recovery guide', 'ready'),
          node('C', 'Check the original Agent connection', 'unknown'),
        ] },
        { goalId: second!.id, goalUpdatedAt: second!.updatedAt, nodes: [
          node('D', 'Keep the terminal reading position while the original Agent continues to produce output after reconnecting', 'changes'),
          node('E', 'Record reproducible performance measurements', 'working'),
        ] },
      ]
      api.demands.delegation = (async (operation, input) => {
        if (operation !== 'goal.plan.active') return originalDelegation(operation, input)
        if (unavailable) throw Error('The original active Goal index is unconfirmed.')
        return { owner, view: 'manage', goals }
      }) as typeof originalDelegation
      flushSync(() => {
        useAppStore.setState({ demands: Object.fromEntries([first!, second!].map(goal => [goal.id,
          { ...goal, address: formatGoalAddress(goal.id, owner.runtimeId, owner.namespace) }])) })
        render()
      })
    },
    inspection() {
      seed('confirmed')
      const store = useAppStore.getState(), original = store.demands[store.selectedDemandId!]!
      const worker = store.sessions.find(session => session.kind === 'agent')!
      const dispatches = [parseDemandDispatch({ operationId: 'workspace-check', execution: 'finite', stage: 'prepared',
        agentSessionId: worker.control.agentSessionId, hostId: worker.control.hostId, runId: worker.control.run.runId,
        prompt: 'Check the recovery state of the original workspace.', preparedAt: original.updatedAt - 90_000 })]
      const goal = { ...original, dispatches, title: 'Restore the original workspace', supervisorSessionId: null, assigneeSessionIds: [],
        description: 'Recover the same workspace with every tab, agent session and unsent draft intact.' }
      const at = goal.updatedAt, operationId = 'inspection:workspace/original'
      const request = { expectedScope: demandPatrolScope(goal), supervisorAgentSessionId: null, executions: demandExecutionReferences(goal), context: goal.description,
        requestedBy: { kind: 'user', id: 'workspace-owner' }, attempts: [] }
      const patrols = parseDemandPatrols([
        { ...request, operationId: 'inspection:workspace/earlier', requestedAt: at - 60000 },
        { ...request, operationId, requestedAt: at },
      ])
      const patrolObservations = parseGoalPatrolObservations([{ operationId, state: 'missing', reason: 'Original inspection retained. Supervisor delivery has not been confirmed.' }], patrols.map(item => item.operationId))
      api.demands.delegation = async (operation, input) => input.goalId === goal.id && operation === 'goal.delegations'
        ? { goalId: goal.id, goalUpdatedAt: goal.updatedAt, diskDurability: 'confirmed', delegations: [], dispatches, patrols, patrolObservations }
        : originalDelegation(operation, input)
      flushSync(() => { useAppStore.setState({ demands: { [goal.id]: { ...goal, patrols, patrolObservations } } }); render() })
    },
    request(state: 'none' | 'prepared' | 'delivered' | 'missing' | 'unknown' | 'stale') {
      seed('confirmed')
      const store = useAppStore.getState(), goal = store.demands[store.selectedDemandId!]!, agents = store.sessions.filter(session => session.kind === 'agent')
      const supervisor = agents[1] ?? agents[0]!, now = goal.updatedAt
      const next = { ...goal, title: 'Restore the original workspace', supervisorSessionId: state === 'none' ? null : supervisor.control.agentSessionId,
        assigneeSessionIds: state === 'none' ? [] : [supervisor.control.agentSessionId], plan: undefined, planState: undefined, responsibility: undefined }
      const reason = { prepared: 'The Supervisor is working. This original planning request waits for eligible input; the current draft and Agent remain available.',
        delivered: 'The original planning input is confirmed. Waiting for this Supervisor to save a newer plan in the same Goal.',
        missing: 'The original Supervisor Host is unavailable. Reconnect its original Host, then continue this saved request; no replacement Agent was created.',
        unknown: 'The original input receipt could not be read. Check this same request; it is never automatically resent.',
        stale: 'The original Supervisor Run changed. Explicitly continue this never-attempted request on its recovered same Session.' }
      const patrols = state === 'none' ? [] : parseDemandPatrols([{ purpose: 'plan', planRevision: 0, operationId: 'original-planning-request',
        expectedScope: demandPatrolScope(next as never, 'plan'), executions: [], supervisorAgentSessionId: supervisor.control.agentSessionId,
        context: JSON.stringify({ goalId: goal.id, planRevision: 0 }), requestedBy: { kind: 'user', id: 'preview-person' }, requestedAt: now,
        attempts: state === 'missing' ? [] : [{ operationId: 'original-planning-input', actionOperationId: 'original-planning-request', intentId: 'original-planning-input',
          target: { hostId: supervisor.control.hostId, agentSessionId: supervisor.control.agentSessionId,
            runId: state === 'stale' ? 'original-earlier-run' : supervisor.control.run.runId, providerId: supervisor.providerId, workspacePath: supervisor.workspacePath },
          agentMuxNote: 'Original saved planning request', preparedAt: now, ...(['delivered', 'unknown'].includes(state) ? { attemptedAt: now } : {}) }] }])
      const patrolObservations = state === 'none' ? [] : parseGoalPatrolObservations([{ operationId: 'original-planning-request', state, reason: reason[state] }], ['original-planning-request'])
      const observed = { ...next, patrols, patrolObservations }
      api.demands.delegation = async (operation, input) => input.goalId === goal.id && operation === 'goal.delegations'
        ? { goalId: goal.id, goalUpdatedAt: goal.updatedAt, diskDurability: 'confirmed', delegations: [], patrols, patrolObservations }
        : originalDelegation(operation, input)
      flushSync(() => { useAppStore.setState({ demands: { [goal.id]: observed as never }, goalDiscussionRequests: state === 'none' ? {} : {
        [JSON.stringify([goal.id, 'plan'])]: { goalId: goal.id, mode: 'plan', requestId: 'original-planning-request' } }, agentNames: { ...store.agentNames, [supervisor.id]: 'Mira' } }); render() })
    },
    facts() {
      const state = useAppStore.getState(), goal = state.demands[state.selectedDemandId!]!
      return { plan: goal.plan, delegations: goal.delegations, responsibility: goal.responsibility }
    }
  }
}
