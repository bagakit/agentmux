import * as Menu from '@radix-ui/react-dropdown-menu'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { ArrowUpRight, Check, ChevronRight, MoreHorizontal, Bot, NotebookPen, Pencil, SlidersHorizontal, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentMuxSpaceFact, AgentMuxZoneFact } from '@agentmux/core/control'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { usePathDisplay } from '../hooks/usePathDisplay'

/** The selected Item's actions read the original owners; Radix owns disclosure and focus. */
export type SurveyItemOptionsProps = {
  compact?: boolean
  visible: boolean
  title: string
  zone: AgentMuxZoneFact | null
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
}

export function SurveyItemOptions(props: SurveyItemOptionsProps) {
  const { visible, zone, compact } = props
  const [open, setOpen] = useState(false)
  useEffect(() => { if (!visible) setOpen(false) }, [visible])
  useEffect(() => setOpen(false), [zone?.zoneId])
  return <Menu.Root modal={false} open={visible && open} onOpenChange={setOpen}>
    <Menu.Trigger asChild><button type="button" className={`survey-item-options ${zone ? 'survey-tab-view' : 'survey-icon-button'}`} data-compact={compact || undefined} aria-label="Exploration options" title="Exploration options"><MoreHorizontal size={16} aria-hidden="true" />{zone && !compact ? <span>Organize</span> : null}</button></Menu.Trigger>
    <Menu.Portal container={resolveOverlayContainer()}><Menu.Content className="tab-context-menu survey-topic-menu survey-item-menu" align="start" sideOffset={4} collisionPadding={8}
      onCloseAutoFocus={event => { if (!visible) event.preventDefault() }}>
      <SurveyItemMenuItems {...props} primitives={Menu} />
    </Menu.Content></Menu.Portal>
  </Menu.Root>
}

/** A single menu serves the directory; opening does not select a different workface. */
export function SurveyItemContextMenu({ children, returnFocus, ...props }: SurveyItemOptionsProps & { children: ReactNode; returnFocus(): HTMLElement | null }) {
  const pendingAction = useRef<(() => void) | null>(null)
  const outside = useRef(false)
  const isItemTarget = (target: EventTarget | null) => target instanceof Element &&
    !!target.closest('.survey-item') && !!returnFocus()?.closest('.survey-page-list')?.contains(target)
  return <ContextMenu.Root modal={false} onOpenChange={open => {
    if (open) { pendingAction.current = null; outside.current = false }
  }}>
    {children}
    {props.visible && props.zone ? <ContextMenu.Portal container={resolveOverlayContainer()}><ContextMenu.Content className="tab-context-menu survey-topic-menu survey-item-menu" data-survey-context-zone-id={props.zone.zoneId} collisionPadding={8}
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
    </ContextMenu.Content></ContextMenu.Portal> : null}
  </ContextMenu.Root>
}

function SurveyItemMenuItems({ primitives: M, run = action => action(), title, zone, workspace, collected, relatedSpaces, relatedSpacesUnconfirmed = false, activityDetails, onRename, onCollectedChange, onManageBrowsers, onOpenWorkspace, onSaveToTopic, currentPanelAvailable = false, onDeleteNotebook, onNewNote, onNewAgent }: SurveyItemOptionsProps & { primitives: typeof Menu | typeof ContextMenu; run?: (action: () => void) => void }) {
  const displayPath = usePathDisplay()
  return <>
      <M.Label className="survey-topic-menu__label">{title}</M.Label>
      {onNewNote ? <M.Item className="tab-context-menu__item" onSelect={() => run(onNewNote)}><NotebookPen size={14} /><span>New Note</span></M.Item> : null}
      {onNewAgent ? <M.Item className="tab-context-menu__item" onSelect={() => run(onNewAgent)}><Bot size={14} /><span>New Agent</span></M.Item> : null}
      {onNewNote || onNewAgent ? <M.Separator className="tab-context-menu__separator" /> : null}
      {zone && onRename ? <M.Item className="tab-context-menu__item" onSelect={() => run(onRename)}><Pencil size={14} /><span>Rename exploration</span></M.Item> : null}
      {zone && collected ? <M.CheckboxItem className="tab-context-menu__item" checked={collected} disabled={!collected && zone.kind === 'unknown'}
        onSelect={event => event.preventDefault()} onCheckedChange={value => { if (value === false) onCollectedChange(false) }}>
        <span className="survey-topic-menu__indicator"><M.ItemIndicator><Check size={13} aria-hidden="true" /></M.ItemIndicator></span><span>Keep in Survey</span>
      </M.CheckboxItem> : null}

      {collected && onSaveToTopic ? <>
        <M.Item className="tab-context-menu__item" onSelect={() => run(() => onSaveToTopic('research'))}><ArrowUpRight size={14} /><span>Save research to Topic…</span></M.Item>
        {currentPanelAvailable ? <M.Item className="tab-context-menu__item" onSelect={() => run(() => onSaveToTopic('panel'))}><ArrowUpRight size={14} /><span>Save current panel to Topic…</span></M.Item> : null}
      </> : null}
      {onDeleteNotebook ? <M.Item className="tab-context-menu__item" onSelect={() => run(onDeleteNotebook)}><Trash2 size={14} /><span>Delete notebook…</span></M.Item> : null}
      <M.Separator className="tab-context-menu__separator" />
      {onManageBrowsers ? <M.Item className="tab-context-menu__item" aria-label="Browser management" disabled={!workspace} onSelect={() => run(onManageBrowsers)}><SlidersHorizontal size={14} /><span>Browser tools</span></M.Item> : null}
      {workspace ? <M.Item className="tab-context-menu__item" aria-label={`Open resource Workspace: ${workspace.name}, ${workspace.hostId}, ${displayPath(workspace.path, workspace.hostId)}`}
        onSelect={() => run(() => onOpenWorkspace(workspace.id))}><ArrowUpRight size={14} /><span>Open resource in Space</span></M.Item> : null}
      <M.Sub><M.SubTrigger className="tab-context-menu__item" aria-label="Item details"><span className="survey-topic-menu__indicator" aria-hidden="true" /><span>Details</span><ChevronRight size={12} /></M.SubTrigger>
        <M.Portal container={resolveOverlayContainer()}><M.SubContent className="tab-context-menu survey-topic-menu" collisionPadding={8} sideOffset={4}>
          <div className="survey-item-details-content">
            <span>{workspace ? `${workspace.name}\n${workspace.hostId}\n${displayPath(workspace.path, workspace.hostId)}${workspace.branch ? `\nBranch: ${workspace.branch}` : ''}` : 'Resource Workspace is not confirmed. The original item is retained.'}</span>
            {zone ? <><span>{relatedSpaces === null ? 'Linked locations unknown' : relatedSpaces.length ? `${relatedSpaces.length} linked location${relatedSpaces.length === 1 ? '' : 's'}` : 'No linked locations'}</span>
              {relatedSpaces?.map(space => <span key={space.spaceId}>{space.name} · {space.hostId} · {displayPath(space.directoryPath, space.hostId)}</span>)}
              {relatedSpacesUnconfirmed ? <span role="status">Some linked locations are not confirmed. Original bindings are retained.</span> : null}{activityDetails}</> : null}
          </div>
        </M.SubContent></M.Portal>
      </M.Sub>
  </>
}
