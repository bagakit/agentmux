import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  Columns2,
  Columns3,
  Grid2x2,
  Grid3x3,
  LayoutGrid
} from 'lucide-react'
import { WORKBENCH_TAB_SPLIT_ACTIONS, workbenchRegionPresetMenu } from '../lib/workbench-tab-actions'
import type { SplitDirection } from '../lib/workbench-layout'
import type { WorkbenchRegionLayoutPreset } from '../lib/workbench-view-layout'

const SPLIT_ICONS = {
  left: ArrowLeft,
  right: ArrowRight,
  up: ArrowUp,
  down: ArrowDown
} satisfies Record<SplitDirection, typeof ArrowRight>

const PRESET_ICONS = {
  'columns-3': Columns3,
  'grid-4': Grid2x2,
  'grid-6': LayoutGrid,
  'grid-9': Grid3x3
} satisfies Record<WorkbenchRegionLayoutPreset, typeof Grid2x2>

export function PaneSplitMenu({
  disabled = false,
  regionCount,
  onOpenChange,
  onSplit,
  onArrange
}: {
  disabled?: boolean
  /** 当前 Tab 的格数。预设只增不减，所以它决定了哪几项列得出来——判定在 workbenchRegionPresetMenu。 */
  regionCount: number
  onOpenChange(open: boolean): void
  onSplit(direction: SplitDirection): void
  onArrange(preset: WorkbenchRegionLayoutPreset): void
}) {
  const presetMenu = workbenchRegionPresetMenu({ regionCount, arrange: onArrange })
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
          {presetMenu.presets.length > 0 ? (
            <DropdownMenu.Separator className="tab-context-menu__separator" />
          ) : null}
          {presetMenu.presets.map((action) => {
            const Icon = PRESET_ICONS[action.preset]
            return (
              <DropdownMenu.Item
                key={action.preset}
                className="tab-context-menu__item"
                onSelect={() => presetMenu.onSelect(action.preset)}
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
