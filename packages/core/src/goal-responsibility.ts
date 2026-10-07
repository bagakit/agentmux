import { demandExecutionKey, demandHandoffDestinations, demandProgressBusinessCurrent, latestDemandProgress, sameDemandExecution, type Demand, type DemandExecutionReference,
  type DemandProgress, type DemandResponsibilityBasis } from '@agentmux/demand'
import type { AgentMuxAgentRuntimeStatus } from './client.js'
import { currentAgentSemanticStatus } from './agent-status-freshness.js'
import type { AgentObservation } from './agent-status-freshness.js'
import { AgentMuxError } from './errors.js'

/** Turn-end and a subsequent report/handoff may be separate operations. This only delays a notice. */
export const GOAL_IDLE_GRACE_MS = 60_000
export type GoalSupervisorObservation = {
  agentSessionId: string | null
  hostId?: string
  runId?: string
  state: 'available' | 'busy' | 'blocked' | 'ended' | 'unknown' | 'missing'
  reason: string
}
export type GoalResponsibilityPhase = 'executing' | 'idle-grace' | 'stalled' | 'needs-input' | 'blocked' |
  'waiting-external' | 'report-review' | 'result-review' | 'handed-off' | 'ended' | 'unknown' | 'closed'
export type GoalResponsibilityRow = {
  execution: DemandExecutionReference
  binding: 'confirmed' | 'unconfirmed' | 'ambiguous'
  phase: GoalResponsibilityPhase
  reason: string
  nextOwner: { kind: 'worker' | 'manager' | 'human' | 'external'; agentSessionId: string | null; action: string }
  alert: 'stalled' | 'error' | 'ended' | 'manager-review' | 'unknown' | null
  basis: DemandResponsibilityBasis
  observation?: AgentObservation
  stateSince?: number
  nextCheckAt?: number
  progress?: DemandProgress
}
export type GoalResponsibilityObservation = {
  scope: string
  observedAt: number
  supervisor: GoalSupervisorObservation
  executions: GoalResponsibilityRow[]
}
export type GoalExecutionFacts = {
  execution: DemandExecutionReference
  inputConfirmed: boolean
  originalRun?: { runId: string; state: 'running' | 'exited' | 'interrupted' }
  status?: AgentMuxAgentRuntimeStatus
  report?: boolean
  collected?: boolean
  unknown?: string
}
export function goalResponsibilityBasis(status: AgentMuxAgentRuntimeStatus | undefined): DemandResponsibilityBasis {
  const state = status?.session.semanticStatus
  return { stateEnteredAt: state?.stateEnteredAt ?? null, activityRevision: state?.currentActivityRevision ?? null,
    inputSubmissionId: status?.session.promptCompletionAdmission?.submissionId ?? status?.session.terminalPromptSubmission?.submissionId ?? null }
}
/** Only original Core/domain facts select a phase. Display text never participates. */
export function observeGoalExecution(goal: Demand, facts: GoalExecutionFacts, now: number, ambiguous = false,
  indexed?: { progress: ReadonlyMap<string, DemandProgress>; handoffs: ReadonlyMap<string, DemandExecutionReference | null> }): GoalResponsibilityRow {
  const execution = facts.execution
  const exact = facts.status?.session.agentSessionId === execution.agentSessionId && facts.status.session.run.runId === execution.runId && facts.status.run.runId === execution.runId
  const status = exact ? facts.status : undefined, basis = goalResponsibilityBasis(status)
  const progress = indexed?.progress ?? latestDemandProgress(goal)
  const update = progress.get(demandExecutionKey(execution))
  const current = update && demandProgressBusinessCurrent(goal, update) ? update : undefined
  const row: GoalResponsibilityRow = { execution, binding: facts.inputConfirmed ? ambiguous ? 'ambiguous' : 'confirmed' : 'unconfirmed',
    phase: 'unknown', reason: facts.unknown ?? 'The original execution observation is unknown.', alert: 'unknown', basis,
    nextOwner: { kind: 'manager', agentSessionId: goal.supervisorSessionId, action: 'Inspect the original execution and its input.' },
    ...(status ? { observation: status.observation } : {}), ...(basis.stateEnteredAt ? { stateSince: basis.stateEnteredAt } : {}),
    ...(update ? { progress: update } : {}) }
  const set = (phase: GoalResponsibilityPhase, reason: string, alert: GoalResponsibilityRow['alert'],
    kind: GoalResponsibilityRow['nextOwner']['kind'] = 'manager', action = 'Inspect the original work and record its next responsibility.') => {
    row.phase = phase; row.reason = reason; row.alert = alert
    row.nextOwner = { kind, agentSessionId: kind === 'worker' ? execution.agentSessionId : kind === 'manager' ? goal.supervisorSessionId : null, action }
    return row
  }
  if (goal.status === 'done' || goal.status === 'cancelled') return set('closed', 'This Goal is closed; original execution and evidence are retained.', null)
  const grounding = goal.grounding
  if (current?.managerVerified && current.phase === 'review' && current.groundingSubmissionId &&
    grounding?.submissionId === current.groundingSubmissionId && grounding?.alignmentRevision === goal.alignment?.revision)
    return set('result-review', current.summary, null, 'human', current.nextAction)
  if (facts.collected) return set('result-review', 'This original worker report was collected. Management must verify the result and update the next step.', 'manager-review', 'manager', 'Verify the collected evidence and current Goal result; human acceptance is separate.')
  if (facts.report) return set('report-review', 'An original worker report awaits collection and verification.', 'manager-review', 'manager', 'Read and collect this original report, then update this Goal.')
  if (!facts.inputConfirmed) return set('unknown', facts.unknown ?? 'The original input is not confirmed. Keep its identity and inspect it before recovery.', 'unknown')
  if (current?.managerVerified && current.phase === 'handed-off') {
    const destination = (indexed?.handoffs ?? demandHandoffDestinations(goal)).get(demandExecutionKey(execution))
    if (!destination || sameDemandExecution(destination, execution)) return set('unknown', 'The accepted handoff has no confirmed responsible endpoint. Inspect the original Goal handoffs.', 'manager-review')
    const result = set('handed-off', current.summary, null, 'worker', current.nextAction)
    result.nextOwner.agentSessionId = destination.agentSessionId
    return result
  }
  const ended = facts.originalRun?.runId === execution.runId && facts.originalRun.state !== 'running'
  if (ended) return set('ended', `The original Run ${facts.originalRun!.state} without a collected result or accepted handoff.`, 'ended', 'manager', 'Recover the original Session or record the blocker and next responsibility.')
  if (ambiguous) return set('unknown', 'Several unresolved original executions share this Session and Run. Current task attribution requires management inspection.', 'unknown')
  if (!status || facts.originalRun?.runId !== execution.runId || facts.originalRun.state !== 'running')
    return set('unknown', facts.unknown ?? 'Current semantic facts are not confirmed on this original Run. Keep the original work and native input.', 'unknown')
  if (current?.phase === 'blocked') return set('blocked', current.summary, 'manager-review', 'manager', current.nextAction)
  if (current && !current.managerVerified && current.phase !== 'executing')
    return set('report-review', 'The worker declared a next step; management has not verified the waiting, result or handoff.', 'manager-review', 'manager', current.nextAction)
  const observation = status.observation, semantic = currentAgentSemanticStatus(status.session.semanticStatus)
  if (observation.semantic === 'unknown' || observation.semantic === 'unsupported' || observation.stale && observation.semantic === 'active')
    return set('unknown', facts.unknown ?? 'Semantic observation is unknown or stale. The original healthy Run and native input remain available.', 'unknown')
  if (semantic?.state === 'error') return set('blocked', 'Core reports an original native error; the uncompleted business responsibility needs follow-up.', 'error')
  if (observation.semantic === 'awaiting-input') return set('needs-input', 'The original Agent is waiting for an answer or permission.', 'manager-review', 'manager', 'Answer the exact original request or coordinate its responsible person.')
  if (observation.readiness === 'pending') return set('unknown', 'Input readiness is not confirmed. Inspect the original request or handshake; native input remains available.', 'unknown')
  if (current?.managerVerified && current.phase === 'waiting-external' && current.waiting && current.evidence.length && JSON.stringify(current.basis) === JSON.stringify(basis))
    return set('waiting-external', `${current.summary} Resume when: ${current.waiting.resumeWhen}`, null, 'external', current.nextAction)
  if (observation.semantic === 'active') return set('executing', 'Core confirms activity on this original execution Run.', null, 'worker', 'Continue the original task and report progress, blockers and delivery.')
  if (observation.semantic === 'idle') {
    if (!basis.stateEnteredAt || basis.stateEnteredAt > now) return set('unknown', 'Core confirms idle but its original state start is unavailable. Idle duration is unknown.', 'unknown')
    const due = basis.stateEnteredAt + GOAL_IDLE_GRACE_MS
    if (now < due) { set('idle-grace', 'The original turn ended; its report or handoff may still be arriving.', null, 'worker', 'Return the original report or declare the next responsibility.'); row.nextCheckAt = due; return row }
    return set('stalled', 'The original Agent remains idle without a verified report, waiting condition or handoff.', 'stalled', 'manager', 'Inspect the original Agent, collect its result or arrange explicit continuation.')
  }
  return row
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new AgentMuxError('Invalid Goal responsibility observation.', 'CONTROL_PROTOCOL_ERROR')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new AgentMuxError('Invalid Goal responsibility identity or explanation.', 'CONTROL_PROTOCOL_ERROR')
  return value
}
function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new AgentMuxError('Invalid Goal responsibility observation time.', 'CONTROL_PROTOCOL_ERROR')
  return value
}
import { parseDemandExecutionReference, parseDemandProgress, parseDemandResponsibilityBasis } from '@agentmux/demand'
export function parseGoalResponsibility(value: unknown, references: readonly DemandExecutionReference[]): GoalResponsibilityObservation {
  const p = record(value, ['scope', 'observedAt', 'supervisor', 'executions'])
  const s = record(p.supervisor, ['agentSessionId', 'hostId', 'runId', 'state', 'reason'])
  if (!['available', 'busy', 'blocked', 'ended', 'unknown', 'missing'].includes(String(s.state))) throw new AgentMuxError('Invalid original Supervisor observation.', 'CONTROL_PROTOCOL_ERROR')
  if (!Array.isArray(p.executions)) throw new AgentMuxError('Goal responsibility requires original execution observations.', 'CONTROL_PROTOCOL_ERROR')
  const seen = new Set<string>()
  const executions = p.executions.map(value => {
    const r = record(value, ['execution', 'binding', 'phase', 'reason', 'nextOwner', 'alert', 'basis', 'observation', 'stateSince', 'nextCheckAt', 'progress'])
    const execution = parseDemandExecutionReference(r.execution), key = JSON.stringify(execution)
    if (!references.some(ref => sameDemandExecution(ref, execution)) || seen.has(key)) throw new AgentMuxError('Responsibility belongs to another or duplicate original execution.', 'CONTROL_PROTOCOL_ERROR')
    seen.add(key)
    if (!['confirmed', 'unconfirmed', 'ambiguous'].includes(String(r.binding)) ||
      !['executing', 'idle-grace', 'stalled', 'needs-input', 'blocked', 'waiting-external', 'report-review', 'result-review', 'handed-off', 'ended', 'unknown', 'closed'].includes(String(r.phase)) ||
      r.alert !== null && !['stalled', 'error', 'ended', 'manager-review', 'unknown'].includes(String(r.alert))) throw new AgentMuxError('Invalid original responsibility phase.', 'CONTROL_PROTOCOL_ERROR')
    const next = record(r.nextOwner, ['kind', 'agentSessionId', 'action'])
    if (!['worker', 'manager', 'human', 'external'].includes(String(next.kind))) throw new AgentMuxError('Invalid next responsibility.', 'CONTROL_PROTOCOL_ERROR')
    let observation: AgentObservation | undefined
    if (r.observation !== undefined) {
      const o = record(r.observation, ['process', 'semantic', 'readiness', 'source', 'observedAt', 'stale', 'reason', 'lastKnownActivity'])
      if (!['running', 'exited', 'interrupted'].includes(String(o.process)) || !['active', 'idle', 'awaiting-input', 'unknown', 'unsupported'].includes(String(o.semantic)) ||
        !['ready', 'pending', 'unknown'].includes(String(o.readiness)) || typeof o.stale !== 'boolean') throw new AgentMuxError('Invalid original Core observation.', 'CONTROL_PROTOCOL_ERROR')
      text(o.source); time(o.observedAt)
      observation = o as unknown as AgentObservation
    }
    const progress = r.progress === undefined ? undefined : parseDemandProgress(r.progress)
    if (progress && !sameDemandExecution(progress.execution, execution)) throw new AgentMuxError('Progress belongs to another execution.', 'CONTROL_PROTOCOL_ERROR')
    return { execution, binding: r.binding as GoalResponsibilityRow['binding'], phase: r.phase as GoalResponsibilityPhase,
      reason: text(r.reason), alert: r.alert as GoalResponsibilityRow['alert'], basis: parseDemandResponsibilityBasis(r.basis),
      nextOwner: { kind: next.kind as GoalResponsibilityRow['nextOwner']['kind'], agentSessionId: next.agentSessionId === null ? null : text(next.agentSessionId), action: text(next.action) },
      ...(observation ? { observation } : {}), ...(r.stateSince === undefined ? {} : { stateSince: time(r.stateSince) }),
      ...(r.nextCheckAt === undefined ? {} : { nextCheckAt: time(r.nextCheckAt) }), ...(progress ? { progress } : {}) }
  })
  if (executions.length !== references.length) throw new AgentMuxError('Original execution observations are incomplete.', 'CONTROL_PROTOCOL_ERROR')
  return { scope: text(p.scope), observedAt: time(p.observedAt), supervisor: { agentSessionId: s.agentSessionId === null ? null : text(s.agentSessionId),
    state: s.state as GoalSupervisorObservation['state'], reason: text(s.reason), ...(s.hostId === undefined ? {} : { hostId: text(s.hostId) }), ...(s.runId === undefined ? {} : { runId: text(s.runId) }) }, executions }
}
