import type { CSSProperties, MouseEvent } from 'react'
import pmoTeamsTopicAvatar from '../assets/pmo-teams-topic-avatar.png'
import { PMO_TEAMS_TOPIC_ID, PMO_TEAMS_TOPIC_TITLE } from '../../../shared/scratch-topics'
import { categoryFor, isUrgentAttention } from '../lib/attention-event'
import { topicIdForSession } from '../lib/workbench-tabs'
import {
  requestPmoTeamsTopicFloatingOpen,
  requestPmoTeamsTopicFloatingClose,
  usePmoTeamsTopicFloatingState
} from '../lib/pmo-teams-topic-floating'
import { useAppStore } from '../store'

const EMPTY_SESSIONS = [] as const

export function PmoTeamsTopicEntry({
  style,
  placement = 'compact'
}: {
  placement?: 'compact' | 'floating'
  style?: CSSProperties
}) {
  const [floating] = usePmoTeamsTopicFloatingState()
  const config = useAppStore((state) => state.config ?? null)
  const sessions = useAppStore((state) => state.sessions ?? EMPTY_SESSIONS)
  if (placement !== 'compact') return null

  const needsAttention = sessions.some((session) =>
    session.kind === 'agent'
      && topicIdForSession(config, session) === PMO_TEAMS_TOPIC_ID
      && isUrgentAttention(categoryFor(session.status.state))
  )
  const className = 'pmo-teams-topic-compact-launcher'
  const openLabel = floating.open ? `Close ${PMO_TEAMS_TOPIC_TITLE}` : `Open ${PMO_TEAMS_TOPIC_TITLE}`
  const working = sessions.some((session) => session.kind === 'agent'
    && topicIdForSession(config, session) === PMO_TEAMS_TOPIC_ID && session.status.state === 'working')
  const statusText = needsAttention ? 'Needs you' : working ? 'Working' : undefined
  const defaultOpen = (): void => {
    if (floating.open) {
      requestPmoTeamsTopicFloatingClose()
      return
    }
    requestPmoTeamsTopicFloatingOpen()
  }
  const handleLauncherClick = (event: MouseEvent<HTMLDivElement>): void => {
    defaultOpen()
  }
  return (
    <div
      className={className}
      data-pmo-teams-topic-launcher
      style={style}
      onClick={handleLauncherClick}
    >
      <button
        type="button"
        className={`${className}__button`}
        aria-label={openLabel}
        title={statusText ? `${openLabel} · ${statusText}` : openLabel}
        aria-describedby={statusText ? 'mote-shortcut-status' : undefined}
        aria-expanded={floating.open}
        aria-controls="pmo-teams-topic-floating-panel"
      >
        <img src={pmoTeamsTopicAvatar} alt="" aria-hidden="true" draggable={false} />
        {floating.open ? (
          <span className="pmo-teams-topic-compact-launcher__fireworks" aria-hidden="true">
            <span className="pmo-teams-topic-compact-launcher__firework pmo-teams-topic-compact-launcher__firework--left">
              {Array.from({ length: 6 }, (_, index) => <i key={index} data-particle={index} />)}
            </span>
            <span className="pmo-teams-topic-compact-launcher__firework pmo-teams-topic-compact-launcher__firework--right">
              {Array.from({ length: 6 }, (_, index) => <i key={index} data-particle={index} />)}
            </span>
          </span>
        ) : null}
        {needsAttention ? <span className={`${className}__attention`} aria-hidden="true" /> : null}
        {statusText ? <span hidden id="mote-shortcut-status">{statusText}</span> : null}
      </button>
    </div>
  )
}
