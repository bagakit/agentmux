import { semanticIconComponent, type SemanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusContext } from '../lib/focus-context'

const ThemeStatusWarningIcon = semanticIconComponent('status.warning')
const ThemeObjectConversationIcon = semanticIconComponent('object.conversation')
const ThemeStatusWorkingIcon = semanticIconComponent('status.working')
const ThemeStatusCompletedIcon = semanticIconComponent('status.completed')
const ThemeStatusUnknownIcon = semanticIconComponent('status.unknown')
const ThemeStatusDisconnectedIcon = semanticIconComponent('status.disconnected')
const ThemeActionPauseIcon = semanticIconComponent('action.pause')


/** Shapes express the existing Focus state; they do not classify the Session again. */
export function FocusContextStateMark({ context }: { context: FocusContext }) {
  const unknown = context.bucket === 'idle' && (context.state === 'running' || context.activitySemantic === 'unknown' || context.activitySemantic === 'unsupported')
  const [kind, Icon]: [string, SemanticIconComponent] = context.bucket === 'attention' ? context.state === 'error' ? ['error', ThemeStatusWarningIcon] : ['attention', ThemeObjectConversationIcon]
    : context.bucket === 'working' ? ['working', ThemeStatusWorkingIcon]
      : context.bucket === 'results' ? ['results', ThemeStatusCompletedIcon]
        : context.runUnobserved ? ['unknown', ThemeStatusUnknownIcon]
          : context.processState === 'interrupted' ? ['interrupted', ThemeStatusWarningIcon]
          : unknown ? ['unknown', ThemeStatusUnknownIcon]
          : context.processState !== 'running' ? ['recovery', ThemeStatusDisconnectedIcon] : ['idle', ThemeActionPauseIcon]
  return <span className="focus-state-mark" data-focus-state-icon={kind} aria-hidden="true"><Icon size={12} strokeWidth={1.8} /></span>
}
