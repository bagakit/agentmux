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
  onOpen
}: {
  placement: LeaderTopicLauncherPlacement
  style?: CSSProperties
  dragging?: boolean
  onPointerDown?: PointerEventHandler<HTMLDivElement>
  onPointerMove?: PointerEventHandler<HTMLDivElement>
  onPointerUp?: PointerEventHandler<HTMLDivElement>
  onPointerCancel?: PointerEventHandler<HTMLDivElement>
  onOpen?: () => void
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
  const toggleLabel = placement === 'floating' ? 'Move Leader Topic to bottom switcher' : 'Restore Leader Topic as floating button'
  return (
    <div
      className={`${className}${dragging ? ' is-dragging' : ''}`}
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
        aria-label={`Open ${LEADER_TOPIC_TITLE}`}
        title={`Open ${LEADER_TOPIC_TITLE}`}
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
