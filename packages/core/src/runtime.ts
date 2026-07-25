import { AgentMuxError } from './errors.js'
import type { AgentExecutorId, AgentProviderId, AgentMuxAgentSession, AgentMuxRun } from './types.js'

export type AgentMuxTerminalRuntimeSubject = {
  subjectId: string
  kind: 'terminal'
  hostId: string
  workspacePath: string
  run: AgentMuxRun & { kind: 'terminal'; providerId: null; executorId: null; agentSessionId: null }
}

export type AgentMuxAgentRuntimeSubject = {
  subjectId: string
  kind: 'agent'
  hostId: string
  workspacePath: string
  providerId: AgentProviderId
  executorId: AgentExecutorId
  agentSession: AgentMuxAgentSession
  run: AgentMuxRun & {
    kind: 'agent'
    providerId: AgentProviderId
    executorId: AgentExecutorId
    agentSessionId: string
  }
}

export type AgentMuxRuntimeSubject =
  | AgentMuxTerminalRuntimeSubject
  | AgentMuxAgentRuntimeSubject

export type AgentMuxRuntimeProjection = {
  hostId: string
  subjects: AgentMuxRuntimeSubject[]
}

export type AgentMuxRuntimeProjectionRequest = {
  subjectId: string
  target:
    | { kind: 'terminal-run'; run: { runId: string } }
    | { kind: 'agent-session'; agentSessionId: string }
}

function sameRun(left: { runId: string }, right: { runId: string }): boolean {
  return left.runId === right.runId
}

export function projectAgentMuxRuntimeSubjects(
  hostId: string,
  runs: readonly AgentMuxRun[],
  agentSessions: readonly AgentMuxAgentSession[],
  requests?: readonly AgentMuxRuntimeProjectionRequest[]
): AgentMuxRuntimeSubject[] {
  const sessions = new Map(agentSessions.map((session) => [session.agentSessionId, session]))
  const runsById = new Map(runs.map((run) => [run.runId, run]))
  const resolvedRequests = requests ?? runs.map((run): AgentMuxRuntimeProjectionRequest => run.kind === 'terminal'
    ? {
        subjectId: `terminal:${hostId}:${run.runId}`,
        target: { kind: 'terminal-run', run: { runId: run.runId } }
      }
    : {
        subjectId: `agent:${hostId}:${run.agentSessionId ?? run.runId}`,
        target: { kind: 'agent-session', agentSessionId: run.agentSessionId ?? '' }
      })
  if (new Set(resolvedRequests.map((request) => request.subjectId)).size !== resolvedRequests.length) {
    throw new AgentMuxError('Runtime Subject identity must be unique within a projection.', 'DUPLICATE_RUNTIME_SUBJECT_ID')
  }
  return resolvedRequests.map((request): AgentMuxRuntimeSubject => {
    const run = request.target.kind === 'terminal-run'
      ? runsById.get(request.target.run.runId)
      : (() => {
          const session = sessions.get(request.target.agentSessionId)
          return session ? runsById.get(session.run.runId) : undefined
        })()
    if (!run) {
      throw new AgentMuxError(
        'Runtime Subject target is unavailable.',
        'UNKNOWN_RUNTIME_SUBJECT_TARGET'
      )
    }
    if (request.target.kind === 'terminal-run' && !sameRun(request.target.run, run)) {
      throw new AgentMuxError(
        'Terminal Runtime Subject points to another Run.',
        'STALE_RUNTIME_SUBJECT_TARGET'
      )
    }
    if (run.kind === 'terminal') {
      if (
        request.target.kind !== 'terminal-run' ||
        run.providerId !== null ||
        run.executorId !== null ||
        run.agentSessionId !== null
      ) {
        throw new AgentMuxError('Raw Terminal run carries Agent identity.', 'SESSION_KIND_MISMATCH')
      }
      return {
        subjectId: request.subjectId,
        kind: 'terminal',
        hostId,
        workspacePath: run.workspacePath,
        run: structuredClone(run) as AgentMuxTerminalRuntimeSubject['run']
      }
    }
    if (!run.providerId || !run.executorId || !run.agentSessionId) {
      throw new AgentMuxError('Agent Run is missing Agent Session identity.', 'SESSION_KIND_MISMATCH')
    }
    const agentSession = request.target.kind === 'agent-session'
      ? sessions.get(request.target.agentSessionId)
      : undefined
    if (
      !agentSession ||
      agentSession.hostId !== hostId ||
      agentSession.providerId !== run.providerId ||
      agentSession.executorId !== run.executorId ||
      agentSession.workspacePath !== run.workspacePath ||
      !sameRun(agentSession.run, run)
    ) {
      throw new AgentMuxError('Agent Run does not match its Agent Session.', 'AGENT_SESSION_RUN_MISMATCH')
    }
    return {
      subjectId: request.subjectId,
      kind: 'agent',
      hostId,
      workspacePath: agentSession.workspacePath,
      providerId: agentSession.providerId,
      executorId: agentSession.executorId,
      agentSession: structuredClone(agentSession),
      run: structuredClone(run) as AgentMuxAgentRuntimeSubject['run']
    }
  })
}
