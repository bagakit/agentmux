import type { CSSProperties } from 'react'
import pmoTeamsTopicAvatar from '../assets/pmo-teams-topic-avatar.png'
import { PMO_TEAMS_TOPIC_TITLE, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingClose,
  requestPmoTeamsTopicFloatingPreview, leavePmoTeamsTopicFloatingPreview,
  usePmoTeamsTopicFloatingState } from '../lib/pmo-teams-topic-floating'
import { usePmoTeamsTopicTarget } from '../lib/pmo-teams-topic-target'
import { StatusDot } from './StatusDot'

export function PmoTeamsTopicEntry({ style, placement = 'compact' }: {
  placement?: 'compact' | 'floating'; style?: CSSProperties
}) {
  const [floating] = usePmoTeamsTopicFloatingState()
  useScratchTopics(SCRATCH_WORKSPACE_ID)
  const target = usePmoTeamsTopicTarget(floating)
  if (placement !== 'compact') return null
  const visible = floating.open || floating.preview
  const className = 'pmo-teams-topic-compact-launcher'
  return <div className={className} data-pmo-teams-topic-launcher style={style}>
    <button type="button" className={className + '__button'}
      popoverTarget="pmo-teams-topic-floating-panel" popoverTargetAction="toggle"
      aria-label={(floating.open ? 'Close ' : 'Open ') + PMO_TEAMS_TOPIC_TITLE}
      aria-describedby="mote-shortcut-status" aria-expanded={visible} aria-controls="pmo-teams-topic-floating-panel"
      data-mote-target-topic={target.topicId} data-mote-target-tab={target.tabId}
      data-mote-target-region={target.region?.regionId} data-mote-target-session={target.session?.id}
      data-mote-status={target.statusText} data-mote-presentation={floating.open ? 'pinned' : floating.preview ? 'preview' : 'closed'}
      onPointerEnter={event => { if (event.pointerType === 'mouse' && event.buttons === 0) requestPmoTeamsTopicFloatingPreview() }}
      onPointerLeave={event => { if (event.pointerType === 'mouse') leavePmoTeamsTopicFloatingPreview() }}
      onMouseDown={event => { if (event.button === 0) event.preventDefault() }}
      onClick={event => { event.preventDefault(); floating.open ? requestPmoTeamsTopicFloatingClose() : requestPmoTeamsTopicFloatingOpen({ targetTopicId: target.topicId, ...(target.tabId ? { targetTabId: target.tabId } : {}) }) }}
      >
      <span className={className + '__surface'} data-state="open">
        <img src={pmoTeamsTopicAvatar} alt="" aria-hidden="true" draggable={false} />
        {target.session ? <span className={className + '__status'} aria-hidden="true"><StatusDot status={target.session.status} /></span> : null}
      </span>
      <span hidden id="mote-shortcut-status">{target.label} · {target.statusText}</span>
    </button>
  </div>
}
