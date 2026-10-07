import { goalRoleGuidance } from '@agentmux/core/goal-role-guidance'
import { createHash } from 'node:crypto'
import { AgentMuxError, agentPromptCondition, decideFutureProgress, type AgentMuxClientEvent, type AgentMuxRpcCallContext } from '@agentmux/core'
import { demandExecutionReferences, demandResponsibilityScope, type Demand, type DemandPatrol, type DemandPatrolAttempt,
  type DemandPatrolReportInput, type DemandPatrolTarget, type DemandStore } from '@agentmux/demand'
import type { GoalDelegationAuthority, GoalDelegationResult } from '@agentmux/core/goal-delegation'
import type { GoalPatrolObservation } from '@agentmux/core/goal-patrol'
import type { RuntimeController } from './runtime-controller.js'

type Runtime = Pick<RuntimeController, 'resolveGoalAgent' | 'observeCoreEvents' | 'observeInputOccupation' | 'saveGoalAttention' |
  'disableGoalAttention' | 'inspectGoalAttention' | 'observeContinuousProgress' | 'submitPrompt' | 'observeGoalAgent'>
const key = (a: string, b: string) => JSON.stringify([a, b])
const describe = (e: unknown) => e instanceof Error ? e.message : String(e)
const input = (attempt: DemandPatrolAttempt) => ({ hostId: attempt.target.hostId, supervisorAgentSessionId: attempt.target.agentSessionId,
  supervisorRunId: attempt.target.runId, intentId: attempt.intentId, operationId: attempt.operationId, agentMuxNote: attempt.agentMuxNote })

/** Original Goal business records + original conditional Core Input; no new queue or periodic loop. */
export class GoalPatrolOwner {
  private readonly flights = new Map<string, Promise<void>>()
  private readonly scopes = new Map<string, AbortController>()
  private readonly dirty = new Set<string>()
  private readonly runs = new Map<string, Set<string>>()
  private readonly sessions = new Map<string, Set<string>>()
  private readonly hosts = new Map<string, Set<string>>()
  private readonly goals = new Map<string, string>()
  private readonly issues = new Map<string, string>()
  private releases: Array<() => void> = []
  private readonly lifetime = new AbortController()
  constructor(private readonly demands: DemandStore, private readonly runtime: Runtime,
    private readonly read: (goalId: string, context: AgentMuxRpcCallContext) => Promise<GoalDelegationResult>,
    private readonly changed: (ids: string[]) => void) {}
  async start(): Promise<void> {
    this.releases.push(this.demands.subscribe(snapshot => this.index(snapshot.demands)))
    this.releases.push(this.runtime.observeCoreEvents(['agent-session', 'agent-status', 'process-state', 'agent-input', 'connection-state'], (host, event) => this.event(host, event)))
    this.releases.push(this.runtime.observeInputOccupation(control => { for (const id of this.sessions.get(key(control.hostId, control.agentSessionId)) ?? [])
      this.scopes.get(id)?.abort(new Error('The original PMO input became occupied; its draft is retained.')) }))
    try { this.index((await this.demands.snapshot()).demands) } catch (e) { this.issues.set('startup', describe(e)) }
  }
  dispose(): void { this.lifetime.abort(); for (const release of this.releases.splice(0)) release() }
  private index(goals: Demand[]): void {
    this.sessions.clear(); this.runs.clear(); this.hosts.clear()
    const active = new Set<string>()
    const add = (map: Map<string, Set<string>>, name: string, id: string) => { const entries = map.get(name) ?? new Set<string>(); entries.add(id); map.set(name, entries) }
    for (const goal of goals) for (const patrol of goal.patrols ?? []) {
      const id = key(goal.id, patrol.operationId), attempt = patrol.attempts.at(-1)
      if (patrol.report || !attempt || attempt.supersededAt || goal.status === 'done' || goal.status === 'cancelled' ||
        goal.supervisorSessionId !== attempt.target.agentSessionId || demandResponsibilityScope(goal) !== patrol.expectedScope) {
        this.scopes.get(id)?.abort(new Error('The frozen inspection scope changed; the request is retained.')); continue
      }
      active.add(id); add(this.sessions, key(attempt.target.hostId, attempt.target.agentSessionId), id); add(this.runs, key(attempt.target.hostId, attempt.target.runId), id); add(this.hosts, attempt.target.hostId, id)
      const epoch = JSON.stringify([patrol.expectedScope, attempt])
      if (this.goals.get(id) !== epoch) { this.goals.set(id, epoch); queueMicrotask(() => { void this.check(goal.id, patrol.operationId) }) }
    }
    for (const id of this.goals.keys()) if (!active.has(id)) this.goals.delete(id)
  }
  private event(host: string, event: AgentMuxClientEvent): void {
    const sid = event.type === 'agent-session' ? event.session.agentSessionId : event.type === 'agent-input' ? event.receipt.ref.key.agentSessionId : 'agentSessionId' in event ? event.agentSessionId : null
    const refs = sid ? this.sessions.get(key(host, sid)) : event.type === 'process-state' ? this.runs.get(key(host, event.run.runId)) : event.type === 'connection-state' ? this.hosts.get(host) : undefined
    for (const ref of refs ?? []) { const [goalId, patrolId] = JSON.parse(ref) as [string, string]; void this.check(goalId, patrolId) }
  }
  private async exact(goalId: string, operationId: string) {
    const goal = await this.demands.get(goalId), patrol = goal?.patrols?.find(item => item.operationId === operationId)
    if (!goal || !patrol) throw new AgentMuxError('The original Goal inspection is unavailable. Preserve its operation and original work.', 'CONTROL_UNAVAILABLE')
    return { goal, patrol }
  }
  private attempt(goalId: string, patrolId: string, target: DemandPatrolTarget, context: string, suffix: string): Omit<DemandPatrolAttempt, 'preparedAt'> {
    const operationId = 'goal-patrol-' + createHash('sha256').update(JSON.stringify([goalId, patrolId, suffix])).digest('hex')
    const frozen = JSON.parse(context) as { alignmentRevision: number | null; executions: unknown[]; alerts: unknown[]; reports: unknown[]; evidence: string[] }
    // The original Goal holds full tasks/results. Carry exact references and an explicit bounded excerpt.
    const excerpt = { alignmentRevision: frozen.alignmentRevision, executionCount: frozen.executions.length,
      executions: frozen.executions.slice(0, 8), alerts: frozen.alerts.slice(0, 8), reports: frozen.reports.slice(0, 8), evidence: frozen.evidence.slice(0, 8),
      excerpted: frozen.executions.length > 8 || frozen.alerts.length > 8 || frozen.reports.length > 8 || frozen.evidence.length > 8 }
    let encoded = JSON.stringify(excerpt)
    if (Buffer.byteLength(encoded, 'utf8') > 24_000) encoded = JSON.stringify({ alignmentRevision: frozen.alignmentRevision,
      executionCount: frozen.executions.length, excerpted: true, reason: 'Full original identities/evidence exceed this input excerpt; read the retained Goal/patrol.' })
    return { operationId, actionOperationId: suffix, intentId: operationId, target, agentMuxNote: JSON.stringify({ schema: 'agentmux.goal-patrol.v1', goalId, patrolOperationId: patrolId,
      roleGuidance: goalRoleGuidance({ role: 'manager', goalId, agentSessionId: target.agentSessionId, runId: target.runId, source: { kind: 'goal-patrol', operationId: patrolId } }),
      inputOperationId: operationId, target, context: JSON.parse(encoded), read: { method: 'goal.delegations', params: { goalId }, patrolOperationId: patrolId },
      next: 'Read amux goal --skill and the retained original Goal/patrol/execution/input/evidence before inspection. Actually inspect progress, evidence, gaps and unknowns; use goal patrol report --input FILE to write back this patrol, current business status and next responsible party/action. Explicit review of an original stored worker report collects its exact authenticated reply atomically; do not collect separately before frozen-scope reporting. Delivery, acknowledgement and reminders are not inspection or acceptance. Retain original Goal/Session/Run and unknown inputs; never blindly resend. Human confirmation and acceptance remain human actions.' }) }

  }
  async request(goalId: string, operationId: string, context: AgentMuxRpcCallContext, authority: GoalDelegationAuthority): Promise<void> {
    const goal = await this.demands.get(goalId)
    if (!goal) throw new AgentMuxError('The original Goal is unavailable.', 'CONTROL_UNAVAILABLE')
    if (authority.actor.kind === 'agent' && authority.actor.id !== goal.supervisorSessionId && !demandExecutionReferences(goal).some(ref => ref.agentSessionId === authority.actor.id))
      throw new AgentMuxError('Only this Goal’s original execution or management authority can request inspection.', 'CONTROL_PERMISSION_DENIED')
    const original = goal.patrols?.find(item => item.operationId === operationId)
    if (original) { await this.check(goalId, original.operationId); return }
    const expectedScope = demandResponsibilityScope(goal)
    const retained = [...goal.patrols ?? []].reverse().find(item => !item.report && item.expectedScope === expectedScope)
    if (retained) { await this.check(goalId, retained.operationId); return }
    // Reading exact original work is the request basis, not an inference from its title/UI.
    const work = await this.read(goalId, context)
    let target: DemandPatrolTarget | undefined
    if (goal.supervisorSessionId) { try {
      const resolved = await this.runtime.resolveGoalAgent(goal.supervisorSessionId), session = resolved.status.session
      target = { hostId: resolved.hostId, agentSessionId: session.agentSessionId, runId: session.run.runId, providerId: session.providerId, workspacePath: session.workspacePath }
    } catch (e) { this.issues.set(key(goalId, operationId), describe(e)) } }
    const frozen = JSON.stringify({ goalId, expectedScope, alignmentRevision: goal.alignment?.revision ?? null, executions: demandExecutionReferences(goal),
      alerts: work.responsibility?.executions.filter(row => row.alert).map(row => ({ execution: row.execution, phase: row.phase, alert: row.alert, basis: row.basis })) ?? [],
      reports: (goal.delegations ?? []).filter(d => d.report).map(d => ({ delegationOperationId: d.operationId, sourceMessageId: d.sourceMessageId, reportOperationId: d.report!.operationId, replyMessageId: d.report!.replyMessageId })),
      progressOperations: (goal.progressUpdates ?? []).map(update => update.operationId), groundingSubmissionId: goal.grounding?.submissionId ?? null,
      evidence: [...new Set([...(goal.grounding?.checks ?? []).flatMap(c => c.evidence), ...(goal.progressUpdates ?? []).flatMap(p => p.evidence)])] })
    const receipt = await this.demands.preparePatrol(goalId, { operationId, expectedScope, supervisorAgentSessionId: goal.supervisorSessionId,
      executions: demandExecutionReferences(goal), context: frozen, requestedBy: authority.actor,
      ...(target ? { attempt: this.attempt(goalId, operationId, target, frozen, operationId) } : {}) })
    const saved = [...receipt.demand.patrols!].reverse().find(item => item.expectedScope === expectedScope && !item.report)!
    await this.check(goalId, saved.operationId)
  }
  private check(goalId: string, patrolId: string): Promise<void> {
    const id = key(goalId, patrolId), previous = this.flights.get(id)
    if (previous) { this.dirty.add(id); return previous }
    if (this.lifetime.signal.aborted) return Promise.resolve()
    const controller = new AbortController(); this.scopes.set(id, controller)
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    const flight = this.admit(goalId, patrolId, signal).catch(e => { this.issues.set(id, describe(e)); this.changed([goalId]) })
      .finally(() => { if (this.flights.get(id) === flight) { this.flights.delete(id); this.scopes.delete(id) }
        if (this.dirty.delete(id) && !this.lifetime.signal.aborted) queueMicrotask(() => { void this.check(goalId, patrolId) }) })
    this.flights.set(id, flight); return flight
  }
  private async admit(goalId: string, patrolId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const { goal, patrol } = await this.exact(goalId, patrolId), attempt = patrol.attempts.at(-1)
    if (!attempt || attempt.attemptedAt || attempt.supersededAt || patrol.report || demandResponsibilityScope(goal) !== patrol.expectedScope) return
    const target = attempt.target
    signal.throwIfAborted(); await this.runtime.saveGoalAttention(input(attempt)); signal.throwIfAborted()
    const observation = await this.runtime.observeContinuousProgress({ ...target, futureIntentId: attempt.intentId }, attempt.operationId, Date.now(), signal)
    if (observation.session.run.runId !== target.runId) throw new AgentMuxError('The saved PMO Run changed. Recover the same Session and explicitly continue this never-attempted request.', 'STALE_AGENT_SESSION')
    const occurrence = { intentId: attempt.intentId, occurrenceAt: attempt.preparedAt }, decision = decideFutureProgress(observation, occurrence)
    if (decision.kind !== 'send') { this.issues.set(key(goalId, patrolId), decision.reason); this.changed([goalId]); return }
    signal.throwIfAborted()
    const admission = await this.demands.markPatrolAttempt(goalId, patrolId, attempt.operationId)
    if (admission.replayed) return // Another original owner already attempted; this read grants no submit.
    signal.throwIfAborted()
    await this.runtime.submitPrompt({ kind: 'agent', hostId: target.hostId, agentSessionId: target.agentSessionId, run: { runId: target.runId } },
      '', attempt.operationId, agentPromptCondition(observation.session), { futureIntent: occurrence, inputByte: observation.inputByte!, signal,
        isCurrent: () => !signal.aborted }, undefined, undefined, attempt.agentMuxNote, 'api')
    this.issues.delete(key(goalId, patrolId)); this.changed([goalId])
  }
  async continue(goalId: string, patrolId: string, operationId: string, expectedRunId: string, context: AgentMuxRpcCallContext, authority: GoalDelegationAuthority): Promise<void> {
    const { goal, patrol } = await this.exact(goalId, patrolId)
    if (!patrol.supervisorAgentSessionId || authority.actor.kind === 'agent' && authority.actor.id !== patrol.supervisorAgentSessionId)
      throw new AgentMuxError('Continue requires this original PMO or an admitted person/device.', 'CONTROL_PERMISSION_DENIED')
    const originalAction = patrol.attempts.find(item => item.actionOperationId === operationId)
    if (originalAction) {
      if (originalAction.target.runId !== expectedRunId) throw new AgentMuxError('This original continuation action names another Run. Read the saved action without changing its input.', 'CONTROL_REQUEST_CONFLICT')
      await this.check(goalId, patrolId); return
    }
    if (patrol.report || goal.supervisorSessionId !== patrol.supervisorAgentSessionId || demandResponsibilityScope(goal) !== patrol.expectedScope)
      throw new AgentMuxError('The original inspection scope changed. Preserve this request and explicitly inspect the current Goal.', 'CONTROL_REQUEST_CONFLICT')
    const id = key(goalId, patrolId)
    this.scopes.get(id)?.abort(new Error('Explicit continuation fences the original pending admission.'))
    await this.flights.get(id)
    const refreshed = await this.exact(goalId, patrolId), previous = refreshed.patrol.attempts.at(-1)
    if (refreshed.patrol.attempts.some(item => item.attemptedAt)) throw new AgentMuxError('The original input may have been attempted. Inspect it or report the real inspection; no input was resent.', 'CONTROL_REQUEST_CONFLICT')
    const resolved = await this.runtime.resolveGoalAgent(patrol.supervisorAgentSessionId), session = resolved.status.session
    if (session.run.runId !== expectedRunId || previous && (expectedRunId === previous.target.runId || resolved.hostId !== previous.target.hostId))
      throw new AgentMuxError('Continue requires the explicitly recovered same Session at its exact new Run, or the first confirmed route of its retained request.', 'STALE_AGENT_SESSION')
    if (previous) {
      if (await this.runtime.inspectGoalAttention(input(previous))) throw new AgentMuxError('The old input claim exists. Inspect its original receipt; no new attempt is allowed.', 'CONTROL_REQUEST_CONFLICT')
      await this.runtime.disableGoalAttention(input(previous))
    }
    const target = { agentSessionId: session.agentSessionId, hostId: resolved.hostId, runId: expectedRunId, providerId: session.providerId, workspacePath: session.workspacePath }
    await this.demands.continuePatrol(goalId, patrolId, previous?.operationId ?? null, this.attempt(goalId, patrolId, target, patrol.context, operationId))
    await this.check(goalId, patrolId)
  }
  async report(goalId: string, patrolId: string, report: DemandPatrolReportInput, authority: GoalDelegationAuthority): Promise<void> {
    const { patrol } = await this.exact(goalId, patrolId)
    if (authority.actor.kind !== 'agent' || !authority.runId || authority.actor.id !== patrol.supervisorAgentSessionId)
      throw new AgentMuxError('Only the authenticated original PMO can report an actual inspection, including from its recovered Run.', 'CONTROL_PERMISSION_DENIED')
    const resolved = await this.runtime.resolveGoalAgent(authority.actor.id)
    if (resolved.hostId !== authority.hostId || resolved.status.session.run.runId !== authority.runId) throw new AgentMuxError('The actual reporting PMO Run is unconfirmed.', 'STALE_AGENT_SESSION')
    const originalWork = await this.read(goalId, {})
    for (const update of report.progress) if (update.phase === 'review' && update.execution.kind === 'delegation') {
      const original = originalWork.delegations.find(d => d.operationId === update.execution.operationId)
      const observed = originalWork.observations?.find(o => o.operationId === update.execution.operationId)
      if (original?.report && (!observed?.communication || !observed.communication.replies.some(reply => reply.envelope.messageId === original.report!.replyMessageId)))
        throw new AgentMuxError('The original worker reply is not confirmed at its Core source. Keep its report and inspect it before collection.', 'CONTROL_UNAVAILABLE')
    }
    const bases = new Map(await Promise.all(report.progress.map(async update => {
      try { const status = await this.runtime.observeGoalAgent(update.execution.hostId, update.execution.agentSessionId)
        return [JSON.stringify(update.execution), status.session.run.runId === update.execution.runId ? {
          stateEnteredAt: status.session.semanticStatus?.stateEnteredAt ?? null, activityRevision: status.session.semanticStatus?.currentActivityRevision ?? null,
          inputSubmissionId: status.session.promptCompletionAdmission?.submissionId ?? status.session.terminalPromptSubmission?.submissionId ?? null } : null] as const
      } catch { return [JSON.stringify(update.execution), null] as const }
    })))
    await this.demands.recordPatrolReport(goalId, patrolId, report, { agentSessionId: authority.actor.id, runId: authority.runId }, bases)
    this.changed([goalId])
  }
  async observe(goal: Demand): Promise<GoalPatrolObservation[]> {
    return await Promise.all((goal.patrols ?? []).map(async patrol => {
      const attempt = patrol.attempts.at(-1), reason = this.issues.get(key(goal.id, patrol.operationId)) ?? this.issues.get('startup')
      if (patrol.report) return { operationId: patrol.operationId, state: patrol.report.applied ? 'reported' as const : 'stale' as const, reason: patrol.report.reason }
      if (demandResponsibilityScope(goal) !== patrol.expectedScope) return { operationId: patrol.operationId, state: 'stale' as const, reason: 'Original inspection scope changed. Read the current Goal and request a new inspection explicitly.' }
      if (!attempt) return { operationId: patrol.operationId, state: 'missing' as const, reason: reason ?? 'Choose the original Goal Supervisor, then request inspection. No replacement Agent was created.' }
      if (!attempt.attemptedAt) return { operationId: patrol.operationId, state: 'prepared' as const, reason: reason ?? 'Saved request waits for eligible original PMO input; its draft and native capabilities are retained.' }
      try { const receipt = await this.runtime.inspectGoalAttention(input(attempt)), admission = receipt?.admission
        const confirmed = receipt?.agentSessionId === attempt.target.agentSessionId && receipt.run.runId === attempt.target.runId &&
          admission?.submissionId === attempt.operationId && admission.acknowledged && admission.intent?.message?.systemContext === attempt.agentMuxNote &&
          admission.inputKey?.kind === 'prompt' && admission.inputKey.submissionId === attempt.operationId && admission.inputKey.expectedRun.runId === attempt.target.runId
        return { operationId: patrol.operationId, state: confirmed ? 'delivered' as const : 'unknown' as const,
          reason: confirmed ? 'Original PMO input is confirmed. Inspection and Goal writeback are still pending.' : reason ?? 'Original input receipt is unknown. Inspect this operation; it is never automatically resent.' }
      } catch (e) { return { operationId: patrol.operationId, state: 'unknown' as const, reason: describe(e) } }
    }))
  }
}
