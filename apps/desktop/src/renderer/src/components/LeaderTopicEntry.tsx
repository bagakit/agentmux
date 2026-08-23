import { MoreHorizontal } from 'lucide-react'
import type { CSSProperties, PointerEventHandler } from 'react'
import leaderTopicAvatar from '../assets/leader-topic-avatar.png'
import { LEADER_TOPIC_ID, LEADER_TOPIC_TITLE } from '../../../shared/scratch-topics'
import { categoryFor, isUrgentAttention } from '../lib/attention-event'
import { topicIdForSession } from '../lib/workbench-tabs'
import {
  requestLeaderTopicFloatingOpen,
  useLeaderTopicFloatingState,
  type LeaderTopicLauncherPlacement
} from '../lib/leader-topic-floating'
import { useAppStore } from '../store'

const EMPTY_SESSIONS = [] as const

export function LeaderTopicEntry({
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
  placement: LeaderTopicLauncherPlacement
  style?: CSSProperties
  dragging?: boolean
  onPointerDown?: PointerEventHandler<HTMLDivElement>
  onPointerMove?: PointerEventHandler<HTMLDivElement>
  onPointerUp?: PointerEventHandler<HTMLDivElement>
  onPointerCancel?: PointerEventHandler<HTMLDivElement>
  onOpen?: () => void
  attached?: boolean
}) {
  const [floating, setFloating] = useLeaderTopicFloatingState()
  const config = useAppStore((state) => state.config ?? null)
  const sessions = useAppStore((state) => state.sessions ?? EMPTY_SESSIONS)
  if (floating.launcherPlacement !== placement) return null

  const needsAttention = sessions.some((session) =>
    session.kind === 'agent'
      && topicIdForSession(config, session) === LEADER_TOPIC_ID
      && isUrgentAttention(categoryFor(session.status.state))
  )
  const className = placement === 'floating' ? 'leader-topic-floating-launcher' : 'leader-topic-compact-launcher'
  const nextPlacement: LeaderTopicLauncherPlacement = placement === 'floating' ? 'compact' : 'floating'
  const toggleLabel = placement === 'floating' ? 'More Leader Topic actions: move to bottom switcher' : 'More Leader Topic actions: restore floating button'
  const openLabel = placement === 'floating' && floating.open ? `Close ${LEADER_TOPIC_TITLE}` : `Open ${LEADER_TOPIC_TITLE}`
  return (
    <div
      className={`${className}${dragging ? ' is-dragging' : ''}${attached ? ' is-attached' : ''}`}
      data-leader-topic-launcher
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <button
        type="button"
        className={`${className}__button`}
        onClick={onOpen ?? requestLeaderTopicFloatingOpen}
        aria-label={openLabel}
        title={openLabel}
        aria-expanded={placement === 'floating' ? floating.open : undefined}
        aria-controls={placement === 'floating' ? 'leader-topic-floating-panel' : undefined}
      >
        <img src={leaderTopicAvatar} alt="" aria-hidden="true" draggable={false} />
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
