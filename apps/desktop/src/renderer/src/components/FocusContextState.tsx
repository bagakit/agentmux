import { semanticIconComponent, type SemanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusBucket, FocusContext } from '../lib/focus-context'

const ThemeStatusFailedIcon = semanticIconComponent('status.failed')
const ThemeStatusInputIcon = semanticIconComponent('status.needs-input')
const ThemeStatusWorkingIcon = semanticIconComponent('status.working')
const ThemeStatusCompletedIcon = semanticIconComponent('status.completed')
const ThemeStatusUnknownIcon = semanticIconComponent('status.presence-unknown')
const ThemeStatusActivityUnknownIcon = semanticIconComponent('status.activity-unknown')
const ThemeStatusInterruptedIcon = semanticIconComponent('status.interrupted')
const ThemeStatusDisconnectedIcon = semanticIconComponent('status.disconnected')
const ThemeStatusIdleIcon = semanticIconComponent('status.idle')


/** Group headings describe a Focus scope, never an individual Agent state. */
export const FOCUS_BUCKET_PRESENTATION: Record<FocusBucket, { label: string; icon: SemanticIconComponent }> = {
  attention: { label: 'Attention', icon: semanticIconComponent('object.inbox') },
  working: { label: 'Working', icon: ThemeStatusWorkingIcon },
  results: { label: 'Results', icon: ThemeStatusCompletedIcon },
  idle: { label: 'Idle / Recovery', icon: semanticIconComponent('status.neutral') }
}

/** Shapes express the existing Focus state; they do not classify the Session again. */
export function FocusContextStateMark({ context }: { context: FocusContext }) {
  const unknown = context.bucket === 'idle' && (context.activitySemantic === 'unknown' || context.activitySemantic === 'unsupported' || context.activitySemantic === undefined && context.state === 'running')
  const [kind, Icon]: [string, SemanticIconComponent] = context.bucket === 'attention' ? context.state === 'error' ? ['error', ThemeStatusFailedIcon] : ['attention', ThemeStatusInputIcon]
    : context.bucket === 'working' ? ['working', ThemeStatusWorkingIcon]
      : context.bucket === 'results' ? ['results', ThemeStatusCompletedIcon]
        : context.runUnobserved ? ['unknown', ThemeStatusUnknownIcon]
          : context.processState === 'interrupted' ? ['interrupted', ThemeStatusInterruptedIcon]
          : unknown ? ['unknown', ThemeStatusActivityUnknownIcon]
          : context.processState !== 'running' ? ['recovery', ThemeStatusDisconnectedIcon] : ['idle', ThemeStatusIdleIcon]
  return <span className="focus-state-mark" data-focus-state-icon={kind} aria-hidden="true"><Icon size={12} strokeWidth={1.8} animation={kind === 'working' ? 'work' : 'none'} /></span>
}
