import { agentActivityRemainingMs, agentEvidenceStale } from '@agentmux/core/agent-status'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { RendererAgentTimelineSnapshot } from './session-state'
import type { MoteExpression } from '../components/MoteFace'
import { observeAgentSession } from './agent-observation'

type Presentation = { expression: MoteExpression; activeForMs: number }
/** One projection for Desktop and the original public space presentation; no execution state is written. */
export function moteExpressionPresentation(session: SessionSnapshot | undefined, availability: 'static' | 'no-agent' | 'restoring', tool: RendererAgentTimelineSnapshot['liveTool'], now = Date.now()): Presentation {
  const still = (expression: MoteExpression): Presentation => ({ expression, activeForMs: 0 })
  if (!session) return still(availability === 'no-agent' ? 'sleep' : availability === 'restoring' ? 'unknown' : 'identity')
  if (session.kind !== 'agent') return still('identity')
  if (session.control.hostId !== session.hostId || session.currentActivity && session.currentActivity.run.runId !== session.control.run.runId) return still('unknown')
  if (session.processState !== 'running') return still(session.processState === 'exited' || session.status.state === 'exited' ? 'stopped' : 'unknown')
  if (session.currentActivity?.state === 'active' && agentEvidenceStale(session.currentActivity, now)) return still('unknown')
  const observation = observeAgentSession(session, now)
  if (observation.semantic === 'awaiting-input') return still('waiting')
  const activeForMs = agentActivityRemainingMs(observation, now)
  if (observation.semantic === 'active' && activeForMs > 0) {
    const epoch = session.semanticStatus?.stateEnteredAt
    const currentTool = tool && epoch !== undefined && session.semanticStatus?.state === 'working' &&
      tool.hostId === session.hostId && tool.runId === session.control.run.runId && tool.epoch === epoch
    return { expression: currentTool ? 'tool' : 'thinking', activeForMs }
  }
  if (observation.semantic === 'idle') return still(session.status.state === 'error' ? 'error' : 'idle')
  if (session.currentActivity) return still('unknown')
  if (session.status.state === 'error') return still('error')
  if (session.status.state === 'starting') return still('starting')
  if (session.status.state === 'waiting' || session.status.state === 'blocked') return still('waiting')
  return still('unknown')
}

/** Absence/restoring come from the exact Region; static identity has no Session subscription. */
export function moteExpression(session: SessionSnapshot | undefined, availability: 'static' | 'no-agent' | 'restoring', tool: RendererAgentTimelineSnapshot['liveTool'], now = Date.now()): MoteExpression {
  return moteExpressionPresentation(session, availability, tool, now).expression
}
