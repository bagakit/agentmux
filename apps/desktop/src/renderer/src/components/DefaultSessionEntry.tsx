import { Sparkles } from 'lucide-react'
import { requestDefaultSessionFloatingOpen } from '../lib/default-session-floating'
import { useAppStore } from '../store'

export function DefaultSessionEntry({ placement = 'topbar', respectHidden = true }: { placement?: 'topbar' | 'board'; respectHidden?: boolean }) {
  const hidden = useAppStore((state) => state.defaultSessionLauncherHidden)
  const setHidden = useAppStore((state) => state.setDefaultSessionLauncherHidden)

  function openDefaultTopic(): void {
    requestDefaultSessionFloatingOpen()
  }

  const className = placement === 'board' ? 'global-default-session' : 'default-session-entry'
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
        <Sparkles size={14} /> <span>Default Session</span>
      </button>
    </div>
  )
}
