import type { SessionSnapshot } from '../../../shared/contracts'

export const MAX_EXECUTION_FOCUS_HISTORY = 12
export const MAX_EXECUTION_FOCUS_EVENTS = 2000
export const MAX_EXECUTION_FOCUS_HISTORY_BYTES = 512 * 1024

/** Display facts observed at this focus event, never live control or a second Session record. */
export type AgentFocusHistoryIdentity = {
  name: string
  kind: SessionSnapshot['kind']
  providerId: string | null
  hostId: string
  workspacePath: string
  project?: { id: string; name: string }
  branch?: string
  topicId?: string
}

export type AgentFocusHistoryEntry = {
  sessionId: string
  focusedAt: number
  identity?: AgentFocusHistoryIdentity
}

export type AgentFocusContext = {
  execution: {
    sessionId: string | null
    history: AgentFocusHistoryEntry[]
  }
  pmo: {
    sessionId: string | null
  }
}

export type AgentFocusLane = 'execution' | 'pmo'

export const EMPTY_AGENT_FOCUS: AgentFocusContext = {
  execution: { sessionId: null, history: [] },
  pmo: { sessionId: null }
}

export function executionFocusSessionId(context: AgentFocusContext): string | null {
  return context.execution.sessionId
}

export function executionFocusHistory(context: AgentFocusContext): readonly AgentFocusHistoryEntry[] {
  const seen = new Set<string>()
  return context.execution.history.filter(entry => {
    if (seen.has(entry.sessionId) || seen.size >= MAX_EXECUTION_FOCUS_HISTORY) return false
    seen.add(entry.sessionId)
    return true
  })
}

export function pmoFocusSessionId(context: AgentFocusContext): string | null {
  return context.pmo.sessionId
}

export function focusLaneForSession(
  topicId: string | null,
  pmoTopicId: string
): AgentFocusLane {
  return topicId === pmoTopicId ? 'pmo' : 'execution'
}

/** Retain the newest complete prefix, counting the actual JSON including escaping and commas. */
function retainExecutionFocusHistory(history: readonly AgentFocusHistoryEntry[], limit = MAX_EXECUTION_FOCUS_EVENTS): AgentFocusHistoryEntry[] {
  const retained: AgentFocusHistoryEntry[] = []
  let length = 2 // JSON array brackets, in UTF-16 code units.
  for (const entry of history) {
    if (retained.length >= Math.min(limit, MAX_EXECUTION_FOCUS_EVENTS)) break
    const nextLength = length + (retained.length ? 1 : 0) + JSON.stringify(entry).length
    if (nextLength * 2 > MAX_EXECUTION_FOCUS_HISTORY_BYTES) break
    retained.push(entry); length = nextLength
  }
  return retained
}

export function recordExecutionFocus(
  history: readonly AgentFocusHistoryEntry[],
  sessionId: string,
  focusedAt = Date.now(),
  limit = MAX_EXECUTION_FOCUS_EVENTS,
  identity?: AgentFocusHistoryIdentity
): AgentFocusHistoryEntry[] {
  if (!sessionId || limit < 1) return []
  const entries = [
    { sessionId, focusedAt, ...(identity ? { identity } : {}) },
    ...history
  ]
  return retainExecutionFocusHistory(entries, limit)
}

export function focusExecution(
  context: AgentFocusContext,
  sessionId: string | null,
  focusedAt = Date.now(),
  identity?: AgentFocusHistoryIdentity
): AgentFocusContext {
  if (sessionId === context.execution.sessionId) return context
  if (!sessionId) return {
    ...context,
    execution: { ...context.execution, sessionId: null }
  }
  return {
    ...context,
    execution: {
      sessionId,
      history: recordExecutionFocus(context.execution.history, sessionId, focusedAt, MAX_EXECUTION_FOCUS_EVENTS, identity)
    }
  }
}

export function focusPmo(
  context: AgentFocusContext,
  sessionId: string | null
): AgentFocusContext {
  return { ...context, pmo: { sessionId } }
}

function restoreHistoryIdentity(candidate: unknown): AgentFocusHistoryIdentity | undefined {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
  const value = candidate as Record<string, unknown>
  if (typeof value.name !== 'string' || (value.kind !== 'agent' && value.kind !== 'terminal')
    || (value.providerId !== null && typeof value.providerId !== 'string')
    || typeof value.hostId !== 'string' || typeof value.workspacePath !== 'string') return undefined
  const project = value.project && typeof value.project === 'object' && !Array.isArray(value.project)
    ? value.project as Record<string, unknown> : undefined
  return {
    name: value.name, kind: value.kind, providerId: value.providerId,
    hostId: value.hostId, workspacePath: value.workspacePath,
    ...(project && typeof project.id === 'string' && typeof project.name === 'string'
      ? { project: { id: project.id, name: project.name } } : {}),
    ...(typeof value.branch === 'string' ? { branch: value.branch } : {}),
    ...(typeof value.topicId === 'string' ? { topicId: value.topicId } : {})
  }
}

export function restoreAgentFocus(candidate: unknown): AgentFocusContext {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return EMPTY_AGENT_FOCUS
  const value = candidate as Record<string, unknown>
  const execution = value.execution && typeof value.execution === 'object' && !Array.isArray(value.execution)
    ? value.execution as Record<string, unknown>
    : {}
  const pmo = value.pmo && typeof value.pmo === 'object' && !Array.isArray(value.pmo)
    ? value.pmo as Record<string, unknown>
    : {}
  const history = Array.isArray(execution.history)
    ? execution.history.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
        const value = entry as Record<string, unknown>
        const identity = restoreHistoryIdentity(value.identity)
        return typeof value.sessionId === 'string' && value.sessionId.length > 0 && Number.isSafeInteger(value.focusedAt) && (value.focusedAt as number) >= 0
          ? [{ sessionId: value.sessionId, focusedAt: value.focusedAt as number, ...(identity ? { identity } : {}) }]
          : []
      })
    : []
  const sessionId = typeof execution.sessionId === 'string' && execution.sessionId.length > 0
    ? execution.sessionId
    : null
  const pmoSessionId = typeof pmo.sessionId === 'string' && pmo.sessionId.length > 0
    ? pmo.sessionId
    : null
  return {
    execution: {
      sessionId,
      history: retainExecutionFocusHistory(history)
    },
    pmo: { sessionId: pmoSessionId }
  }
}

export function sanitizeAgentFocus(
  context: AgentFocusContext,
  sessions: readonly SessionSnapshot[],
  laneForSession: (session: SessionSnapshot) => AgentFocusLane,
  retainedUnknownSessionIds?: ReadonlySet<string>
): AgentFocusContext {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const executionSession = context.execution.sessionId
    ? byId.get(context.execution.sessionId)
    : undefined
  const pmoSession = context.pmo.sessionId
    ? byId.get(context.pmo.sessionId)
    : undefined
  return {
    execution: {
      sessionId: executionSession && laneForSession(executionSession) === 'execution'
        ? executionSession.id
        : !executionSession && context.execution.sessionId && retainedUnknownSessionIds?.has(context.execution.sessionId)
          ? context.execution.sessionId : null,
      // Removing a current projection cannot erase an earlier execution focus fact.
      history: context.execution.history
    },
    pmo: {
      sessionId: pmoSession && laneForSession(pmoSession) === 'pmo'
        ? pmoSession.id
        : !pmoSession && context.pmo.sessionId && retainedUnknownSessionIds?.has(context.pmo.sessionId)
          ? context.pmo.sessionId : null
    }
  }
}

export function executionFocusContextText(
  context: AgentFocusContext,
  sessions: readonly SessionSnapshot[],
  labelForSession: (session: SessionSnapshot) => string = (session) => session.label
): string {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const entries = executionFocusHistory(context).flatMap((entry) => {
    const session = byId.get(entry.sessionId)
    return session ? [`- ${context.execution.sessionId === session.id ? '[current] ' : ''}${labelForSession(session)} (${session.id}) · ${session.workspacePath} · ${session.status.state}`] : []
  })
  return [
    'Read-only execution Agent context (this is not PMO context):',
    entries.length > 0 ? entries.join('\n') : '- No execution Agent focus history is available.'
  ].join('\n')
}
