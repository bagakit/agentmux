import * as ContextMenu from '@radix-ui/react-context-menu'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Columns2,
  Copy,
  ListX,
  PanelLeftClose,
  PanelRightClose,
  X
} from 'lucide-react'
import type { ReactNode } from 'react'
import { WORKBENCH_TAB_SPLIT_ACTIONS } from '../lib/workbench-tab-actions'
import type { SplitDirection } from '../lib/workbench-layout'

const SPLIT_ICONS = {
  left: ArrowLeft,
  right: ArrowRight,
  up: ArrowUp,
  down: ArrowDown
} satisfies Record<SplitDirection, typeof ArrowRight>

export function WorkbenchTabContextMenu({
  children,
  canCloseOthers,
  canCloseLeft,
  canCloseRight,
  canMoveToNewGroup,
  onOpenChange,
  onCopySessionId,
  onClose,
  onCloseOthers,
  onCloseLeft,
  onCloseRight,
  onMoveToNewGroup
}: {
  children: ReactNode
  canCloseOthers: boolean
  canCloseLeft: boolean
  canCloseRight: boolean
  canMoveToNewGroup: boolean
  onOpenChange?: (open: boolean) => void
  onCopySessionId?: () => void
  onClose(): void
  onCloseOthers(): void
  onCloseLeft(): void
  onCloseRight(): void
  onMoveToNewGroup(direction: SplitDirection): void
}) {
  return (
    <ContextMenu.Root {...(onOpenChange ? { onOpenChange } : {})}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="tab-context-menu" collisionPadding={8}>
          {onCopySessionId ? (
            <>
              <ContextMenu.Item className="tab-context-menu__item" onSelect={onCopySessionId}>
                <Copy size={14} />
                <span>Copy Session ID</span>
              </ContextMenu.Item>
              <ContextMenu.Separator className="tab-context-menu__separator" />
            </>
          ) : null}
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="tab-context-menu__item" disabled={!canMoveToNewGroup}>
              <Columns2 size={14} />
              <span>Move Tab to New Group</span>
              <span className="tab-context-menu__chevron">›</span>
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="tab-context-menu" collisionPadding={8} sideOffset={4}>
                {WORKBENCH_TAB_SPLIT_ACTIONS.map((action) => {
                  const Icon = SPLIT_ICONS[action.direction]
                  return (
                    <ContextMenu.Item
                      key={action.direction}
                      className="tab-context-menu__item"
                      onSelect={() => onMoveToNewGroup(action.direction)}
                    >
                      <Icon size={14} />
                      <span>New Group {action.direction[0]!.toUpperCase() + action.direction.slice(1)}</span>
                    </ContextMenu.Item>
                  )
                })}
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
