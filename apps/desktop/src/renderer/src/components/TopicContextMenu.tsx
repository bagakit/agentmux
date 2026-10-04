import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowRightLeft, Copy, Crosshair, Link, MoreHorizontal, NotebookText, Pencil, Pin, PinOff, RotateCcw, Shapes, ToggleLeft, ToggleRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { useSpaceObjectActionsMenu, useSpaceObjectMenu } from './SpaceObjectContextMenu'

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
    {actions.onMove ? <Item className="tab-context-menu__item" onSelect={() => openDialog(actions.onMove!)}><ArrowRightLeft size={14} /><span>Move to category…</span></Item> : null}
    {actions.onChangeIcon ? <Item className="tab-context-menu__item" onSelect={() => openDialog(actions.onChangeIcon!)}><Shapes size={14} /><span>Change avatar…</span></Item> : null}
    <Item className="tab-context-menu__item" onSelect={actions.onTogglePin}>
      {actions.pinned ? <PinOff size={14} /> : <Pin size={14} />}<span>{actions.pinned ? 'Unpin Topic' : 'Pin Topic'}</span>
    </Item>
    <Separator className="tab-context-menu__separator" />
    <Item className="tab-context-menu__item" onSelect={() => openDialog(actions.onRename)}><Pencil size={14} /><span>Rename Topic</span></Item>
    <Separator className="tab-context-menu__separator" />
    <Item className="tab-context-menu__item" onSelect={actions.onCopyLink}><Link size={14} /><span>Copy Topic link</span></Item>
    <Item className="tab-context-menu__item" onSelect={actions.onReveal}><Crosshair size={14} /><span>Reveal in Files</span></Item>
    <Item className="tab-context-menu__item" onSelect={actions.onCopyPath}><Copy size={14} /><span>Copy Topic Path</span></Item>
    <Separator className="tab-context-menu__separator" />
    <Item className="tab-context-menu__item" onSelect={() => openDialog(actions.onEditWiki)}><NotebookText size={14} /><span>Edit Topic Wiki</span></Item>
    {actions.onToggleWiki ? <Item className="tab-context-menu__item" onSelect={actions.onToggleWiki}>
      {actions.wikiEnabled ? <ToggleLeft size={14} /> : <ToggleRight size={14} />}<span>{actions.wikiEnabled ? 'Disable Topic Wiki' : 'Enable Topic Wiki'}</span>
    </Item> : null}
    {actions.onResetWiki ? <Item className="tab-context-menu__item" onSelect={actions.onResetWiki}><RotateCcw size={14} /><span>Restore default Topic Wiki</span></Item> : null}
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
      onKeyDown={event => { if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) event.stopPropagation() }}><MoreHorizontal size={15} /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
      <DropdownMenu.Content className="tab-context-menu topic-context-menu" align="end" collisionPadding={8}
        onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onCloseAutoFocus={menu.onCloseAutoFocus}>
        {topicMenuItems(DropdownMenu.Item, DropdownMenu.Separator, actions, menu.openDialog)}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}
