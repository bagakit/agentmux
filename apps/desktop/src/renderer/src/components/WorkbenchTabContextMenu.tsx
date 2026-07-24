import * as ContextMenu from '@radix-ui/react-context-menu'
import {
  ArrowDown,
  ArrowRight,
  Columns2,
  ListX,
  PanelLeftClose,
  PanelRightClose,
  X
} from 'lucide-react'
import type { ReactNode } from 'react'

export function WorkbenchTabContextMenu({
  children,
  canCloseOthers,
  canCloseLeft,
  canCloseRight,
  canMoveToSplit,
  onClose,
  onCloseOthers,
  onCloseLeft,
  onCloseRight,
  onMoveToSplitRight,
  onMoveToSplitDown
}: {
  children: ReactNode
  canCloseOthers: boolean
  canCloseLeft: boolean
  canCloseRight: boolean
  canMoveToSplit: boolean
  onClose(): void
  onCloseOthers(): void
  onCloseLeft(): void
  onCloseRight(): void
  onMoveToSplitRight(): void
  onMoveToSplitDown(): void
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="tab-context-menu" collisionPadding={8}>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="tab-context-menu__item" disabled={!canMoveToSplit}>
              <Columns2 size={14} />
              <span>Move Tab to Split</span>
              <span className="tab-context-menu__chevron">›</span>
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="tab-context-menu" collisionPadding={8} sideOffset={4}>
                <ContextMenu.Item className="tab-context-menu__item" onSelect={onMoveToSplitRight}>
                  <ArrowRight size={14} />
                  <span>Right</span>
                </ContextMenu.Item>
                <ContextMenu.Item className="tab-context-menu__item" onSelect={onMoveToSplitDown}>
                  <ArrowDown size={14} />
                  <span>Down</span>
                </ContextMenu.Item>
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Separator className="tab-context-menu__separator" />
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onClose}>
            <X size={14} />
            <span>Close</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" disabled={!canCloseOthers} onSelect={onCloseOthers}>
            <ListX size={14} />
            <span>Close Others</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" disabled={!canCloseRight} onSelect={onCloseRight}>
            <PanelRightClose size={14} />
            <span>Close Tabs to the Right</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" disabled={!canCloseLeft} onSelect={onCloseLeft}>
            <PanelLeftClose size={14} />
            <span>Close Tabs to the Left</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
