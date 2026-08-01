import * as ContextMenu from '@radix-ui/react-context-menu'
import { PanelLeftClose } from 'lucide-react'
import type { ReactNode } from 'react'

/** Low-frequency Project Rail actions stay in the row context menu. */
export function ProjectRailContextMenu({
  children,
  onRemove
}: {
  children: ReactNode
  onRemove(): void
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="tab-context-menu project-rail-context-menu"
          collisionPadding={8}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onRemove}>
            <PanelLeftClose size={14} />
            <span>Remove from Project Rail</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
