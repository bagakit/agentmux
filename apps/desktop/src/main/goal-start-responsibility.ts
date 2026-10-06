import { createHash } from 'node:crypto'
import { agentPromptCondition, decideFutureProgress, type AgentMuxClientEvent, type AgentPromptSubmissionRecord } from '@agentmux/core'
import type { Demand, DemandDispatch, DemandStore, GoalStartObservation } from '@agentmux/demand'
import type { RuntimeController } from './runtime-controller.js'

export type GoalStartRuntimePort = Pick<RuntimeController, 'agentCreation' | 'observeCoreEvents' | 'observeOriginalRun' |
  'saveGoalAttention' | 'inspectGoalAttention' | 'observeContinuousProgress' | 'submitPrompt' | 'observeInputOccupation'> & {
  inspectGoalStart(dispatch: DemandDispatch): Promise<AgentPromptSubmissionRecord | null>
}
type Reference = { goalId: string; operationId: string }
const key = (first: string, second: string) => JSON.stringify([first, second])
const describe = (error: unknown) => error instanceof Error ? error.message : String(error)
const newResult = (goal: Demand, start: DemandDispatch) => Boolean(start.resultBasis && goal.grounding &&
  goal.grounding.submissionId !== start.resultBasis.groundingSubmissionId && goal.grounding.alignmentRevision === goal.alignment?.revision)
const closed = (goal: Demand) => goal.status === 'done' || goal.status === 'cancelled'

/** Finite Start keeps its original Core prompt provenance; it never becomes an A2A report. */
export class GoalStartResponsibilityOwner {
  private readonly workers = new Map<string, Reference[]>()
  private readonly sessions = new Map<string, Reference[]>()
  private readonly hosts = new Map<string, Reference[]>()
  private readonly flights = new Map<string, Promise<void>>()
  private readonly dirty = new Map<string, Reference>()
  private readonly scopes = new Map<string, { controller: AbortController; supervisor: string; runId?: string }>()
  private readonly issues = new Map<string, string>()
  private readonly epochs = new Map<string, string>()
  private readonly controller = new AbortController()
  private disposers: Array<() => void> = []
  private startupIssue: string | undefined
  constructor(private readonly demands: DemandStore, private readonly runtime: GoalStartRuntimePort,
    private readonly changed: (goalIds: string[]) => void) {}

  async start(): Promise<void> {
    this.disposers.push(this.demands.subscribe(snapshot => { this.startupIssue = undefined; this.index(snapshot.demands) }))
    this.disposers.push(this.runtime.observeCoreEvents(['process-state', 'agent-session', 'connection-state'], (host, event) => this.event(host, event)))
    this.disposers.push(this.runtime.observeInputOccupation(control => {
      for (const ref of this.sessions.get(key(control.hostId, control.agentSessionId)) ?? []) {
        const scope = this.scopes.get(key(ref.goalId, ref.operationId))
        if (scope?.supervisor === control.agentSessionId && scope.runId === control.run.runId)
          scope.controller.abort(new Error('The original Supervisor input became occupied. Its draft and Agent are retained.'))
      }
    }))
    try { this.index((await this.demands.snapshot()).demands) }
    catch (error) { this.startupIssue = 'Observing original Goal Starts failed: ' + describe(error) }
  }
  dispose(): void { this.controller.abort(); for (const dispose of this.disposers.splice(0)) dispose() }
  private index(goals: Demand[]): void {
    this.workers.clear(); this.sessions.clear(); this.hosts.clear()
    const current = new Map(goals.flatMap(goal => (goal.dispatches ?? []).filter(start => start.execution === 'finite')
      .map(start => [key(goal.id, start.operationId), { goal, start }] as const)))
    for (const [id, scope] of this.scopes) {
      const item = current.get(id)
      if (!item || closed(item.goal) || item.goal.supervisorSessionId !== scope.supervisor)
        scope.controller.abort(new Error('The original Goal Start responsibility changed before reminder admission.'))
    }
    const add = (map: Map<string, Reference[]>, id: string, ref: Reference) => map.set(id, [...map.get(id) ?? [], ref])
    for (const [id, { goal, start }] of current) {
      if (closed(goal)) continue
      const ref = { goalId: goal.id, operationId: start.operationId }
      add(this.workers, key(start.hostId, start.runId), ref)
      add(this.sessions, key(start.hostId, start.agentSessionId), ref)
      if (goal.supervisorSessionId && goal.supervisorSessionId !== start.agentSessionId) add(this.sessions, key(start.hostId, goal.supervisorSessionId), ref)
      add(this.hosts, start.hostId, ref)
      const epoch = JSON.stringify([goal.supervisorSessionId, goal.grounding?.submissionId, start])
      if (this.epochs.get(id) !== epoch) queueMicrotask(() => { if (!this.controller.signal.aborted) void this.check(ref) })
      this.epochs.set(id, epoch)
    }
  }
  private event(host: string, event: AgentMuxClientEvent): void {
    const refs = event.type === 'process-state' ? this.workers.get(key(host, event.run.runId))
      : event.type === 'agent-session' ? this.sessions.get(key(host, event.session.agentSessionId))
      : event.type === 'connection-state' ? this.hosts.get(host) : undefined
    for (const ref of refs ?? []) {
      const scope = this.scopes.get(key(ref.goalId, ref.operationId))
      if (event.type === 'agent-session' && scope?.supervisor === event.session.agentSessionId && scope.runId && scope.runId !== event.session.run.runId)
        scope.controller.abort(new Error('The original Supervisor Run changed before reminder admission.'))
      void this.check(ref)
    }
  }
  private check(ref: Reference): Promise<void> {
    const id = key(ref.goalId, ref.operationId), previous = this.flights.get(id)
    if (previous) { this.dirty.set(id, ref); return previous }
    const flight = this.run(ref).catch(error => {
      const reason = describe(error)
      if (this.issues.get(id) !== reason) { this.issues.set(id, reason); this.changed([ref.goalId]) }
    }).finally(() => {
      this.flights.delete(id); this.scopes.delete(id)
      const pending = this.dirty.get(id); this.dirty.delete(id)
      if (pending && !this.controller.signal.aborted) queueMicrotask(() => { void this.check(pending) })
    })
    this.flights.set(id, flight); return flight
  }
  private async run(ref: Reference): Promise<void> {
    this.controller.signal.throwIfAborted()
    const goal = await this.demands.get(ref.goalId), start = goal?.dispatches?.find(item => item.operationId === ref.operationId)
    if (!goal || !start || start.execution !== 'finite' || closed(goal)) return
    const observed = await this.observe(goal, start)
    if (observed.originalRun?.state !== 'exited' && observed.originalRun?.state !== 'interrupted') return
    if (!goal.supervisorSessionId) throw new Error('No Supervisor is assigned to this original Goal. Retain its worker identity and explicit continuation entry.')
    let attention = start.attention
    if (attention && attention.supervisorAgentSessionId !== goal.supervisorSessionId)
      throw new Error('The original Start reminder belongs to the prior Supervisor. Inspect its saved input; it was not rerouted.')
    if (attention?.attemptedAt !== undefined) return
    const supervisor = await this.runtime.agentCreation(start.hostId, goal.supervisorSessionId)
    if (supervisor.agentSessionId !== goal.supervisorSessionId || supervisor.hostId !== start.hostId)
      throw new Error('The original Goal Supervisor is not confirmed at the Start Host. No replacement responsibility was chosen.')
    if (supervisor.agentSessionId === start.agentSessionId && supervisor.run.runId === start.runId)
      throw new Error('The Supervisor is the same ended original worker Run. Recover that original Session explicitly; no new Agent was started.')
    const scope = { controller: new AbortController(), supervisor: goal.supervisorSessionId, runId: supervisor.run.runId }
    this.scopes.set(key(goal.id, start.operationId), scope)
    const signal = AbortSignal.any([this.controller.signal, scope.controller.signal])
    if (!attention) {
      const digest = createHash('sha256').update(JSON.stringify([goal.id, start.operationId, start.hostId, start.agentSessionId, start.runId])).digest('hex')
      await this.demands.prepareDispatchAttention(goal.id, start.operationId, { operationId: 'goal-start-attention-' + digest,
        intentId: 'goal-start-attention-' + digest, hostId: start.hostId, supervisorAgentSessionId: supervisor.agentSessionId,
        supervisorRunId: supervisor.run.runId, occurrenceAt: start.preparedAt,
        agentMuxNote: JSON.stringify({ schema: 'agentmux.goal-start-attention.v1', goalId: goal.id, startOperationId: start.operationId,
          hostId: start.hostId, workerAgentSessionId: start.agentSessionId, originalRunId: start.runId,
          originalInputReceipt: start.receipt ?? null, resultBasis: start.resultBasis ?? null,
          next: 'The original finite Goal Start Run ended without a Start-associated result. Inspect its original Core prompt input and Goal evidence. Goal-level grounding is not an authenticated report by this worker. Retain the original Session, identify the blocker or explicit continuation, and use the existing Goal result proposal and human review. Input receipt, Run exit, ordinary completion text and human acceptance are separate facts. Never resend an unknown original input or choose another Agent by guessing.' }) })
      attention = (await this.demands.inspectDispatch(goal.id, start.operationId))!.attention!
    }
    scope.runId = attention.supervisorRunId
    signal.throwIfAborted(); await this.runtime.saveGoalAttention(attention); signal.throwIfAborted()
    const observation = await this.runtime.observeContinuousProgress({ hostId: attention.hostId, agentSessionId: attention.supervisorAgentSessionId,
      providerId: supervisor.providerId, workspacePath: supervisor.workspacePath, futureIntentId: attention.intentId }, attention.operationId, Date.now(), signal)
    if (observation.session.run.runId !== attention.supervisorRunId) throw new Error('The original Start reminder target Run changed; its reference remains retained.')
    const occurrence = { intentId: attention.intentId, occurrenceAt: attention.occurrenceAt }, decision = decideFutureProgress(observation, occurrence)
    if (decision.kind !== 'send') {
      this.issues.set(key(goal.id, start.operationId), 'The original Start reminder is prepared: ' + decision.reason + '. Manual input remains available.'); this.changed([goal.id]); return
    }
    const before = await this.demands.get(goal.id), original = before?.dispatches?.find(item => item.operationId === start.operationId)
    if (!before || !original?.attention || original.attention.attemptedAt !== undefined || closed(before) || before.supervisorSessionId !== attention.supervisorAgentSessionId) return
    await this.demands.markDispatchAttentionAttempt(goal.id, start.operationId, attention.operationId)
    const attempted = await this.demands.get(goal.id), exact = attempted?.dispatches?.find(item => item.operationId === start.operationId)
    if (!attempted || !exact || closed(attempted) || attempted.supervisorSessionId !== attention.supervisorAgentSessionId) return
    this.issues.delete(key(goal.id, start.operationId))
    await this.runtime.submitPrompt({ kind: 'agent', hostId: attention.hostId, agentSessionId: attention.supervisorAgentSessionId, run: { runId: attention.supervisorRunId } },
      '', attention.operationId, agentPromptCondition(observation.session), { futureIntent: occurrence, inputByte: observation.inputByte!,
        isCurrent: () => !signal.aborted, signal }, undefined, undefined, attention.agentMuxNote, 'api')
    this.changed([goal.id])
  }
  async observe(goal: Demand, start: DemandDispatch): Promise<GoalStartObservation> {
    const value: GoalStartObservation = { operationId: start.operationId, input: { state: 'unknown', ...(start.receipt ? { retainedReceipt: start.receipt } : {}) }, responsibility: 'observation-unknown' }
    const issues: string[] = []
    const [input, run] = await Promise.allSettled([this.runtime.inspectGoalStart(start), this.runtime.observeOriginalRun(start.hostId, start.runId)])
    if (input.status === 'fulfilled') {
      const receipt = input.value, admission = receipt?.admission, inputKey = admission?.inputKey, originalBody = admission?.intent?.message?.userContent ?? admission?.intent?.prompt
      if (receipt?.agentSessionId === start.agentSessionId && receipt.run.runId === start.runId && admission?.submissionId === start.operationId &&
        admission.acknowledged && admission.intent?.run.runId === start.runId &&
        originalBody === start.prompt &&
        inputKey?.kind === 'prompt' && inputKey.agentSessionId === start.agentSessionId && inputKey.expectedRun.runId === start.runId && inputKey.submissionId === start.operationId) {
        value.input.state = 'confirmed'
        value.input.proof = { kind: 'core-prompt', agentSessionId: receipt.agentSessionId, runId: receipt.run.runId, operationId: admission.submissionId,
          acknowledged: true, prompt: originalBody, inputKey: { kind: 'prompt', agentSessionId: inputKey.agentSessionId, expectedRun: { runId: inputKey.expectedRun.runId }, submissionId: inputKey.submissionId } }
      }
      else value.input.reason = 'The original Core Start input receipt is unconfirmed. Preserve its operation, exact body and original Run before explicit recovery.'
    } else { value.input.reason = describe(input.reason); issues.push(value.input.reason) }
    if (run.status === 'fulfilled' && run.value.runId === start.runId) value.originalRun = run.value
    else issues.push(run.status === 'rejected' ? describe(run.reason) : 'The Run observation is not this original Start.')
    if (goal.grounding) value.goalResult = { grounding: goal.grounding, association: 'unknown', basis: start.resultBasis ? 'captured' : 'unknown',
      changedSinceStart: start.resultBasis ? goal.grounding.submissionId !== start.resultBasis.groundingSubmissionId : null }
    if (newResult(goal, start)) value.responsibility = 'goal-result-review'
    else if (value.originalRun?.state === 'exited' || value.originalRun?.state === 'interrupted') value.responsibility = 'original-worker-continuation'
    else if (value.originalRun?.state === 'running' && value.input.state === 'confirmed') value.responsibility = 'working'
    const issue = this.issues.get(key(goal.id, start.operationId)) ?? this.startupIssue
    if (issue) issues.push(issue)
    if (!goal.supervisorSessionId) issues.push('No Supervisor is assigned; the original worker and Goal continuation entry are retained.')
    if (start.attention) {
      const attention = start.attention
      value.supervisor = { agentSessionId: attention.supervisorAgentSessionId, hostId: attention.hostId, runId: attention.supervisorRunId }
      if (attention.attemptedAt === undefined) value.attention = { state: 'prepared', reason: issue ?? 'The original Start reminder waits for eligible Supervisor input.' }
      else {
        try {
          const receipt = await this.runtime.inspectGoalAttention(attention)
          value.attention = receipt?.agentSessionId === attention.supervisorAgentSessionId && receipt.run.runId === attention.supervisorRunId &&
            receipt.admission?.submissionId === attention.operationId && receipt.admission.acknowledged &&
            receipt.admission.intent?.message?.systemContext === attention.agentMuxNote && !receipt.admission.intent.message.authorHuman && !receipt.admission.intent.message.authorAgentSessionId
            ? { state: 'confirmed', reason: 'The original Supervisor received the Start responsibility note. Worker result attribution and human acceptance remain separate.' }
            : { state: 'unknown', reason: issue ?? 'The original Start note receipt is unconfirmed. Inspect its original Core input; it is never automatically resent.' }
        } catch (error) { value.attention = { state: 'unknown', reason: describe(error) } }
      }
    }
    if (issues.length) value.unknown = issues.join(' ')
    return value
  }
}
