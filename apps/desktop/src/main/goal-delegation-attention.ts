import { createHash } from 'node:crypto'
import { agentPromptCondition, decideFutureProgress, type AgentMuxClientEvent } from '@agentmux/core'
import type { DemandStore } from '@agentmux/demand'
import type { DemandDelegation, DemandDelegationAttention } from '@agentmux/demand/delegations'
import type { GoalDelegationOwner } from './goal-delegation-owner.js'
import type { RuntimeController } from './runtime-controller.js'

export type GoalAttentionObservation = { state: 'prepared' | 'confirmed' | 'unknown'; reason: string }
type Runtime = Pick<RuntimeController, 'agentCreation' | 'observeCoreEvents' | 'observeOriginalRun' |
  'saveGoalAttention' | 'inspectGoalAttention' | 'observeContinuousProgress' | 'submitPrompt' | 'observeInputOccupation'>
type Reference = { goalId: string; operationId: string }
const key = (hostId: string, id: string) => JSON.stringify([hostId, id])
const describe = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Original business references + exact Runtime events, with no timer, queue or new Agent. */
export class GoalDelegationAttentionOwner {
  private readonly workers = new Map<string, Reference[]>()
  private readonly supervisors = new Map<string, Reference[]>()
  private readonly sources = new Map<string, Reference[]>()
  private readonly hosts = new Map<string, Reference[]>()
  private readonly flights = new Map<string, Promise<void>>()
  private readonly scopes = new Map<string, { controller: AbortController; supervisor: string; runId: string | undefined }>()
  private readonly dirty = new Map<string, Reference>()
  private readonly issues = new Map<string, string>()
  private readonly controller = new AbortController()
  private disposers: Array<() => void> = []
  private startupIssue: string | undefined
  private epochs = new Map<string, string>()
  constructor(private readonly demands: DemandStore, private readonly runtime: Runtime,
    private readonly owner: GoalDelegationOwner, private readonly changed: (goalIds: string[]) => void) {}

  async start(): Promise<void> {
    this.disposers.push(this.demands.subscribe(snapshot => { this.startupIssue = undefined; this.index(snapshot.demands) }))
    this.disposers.push(this.runtime.observeCoreEvents(['process-state', 'agent-session', 'dispatch-changed', 'connection-state'],
      (hostId, event) => this.event(hostId, event)))
    this.disposers.push(this.runtime.observeInputOccupation(control => {
      for (const ref of this.supervisors.get(key(control.hostId, control.agentSessionId)) ?? []) {
        const scope = this.scopes.get(key(ref.goalId, ref.operationId))
        if (scope?.runId === control.run.runId)
          scope.controller.abort(new Error('The original Supervisor input became occupied before reminder admission. Its draft and Agent are retained.'))
      }
    }))
    try { this.index((await this.demands.snapshot()).demands) }
    catch (error) { this.startupIssue = 'Observing original Goal responsibilities failed: ' + describe(error); return }
    for (const refs of this.hosts.values()) for (const ref of refs) void this.check(ref)
  }
  dispose(): void { this.controller.abort(); for (const dispose of this.disposers.splice(0)) dispose() }
  private index(goals: Awaited<ReturnType<DemandStore['list']>>): void {
    this.workers.clear(); this.supervisors.clear(); this.sources.clear(); this.hosts.clear()
    const current = new Map(goals.flatMap(goal => (goal.delegations ?? []).map(delegation =>
      [key(goal.id, delegation.operationId), { goal, delegation }] as const)))
    for (const [id, scope] of this.scopes) {
      const entry = current.get(id)
      if (!entry || entry.delegation.collection || entry.goal.supervisorSessionId !== scope.supervisor)
        scope.controller.abort(new Error('The original Goal responsibility was collected or handed off before reminder admission.'))
    }
    const add = (index: Map<string, Reference[]>, id: string, ref: Reference) => index.set(id, [...index.get(id) ?? [], ref])
    for (const goal of goals) {
      const epoch = JSON.stringify([goal.supervisorSessionId, goal.delegations])
      const changed = this.epochs.get(goal.id) !== epoch; this.epochs.set(goal.id, epoch)
      for (const delegation of goal.delegations ?? []) {
        if (delegation.collection) continue
        const ref = { goalId: goal.id, operationId: delegation.operationId }
        add(this.workers, key(delegation.hostId, delegation.workerRunId), ref)
        if (goal.supervisorSessionId) add(this.supervisors, key(delegation.hostId, goal.supervisorSessionId), ref)
        add(this.sources, key(delegation.hostId, delegation.sourceMessageId), ref)
        add(this.hosts, delegation.hostId, ref)
        if (changed && delegation.linkedAt) queueMicrotask(() => { if (!this.controller.signal.aborted) void this.check(ref) })
      }
    }
  }
  private event(hostId: string, event: AgentMuxClientEvent): void {
    const refs = event.type === 'process-state' ? this.workers.get(key(hostId, event.run.runId))
      : event.type === 'agent-session' ? this.supervisors.get(key(hostId, event.session.agentSessionId))
      : event.type === 'dispatch-changed' ? this.sources.get(key(hostId, event.sourceMessageId))
      : event.type === 'connection-state' ? this.hosts.get(hostId) : undefined
    for (const ref of refs ?? []) {
      const scope = this.scopes.get(key(ref.goalId, ref.operationId))
      if (event.type === 'agent-session' && scope?.runId && event.session.run.runId !== scope.runId)
        scope.controller.abort(new Error('The original Supervisor reminder Run changed before admission.'))
      void this.check(ref)
    }
  }
  private check(ref: Reference): Promise<void> {
    const id = key(ref.goalId, ref.operationId), previous = this.flights.get(id)
    if (previous) { this.dirty.set(id, ref); return previous }
    const flight = this.run(ref).catch(error => this.issue(ref, describe(error))).finally(() => {
      this.flights.delete(id); this.scopes.delete(id)
      const dirty = this.dirty.get(id); this.dirty.delete(id)
      if (dirty && !this.controller.signal.aborted) queueMicrotask(() => { void this.check(dirty) })
    })
    this.flights.set(id, flight); return flight
  }
  private issue(ref: Reference, reason: string): void {
    const id = key(ref.goalId, ref.operationId)
    if (this.issues.get(id) !== reason) { this.issues.set(id, reason); this.changed([ref.goalId]) }
  }
  private async run(ref: Reference): Promise<void> {
    this.controller.signal.throwIfAborted()
    const goal = await this.demands.get(ref.goalId)
    const delegation = goal?.delegations?.find(item => item.operationId === ref.operationId)
    if (!goal || !delegation?.linkedAt || delegation.collection || !goal.supervisorSessionId) return
    const scope = { controller: new AbortController(), supervisor: goal.supervisorSessionId, runId: delegation.attention?.supervisorRunId }
    this.scopes.set(key(ref.goalId, ref.operationId), scope)
    const signal = AbortSignal.any([this.controller.signal, scope.controller.signal])
    let attention = delegation.attention
    if (attention && attention.supervisorAgentSessionId !== goal.supervisorSessionId) {
      this.issue(ref, 'The saved reminder belongs to the original Supervisor. Review its responsibility before explicit continuation; it was not rerouted.'); return
    }
    if (attention?.attemptedAt !== undefined) return // Reconnect/late events only inspect the original input.
    if (!attention) {
      const principal = { kind: 'user' as const, id: 'local-user:' + (process.getuid?.() ?? 'current') }
      const observation = await this.owner.observeDelegation(goal.id, delegation, { principal, signal })
      const ended = observation?.workerRun?.state === 'exited' || observation?.workerRun?.state === 'interrupted'
      if (!ended && !delegation.report && !observation?.recoverableReport) return
      const supervisor = await this.runtime.agentCreation(delegation.hostId, goal.supervisorSessionId)
      const digest = createHash('sha256').update(JSON.stringify([goal.id, delegation.operationId, delegation.sourceMessageId])).digest('hex')
      const agentMuxNote = JSON.stringify({ schema: 'agentmux.goal-attention.v1', goalId: goal.id,
        operationId: delegation.operationId, sourceMessageId: delegation.sourceMessageId, hostId: delegation.hostId,
        originalOwnerAgentSessionId: delegation.ownerAgentSessionId, workerAgentSessionId: delegation.workerAgentSessionId,
        workerRunId: delegation.workerRunId, supervisorAgentSessionId: supervisor.agentSessionId,
        observation: ended ? observation?.workerRun?.state === 'interrupted' ? 'The original worker Run was interrupted.' : 'The original worker Run has ended.' : 'An original worker report is recorded.',
        next: 'This delegation has no collected result in the original Goal. Read goal delegations, inspect the original reply and evidence, and explicitly goal collect the actual report. If no report is available, retain the original worker identity and record the blocker or explicit continuation. Observation unavailable is unknown. Do not mark the Goal done, accepted, or replace an unknown message.' })
      await this.demands.prepareDelegationAttention(goal.id, delegation.operationId, {
        operationId: 'goal-attention-' + digest, intentId: 'goal-attention-' + digest,
        hostId: delegation.hostId, supervisorAgentSessionId: supervisor.agentSessionId, supervisorRunId: supervisor.run.runId,
        occurrenceAt: delegation.preparedAt, agentMuxNote })
      attention = (await this.demands.inspectDelegation(goal.id, delegation.operationId))!.attention!
    }
    signal.throwIfAborted(); scope.runId = attention.supervisorRunId
    await this.runtime.saveGoalAttention(attention)
    signal.throwIfAborted()
    const supervisor = await this.runtime.agentCreation(attention.hostId, attention.supervisorAgentSessionId)
    const observation = await this.runtime.observeContinuousProgress({ hostId: attention.hostId,
      agentSessionId: attention.supervisorAgentSessionId, providerId: supervisor.providerId, workspacePath: supervisor.workspacePath,
      futureIntentId: attention.intentId }, attention.operationId, Date.now(), signal)
    if (observation.session.run.runId !== attention.supervisorRunId) throw new Error('The original Supervisor reminder Run changed; its input and responsibility are retained.')
    const occurrence = { intentId: attention.intentId, occurrenceAt: attention.occurrenceAt }
    const decision = decideFutureProgress(observation, occurrence)
    if (decision.kind !== 'send') { this.issue(ref, 'The original Supervisor reminder is prepared: ' + decision.reason + '. Manual input and the Agent remain available.'); return }
    const before = await this.demands.get(goal.id), current = before?.delegations?.find(item => item.operationId === delegation.operationId)
    if (!current?.attention || current.attention.attemptedAt !== undefined || current.collection ||
      before?.supervisorSessionId !== attention.supervisorAgentSessionId) return
    this.issues.delete(key(ref.goalId, ref.operationId))
    await this.demands.markDelegationAttentionAttempt(goal.id, delegation.operationId, attention.operationId)
    const attempted = await this.demands.get(goal.id), exact = attempted?.delegations?.find(item => item.operationId === delegation.operationId)
    if (!attempted || exact?.collection || exact?.attention?.operationId !== attention.operationId ||
      attempted.supervisorSessionId !== attention.supervisorAgentSessionId) return
    const stillCurrent = () => !signal.aborted && !scope.controller.signal.aborted
    await this.runtime.submitPrompt({ kind: 'agent', hostId: attention.hostId, agentSessionId: attention.supervisorAgentSessionId,
      run: { runId: attention.supervisorRunId } }, '', attention.operationId, agentPromptCondition(observation.session),
      { futureIntent: occurrence, inputByte: observation.inputByte!, isCurrent: stillCurrent, signal },
      undefined, undefined, attention.agentMuxNote, 'api')
    this.changed([goal.id])
  }
  async observe(goalId: string, delegation: DemandDelegation): Promise<GoalAttentionObservation | undefined> {
    if (this.startupIssue) throw new Error(this.startupIssue)
    const attention: DemandDelegationAttention | undefined = delegation.attention
    const issue = this.issues.get(key(goalId, delegation.operationId))
    if (!attention) {
      // Main exposes this exact observation failure as unknown for the original
      // delegation; it does not manufacture a reminder identity or gate the Agent.
      if (issue) throw new Error(issue)
      return undefined
    }
    if (attention.attemptedAt === undefined) return { state: 'prepared', reason: issue ?? 'The original Supervisor reminder is prepared and waiting for eligible input.' }
    try {
      const receipt = await this.runtime.inspectGoalAttention(attention)
      if (receipt?.agentSessionId === attention.supervisorAgentSessionId && receipt.run.runId === attention.supervisorRunId &&
        receipt.admission?.submissionId === attention.operationId && receipt.admission.acknowledged &&
        receipt.admission.intent?.message?.systemContext === attention.agentMuxNote &&
        !receipt.admission.intent.message.authorHuman && !receipt.admission.intent.message.authorAgentSessionId)
        return { state: 'confirmed', reason: 'The original Supervisor received the AgentMux reminder. Collection and human acceptance remain separate.' }
      return { state: 'unknown', reason: issue ?? 'The original reminder submission is unconfirmed. Inspect its saved Core input identity before an explicit recovery; it is never automatically resent.' }
    } catch (error) { return { state: 'unknown', reason: describe(error) } }
  }
}
