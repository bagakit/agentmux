import { agentPromptCondition, decideContinuousProgress, decideFutureProgress } from '@agentmux/core'
import type { GoalDelegationObservation } from '@agentmux/core/goal-delegation'
import { formatGoalTicketLink } from '@agentmux/core/sharing'
import type { Demand, DemandStore, DemandStoreChanges, DemandStoreSnapshot } from '@agentmux/demand'
import type { DemandDelegation, GoalWorkflowReviewRequest, GoalWorkflowReviewer } from '@agentmux/demand/delegations'
import { currentGoalWorkflowDelivery, projectGoalPlan, type GoalPlanOwner } from '@agentmux/demand/goal-plan'
import type { GoalRuntimePort } from './goal-runtime.js'
import { hostGoalAddress } from './goal-projection.js'
import { readGoalWorkflowPreferences } from './goal-workflow-settings.js'
import { resolveGoalWorkflowReviewer } from './goals-preferences.js'

type Runtime = Pick<GoalRuntimePort, 'goalHostRuntimeId' | 'agentCreation' | 'readInputEpoch' | 'observeCoreEvents' |
  'observeInputOccupation' | 'observeContinuousProgress' | 'saveGoalAttention' | 'inspectGoalAttention' | 'submitPrompt'>
type Work = { goalId: string; delegationOperationId: string; request: GoalWorkflowReviewRequest }
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
const reviewerKey = ({ runtimeId, agentSessionId }: GoalWorkflowReviewer) => JSON.stringify([runtimeId, agentSessionId])
const target = ({ operationId, reviewer }: GoalWorkflowReviewRequest, runId: string) => ({
  hostId: reviewer.hostId, expectedRuntimeId: reviewer.runtimeId, supervisorAgentSessionId: reviewer.agentSessionId,
  supervisorRunId: runId, operationId
})

/** Demand holds the work and one-send claim. Core holds the original review input. */
export class GoalWorkflowReviewOwner {
  private readonly pending = new Map<string, Work>()
  private readonly targets = new Map<string, Map<string, Set<string>>>()
  private readonly reviewerWork = new Map<string, Set<string>>()
  private readonly scope = new Map<string, AbortController>()
  private readonly activeReviewers = new Set<string>()
  private readonly deferred = new Set<string>()
  private readonly dirty = new Set<string>()
  private readonly issues = new Map<string, string>()
  private readonly lifetime = new AbortController()
  private readonly releases: Array<() => void> = []
  private revision = -1

  constructor(private readonly demands: DemandStore, private readonly runtime: Runtime, private readonly configurationPath: string,
    private readonly planOwner: () => Promise<GoalPlanOwner>, private readonly changed: (goalIds: string[]) => void) {}

  async reviewer(): Promise<GoalWorkflowReviewer | undefined> {
    const preferences = await readGoalWorkflowPreferences(this.configurationPath)
    const reviewer = preferences.template === 'off' ? undefined : resolveGoalWorkflowReviewer(preferences)
    return reviewer ? { hostId: reviewer.hostId, runtimeId: reviewer.runtimeId, agentSessionId: reviewer.sessionId } : undefined
  }

  async start(): Promise<void> {
    this.releases.push(this.demands.subscribe((snapshot, _ids, changes) => this.index(snapshot, changes)))
    this.releases.push(this.runtime.observeCoreEvents(['agent-session', 'agent-status', 'agent-input', 'connection-state'], (hostId, event) => {
      const host = this.targets.get(hostId)
      if (!host) return
      const sessionId = event.type === 'agent-session' ? event.session.agentSessionId : event.type === 'agent-input' ? event.receipt.ref.key.agentSessionId
        : 'agentSessionId' in event ? event.agentSessionId : undefined
      const groups = event.type === 'connection-state' ? host.values() : [sessionId ? host.get(sessionId) : undefined]
      const reviewers = new Set<string>()
      for (const ids of groups) for (const id of ids ?? []) {
        const work = this.pending.get(id)
        if (work) reviewers.add(reviewerKey(work.request.reviewer))
      }
      for (const reviewer of reviewers) for (const id of this.reviewerWork.get(reviewer) ?? []) this.queue(id)
    }))
    this.releases.push(this.runtime.observeInputOccupation(({ hostId, agentSessionId, run }) => {
      for (const id of this.targets.get(hostId)?.get(agentSessionId) ?? []) {
        if (this.pending.get(id)?.request.input?.runId === run.runId)
          this.scope.get(id)?.abort(new Error('The reviewer input is occupied. Its original draft is retained.'))
      }
    }))
    this.index(await this.demands.snapshot())
  }

  dispose(): void {
    this.lifetime.abort()
    for (const release of this.releases.splice(0)) release()
  }

  private index(snapshot: DemandStoreSnapshot, changes?: DemandStoreChanges): void {
    if (snapshot.revision <= this.revision || this.lifetime.signal.aborted) return
    const complete = this.revision < 0 || !changes || snapshot.revision !== this.revision + 1
    const records = new Map<string, Demand | null>(complete ? snapshot.demands.map(goal => [goal.id, goal]) : changes)
    this.revision = snapshot.revision
    const next = new Map<string, Work>()
    for (const [goalId, goal] of records) {
      if (!goal?.plan || !goal.alignment || goal.status === 'done' || goal.status === 'cancelled' ||
          !goal.delegations?.some(attempt => attempt.collection?.workflowReview)) continue
      const plan = projectGoalPlan(goal.plan, goal.delegations, goal.alignment.criteria, undefined, goal.alignment.revision)
      for (const row of plan.nodes) {
        const request = row.delegation?.collection?.workflowReview
        if (row.state === 'review' && request)
          next.set(request.operationId, { goalId, delegationOperationId: row.delegation!.operationId, request })
      }
    }
    for (const [operationId, prior] of this.pending) {
      if (next.has(operationId) || !complete && !records.has(prior.goalId)) continue
      this.remove(operationId)
      this.scope.get(operationId)?.abort(new Error('The original workflow delivery changed.'))
    }
    for (const [operationId, work] of next) {
      const wasPending = this.pending.has(operationId)
      this.pending.set(operationId, work)
      if (wasPending) continue
      const { hostId, agentSessionId } = work.request.reviewer
      const host = this.targets.get(hostId) ?? new Map<string, Set<string>>()
      const ids = host.get(agentSessionId) ?? new Set<string>()
      ids.add(operationId); host.set(agentSessionId, ids); this.targets.set(hostId, host)
      const key = reviewerKey(work.request.reviewer)
      const workIds = this.reviewerWork.get(key) ?? new Set<string>()
      workIds.add(operationId); this.reviewerWork.set(key, workIds)
      this.queue(operationId)
    }
  }

  private remove(operationId: string): void {
    const work = this.pending.get(operationId)
    if (!work) return
    this.pending.delete(operationId)
    this.dirty.delete(operationId)
    this.deferred.delete(operationId)
    this.issues.delete(operationId)
    const key = reviewerKey(work.request.reviewer), workIds = this.reviewerWork.get(key)
    workIds?.delete(operationId)
    if (!workIds?.size) this.reviewerWork.delete(key)
    const { hostId, agentSessionId } = work.request.reviewer, host = this.targets.get(hostId), ids = host?.get(agentSessionId)
    ids?.delete(operationId)
    if (!ids?.size) host?.delete(agentSessionId)
    if (!host?.size) this.targets.delete(hostId)
  }

  private queue(operationId: string): void {
    const work = this.pending.get(operationId)
    if (this.lifetime.signal.aborted || !work || work.request.input?.attemptedAt !== undefined) return
    if (this.scope.has(operationId)) { this.dirty.add(operationId); return }
    const reviewer = reviewerKey(work.request.reviewer)
    // One candidate may observe/claim a reviewer at a time. Core remains the
    // input authority even if other Goal owners or people use that Agent.
    if (this.activeReviewers.has(reviewer)) { this.deferred.add(operationId); return }
    this.activeReviewers.add(reviewer)
    const scope = new AbortController()
    this.scope.set(operationId, scope)
    const signal = AbortSignal.any([scope.signal, this.lifetime.signal])
    void this.deliver(work, signal).catch(error => {
      if (!this.lifetime.signal.aborted) this.issue(work, errorMessage(error))
    }).finally(() => {
      this.scope.delete(operationId)
      this.activeReviewers.delete(reviewer)
      const current = this.pending.get(operationId)
      const retry = this.dirty.delete(operationId) && current?.request.input?.attemptedAt === undefined
      for (const waiting of this.reviewerWork.get(reviewer) ?? []) {
        if (this.deferred.delete(waiting)) this.queue(waiting)
      }
      if (retry) this.queue(operationId)
    })
  }

  private issue(work: Work, reason: string): void {
    if (this.issues.get(work.request.operationId) === reason) return
    this.issues.set(work.request.operationId, reason)
    this.changed([work.goalId])
  }

  private async deliver(work: Work, signal: AbortSignal): Promise<void> {
    const { goalId, delegationOperationId, request: { operationId, reviewer } } = work
    const goal = await this.demands.get(goalId)
    const attempt = goal?.delegations?.find(value => value.operationId === delegationOperationId)
    const request = attempt?.collection?.workflowReview
    const node = goal && attempt && currentGoalWorkflowDelivery(goal, attempt)
    if (!goal || !attempt?.collection || !node || request?.operationId !== operationId || request.input?.attemptedAt !== undefined) return
    for (const other of this.reviewerWork.get(reviewerKey(reviewer)) ?? []) {
      const original = this.pending.get(other)?.request
      if (other !== operationId && original?.input?.attemptedAt !== undefined &&
          (await this.observeRequest(original)).state !== 'confirmed') {
        this.issue(work, 'The previous automatic review input is unconfirmed. Inspect that original request or record its independent review manually.')
        return
      }
    }
    if (await this.runtime.goalHostRuntimeId(reviewer.hostId) !== reviewer.runtimeId)
      throw new Error('The original workflow reviewer Runtime is unavailable at its saved Host.')
    const agent = await this.runtime.agentCreation(reviewer.hostId, reviewer.agentSessionId)
    if (agent.kind !== 'agent') throw new Error('The original workflow reviewer Session is unavailable.')
    let input = request.input
    if (!input) {
      const owner = await this.planOwner()
      const ticket = formatGoalTicketLink(goalId, hostGoalAddress(goal, owner), node.id)
      const agentMuxNote = JSON.stringify({ schema: 'agentmux.goal-workflow-review.v1', goalId, ticket,
        goalOwner: owner, nodeId: node.id, delegationOperationId, deliveryHash: request.deliveryHash,
        reviewOperationId: operationId + '-verdict', check: node.check,
        next: 'Read amux goal --skill and the exact Ticket and delivery at the original Goal owner. Use an approved route to that owner. Run the declared check against the exact delivered resource and version. Record the actual check, result and evidence with goal plan review using these identities. If access, resource, or evidence is unconfirmed, leave it pending and report the gap. Approval of the Goal remains with its person.' })
      const inputEpoch = await this.runtime.readInputEpoch(reviewer.hostId)
      signal.throwIfAborted()
      const saved = await this.demands.saveWorkflowReviewInput(goalId, delegationOperationId, operationId, {
        kind: 'prepare', input: { runId: agent.run.runId, ...(inputEpoch === undefined ? {} : { inputEpoch }), agentMuxNote }
      })
      input = saved.demand.delegations?.find(value => value.operationId === delegationOperationId)?.collection?.workflowReview?.input
    }
    if (!input || input.attemptedAt !== undefined) return
    if (input.runId !== agent.run.runId) throw new Error('The original workflow reviewer Run changed. Read the retained request or record an independent manual review.')
    const reference = { ...target(request, input.runId), ...(input.inputEpoch ? { inputEpoch: input.inputEpoch } : {}) }
    signal.throwIfAborted()
    await this.runtime.saveGoalAttention({ ...reference, intentId: operationId, agentMuxNote: input.agentMuxNote })
    const occurrence = { intentId: operationId, occurrenceAt: attempt.collection.collectedAt }
    const observed = await this.runtime.observeContinuousProgress({ hostId: reviewer.hostId, agentSessionId: reviewer.agentSessionId,
      providerId: agent.providerId, workspacePath: agent.workspacePath, futureIntentId: operationId }, operationId, Date.now(), signal)
    if (observed.session.run.runId !== input.runId) throw new Error('The original workflow reviewer Run changed before input.')
    const progress = decideContinuousProgress(observed)
    if (progress.kind === 'skip' && progress.reason === 'completion-consumed') {
      this.issue(work, 'The reviewer is waiting to finish its prior input.')
      return
    }
    const decision = decideFutureProgress(observed, occurrence)
    if (decision.kind !== 'send') { this.issue(work, 'The review is waiting for eligible input: ' + decision.reason + '.'); return }
    signal.throwIfAborted()
    const claim = await this.demands.saveWorkflowReviewInput(goalId, delegationOperationId, operationId, { kind: 'claim' })
    if (claim.replayed) return
    const current = await this.demands.get(goalId)
    if (!current || !currentGoalWorkflowDelivery(current, attempt)) return
    this.issues.delete(operationId)
    await this.runtime.submitPrompt({ kind: 'agent', hostId: reviewer.hostId, agentSessionId: reviewer.agentSessionId,
      expectedRuntimeId: reviewer.runtimeId, run: { runId: input.runId } }, '', operationId, agentPromptCondition(observed.session),
    { futureIntent: occurrence, inputByte: observed.inputByte!, isCurrent: () => !signal.aborted, signal },
    undefined, undefined, input.agentMuxNote, 'api')
    this.changed([goalId])
  }

  async observe(attempt: DemandDelegation): Promise<GoalDelegationObservation['workflowReview']> {
    const request = attempt.collection?.workflowReview
    return request ? this.observeRequest(request) : undefined
  }

  private async observeRequest(request: GoalWorkflowReviewRequest): Promise<NonNullable<GoalDelegationObservation['workflowReview']>> {
    const issue = this.issues.get(request.operationId)
    if (!request.input?.attemptedAt) return { state: 'prepared', reason: issue ?? 'Waiting for the original independent reviewer to accept input.' }
    try {
      const receipt = await this.runtime.inspectGoalAttention(target(request, request.input.runId))
      if (receipt?.agentSessionId === request.reviewer.agentSessionId && receipt.run.runId === request.input.runId &&
          receipt.admission?.submissionId === request.operationId && receipt.admission.acknowledged &&
          receipt.admission.intent?.message?.systemContext === request.input.agentMuxNote &&
          !receipt.admission.intent.message.authorHuman && !receipt.admission.intent.message.authorAgentSessionId)
        return { state: 'confirmed', reason: 'The independent reviewer received the original delivery. Its verdict remains separate.' }
      return { state: 'unknown', reason: issue ?? 'The original reviewer input is unconfirmed. Inspect its receipt or record an independent manual review.' }
    } catch (error) {
      return { state: 'unknown', reason: errorMessage(error) }
    }
  }
}
