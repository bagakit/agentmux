import { AgentMuxError } from './errors.js'
import type { AgentId, AgentMuxAgentSession, AgentMuxRun } from './types.js'

export type AgentMuxTerminalView = {
  viewId: string
  kind: 'terminal'
  hostId: string
  workspacePath: string
  run: AgentMuxRun & { kind: 'terminal'; agentId: null; agentSessionId: null }
}

export type AgentMuxAgentView = {
  viewId: string
  kind: 'agent'
  hostId: string
  workspacePath: string
  agentId: AgentId
  agentSession: AgentMuxAgentSession
  run: AgentMuxRun & { kind: 'agent'; agentId: AgentId; agentSessionId: string }
}

export type AgentMuxView =
  | AgentMuxTerminalView
  | AgentMuxAgentView

export type AgentMuxWorkspaceView = {
  hostId: string
  views: AgentMuxView[]
}

export type AgentMuxViewRequest = {
  viewId: string
  target:
    | { kind: 'terminal-run'; run: { runId: string } }
    | { kind: 'agent-session'; agentSessionId: string }
}

function sameRun(left: { runId: string }, right: { runId: string }): boolean {
  return left.runId === right.runId
}

export function projectAgentMuxViews(
  hostId: string,
  runs: readonly AgentMuxRun[],
  agentSessions: readonly AgentMuxAgentSession[],
  requests?: readonly AgentMuxViewRequest[]
): AgentMuxView[] {
  const sessions = new Map(agentSessions.map((session) => [session.agentSessionId, session]))
  const runsById = new Map(runs.map((run) => [run.runId, run]))
  const resolvedRequests = requests ?? runs.map((run): AgentMuxViewRequest => run.kind === 'terminal'
    ? {
        viewId: `terminal-view:${hostId}:${run.runId}`,
        target: { kind: 'terminal-run', run: { runId: run.runId } }
      }
    : {
        viewId: `agent-view:${hostId}:${run.agentSessionId ?? run.runId}`,
        target: { kind: 'agent-session', agentSessionId: run.agentSessionId ?? '' }
      })
  if (new Set(resolvedRequests.map((request) => request.viewId)).size !== resolvedRequests.length) {
    throw new AgentMuxError('View identity must be unique within a projection.', 'DUPLICATE_VIEW_ID')
  }
  return resolvedRequests.map((request): AgentMuxView => {
    const run = request.target.kind === 'terminal-run'
      ? runsById.get(request.target.run.runId)
      : (() => {
          const session = sessions.get(request.target.agentSessionId)
          return session ? runsById.get(session.run.runId) : undefined
        })()
    if (!run) throw new AgentMuxError('View target is unavailable.', 'UNKNOWN_VIEW_TARGET')
    if (request.target.kind === 'terminal-run' && !sameRun(request.target.run, run)) {
      throw new AgentMuxError('Terminal View points to another Run.', 'STALE_VIEW_TARGET')
    }
    if (run.kind === 'terminal') {
      if (
        request.target.kind !== 'terminal-run' ||
        run.agentId !== null ||
        run.agentSessionId !== null
      ) {
        throw new AgentMuxError('Raw Terminal run carries Agent identity.', 'SESSION_KIND_MISMATCH')
      }
      return {
        viewId: request.viewId,
        kind: 'terminal',
        hostId,
        workspacePath: run.workspacePath,
        run: structuredClone(run) as AgentMuxTerminalView['run']
      }
    }
    if (!run.agentId || !run.agentSessionId) {
      throw new AgentMuxError('Agent Run is missing Agent Session identity.', 'SESSION_KIND_MISMATCH')
    }
    const agentSession = request.target.kind === 'agent-session'
      ? sessions.get(request.target.agentSessionId)
      : undefined
    if (
      !agentSession ||
      agentSession.hostId !== hostId ||
      agentSession.agentId !== run.agentId ||
      agentSession.workspacePath !== run.workspacePath ||
      !sameRun(agentSession.run, run)
    ) {
      throw new AgentMuxError('Agent Run does not match its Agent Session.', 'AGENT_SESSION_RUN_MISMATCH')
    }
    return {
      viewId: request.viewId,
      kind: 'agent',
      hostId,
      workspacePath: agentSession.workspacePath,
      agentId: agentSession.agentId,
      agentSession: structuredClone(agentSession),
      run: structuredClone(run) as AgentMuxAgentView['run']
    }
  })
}
