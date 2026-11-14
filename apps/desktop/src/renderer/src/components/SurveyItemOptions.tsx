import * as Menu from '@radix-ui/react-dropdown-menu'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentMuxSpaceFact, AgentMuxZoneFact, AgentMuxSurveyPageReference } from '@agentmux/core/control'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { usePathDisplay } from '../hooks/usePathDisplay'
import type { SurveyItemGrouping } from '../hooks/useSurveyListOrganization'

const ThemeActionMoreIcon = semanticIconComponent('action.more')
const ThemeActionCreateNoteIcon = semanticIconComponent('action.create-note')
const ThemeObjectAgentIcon = semanticIconComponent('object.agent')
const ThemeActionEditIcon = semanticIconComponent('action.edit')
const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')
const ThemeNavigationSpaceIcon = semanticIconComponent('navigation.space')
const CollectSourcesIcon = semanticIconComponent('action.collect-sources')
const ThemeActionRemoveIcon = semanticIconComponent('action.remove')
const ThemeActionAdjustIcon = semanticIconComponent('action.adjust')
const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const PinIcon = semanticIconComponent('action.pin')
const ThemeObjectBrowserIcon = semanticIconComponent('object.browser')
const ThemeObjectLauncherIcon = semanticIconComponent('object.launcher')


/** The selected Item's actions read the original owners; Radix owns disclosure and focus. */
export type SurveyItemOptionsProps = {
  compact?: boolean
  rowAction?: boolean
  visible: boolean
  title: string
  zone: AgentMuxZoneFact | null
  page?: AgentMuxSurveyPageReference | undefined
  workspace: WorkspaceRecord | null
  collected: boolean
  relatedSpaces: readonly AgentMuxSpaceFact[] | null
  relatedSpacesUnconfirmed?: boolean
  activityDetails: ReactNode
  onRename?: () => void
  onDeleteNotebook?: (() => void) | undefined
  onSaveToTopic?: (scope: 'research' | 'panel') => void
  currentPanelAvailable?: boolean
  onCollectedChange(collected: boolean): void
  onManageBrowsers?: (() => void) | undefined
  onOpenWorkspace(workspaceId: string): void
  onNewNote?: () => void
  onNewAgent?: () => void
  onNewBrowser?: () => void
  onNewTab?: () => void
  onSelectContent?: () => void
  onMoveTab?: () => void
  onMovePage?: () => void
  onRemovePageReference?: () => void
  onClose?: () => void
  onClosePage?: (() => void) | undefined
  pinned?: boolean
  onPinChange?(pinned: boolean): void
  grouping?: SurveyItemGrouping | undefined
}

export function SurveyItemOptions(props: SurveyItemOptionsProps) {
  const { visible, zone, compact, rowAction } = props
  const [open, setOpen] = useState(false)
  const [grouping, setGrouping] = useState(props.grouping)
  useEffect(() => { if (!visible) setOpen(false) }, [visible])
  useEffect(() => setOpen(false), [zone?.zoneId])
  return <Menu.Root modal={false} open={visible && open} onOpenChange={value => { if (value) setGrouping(props.grouping); setOpen(value) }}>
    <Menu.Trigger asChild><button type="button" className={`survey-item-options ${rowAction ? '' : zone ? 'survey-tab-view' : 'survey-icon-button'}`} data-row-action={rowAction || undefined} data-compact={compact || undefined} aria-label={rowAction ? `Options for ${props.title}` : 'Exploration options'} title="Exploration options"><ThemeActionMoreIcon size={rowAction ? 14 : 16} aria-hidden="true" />{zone && !compact && !rowAction ? <span>Organize</span> : null}</button></Menu.Trigger>
    <DocumentOverlayPortal component={Menu.Portal}><Menu.Content className="tab-context-menu survey-topic-menu survey-item-menu" align="end" sideOffset={4} collisionPadding={8}
      onCloseAutoFocus={event => { if (!visible) event.preventDefault() }}>
      <SurveyItemMenuItems {...props} grouping={grouping} primitives={Menu} />
    </Menu.Content></DocumentOverlayPortal>
  </Menu.Root>
}

/** A single menu serves the directory; opening does not select a different workface. */
export function SurveyItemContextMenu({ children, returnFocus, ...props }: SurveyItemOptionsProps & { children: ReactNode; returnFocus(): HTMLElement | null }) {
  const pendingAction = useRef<(() => void) | null>(null)
  const outside = useRef(false)
  const isItemTarget = (target: EventTarget | null) => target instanceof Element &&
    !!target.closest('.survey-item-row') && !!returnFocus()?.closest('.survey-page-list')?.contains(target)
  return <ContextMenu.Root modal={false} onOpenChange={open => {
    if (open) { pendingAction.current = null; outside.current = false }
  }}>
    {children}
    {props.visible && (props.zone || props.page) ? <DocumentOverlayPortal component={ContextMenu.Portal}><ContextMenu.Content className="tab-context-menu survey-topic-menu survey-item-menu" data-survey-context-zone-id={props.zone?.zoneId} data-survey-context-page-region-id={props.page?.regionId} data-survey-context-page-browser-id={props.page?.browserId} collisionPadding={8}
      onPointerDownOutside={event => {
        // A second row's right-click updates this shared menu instead of racing its dismissal.
        if (event.detail.originalEvent.button === 2 && isItemTarget(event.target)) event.preventDefault()
      }}
      onFocusOutside={event => { if (isItemTarget(event.target)) event.preventDefault() }}
      onInteractOutside={event => { if (!event.defaultPrevented) outside.current = true }}
      onCloseAutoFocus={event => {
        event.preventDefault()
        const action = pendingAction.current; pendingAction.current = null
        const origin = returnFocus()
        if (!outside.current && origin?.isConnected) origin.focus()
        action?.()
      }}
      onPointerUpCapture={event => { if (event.button === 2) { event.preventDefault(); event.stopPropagation() } }}>
      <SurveyItemMenuItems {...props} primitives={ContextMenu} run={action => { pendingAction.current = action }} />
    </ContextMenu.Content></DocumentOverlayPortal> : null}
  </ContextMenu.Root>
}

function SurveyItemMenuItems({ primitives: M, run = action => action(), title, zone, workspace, collected, relatedSpaces, relatedSpacesUnconfirmed = false, activityDetails, onRename, onCollectedChange, onManageBrowsers, onOpenWorkspace, onSaveToTopic, currentPanelAvailable = false, onDeleteNotebook, onNewNote, onNewAgent, onNewBrowser, onNewTab, onSelectContent, onMoveTab, onMovePage, onRemovePageReference, onClose, onClosePage, pinned, onPinChange, grouping }: SurveyItemOptionsProps & { primitives: typeof Menu | typeof ContextMenu; run?: (action: () => void) => void }) {
  const displayPath = usePathDisplay()
  return <>
      <M.Label className="survey-topic-menu__label">{title}</M.Label>
      {onNewBrowser ? <M.Item className="tab-context-menu__item" onSelect={() => run(onNewBrowser)}><ThemeObjectBrowserIcon size={14} /><span>New Browser</span></M.Item> : null}
      {onNewNote ? <M.Item className="tab-context-menu__item" onSelect={() => run(onNewNote)}><ThemeActionCreateNoteIcon size={14} /><span>New Note in Recall</span></M.Item> : null}
      {onNewAgent ? <M.Item className="tab-context-menu__item" onSelect={() => run(onNewAgent)}><ThemeObjectAgentIcon size={14} /><span>New Agent</span></M.Item> : null}
      {onNewTab ? <M.Item className="tab-context-menu__item" onSelect={() => run(onNewTab)}><ThemeObjectLauncherIcon size={14} /><span>New tab…</span></M.Item> : null}
      {onNewBrowser || onNewNote || onNewAgent || onNewTab ? <M.Separator className="tab-context-menu__separator" /> : null}
      {zone && onRename ? <M.Item className="tab-context-menu__item" onSelect={() => run(onRename)}><ThemeActionEditIcon size={14} /><span>Rename exploration</span></M.Item> : null}
      {onMoveTab ? <M.Item className="tab-context-menu__item" onSelect={() => run(onMoveTab)}><ThemeNavigationSpaceIcon size={14} /><span>Move Tab to research…</span></M.Item> : null}
      {onMovePage ? <M.Item className="tab-context-menu__item" onSelect={() => run(onMovePage)}><ThemeNavigationSpaceIcon size={14} /><span>Move page to research…</span></M.Item> : null}
      {onSelectContent ? <M.Item className="tab-context-menu__item" onSelect={() => run(onSelectContent)}><ThemeNavigationSpaceIcon size={14} /><span>Select content to combine…</span></M.Item> : null}
      {onPinChange ? <M.Item className="tab-context-menu__item" onSelect={() => run(() => onPinChange(!pinned))}><PinIcon size={14} /><span>{pinned ? 'Unpin' : 'Pin'}</span></M.Item> : null}
      {onClosePage ? <M.Item className="tab-context-menu__item" onSelect={() => run(onClosePage)}><ThemeActionCloseIcon size={14} /><span>Close page</span></M.Item> : null}
      {onRemovePageReference ? <M.Item className="tab-context-menu__item" onSelect={() => run(onRemovePageReference)}><ThemeActionRemoveIcon size={14} /><span>Remove page from Survey</span></M.Item> : null}
      {zone && onClose ? <M.Item className="tab-context-menu__item" onSelect={() => run(onClose)}><ThemeActionCloseIcon size={14} /><span>Close in Survey</span></M.Item> : null}
      {grouping ? <M.Sub><M.SubTrigger className="tab-context-menu__item"><span className="survey-topic-menu__indicator" /><span>Move to group</span><ThemeNavigationDisclosureIcon size={12} /></M.SubTrigger>
        <DocumentOverlayPortal component={M.Portal}><M.SubContent className="tab-context-menu survey-item-menu" sideOffset={4} collisionPadding={8}>
          <M.Item className="tab-context-menu__item" onSelect={() => run(() => grouping.onMove(null))}><span className="survey-topic-menu__indicator">{grouping.currentGroupId === null ? <ThemeStatusSelectedIcon size={13} /> : null}</span><span>Ungrouped</span></M.Item>
          {grouping.groups.map(group => <M.Item key={group.groupId} className="tab-context-menu__item" onSelect={() => run(() => grouping.onMove(group.groupId))}><span className="survey-topic-menu__indicator">{grouping.currentGroupId === group.groupId ? <ThemeStatusSelectedIcon size={13} /> : null}</span><span>{group.name || 'Unnamed group'}</span></M.Item>)}
          <M.Separator className="tab-context-menu__separator" />
          <M.Item className="tab-context-menu__item" onSelect={() => run(grouping.onNewGroup)}><ThemeActionCreateNoteIcon size={14} /><span>New group…</span></M.Item>
        </M.SubContent></DocumentOverlayPortal>
      </M.Sub> : null}
      {zone && collected ? <M.CheckboxItem className="tab-context-menu__item" checked={collected} disabled={!collected && zone.kind === 'unknown'}
        onSelect={event => event.preventDefault()} onCheckedChange={value => { if (value === false) onCollectedChange(false) }}>
        <span className="survey-topic-menu__indicator"><M.ItemIndicator><ThemeStatusSelectedIcon size={13} aria-hidden="true" /></M.ItemIndicator></span><span>Keep in Survey</span>
      </M.CheckboxItem> : null}

      {collected && onSaveToTopic ? <>
        <M.Item className="tab-context-menu__item" onSelect={() => run(() => onSaveToTopic('research'))}><CollectSourcesIcon size={14} /><span>Save research to Topic…</span></M.Item>
        {currentPanelAvailable ? <M.Item className="tab-context-menu__item" onSelect={() => run(() => onSaveToTopic('panel'))}><CollectSourcesIcon size={14} /><span>Save current panel to Topic…</span></M.Item> : null}
      </> : null}
      {onDeleteNotebook ? <M.Item className="tab-context-menu__item" onSelect={() => run(onDeleteNotebook)}><ThemeActionRemoveIcon size={14} /><span>Delete notebook…</span></M.Item> : null}
      <M.Separator className="tab-context-menu__separator" />
      {onManageBrowsers ? <M.Item className="tab-context-menu__item" aria-label="Browser management" disabled={!workspace} onSelect={() => run(onManageBrowsers)}><ThemeActionAdjustIcon size={14} /><span>Browser tools</span></M.Item> : null}
      {workspace ? <M.Item className="tab-context-menu__item" aria-label={`Open resource Workspace: ${workspace.name}, ${workspace.hostId}, ${displayPath(workspace.path, workspace.hostId)}`}
        onSelect={() => run(() => onOpenWorkspace(workspace.id))}><ThemeNavigationSpaceIcon size={14} /><span>Open resource in Space</span></M.Item> : null}
      <M.Sub><M.SubTrigger className="tab-context-menu__item" aria-label="Item details"><span className="survey-topic-menu__indicator" aria-hidden="true" /><span>Details</span><ThemeNavigationDisclosureIcon size={12} /></M.SubTrigger>
        <DocumentOverlayPortal component={M.Portal}><M.SubContent className="tab-context-menu survey-topic-menu" collisionPadding={8} sideOffset={4}>
          <div className="survey-item-details-content">
            <span>{workspace ? `${workspace.name}\n${workspace.hostId}\n${displayPath(workspace.path, workspace.hostId)}${workspace.branch ? `\nBranch: ${workspace.branch}` : ''}` : 'Resource Workspace is not confirmed. The original item is retained.'}</span>
            {zone ? <><span>{relatedSpaces === null ? 'Linked locations unknown' : relatedSpaces.length ? `${relatedSpaces.length} linked location${relatedSpaces.length === 1 ? '' : 's'}` : 'No linked locations'}</span>
              {relatedSpaces?.map(space => <span key={space.spaceId}>{space.name} · {space.hostId} · {displayPath(space.directoryPath, space.hostId)}</span>)}
              {relatedSpacesUnconfirmed ? <span role="status">Some linked locations are not confirmed. Original bindings are retained.</span> : null}</> : null}{activityDetails}
          </div>
        </M.SubContent></DocumentOverlayPortal>
      </M.Sub>
  </>
}
