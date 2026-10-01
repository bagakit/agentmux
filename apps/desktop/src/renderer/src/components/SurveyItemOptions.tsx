import * as Menu from '@radix-ui/react-dropdown-menu'
import { ArrowUpRight, Check, ChevronRight, MoreHorizontal, Pencil, PanelsTopLeft, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState, type ComponentProps, type ReactNode } from 'react'
import type { AgentMuxSpaceFact, AgentMuxZoneFact } from '@agentmux/core/control'
import type { WorkspaceRecord } from '../../../shared/contracts'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { SurveyPanelChoices } from './SurveyPanelChoices'
import { SurveyTopicRelations } from './SurveyTopicRelations'
import { resolveOverlayContainer } from './WindowOverlayHost'

/** The selected Item's actions read the original owners; Radix owns disclosure and focus. */
export function SurveyItemOptions({ visible, title, zone, workspace, collected, relatedTopics, activityDetails, panels, relations, tabViewControl, onRename, onCollectedChange, onManageBrowsers, onOpenWorkspace }: {
  visible: boolean
  title: string
  zone: AgentMuxZoneFact | null
  workspace: WorkspaceRecord | null
  collected: boolean
  relatedTopics: readonly AgentMuxSpaceFact[] | null
  activityDetails: ReactNode
  panels: Pick<ComponentProps<typeof SurveyPanelChoices<WorkbenchProjectionSelection>>, 'choices' | 'facts' | 'onSelect'> | null
  relations: ComponentProps<typeof SurveyTopicRelations> | null
  tabViewControl?: { active: boolean; available: boolean; onToggle(): void }
  onRename?: () => void
  onCollectedChange(collected: boolean): void
  onManageBrowsers(): void
  onOpenWorkspace(workspaceId: string): void
}) {
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
      {zone ? <Menu.CheckboxItem className="tab-context-menu__item" checked={collected} disabled={!collected && zone.kind === 'unknown'}
        onSelect={event => event.preventDefault()} onCheckedChange={value => onCollectedChange(value === true)}>
        <span className="survey-topic-menu__indicator"><Menu.ItemIndicator><Check size={13} aria-hidden="true" /></Menu.ItemIndicator></span><span>Keep in Survey</span>
      </Menu.CheckboxItem> : null}
      {zone && tabViewControl ? <Menu.Item className="tab-context-menu__item" aria-label={tabViewControl.active ? 'Show full Survey item' : 'View current Survey Tab'}
        title={tabViewControl.active ? 'Return to all original Tabs and Groups' : tabViewControl.available ? 'View this exact Tab without changing the Item layout' : 'Choose a confirmed panel to view its Tab'}
        disabled={!tabViewControl.active && !tabViewControl.available} onSelect={tabViewControl.onToggle}><PanelsTopLeft size={14} /><span>{tabViewControl.active ? 'All tabs' : 'Only this tab'}</span></Menu.Item> : null}
      {panels ? <SurveyPanelChoices {...panels} mode="submenu" visible={visible} /> : null}
      {relations ? <Menu.Sub><Menu.SubTrigger className="tab-context-menu__item" aria-label="Link Topics"><ArrowUpRight size={14} /><span>Link to Topic</span><ChevronRight size={12} /></Menu.SubTrigger>
        <Menu.Portal container={resolveOverlayContainer()}><Menu.SubContent className="tab-context-menu survey-topic-menu survey-topic-submenu" collisionPadding={8} sideOffset={4}><SurveyTopicRelations {...relations} /></Menu.SubContent></Menu.Portal>
      </Menu.Sub> : null}
      <Menu.Separator className="tab-context-menu__separator" />
      <Menu.Item className="tab-context-menu__item" aria-label="Browser management" disabled={!workspace} onSelect={onManageBrowsers}><SlidersHorizontal size={14} /><span>Browser tools</span></Menu.Item>
      {workspace ? <Menu.Item className="tab-context-menu__item" aria-label={`Open resource Workspace: ${workspace.name}, ${workspace.hostId}, ${workspace.path}`}
        onSelect={() => onOpenWorkspace(workspace.id)}><ArrowUpRight size={14} /><span>Open resource in Space</span></Menu.Item> : null}
      <Menu.Sub><Menu.SubTrigger className="tab-context-menu__item"><span className="survey-topic-menu__indicator" aria-hidden="true" /><span>Details</span><ChevronRight size={12} /></Menu.SubTrigger>
        <Menu.Portal container={resolveOverlayContainer()}><Menu.SubContent className="tab-context-menu survey-topic-menu" collisionPadding={8} sideOffset={4}>
          <div className="survey-item-details-content">
            <span>{workspace ? `${workspace.name}\n${workspace.hostId}\n${workspace.path}${workspace.branch ? `\nBranch: ${workspace.branch}` : ''}` : 'Resource Workspace is not confirmed. The original item is retained.'}</span>
            {zone ? <><span>{topics === undefined ? 'Topic links unknown' : topics.length ? `${topics.length} linked Topic${topics.length === 1 ? '' : 's'}` : 'No Topic links'}</span>
              {topics?.map(topic => <span key={topic.spaceId}>{topic.name} · {topic.hostId} · {topic.directoryPath}</span>)}{activityDetails}</> : null}
          </div>
        </Menu.SubContent></Menu.Portal>
      </Menu.Sub>
    </Menu.Content></Menu.Portal>
  </Menu.Root>
}
