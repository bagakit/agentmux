import { Activity, Check, CircleHelp, MessageSquare, Pause, TriangleAlert, Unplug, type LucideIcon } from 'lucide-react'
import type { FocusContext } from '../lib/focus-context'

/** Shapes express the existing Focus state; they do not classify the Session again. */
export function FocusContextStateMark({ context }: { context: FocusContext }) {
  const unknown = context.bucket === 'idle' && (context.state === 'running' || context.activitySemantic === 'unknown' || context.activitySemantic === 'unsupported')
  const [kind, Icon]: [string, LucideIcon] = context.bucket === 'attention' ? context.state === 'error' ? ['error', TriangleAlert] : ['attention', MessageSquare]
    : context.bucket === 'working' ? ['working', Activity]
      : context.bucket === 'results' ? ['results', Check]
        : context.runUnobserved ? ['unknown', CircleHelp]
          : context.processState === 'interrupted' ? ['interrupted', TriangleAlert]
          : unknown ? ['unknown', CircleHelp]
          : context.processState !== 'running' ? ['recovery', Unplug] : ['idle', Pause]
  return <span className="focus-state-mark" data-focus-state-icon={kind} aria-hidden="true"><Icon size={12} strokeWidth={1.8} /></span>
}
