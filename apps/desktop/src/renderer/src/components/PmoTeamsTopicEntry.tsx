import { MoreHorizontal } from 'lucide-react'
import type { CSSProperties, PointerEventHandler } from 'react'
import pmoTeamsTopicAvatar from '../assets/pmo-teams-topic-avatar.png'
import { PMO_TEAMS_TOPIC_ID, PMO_TEAMS_TOPIC_TITLE } from '../../../shared/scratch-topics'
import { categoryFor, isUrgentAttention } from '../lib/attention-event'
import { topicIdForSession } from '../lib/workbench-tabs'
import {
  requestPmoTeamsTopicFloatingOpen,
  requestPmoTeamsTopicFloatingClose,
  usePmoTeamsTopicFloatingState,
  type PmoTeamsTopicLauncherPlacement
} from '../lib/pmo-teams-topic-floating'
import { useAppStore } from '../store'

const EMPTY_SESSIONS = [] as const

export function PmoTeamsTopicEntry({
  placement,
  style,
  dragging = false,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onOpen,
  attached = false
}: {
  placement: PmoTeamsTopicLauncherPlacement
  style?: CSSProperties
  dragging?: boolean
  onPointerDown?: PointerEventHandler<HTMLDivElement>
  onPointerMove?: PointerEventHandler<HTMLDivElement>
  onPointerUp?: PointerEventHandler<HTMLDivElement>
  onPointerCancel?: PointerEventHandler<HTMLDivElement>
  onOpen?: () => void
  attached?: boolean
}) {
  const [floating, setFloating] = usePmoTeamsTopicFloatingState()
  const config = useAppStore((state) => state.config ?? null)
  const sessions = useAppStore((state) => state.sessions ?? EMPTY_SESSIONS)
  if (floating.launcherPlacement !== placement) return null

  const needsAttention = sessions.some((session) =>
    session.kind === 'agent'
      && topicIdForSession(config, session) === PMO_TEAMS_TOPIC_ID
      && isUrgentAttention(categoryFor(session.status.state))
  )
  const className = placement === 'floating' ? 'pmo-teams-topic-floating-launcher' : 'pmo-teams-topic-compact-launcher'
  const nextPlacement: PmoTeamsTopicLauncherPlacement = placement === 'floating' ? 'compact' : 'floating'
  const toggleLabel = placement === 'floating' ? 'More PMO teams topic actions: move to bottom switcher' : 'More PMO teams topic actions: restore floating button'
  const openLabel = placement === 'floating' && floating.open ? `Close ${PMO_TEAMS_TOPIC_TITLE}` : `Open ${PMO_TEAMS_TOPIC_TITLE}`
  const defaultOpen = (): void => {
    if (floating.open) {
      requestPmoTeamsTopicFloatingClose()
      return
    }
    requestPmoTeamsTopicFloatingOpen({ anchor: placement })
  }
  return (
    <div
      className={`${className}${dragging ? ' is-dragging' : ''}${attached ? ' is-attached' : ''}`}
      data-pmo-teams-topic-launcher
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <button
        type="button"
        className={`${className}__button`}
        onClick={onOpen ?? defaultOpen}
        aria-label={openLabel}
        title={openLabel}
        aria-expanded={placement === 'floating' ? floating.open : undefined}
        aria-controls={placement === 'floating' ? 'pmo-teams-topic-floating-panel' : undefined}
      >
        <img src={pmoTeamsTopicAvatar} alt="" aria-hidden="true" draggable={false} />
        {needsAttention ? <span className={`${className}__attention`} aria-hidden="true" /> : null}
      </button>
      <button
        type="button"
        className={`${className}__mode-button`}
        aria-label={toggleLabel}
        title={toggleLabel}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setFloating({ launcherPlacement: nextPlacement })}
      >
        <MoreHorizontal size={12} aria-hidden="true" />
      </button>
    </div>
  )
}
