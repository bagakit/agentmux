import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, Columns2 } from 'lucide-react'
import { WORKBENCH_TAB_SPLIT_ACTIONS } from '../lib/workbench-tab-actions'
import type { SplitDirection } from '../lib/workbench-layout'

const SPLIT_ICONS = {
  left: ArrowLeft,
  right: ArrowRight,
  up: ArrowUp,
  down: ArrowDown
} satisfies Record<SplitDirection, typeof ArrowRight>

export function PaneSplitMenu({
  disabled = false,
  onOpenChange,
  onSplit
}: {
  disabled?: boolean
  onOpenChange(open: boolean): void
  onSplit(direction: SplitDirection): void
}) {
  return (
    <DropdownMenu.Root onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="pane-action pane-action--split"
          title="Split current tab"
          aria-label="Split current tab"
          disabled={disabled}
        >
          <Columns2 size={13} />
          <span>Split</span>
          <ChevronDown size={10} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="tab-context-menu pane-split-menu"
          align="end"
          sideOffset={4}
          collisionPadding={8}
        >
          {WORKBENCH_TAB_SPLIT_ACTIONS.map((action) => {
            const Icon = SPLIT_ICONS[action.direction]
            return (
              <DropdownMenu.Item
                key={action.direction}
                className="tab-context-menu__item"
                onSelect={() => onSplit(action.direction)}
              >
                <Icon size={14} />
                <span>{action.label}</span>
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
