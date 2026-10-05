import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ReactNode } from 'react'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { useSpaceObjectActionsMenu, useSpaceObjectMenu } from './SpaceObjectContextMenu'

const ThemeActionExchangeIcon = semanticIconComponent('action.exchange')
const ThemeObjectShapesIcon = semanticIconComponent('object.shapes')
const ThemeActionUnpinIcon = semanticIconComponent('action.unpin')
const ThemeActionPinIcon = semanticIconComponent('action.pin')
const ThemeActionEditIcon = semanticIconComponent('action.edit')
const ThemeObjectLinkIcon = semanticIconComponent('object.link')
const ThemeActionFocusIcon = semanticIconComponent('action.focus')
const ThemeActionCopyIcon = semanticIconComponent('action.copy')
const ThemeObjectNotebookIcon = semanticIconComponent('object.notebook')
const ThemeStatusDisabledIcon = semanticIconComponent('status.disabled')
const ThemeStatusEnabledIcon = semanticIconComponent('status.enabled')
const ThemeActionRotateResetIcon = semanticIconComponent('action.rotate-reset')
const ThemeActionMoreIcon = semanticIconComponent('action.more')


type TopicMenuActions = {
  pinned: boolean
  onCopyPath(): void
  onCopyLink(): void
  onRename(): void
  onReveal(): void
  onTogglePin(): void
  onEditWiki(): void
  onMove?: (() => void) | undefined
  onToggleWiki?: (() => void) | undefined
  onResetWiki?: (() => void) | undefined
  onChangeIcon?: (() => void) | undefined
  wikiEnabled?: boolean | undefined
}

/** The visible action menu and right-click menu offer the same original Topic actions. */
function topicMenuItems(Item: typeof ContextMenu.Item, Separator: typeof ContextMenu.Separator, actions: TopicMenuActions, openDialog: (callback: () => void) => void) {
  return <>
    {actions.onMove ? <Item className="tab-context-menu__item" onSelect={() => openDialog(actions.onMove!)}><ThemeActionExchangeIcon size={14} /><span>Move to category…</span></Item> : null}
    {actions.onChangeIcon ? <Item className="tab-context-menu__item" onSelect={() => openDialog(actions.onChangeIcon!)}><ThemeObjectShapesIcon size={14} /><span>Change avatar…</span></Item> : null}
    <Item className="tab-context-menu__item" onSelect={actions.onTogglePin}>
      {actions.pinned ? <ThemeActionUnpinIcon size={14} /> : <ThemeActionPinIcon size={14} />}<span>{actions.pinned ? 'Unpin Topic' : 'Pin Topic'}</span>
    </Item>
    <Separator className="tab-context-menu__separator" />
    <Item className="tab-context-menu__item" onSelect={() => openDialog(actions.onRename)}><ThemeActionEditIcon size={14} /><span>Rename Topic</span></Item>
    <Separator className="tab-context-menu__separator" />
    <Item className="tab-context-menu__item" onSelect={actions.onCopyLink}><ThemeObjectLinkIcon size={14} /><span>Copy Topic link</span></Item>
    <Item className="tab-context-menu__item" onSelect={actions.onReveal}><ThemeActionFocusIcon size={14} /><span>Reveal in Files</span></Item>
    <Item className="tab-context-menu__item" onSelect={actions.onCopyPath}><ThemeActionCopyIcon size={14} /><span>Copy Topic Path</span></Item>
    <Separator className="tab-context-menu__separator" />
    <Item className="tab-context-menu__item" onSelect={() => openDialog(actions.onEditWiki)}><ThemeObjectNotebookIcon size={14} /><span>Edit Topic Wiki</span></Item>
    {actions.onToggleWiki ? <Item className="tab-context-menu__item" onSelect={actions.onToggleWiki}>
      {actions.wikiEnabled ? <ThemeStatusDisabledIcon size={14} /> : <ThemeStatusEnabledIcon size={14} />}<span>{actions.wikiEnabled ? 'Disable Topic Wiki' : 'Enable Topic Wiki'}</span>
    </Item> : null}
    {actions.onResetWiki ? <Item className="tab-context-menu__item" onSelect={actions.onResetWiki}><ThemeActionRotateResetIcon size={14} /><span>Restore default Topic Wiki</span></Item> : null}
  </>
}

/** Shift+F10 and the menu key use the existing object-menu keyboard and focus owner. */
export function TopicContextMenu({ children, ...actions }: TopicMenuActions & { children: ReactNode }) {
  const menu = useSpaceObjectMenu()
  return <ContextMenu.Root onOpenChange={menu.onOpenChange}>
    <ContextMenu.Trigger asChild {...menu.triggerProps}>{children}</ContextMenu.Trigger>
    <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
      <ContextMenu.Content className="tab-context-menu topic-context-menu" collisionPadding={8} onCloseAutoFocus={menu.onCloseAutoFocus}>
        {topicMenuItems(ContextMenu.Item, ContextMenu.Separator, actions, menu.changeIcon)}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>
}

/** Dialog actions wait until Radix releases the menu focus scope and restore its invoker. */
export function TopicActionsMenu({ title, ...actions }: TopicMenuActions & { title: string }) {
  const menu = useSpaceObjectActionsMenu()
  return <DropdownMenu.Root onOpenChange={menu.onOpenChange}>
    <DropdownMenu.Trigger asChild><button ref={menu.trigger} type="button" className="icon-button workspace-topic-entry__actions" aria-label={`Actions for ${title}`} title={`Actions for ${title}`}
      onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => { if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) event.stopPropagation() }}><ThemeActionMoreIcon size={15} /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
      <DropdownMenu.Content className="tab-context-menu topic-context-menu" align="end" collisionPadding={8}
        onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onCloseAutoFocus={menu.onCloseAutoFocus}>
        {topicMenuItems(DropdownMenu.Item, DropdownMenu.Separator, actions, menu.openDialog)}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}
