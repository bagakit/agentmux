import { ChevronDown, ChevronUp } from 'lucide-react'
import type { CSSProperties, MouseEvent, PointerEventHandler } from 'react'
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
  attached = false,
  footer = false
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
  footer?: boolean
}) {
  const [floating, setFloating] = usePmoTeamsTopicFloatingState()
  const config = useAppStore((state) => state.config ?? null)
  const sessions = useAppStore((state) => state.sessions ?? EMPTY_SESSIONS)
  const isFooterCollapse = footer && placement === 'compact' && floating.launcherPlacement === 'floating'
  if (floating.launcherPlacement !== placement && !isFooterCollapse) return null

  const needsAttention = sessions.some((session) =>
    session.kind === 'agent'
      && topicIdForSession(config, session) === PMO_TEAMS_TOPIC_ID
      && isUrgentAttention(categoryFor(session.status.state))
  )
  const className = placement === 'floating' ? 'pmo-teams-topic-floating-launcher' : 'pmo-teams-topic-compact-launcher'
  const nextPlacement: PmoTeamsTopicLauncherPlacement = placement === 'floating' ? 'compact' : 'floating'
  const toggleLabel = placement === 'floating' ? 'Collapse PMO teams topic to bottom switcher' : 'Restore floating PMO teams topic button'
  const openLabel = placement === 'floating' && floating.open ? `Close ${PMO_TEAMS_TOPIC_TITLE}` : `Open ${PMO_TEAMS_TOPIC_TITLE}`
  const defaultOpen = (): void => {
    if (floating.open) {
      requestPmoTeamsTopicFloatingClose()
      return
    }
    requestPmoTeamsTopicFloatingOpen({ anchor: placement })
  }
  const handleLauncherClick = (event: MouseEvent<HTMLDivElement>): void => {
    if ((event.target as Element | null)?.closest('[data-pmo-teams-topic-mode]')) return
    const open = onOpen ?? defaultOpen
    open()
  }
  if (isFooterCollapse) {
    return (
      <div className="pmo-teams-topic-compact-launcher" data-pmo-teams-topic-launcher>
        <button
          type="button"
          className="pmo-teams-topic-compact-launcher__collapse-button"
          aria-label="Collapse PMO teams topic to bottom switcher"
          title="Collapse PMO teams topic to bottom switcher"
          onClick={() => setFloating({ launcherPlacement: 'compact', open: false })}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
    )
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
      onClick={handleLauncherClick}
    >
      <button
        type="button"
        className={`${className}__button`}
        aria-label={openLabel}
        title={openLabel}
        aria-expanded={placement === 'floating' ? floating.open : undefined}
        aria-controls={placement === 'floating' ? 'pmo-teams-topic-floating-panel' : undefined}
      >
        <img src={pmoTeamsTopicAvatar} alt="" aria-hidden="true" draggable={false} />
        {needsAttention ? <span className={`${className}__attention`} aria-hidden="true" /> : null}
      </button>
      {placement === 'compact' ? (
        <button
          type="button"
          className={`${className}__mode-button`}
          data-pmo-teams-topic-mode
          aria-label={toggleLabel}
          title={toggleLabel}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            setFloating({ launcherPlacement: nextPlacement, open: false })
          }}
        >
          <ChevronUp size={13} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}
