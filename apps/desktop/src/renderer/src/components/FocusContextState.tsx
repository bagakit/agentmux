import { semanticIconComponent, type SemanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusContext } from '../lib/focus-context'

const ThemeStatusFailedIcon = semanticIconComponent('status.failed')
const ThemeStatusInputIcon = semanticIconComponent('status.needs-input')
const ThemeStatusWorkingIcon = semanticIconComponent('status.working')
const ThemeStatusCompletedIcon = semanticIconComponent('status.completed')
const ThemeStatusUnknownIcon = semanticIconComponent('status.presence-unknown')
const ThemeStatusStoppedIcon = semanticIconComponent('status.killed')
const ThemeStatusDisconnectedIcon = semanticIconComponent('status.disconnected')
const ThemeStatusIdleIcon = semanticIconComponent('status.idle')


/** Shapes express the existing Focus state; they do not classify the Session again. */
export function FocusContextStateMark({ context }: { context: FocusContext }) {
  const unknown = context.bucket === 'idle' && (context.activitySemantic === 'unknown' || context.activitySemantic === 'unsupported' || context.activitySemantic === undefined && context.state === 'running')
  const [kind, Icon]: [string, SemanticIconComponent] = context.bucket === 'attention' ? context.state === 'error' ? ['error', ThemeStatusFailedIcon] : ['attention', ThemeStatusInputIcon]
    : context.bucket === 'working' ? ['working', ThemeStatusWorkingIcon]
      : context.bucket === 'results' ? ['results', ThemeStatusCompletedIcon]
        : context.runUnobserved ? ['unknown', ThemeStatusUnknownIcon]
          : context.processState === 'interrupted' ? ['interrupted', ThemeStatusStoppedIcon]
          : unknown ? ['unknown', ThemeStatusUnknownIcon]
          : context.processState !== 'running' ? ['recovery', ThemeStatusDisconnectedIcon] : ['idle', ThemeStatusIdleIcon]
  return <span className="focus-state-mark" data-focus-state-icon={kind} aria-hidden="true"><Icon size={12} strokeWidth={1.8} animation={kind === 'working' ? 'work' : 'none'} /></span>
}
