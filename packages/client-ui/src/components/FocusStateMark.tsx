import { semanticIconComponent } from '../theme/icons.js'
import type { FocusStateMarkKind } from '../lib/focus-state-mark.js'
const marks = {
  error: semanticIconComponent('status.failed'), attention: semanticIconComponent('status.needs-input'),
  working: semanticIconComponent('status.working'), results: semanticIconComponent('status.completed'),
  unknown: semanticIconComponent('status.activity-unknown'), interrupted: semanticIconComponent('status.interrupted'),
  recovery: semanticIconComponent('status.disconnected'), idle: semanticIconComponent('status.idle')
}
/** Same semantic icon, theme, shape and motion in every client. */
export function FocusStateMark({ kind, size = 12, presenceUnknown = false }: { kind: FocusStateMarkKind; size?: number; presenceUnknown?: boolean | undefined }) {
  const Icon = kind === 'unknown' && presenceUnknown ? semanticIconComponent('status.presence-unknown') : marks[kind]
  return <span className="focus-state-mark" data-focus-state-icon={kind} aria-hidden="true"><Icon size={size} strokeWidth={1.8} animation={kind === 'working' ? 'work' : 'none'} /></span>
}
