import { AgentMuxError, currentAgentSemanticStatus, type AgentMuxAgentRuntimeStatus, type AgentMuxClientEvent, type AgentMuxRpcCallContext } from '@agentmux/core'
import { demandExecutionReferences, demandHandoffDestinations, latestDemandProgress, demandResponsibilityScope, sameDemandExecution, type Demand, type DemandStore,
  type DemandProgressInput } from '@agentmux/demand'
import type { GoalDelegationAuthority, GoalDelegationResult } from '@agentmux/core/goal-delegation'
import { goalResponsibilityBasis, observeGoalExecution, type GoalExecutionFacts, type GoalResponsibilityObservation,
  type GoalSupervisorObservation } from '@agentmux/core/goal-responsibility'

export interface GoalResponsibilityRuntime {
  observeGoalAgent(hostId: string, agentSessionId: string): Promise<AgentMuxAgentRuntimeStatus>
  resolveGoalAgent(agentSessionId: string): Promise<{ hostId: string; status: AgentMuxAgentRuntimeStatus }>
  observeCoreEvents(types: readonly AgentMuxClientEvent['type'][], listener: (hostId: string, event: AgentMuxClientEvent) => void): () => void
}
const key = (hostId: string, id: string) => JSON.stringify([hostId, id])
const describe = (value: unknown) => value instanceof Error ? value.message : String(value)
const principal = { kind: 'user' as const, id: 'local-user:' + (process.getuid?.() ?? 'current') }

/** Related original facts + one idle deadline. No polling, task registry, input or Runtime lifecycle. */
export class GoalResponsibilityOwner {
  private readonly sessions = new Map<string, Set<string>>()
  private readonly managers = new Map<string, Set<string>>()
  private readonly runs = new Map<string, Set<string>>()
  private readonly sources = new Map<string, Set<string>>()
  private readonly hosts = new Map<string, Set<string>>()
  private readonly versions = new Map<string, string>()
  private readonly observations = new Map<string, GoalResponsibilityObservation>()
  private readonly deadlines = new Map<string, number>()
  private readonly flights = new Map<string, Promise<void>>()
  private readonly dirty = new Set<string>()
  private disposers: Array<() => void> = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private startupIssue: string | undefined
  constructor(private readonly demands: DemandStore, private readonly runtime: GoalResponsibilityRuntime,
    private readonly read: (goalId: string, context: AgentMuxRpcCallContext) => Promise<GoalDelegationResult>,
    private readonly changed: (goalIds: string[]) => void) {}

  async start(): Promise<void> {
    this.disposers.push(this.demands.subscribe(snapshot => { this.startupIssue = undefined; this.index(snapshot.demands) }))
    this.disposers.push(this.runtime.observeCoreEvents(['agent-status', 'agent-session', 'agent-input', 'process-state', 'run-removed', 'dispatch-changed', 'connection-state'], (host, event) => this.event(host, event)))
    try { this.index((await this.demands.snapshot()).demands) }
    catch (error) { this.startupIssue = 'Reading original Goal responsibilities failed: ' + describe(error) }
  }
  dispose(): void { this.disposed = true; if (this.timer) clearTimeout(this.timer); for (const release of this.disposers.splice(0)) release() }
  private index(goals: Demand[]): void {
    this.sessions.clear(); this.managers.clear(); this.runs.clear(); this.sources.clear(); this.hosts.clear()
    const retained = new Set<string>()
    const add = (index: Map<string, Set<string>>, id: string, goalId: string) => { const set = index.get(id) ?? new Set(); set.add(goalId); index.set(id, set) }
    for (const goal of goals) {
      retained.add(goal.id)
      const refs = demandExecutionReferences(goal)
      const version = demandResponsibilityScope(goal), changed = this.versions.get(goal.id) !== version
      this.versions.set(goal.id, version)
      if (goal.status === 'done' || goal.status === 'cancelled' || !refs.length) { this.observations.delete(goal.id); this.deadlines.delete(goal.id); continue }
      for (const ref of refs) {
        add(this.sessions, key(ref.hostId, ref.agentSessionId), goal.id); add(this.runs, key(ref.hostId, ref.runId), goal.id); add(this.hosts, ref.hostId, goal.id)
      }
      for (const delegation of goal.delegations ?? []) add(this.sources, key(delegation.hostId, delegation.sourceMessageId), goal.id)
      if (goal.supervisorSessionId) add(this.managers, goal.supervisorSessionId, goal.id)
      if (changed) queueMicrotask(() => { void this.refresh(goal.id) })
    }
    for (const id of this.versions.keys()) if (!retained.has(id)) { this.versions.delete(id); this.observations.delete(id); this.deadlines.delete(id) }
    this.schedule()
  }
  private event(hostId: string, event: AgentMuxClientEvent): void {
    const ids = new Set<string>()
    const add = (values: Iterable<string> | undefined) => { for (const id of values ?? []) ids.add(id) }
    if (event.type === 'agent-status' || event.type === 'agent-session' || event.type === 'agent-input') {
      const sessionId = event.type === 'agent-session' ? event.session.agentSessionId : event.type === 'agent-input' ? event.receipt.ref.key.agentSessionId : event.agentSessionId
      add(this.sessions.get(key(hostId, sessionId))); add(this.managers.get(sessionId))
    } else if (event.type === 'process-state' || event.type === 'run-removed') add(this.runs.get(key(hostId, event.run.runId)))
    else if (event.type === 'dispatch-changed') add(this.sources.get(key(hostId, event.sourceMessageId)))
    else if (event.type === 'connection-state') {
      add(this.hosts.get(hostId))
      for (const [goalId, observation] of this.observations) if (observation.supervisor.hostId === hostId || observation.supervisor.state === 'unknown') ids.add(goalId)
    }
    for (const id of ids) void this.refresh(id)
  }
  private refresh(goalId: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const active = this.flights.get(goalId)
    if (active) { this.dirty.add(goalId); return active }
    const flight = this.read(goalId, { principal }).then(result => {
      if (result.responsibility && !this.disposed) this.remember(goalId, result.responsibility)
    }).catch(error => {
      if (this.disposed) return
      const original = this.observations.get(goalId)
      if (original) this.remember(goalId, { ...original, executions: original.executions.map(row => {
        const { nextCheckAt: _deadline, ...retained } = row
        return { ...retained, phase: 'unknown', alert: 'unknown', reason: 'Reading this original responsibility failed: ' + describe(error) }
      }) })
      this.changed([goalId])
    }).finally(() => {
      this.flights.delete(goalId)
      if (this.dirty.delete(goalId) && !this.disposed) queueMicrotask(() => { void this.refresh(goalId) })
    })
    this.flights.set(goalId, flight); return flight
  }
  private remember(goalId: string, value: GoalResponsibilityObservation): void {
    const before = this.observations.get(goalId)
    if (this.disposed || before && before.observedAt > value.observedAt || this.versions.has(goalId) && this.versions.get(goalId) !== value.scope) return
    const meaning = (observation: GoalResponsibilityObservation | undefined) => observation && JSON.stringify({
      ...observation, observedAt: undefined, executions: observation.executions.map(row => ({ ...row, observation: row.observation && { ...row.observation, observedAt: undefined } })) })
    this.observations.set(goalId, value)
    let due = Infinity
    for (const row of value.executions) if (row.nextCheckAt !== undefined) due = Math.min(due, row.nextCheckAt)
    const priorDue = this.deadlines.get(goalId)
    if (Number.isFinite(due)) this.deadlines.set(goalId, due); else this.deadlines.delete(goalId)
    if (priorDue !== this.deadlines.get(goalId)) this.schedule()
    if (meaning(before) !== meaning(value)) this.changed([goalId])
  }
  private schedule(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (this.disposed) return
    let due = Infinity
    for (const deadline of this.deadlines.values()) due = Math.min(due, deadline)
    if (!Number.isFinite(due)) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const now = Date.now()
      for (const [id, deadline] of this.deadlines) if (deadline <= now) void this.refresh(id)
    }, Math.max(1, due - Date.now()))
    this.timer.unref?.()
  }
  async observe(goal: Demand, work: GoalDelegationResult): Promise<GoalResponsibilityObservation> {
    const now = Date.now(), references = demandExecutionReferences(goal)
    const starts = new Map((work.startObservations ?? []).map(item => [item.operationId, item]))
    const delegations = new Map((goal.delegations ?? []).map(item => [item.operationId, item]))
    const observations = new Map((work.observations ?? []).map(item => [item.operationId, item]))
    const states = new Map<string, Promise<AgentMuxAgentRuntimeStatus>>()
    const status = (host: string, session: string) => {
      const id = key(host, session), prior = states.get(id)
      if (prior) return prior
      const pending = this.runtime.observeGoalAgent(host, session); states.set(id, pending); return pending
    }
    let supervisor: GoalSupervisorObservation = { agentSessionId: goal.supervisorSessionId, state: 'missing', reason: 'Choose a Supervisor for this original Goal.' }
    const supervisorRead = goal.supervisorSessionId ? this.runtime.resolveGoalAgent(goal.supervisorSessionId).then(value => {
      const observed = value.status
      supervisor = { agentSessionId: goal.supervisorSessionId, hostId: value.hostId, runId: observed.run.runId,
        state: observed.run.state !== 'running' ? 'ended' : currentAgentSemanticStatus(observed.session.semanticStatus)?.state === 'error' ? 'blocked'
          : observed.observation.semantic === 'unknown' || observed.observation.readiness === 'unknown' || observed.observation.stale && observed.observation.semantic === 'active'
          ? 'unknown' : observed.observation.semantic === 'active' || observed.observation.readiness === 'pending' ? 'busy' : 'available',
        reason: observed.run.state !== 'running' ? 'The original management Run ended. Recover its original Session or explicitly assign responsibility.'
          : currentAgentSemanticStatus(observed.session.semanticStatus)?.state === 'error' ? 'Core reports an original native management error. Keep its Session and inspect or continue its responsibility.'
          : observed.observation.semantic === 'unknown' || observed.observation.stale && observed.observation.semantic === 'active' ? 'Management observation is unknown; its original Session and capabilities are retained.'
          : 'The exact management Session was observed at its original Host.' }
    }).catch(error => { supervisor = { agentSessionId: goal.supervisorSessionId, state: 'unknown', reason: 'Observing the original management Session failed: ' + describe(error) } }) : Promise.resolve()
    const facts = await Promise.all(references.map(async execution => {
      const fact: GoalExecutionFacts = { execution, inputConfirmed: false }
      if (execution.kind === 'start') {
        const start = starts.get(execution.operationId)
        fact.inputConfirmed = start?.input.state === 'confirmed'
        if (start?.originalRun) fact.originalRun = start.originalRun
        if (start?.unknown ?? start?.input.reason) fact.unknown = (start?.unknown ?? start?.input.reason)!
      } else {
        const saved = delegations.get(execution.operationId)
        const observed = observations.get(execution.operationId)
        fact.inputConfirmed = Boolean(saved?.linkedAt && observed?.communication && observed.communication.source.delivery.state === 'delivered')
        if (observed?.workerRun) fact.originalRun = observed.workerRun
        fact.report = Boolean(saved?.report || observed?.recoverableReport); fact.collected = Boolean(saved?.collection)
        if (observed?.unknown) fact.unknown = observed.unknown
      }
      try { fact.status = await status(execution.hostId, execution.agentSessionId) }
      catch (error) { fact.unknown = [fact.unknown, describe(error)].filter(Boolean).join(' ') }
      if (this.startupIssue) fact.unknown = [fact.unknown, this.startupIssue].filter(Boolean).join(' ')
      return fact
    }))
    await supervisorRead
    const unresolved = new Map<string, number>()
    const runKey = (fact: GoalExecutionFacts) => JSON.stringify([fact.execution.hostId, fact.execution.agentSessionId, fact.execution.runId])
    for (const fact of facts) if (fact.inputConfirmed && !fact.collected && !fact.report) unresolved.set(runKey(fact), (unresolved.get(runKey(fact)) ?? 0) + 1)
    const progress = latestDemandProgress(goal), indexed = { progress, handoffs: demandHandoffDestinations(goal, progress) }
    const executions = facts.map(fact => observeGoalExecution(goal, fact, now, (unresolved.get(runKey(fact)) ?? 0) > 1, indexed))
    const result = { scope: demandResponsibilityScope(goal), observedAt: now, supervisor, executions }
    if (!this.disposed) this.remember(goal.id, result)
    return result
  }
  async progress(goalId: string, input: DemandProgressInput, _context: AgentMuxRpcCallContext, authority: GoalDelegationAuthority): Promise<void> {
    const goal = await this.demands.get(goalId)
    if (!goal || !demandExecutionReferences(goal).some(ref => sameDemandExecution(ref, input.execution))) throw new AgentMuxError('Progress requires this original Goal execution.', 'CONTROL_REQUEST_CONFLICT')
    const manager = authority.actor.kind !== 'agent' || authority.actor.id === goal.supervisorSessionId
    if (!manager && (authority.actor.id !== input.execution.agentSessionId || authority.hostId !== input.execution.hostId || authority.runId !== input.execution.runId))
      throw new AgentMuxError('Progress requires the authenticated original worker Run or current management authority. Native input remains available.', 'CONTROL_PERMISSION_DENIED')
    let observed: AgentMuxAgentRuntimeStatus | undefined
    try { observed = await this.runtime.observeGoalAgent(input.execution.hostId, input.execution.agentSessionId) } catch { /* A blocked/progress declaration remains possible with unknown observation. */ }
    if (observed && (observed.session.agentSessionId !== input.execution.agentSessionId || observed.session.run.runId !== input.execution.runId || observed.run.runId !== input.execution.runId)) observed = undefined
    if (input.phase === 'handed-off' && input.handoffExecution) {
      const target = await this.read(goalId, { principal })
      if (!target.responsibility?.executions.some(row => sameDemandExecution(row.execution, input.handoffExecution!) && row.binding === 'confirmed'))
        throw new AgentMuxError('Handoff requires the actual verified target execution. A proposed next Agent is not a handoff.', 'CONTROL_REQUEST_CONFLICT')
    }
    await this.demands.recordProgress(goalId, input, { author: authority.actor,
      reportingRunId: authority.actor.kind === 'agent' ? authority.runId ?? null : null, basis: goalResponsibilityBasis(observed) })
  }
}
