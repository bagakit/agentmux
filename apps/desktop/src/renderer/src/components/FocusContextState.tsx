import { semanticIconComponent, type SemanticIconComponent } from '@agentmux/client-ui/icons'
import { FocusStateMark } from '@agentmux/client-ui/components/FocusStateMark'
import { focusStateMarkKind } from '@agentmux/client-ui/focus-state-mark'
import type { FocusBucket, FocusContext } from '../lib/focus-context'

const ThemeStatusWorkingIcon = semanticIconComponent('status.working')
const ThemeStatusCompletedIcon = semanticIconComponent('status.completed')


/** Group headings describe a Focus scope, never an individual Agent state. */
export const FOCUS_BUCKET_PRESENTATION: Record<FocusBucket, { label: string; icon: SemanticIconComponent }> = {
  attention: { label: 'Attention', icon: semanticIconComponent('object.inbox') },
  working: { label: 'Working', icon: ThemeStatusWorkingIcon },
  results: { label: 'Results', icon: ThemeStatusCompletedIcon },
  idle: { label: 'Idle / Recovery', icon: semanticIconComponent('status.neutral') }
}

/** Shapes express the original Focus owner facts; both clients share the rendering. */
export function FocusContextStateMark({ context }: { context: FocusContext }) {
  return <FocusStateMark kind={focusStateMarkKind(context)} presenceUnknown={context.runUnobserved} />
}
