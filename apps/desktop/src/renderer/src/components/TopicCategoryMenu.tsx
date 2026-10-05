import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ReactNode } from 'react'
import type { SpaceIconTarget } from '../lib/space-object-appearance'
import { useSpaceObjectActionsMenu, useSpaceObjectMenu } from './SpaceObjectContextMenu'
import { resolveOverlayContainer } from './WindowOverlayHost'

const ThemeObjectShapesIcon = semanticIconComponent('object.shapes')
const ThemeActionEditIcon = semanticIconComponent('action.edit')
const ThemeObjectLinkIcon = semanticIconComponent('object.link')
const ThemeActionMoreIcon = semanticIconComponent('action.more')


type CategoryMenuActions = {
  target: SpaceIconTarget
  onChangeIcon(target: SpaceIconTarget): void
  onRename(): void
  onCopyLink(): void
}

/** Both entries act on this Category Space, independently from its member Topics. */
function categoryMenuItems(Item: typeof ContextMenu.Item, Separator: typeof ContextMenu.Separator,
  actions: CategoryMenuActions, openDialog: (callback: () => void) => void) {
  return <>
    <Item className="tab-context-menu__item" onSelect={() => openDialog(() => actions.onChangeIcon(actions.target))}><ThemeObjectShapesIcon size={14} /><span>Change avatar…</span></Item>
    <Item className="tab-context-menu__item" onSelect={() => openDialog(actions.onRename)}><ThemeActionEditIcon size={14} /><span>Rename category…</span></Item>
    <Separator className="tab-context-menu__separator" />
    <Item className="tab-context-menu__item" onSelect={actions.onCopyLink}><ThemeObjectLinkIcon size={14} /><span>Copy Category link</span></Item>
  </>
}

export function TopicCategoryContextMenu({ children, ...actions }: CategoryMenuActions & { children: ReactNode }) {
  const menu = useSpaceObjectMenu()
  return <ContextMenu.Root onOpenChange={menu.onOpenChange}>
    <ContextMenu.Trigger asChild {...menu.triggerProps}>{children}</ContextMenu.Trigger>
    <ContextMenu.Portal container={resolveOverlayContainer()}>
      <ContextMenu.Content className="tab-context-menu" collisionPadding={8} onCloseAutoFocus={menu.onCloseAutoFocus}>
        {categoryMenuItems(ContextMenu.Item, ContextMenu.Separator, actions, menu.changeIcon)}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>
}

export function TopicCategoryActionsMenu(actions: CategoryMenuActions) {
  const menu = useSpaceObjectActionsMenu()
  return <DropdownMenu.Root onOpenChange={menu.onOpenChange}>
    <DropdownMenu.Trigger asChild><button ref={menu.trigger} type="button" className="icon-button space-row-action"
      aria-label={`Actions for category ${actions.target.name}`} title={`Actions for category ${actions.target.name}`}
      onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => { if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) event.stopPropagation() }}><ThemeActionMoreIcon size={13} /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal container={resolveOverlayContainer()}>
      <DropdownMenu.Content className="tab-context-menu" align="end" collisionPadding={8}
        onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
        onCloseAutoFocus={menu.onCloseAutoFocus}>
        {categoryMenuItems(DropdownMenu.Item, DropdownMenu.Separator, actions, menu.openDialog)}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}
