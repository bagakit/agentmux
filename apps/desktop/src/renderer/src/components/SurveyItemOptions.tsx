import * as Menu from '@radix-ui/react-dropdown-menu'
import { ArrowUpRight, Check, ChevronRight, MoreHorizontal, Pencil, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { AgentMuxSpaceFact, AgentMuxZoneFact } from '@agentmux/core/control'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { usePathDisplay } from '../hooks/usePathDisplay'

/** The selected Item's actions read the original owners; Radix owns disclosure and focus. */
export function SurveyItemOptions({ visible, title, zone, workspace, collected, relatedSpaces, relatedSpacesUnconfirmed = false, activityDetails, onRename, onCollectedChange, onManageBrowsers, onOpenWorkspace, onSaveToTopic, currentPanelAvailable = false }: {
  visible: boolean
  title: string
  zone: AgentMuxZoneFact | null
  workspace: WorkspaceRecord | null
  collected: boolean
  relatedSpaces: readonly AgentMuxSpaceFact[] | null
  relatedSpacesUnconfirmed?: boolean
  activityDetails: ReactNode
  onRename?: () => void
  onSaveToTopic?: (scope: 'research' | 'panel') => void
  currentPanelAvailable?: boolean
  onCollectedChange(collected: boolean): void
  onManageBrowsers(): void
  onOpenWorkspace(workspaceId: string): void
}) {
  const displayPath = usePathDisplay()
  const [open, setOpen] = useState(false)
  useEffect(() => { if (!visible) setOpen(false) }, [visible])
  useEffect(() => setOpen(false), [zone?.zoneId])
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

      {collected && onSaveToTopic ? <>
        <Menu.Item className="tab-context-menu__item" onSelect={() => onSaveToTopic('research')}><ArrowUpRight size={14} /><span>Save research to Topic…</span></Menu.Item>
        {currentPanelAvailable ? <Menu.Item className="tab-context-menu__item" onSelect={() => onSaveToTopic('panel')}><ArrowUpRight size={14} /><span>Save current panel to Topic…</span></Menu.Item> : null}
      </> : null}
      <Menu.Separator className="tab-context-menu__separator" />
      <Menu.Item className="tab-context-menu__item" aria-label="Browser management" disabled={!workspace} onSelect={onManageBrowsers}><SlidersHorizontal size={14} /><span>Browser tools</span></Menu.Item>
      {workspace ? <Menu.Item className="tab-context-menu__item" aria-label={`Open resource Workspace: ${workspace.name}, ${workspace.hostId}, ${displayPath(workspace.path, workspace.hostId)}`}
        onSelect={() => onOpenWorkspace(workspace.id)}><ArrowUpRight size={14} /><span>Open resource in Space</span></Menu.Item> : null}
      <Menu.Sub><Menu.SubTrigger className="tab-context-menu__item" aria-label="Item details"><span className="survey-topic-menu__indicator" aria-hidden="true" /><span>Details</span><ChevronRight size={12} /></Menu.SubTrigger>
        <Menu.Portal container={resolveOverlayContainer()}><Menu.SubContent className="tab-context-menu survey-topic-menu" collisionPadding={8} sideOffset={4}>
          <div className="survey-item-details-content">
            <span>{workspace ? `${workspace.name}\n${workspace.hostId}\n${displayPath(workspace.path, workspace.hostId)}${workspace.branch ? `\nBranch: ${workspace.branch}` : ''}` : 'Resource Workspace is not confirmed. The original item is retained.'}</span>
            {zone ? <><span>{relatedSpaces === null ? 'Linked locations unknown' : relatedSpaces.length ? `${relatedSpaces.length} linked location${relatedSpaces.length === 1 ? '' : 's'}` : 'No linked locations'}</span>
              {relatedSpaces?.map(space => <span key={space.spaceId}>{space.name} · {space.hostId} · {displayPath(space.directoryPath, space.hostId)}</span>)}
              {relatedSpacesUnconfirmed ? <span role="status">Some linked locations are not confirmed. Original bindings are retained.</span> : null}{activityDetails}</> : null}
          </div>
        </Menu.SubContent></Menu.Portal>
      </Menu.Sub>
    </Menu.Content></Menu.Portal>
  </Menu.Root>
}
