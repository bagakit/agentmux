import type { CSSProperties } from 'react'
import pmoTeamsTopicAvatar from '../assets/pmo-teams-topic-avatar.png'
import { PMO_TEAMS_TOPIC_TITLE } from '../../../shared/scratch-topics'
import {
  requestPmoTeamsTopicFloatingOpen,
  requestPmoTeamsTopicFloatingClose,
  usePmoTeamsTopicFloatingState
} from '../lib/pmo-teams-topic-floating'
import { usePmoTeamsTopicTarget } from '../lib/pmo-teams-topic-target'
import { StatusDot } from './StatusDot'

export function PmoTeamsTopicEntry({
  style,
  placement = 'compact'
}: {
  placement?: 'compact' | 'floating'
  style?: CSSProperties
}) {
  const [floating] = usePmoTeamsTopicFloatingState()
  const target = usePmoTeamsTopicTarget(floating)
  if (placement !== 'compact') return null

  const className = 'pmo-teams-topic-compact-launcher'
  const openLabel = floating.open ? `Close ${PMO_TEAMS_TOPIC_TITLE}` : `Open ${PMO_TEAMS_TOPIC_TITLE}`
  const defaultOpen = (): void => {
    if (floating.open) {
      requestPmoTeamsTopicFloatingClose()
      return
    }
    requestPmoTeamsTopicFloatingOpen(target.tabId ? { targetTabId: target.tabId } : undefined)
  }
  return (
    <div
      className={className}
      data-pmo-teams-topic-launcher
      style={style}
    >
      <button
        type="button"
        className={`${className}__button`}
        aria-label={openLabel}
        title={`${floating.open ? 'Close' : 'Open'} ${target.label} · ${target.statusText}`}
        aria-describedby="mote-shortcut-status"
        aria-expanded={floating.open}
        aria-controls="pmo-teams-topic-floating-panel"
        data-mote-target-tab={target.tabId}
        data-mote-target-region={target.region?.regionId}
        data-mote-target-session={target.session?.id}
        data-mote-status={target.statusText}
        onMouseDown={(event) => { if (event.button === 0) event.preventDefault() }}
        onClick={defaultOpen}
      >
        <img src={pmoTeamsTopicAvatar} alt="" aria-hidden="true" draggable={false} />
        {target.session ? <span className={`${className}__status`} aria-hidden="true"><StatusDot status={target.session.status} /></span> : null}
        <span hidden id="mote-shortcut-status">{target.name} · {target.statusText}</span>
      </button>
    </div>
  )
}

/** The footer tooltip describes the exact context its neighbouring shortcut opens. */
export function PmoTeamsTopicShortcutPreview() {
  const [floating] = usePmoTeamsTopicFloatingState()
  const target = usePmoTeamsTopicTarget(floating)
  return <div className="mote-shortcut-preview" data-mote-target-tab={target.tabId}>
    <strong>{PMO_TEAMS_TOPIC_TITLE}</strong>
    {target.name !== PMO_TEAMS_TOPIC_TITLE ? <span>{target.name}</span> : null}
    <small>{target.statusText} · {floating.open ? 'Click to close this context' : 'Open this coordination context'}</small>
  </div>
}
