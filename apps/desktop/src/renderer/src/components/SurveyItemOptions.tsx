import * as Menu from '@radix-ui/react-dropdown-menu'
import { ArrowUpRight, Check, ChevronRight, MoreHorizontal, Pencil, PanelsTopLeft, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState, type ComponentProps, type ReactNode } from 'react'
import type { AgentMuxSpaceFact, AgentMuxZoneFact } from '@agentmux/core/control'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { SurveyTopicRelations } from './SurveyTopicRelations'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { usePathDisplay } from '../hooks/usePathDisplay'

/** The selected Item's actions read the original owners; Radix owns disclosure and focus. */
export function SurveyItemOptions({ visible, title, zone, workspace, collected, relatedTopics, activityDetails, relations, onRename, onCollectedChange, onManageBrowsers, onOpenWorkspace, onOrganize }: {
  visible: boolean
  title: string
  zone: AgentMuxZoneFact | null
  workspace: WorkspaceRecord | null
  collected: boolean
  relatedTopics: readonly AgentMuxSpaceFact[] | null
  activityDetails: ReactNode
  relations: ComponentProps<typeof SurveyTopicRelations> | null
  onRename?: () => void
  onOrganize?: (spaceId: string) => void
  onCollectedChange(collected: boolean): void
  onManageBrowsers(): void
  onOpenWorkspace(workspaceId: string): void
}) {
  const displayPath = usePathDisplay()
  const [open, setOpen] = useState(false)
  useEffect(() => { if (!visible) setOpen(false) }, [visible])
  useEffect(() => setOpen(false), [zone?.zoneId])
  const topics = relatedTopics?.filter(topic => topic.kind === 'topic')
  return <Menu.Root modal={false} open={visible && open} onOpenChange={setOpen}>
    <Menu.Trigger asChild><button type="button" className={`survey-item-options ${zone ? 'survey-tab-view' : 'survey-icon-button'}`} aria-label="Exploration options" title="Exploration options"><MoreHorizontal size={16} aria-hidden="true" />{zone ? <span>Organize</span> : null}</button></Menu.Trigger>
    <Menu.Portal container={resolveOverlayContainer()}><Menu.Content className="tab-context-menu survey-topic-menu survey-item-menu" align="start" sideOffset={4} collisionPadding={8}
      onCloseAutoFocus={event => { if (!visible) event.preventDefault() }}>
      <Menu.Label className="survey-topic-menu__label">{title}</Menu.Label>
      {zone && onRename ? <Menu.Item className="tab-context-menu__item" onSelect={onRename}><Pencil size={14} /><span>Rename exploration</span></Menu.Item> : null}
      {zone && collected ? <Menu.CheckboxItem className="tab-context-menu__item" checked={collected} disabled={!collected && zone.kind === 'unknown'}
        onSelect={event => event.preventDefault()} onCheckedChange={value => { if (value === false) onCollectedChange(false) }}>
        <span className="survey-topic-menu__indicator"><Menu.ItemIndicator><Check size={13} aria-hidden="true" /></Menu.ItemIndicator></span><span>Keep in Survey</span>
      </Menu.CheckboxItem> : null}

      {relations && onOrganize ? <Menu.Sub><Menu.SubTrigger className="tab-context-menu__item" aria-label="Organize into Topic"><ArrowUpRight size={14} /><span>Organize into Topic…</span><ChevronRight size={12} /></Menu.SubTrigger>
        <Menu.Portal container={resolveOverlayContainer()}><Menu.SubContent className="tab-context-menu survey-topic-menu" collisionPadding={8} sideOffset={4}>
          <Menu.Label className="survey-topic-menu__label">Choose a destination</Menu.Label>
          {(relations.topics ?? []).filter(topic => topic.kind === 'topic').map(topic => <Menu.Item key={topic.spaceId} className="tab-context-menu__item survey-topic-menu__item" data-survey-topic-id={topic.spaceId} aria-label={`Organize into Topic: ${topic.name}, ${topic.hostId}, ${topic.directoryPath}`} title={`${topic.hostId}\n${topic.directoryPath}`} disabled={relations.pendingSpaceId !== null} onSelect={() => onOrganize(topic.spaceId)}><span className="survey-topic-menu__context"><strong>{topic.name}</strong><small>{topic.hostId} · {topic.directoryPath}</small></span></Menu.Item>)}
          {relations.topics === null ? <p className="survey-topic-menu__notice">Topic discovery is not confirmed. Your research is kept.</p> : !relations.topics.length ? <p className="survey-topic-menu__notice">Create a Topic in Space to organize this research.</p> : null}
        </Menu.SubContent></Menu.Portal>
      </Menu.Sub> : null}
      <Menu.Separator className="tab-context-menu__separator" />
      <Menu.Item className="tab-context-menu__item" aria-label="Browser management" disabled={!workspace} onSelect={onManageBrowsers}><SlidersHorizontal size={14} /><span>Browser tools</span></Menu.Item>
      {workspace ? <Menu.Item className="tab-context-menu__item" aria-label={`Open resource Workspace: ${workspace.name}, ${workspace.hostId}, ${displayPath(workspace.path, workspace.hostId)}`}
        onSelect={() => onOpenWorkspace(workspace.id)}><ArrowUpRight size={14} /><span>Open resource in Space</span></Menu.Item> : null}
      <Menu.Sub><Menu.SubTrigger className="tab-context-menu__item" aria-label="Item details"><span className="survey-topic-menu__indicator" aria-hidden="true" /><span>Details</span><ChevronRight size={12} /></Menu.SubTrigger>
        <Menu.Portal container={resolveOverlayContainer()}><Menu.SubContent className="tab-context-menu survey-topic-menu" collisionPadding={8} sideOffset={4}>
          {relations ? <Menu.Sub><Menu.SubTrigger className="tab-context-menu__item" aria-label="Link Topics"><span>Manage Topic links</span><ChevronRight size={12} /></Menu.SubTrigger>
            <Menu.Portal container={resolveOverlayContainer()}><Menu.SubContent className="tab-context-menu survey-topic-menu survey-topic-submenu" collisionPadding={8} sideOffset={4}><SurveyTopicRelations {...relations} /></Menu.SubContent></Menu.Portal>
          </Menu.Sub> : null}
          <div className="survey-item-details-content">
            <span>{workspace ? `${workspace.name}\n${workspace.hostId}\n${displayPath(workspace.path, workspace.hostId)}${workspace.branch ? `\nBranch: ${workspace.branch}` : ''}` : 'Resource Workspace is not confirmed. The original item is retained.'}</span>
            {zone ? <><span>{topics === undefined ? 'Topic links unknown' : topics.length ? `${topics.length} linked Topic${topics.length === 1 ? '' : 's'}` : 'No Topic links'}</span>
              {topics?.map(topic => <span key={topic.spaceId}>{topic.name} · {topic.hostId} · {displayPath(topic.directoryPath, topic.hostId)}</span>)}{activityDetails}</> : null}
          </div>
        </Menu.SubContent></Menu.Portal>
      </Menu.Sub>
    </Menu.Content></Menu.Portal>
  </Menu.Root>
}
