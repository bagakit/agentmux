import { Sparkles } from 'lucide-react'
import { requestDefaultSessionFloatingOpen } from '../lib/default-session-floating'
import { categoryFor, isUrgentAttention } from '../lib/attention-event'
import { topicIdForSession } from '../lib/workbench-tabs'
import { useAppStore } from '../store'

const EMPTY_SESSIONS = [] as const

export function DefaultSessionEntry({ placement = 'topbar', respectHidden = true }: { placement?: 'topbar' | 'board' | 'floating'; respectHidden?: boolean }) {
  const hidden = useAppStore((state) => state.defaultSessionLauncherHidden)
  const setHidden = useAppStore((state) => state.setDefaultSessionLauncherHidden)
  const config = useAppStore((state) => state.config ?? null)
  const sessions = useAppStore((state) => state.sessions ?? EMPTY_SESSIONS)

  function openDefaultTopic(): void {
    requestDefaultSessionFloatingOpen()
  }

  const className = placement === 'board'
    ? 'global-default-session'
    : placement === 'floating'
      ? 'default-session-floating-launcher'
      : 'default-session-entry'
  if (placement === 'floating' && hidden && respectHidden) return null
  const needsAttention = placement === 'floating' && sessions.some((session) =>
    session.kind === 'agent'
      && topicIdForSession(config, session) === 'launcher:default'
      && isUrgentAttention(categoryFor(session.status.state))
  )
  if (hidden && respectHidden) {
    return <button type="button" className={`${className}__recover`} onClick={() => setHidden(false)} title="Show Default Session launcher"><Sparkles size={13} /> Default Session</button>
  }
  return (
    <div className={className}>
      <button
        type="button"
        className={`${className}__button`}
        onClick={openDefaultTopic}
        aria-label="Open Default Session"
        title="Open Default Session"
      >
        <Sparkles size={placement === 'floating' ? 17 : 14} />
        {placement === 'floating' && needsAttention ? <span className="default-session-floating-launcher__attention" aria-hidden="true" /> : placement === 'floating' ? null : <span>Default Session</span>}
      </button>
    </div>
  )
}
