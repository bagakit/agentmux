import type { SessionSnapshot } from '../../../shared/contracts'
import type { RendererAgentTimelineSnapshot } from './session-state'
import type { MoteExpression } from '../components/MoteFace'

/** Absence and restoring are supplied by the exact original Region, never inferred from a missing Session. */
export function moteExpression(session: SessionSnapshot | undefined, availability: 'static' | 'no-agent' | 'restoring', tool: RendererAgentTimelineSnapshot['liveTool']): MoteExpression {
  if (!session) return availability === 'no-agent' ? 'sleep' : availability === 'restoring' ? 'unknown' : 'identity'
  if (session.kind !== 'agent') return 'identity'
  if (session.status.state === 'error') return 'error'
  if (session.status.state === 'disconnected' || session.status.state === 'running') return 'unknown'
  if (session.status.state === 'exited') return 'stopped'
  if (session.pendingInteraction || session.status.state === 'waiting' || session.status.state === 'blocked') return 'waiting'
  if (session.status.state === 'starting') return 'starting'
  if (session.status.state === 'done') return 'idle'
  const epoch = session.semanticStatus?.stateEnteredAt
  return tool && epoch !== undefined && session.semanticStatus?.state === 'working' &&
    tool.hostId === session.hostId && tool.runId === session.control.run.runId && tool.epoch === epoch ? 'tool' : 'thinking'
}
