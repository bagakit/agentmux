import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { PMO_TEAMS_TOPIC_TITLE, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingClose,
  requestPmoTeamsTopicFloatingPreview, leavePmoTeamsTopicFloatingPreview,
  usePmoTeamsTopicFloatingState } from '../lib/pmo-teams-topic-floating'
import { usePmoTeamsTopicTarget } from '../lib/pmo-teams-topic-target'
import { StatusDot } from './StatusDot'
import { useAppStore } from '../store'
import { topicSpaceIconTarget, type SpaceIconTarget } from '../lib/space-object-appearance'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { SpaceIconPicker } from './SpaceIconPicker'
import { SpaceObjectContextMenu } from './SpaceObjectContextMenu'

export function PmoTeamsTopicEntry({ style, placement = 'compact' }: {
  placement?: 'compact' | 'floating'; style?: CSSProperties
}) {
  const [floating] = usePmoTeamsTopicFloatingState()
  const { topics } = useScratchTopics(SCRATCH_WORKSPACE_ID)
  const target = usePmoTeamsTopicTarget(floating)
  const workspace = useAppStore(state => state.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID))
  const identityConfirmed = Boolean(floating.targetTopicId || target.tab || typeof floating.targetTabId !== 'string')
  const topic = identityConfirmed ? topics?.find(item => item.id === target.topicId) : undefined
  const iconTarget = useMemo(() => workspace && topic ? topicSpaceIconTarget(workspace, topic) : undefined, [workspace, topic])
  const manualIcon = useAppStore(state => iconTarget ? state.spaceObjectIcons[iconTarget.key] ?? null : null)
  const [editing, setEditing] = useState<SpaceIconTarget | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  if (placement !== 'compact') return null
  const visible = floating.open || floating.preview
  const className = 'pmo-teams-topic-compact-launcher'
  const launcher = <div className={className} data-pmo-teams-topic-launcher style={style}>
    <button ref={button} type="button" className={className + '__button'}
      data-space-icon-target={iconTarget?.key}
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
        <SpaceObjectIcon kind="mote" name={target.moteName} manualIcon={manualIcon}
          avatarObjectKey={iconTarget?.key} avatarWorkspaceId={iconTarget?.avatarTarget?.workspaceId} avatarTopicId={iconTarget?.avatarTarget?.topicId ?? (identityConfirmed ? target.topicId : undefined)} />
        {target.session ? <span className={className + '__status'} aria-hidden="true"><StatusDot status={target.session.status} /></span> : null}
      </span>
      <span hidden id="mote-shortcut-status">{target.label} · {target.statusText}</span>
    </button>
  </div>
  const closeForEditor = () => {
    requestPmoTeamsTopicFloatingClose()
    // The original auto-popover must leave the top layer before its window Dialog opens.
    const panel = document.getElementById('pmo-teams-topic-floating-panel')
    if (panel?.matches(':popover-open')) panel.hidePopover()
  }
  return <>
    {iconTarget ? <SpaceObjectContextMenu target={iconTarget} onMenuOpen={closeForEditor} onChangeIcon={setEditing}>{launcher}</SpaceObjectContextMenu> : launcher}
    <SpaceIconPicker target={editing} onClose={() => setEditing(null)} returnFocus={() => button.current} />
  </>
}
