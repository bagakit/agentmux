import type { FocusContext } from '../lib/focus-context'
import { FocusContextStateMark } from './FocusContextState'

/** Original semantic hints remain visible regardless of the optional Map ink. */
export const collaborationEssentialState = (context: FocusContext) => context.bucket === 'attention' || context.detailKind === 'service' || context.detailKind === 'observation' || context.activitySemantic === 'unknown' || context.state === 'disconnected'
export function CollaborationEssentialState({ context }: { context: FocusContext }) {
  return collaborationEssentialState(context) ? <span className="collaboration-agent__essential" title={context.stateLabel}><FocusContextStateMark context={context} /></span> : null
}
export function CollaborationCompactState({ context, progress, left, opacity, zoom }: { context: FocusContext; progress: number; left: number; opacity: number; zoom: number }) {
  return progress > 0 ? <span className="collaboration-agent__status" style={{ left, opacity: progress * opacity, fontSize: Math.max(10, 9 / zoom), transform: `translateY(${9 * progress}px)` }}><FocusContextStateMark context={context} /><small>{context.stateLabel}</small></span> : null
}
