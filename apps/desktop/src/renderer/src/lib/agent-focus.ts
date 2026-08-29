import type { SessionSnapshot } from '../../../shared/contracts'

export const MAX_EXECUTION_FOCUS_HISTORY = 12

export type AgentFocusHistoryEntry = {
  sessionId: string
  focusedAt: number
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

export function focusLaneForSession(
  topicId: string | null,
  pmoTopicId: string
): AgentFocusLane {
  return topicId === pmoTopicId ? 'pmo' : 'execution'
}

export function recordExecutionFocus(
  history: readonly AgentFocusHistoryEntry[],
  sessionId: string,
  focusedAt = Date.now(),
  limit = MAX_EXECUTION_FOCUS_HISTORY
): AgentFocusHistoryEntry[] {
  if (!sessionId || limit < 1) return []
  return [
    { sessionId, focusedAt },
    ...history.filter((entry) => entry.sessionId !== sessionId)
  ].slice(0, limit)
}

export function focusExecution(
  context: AgentFocusContext,
  sessionId: string | null,
  focusedAt = Date.now()
): AgentFocusContext {
  if (!sessionId) return {
    ...context,
    execution: { ...context.execution, sessionId: null }
  }
  return {
    ...context,
    execution: {
      sessionId,
      history: recordExecutionFocus(context.execution.history, sessionId, focusedAt)
    }
  }
}

export function focusPmo(
  context: AgentFocusContext,
  sessionId: string | null
): AgentFocusContext {
  return { ...context, pmo: { sessionId } }
}

export function pruneFocusHistory(
  context: AgentFocusContext,
  sessions: readonly SessionSnapshot[]
): AgentFocusContext {
  const known = new Set(sessions.map((session) => session.id))
  const history = context.execution.history.filter((entry) => known.has(entry.sessionId))
  const executionSessionId = context.execution.sessionId && known.has(context.execution.sessionId)
    ? context.execution.sessionId
    : null
  const pmoSessionId = context.pmo.sessionId && known.has(context.pmo.sessionId)
    ? context.pmo.sessionId
    : null
  return {
    execution: {
      sessionId: executionSessionId,
      history
    },
    pmo: { sessionId: pmoSessionId }
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
        return typeof value.sessionId === 'string' && value.sessionId.length > 0 && typeof value.focusedAt === 'number'
          ? [{ sessionId: value.sessionId, focusedAt: value.focusedAt }]
          : []
      })
    : []
  const sessionId = typeof execution.sessionId === 'string' && execution.sessionId.length > 0
    ? execution.sessionId
    : null
  const pmoSessionId = typeof pmo.sessionId === 'string' && pmo.sessionId.length > 0
    ? pmo.sessionId
    : null
  const uniqueHistory = history.filter((entry, index, values) => (
    values.findIndex((candidate) => candidate.sessionId === entry.sessionId) === index
  )).slice(0, MAX_EXECUTION_FOCUS_HISTORY)
  if (sessionId) {
    const currentEntry = uniqueHistory.find((entry) => entry.sessionId === sessionId)
    if (currentEntry) {
      uniqueHistory.splice(uniqueHistory.indexOf(currentEntry), 1)
      uniqueHistory.unshift(currentEntry)
    } else {
      uniqueHistory.unshift({ sessionId, focusedAt: Date.now() })
      uniqueHistory.splice(MAX_EXECUTION_FOCUS_HISTORY)
    }
  }
  return {
    execution: {
      sessionId,
      history: uniqueHistory
    },
    pmo: { sessionId: pmoSessionId }
  }
}

export function sanitizeAgentFocus(
  context: AgentFocusContext,
  sessions: readonly SessionSnapshot[],
  laneForSession: (session: SessionSnapshot) => AgentFocusLane
): AgentFocusContext {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const executionHistory = context.execution.history.filter((entry) => {
    const session = byId.get(entry.sessionId)
    return session !== undefined && laneForSession(session) === 'execution'
  })
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
        : null,
      history: executionHistory
    },
    pmo: {
      sessionId: pmoSession && laneForSession(pmoSession) === 'pmo'
        ? pmoSession.id
        : null
    }
  }
}

export function executionFocusContextText(
  context: AgentFocusContext,
  sessions: readonly SessionSnapshot[],
  labelForSession: (session: SessionSnapshot) => string = (session) => session.label
): string {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const entries = context.execution.history.flatMap((entry) => {
    const session = byId.get(entry.sessionId)
    return session ? [`- ${context.execution.sessionId === session.id ? '[current] ' : ''}${labelForSession(session)} (${session.id}) · ${session.workspacePath} · ${session.status.state}`] : []
  })
  return [
    'Read-only execution Agent context (this is not PMO context):',
    entries.length > 0 ? entries.join('\n') : '- No execution Agent focus history is available.'
  ].join('\n')
}
