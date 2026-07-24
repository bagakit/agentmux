import { AgentMuxError } from './errors.js'
import type { AgentMuxDaemonSession } from './daemon-protocol.js'
import type { AgentId, AgentMuxSemanticSession } from './types.js'

export type AgentMuxTerminalSessionSnapshot = {
  id: string
  kind: 'terminal'
  hostId: string
  workspacePath: string
  run: AgentMuxDaemonSession & { kind: 'terminal'; agentId: null; semanticSessionId: null }
}

export type AgentMuxAgentSessionSnapshot = {
  id: string
  kind: 'agent'
  hostId: string
  workspacePath: string
  agentId: AgentId
  semantic: AgentMuxSemanticSession
  run: AgentMuxDaemonSession & { kind: 'agent'; agentId: AgentId; semanticSessionId: string }
}

export type AgentMuxSessionSnapshot =
  | AgentMuxTerminalSessionSnapshot
  | AgentMuxAgentSessionSnapshot

export type AgentMuxRuntimeSnapshot = {
  hostId: string
  sessions: AgentMuxSessionSnapshot[]
}

function sameRun(
  left: { sessionId: string; incarnationId: string },
  right: { sessionId: string; incarnationId: string }
): boolean {
  return left.sessionId === right.sessionId && left.incarnationId === right.incarnationId
}

export function projectAgentMuxSessions(
  hostId: string,
  runs: readonly AgentMuxDaemonSession[],
  semanticSessions: readonly AgentMuxSemanticSession[]
): AgentMuxSessionSnapshot[] {
  const semantics = new Map(semanticSessions.map((session) => [session.semanticSessionId, session]))
  return runs.map((run): AgentMuxSessionSnapshot => {
    if (run.kind === 'terminal') {
      if (run.agentId !== null || run.semanticSessionId !== null) {
        throw new AgentMuxError('Raw Terminal run carries Agent identity.', 'SESSION_KIND_MISMATCH')
      }
      return {
        id: run.sessionId,
        kind: 'terminal',
        hostId,
        workspacePath: run.cwd,
        run: structuredClone(run) as AgentMuxTerminalSessionSnapshot['run']
      }
    }
    if (!run.agentId || !run.semanticSessionId) {
      throw new AgentMuxError('Agent run is missing semantic identity.', 'SESSION_KIND_MISMATCH')
    }
    const semantic = semantics.get(run.semanticSessionId)
    if (
      !semantic ||
      semantic.hostId !== hostId ||
      semantic.agentId !== run.agentId ||
      semantic.workspacePath !== run.cwd ||
      !sameRun(semantic.daemonSession, run)
    ) {
      throw new AgentMuxError('Agent run does not match its semantic session.', 'SEMANTIC_RUN_MISMATCH')
    }
    return {
      id: semantic.semanticSessionId,
      kind: 'agent',
      hostId,
      workspacePath: semantic.workspacePath,
      agentId: semantic.agentId,
      semantic: structuredClone(semantic),
      run: structuredClone(run) as AgentMuxAgentSessionSnapshot['run']
    }
  })
}
