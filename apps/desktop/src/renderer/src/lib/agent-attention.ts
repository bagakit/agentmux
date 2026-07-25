import type { SessionSnapshot } from '../../../shared/contracts'

// A window-wide cross-session rollup of Agent attention. Every other indicator in the window is
// scoped — the tab dot is one Session, Board columns are one Project, the Agents tool total is one
// Workspace and only while its dock is open. This answers the single question none of them do:
// anywhere in this window, does any Agent need me right now? It reads only the Session projection
// already in the Store and adds no new plumbing.
export type AgentAttentionRollup = {
  // Every Agent Session the window is projecting, regardless of whether it currently has a View.
  total: number
  working: number
  // waiting + blocked: the Agent has surfaced a request or is stuck and cannot proceed without you.
  needsYou: number
  error: number
  // The earliest Session by status.observedAt in each attention class, so a click lands on the one
  // that has been waiting longest — null when that class is empty.
  needsYouSessionId: string | null
  errorSessionId: string | null
}

function isAgent(session: SessionSnapshot): session is Extract<SessionSnapshot, { kind: 'agent' }> {
  return session.kind === 'agent'
}

// The earliest by observedAt wins; on an exact tie the first in projection order holds, so the
// result is deterministic. status.observedAt is the field this rollup finally reads.
function earliest(
  sessions: readonly SessionSnapshot[],
  matches: (state: SessionSnapshot['status']['state']) => boolean
): string | null {
  let winner: SessionSnapshot | null = null
  for (const session of sessions) {
    if (!isAgent(session) || !matches(session.status.state)) continue
    if (!winner || session.status.observedAt < winner.status.observedAt) winner = session
  }
  return winner?.id ?? null
}

export function summarizeAgentAttention(
  sessions: readonly SessionSnapshot[]
): AgentAttentionRollup {
  const agents = sessions.filter(isAgent)
  return {
    total: agents.length,
    working: agents.filter((session) => session.status.state === 'working').length,
    needsYou: agents.filter((session) => (
      session.status.state === 'waiting' || session.status.state === 'blocked'
    )).length,
    error: agents.filter((session) => session.status.state === 'error').length,
    needsYouSessionId: earliest(sessions, (state) => state === 'waiting' || state === 'blocked'),
    errorSessionId: earliest(sessions, (state) => state === 'error')
  }
}
