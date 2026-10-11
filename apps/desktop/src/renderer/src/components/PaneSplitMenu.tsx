import * as DropdownMenu from './HoverDropdownMenu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentMuxArrangeMode } from '@agentmux/core/control'
import { workbenchSplitMenuEntries } from '../lib/workbench-tab-actions'
import type { SplitDirection } from '@agentmux/layout'
import { WorkbenchLayoutMenuRows } from './WorkbenchLayoutMenuRows'

const ThemeLayoutColumns2Icon = semanticIconComponent('layout.columns-2')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')


/** The original default split and compact menu consume the shared action model. */
export function PaneSplitMenu({
  disabled = false,
  regionCount,
  onSplit,
  onArrange
}: {
  disabled?: boolean
  /** 当前 Tab 的格数。预设只增不减，所以它决定了哪几项列得出来——判定在 workbenchRegionPresetMenu。 */
  regionCount: number
  onSplit(direction: SplitDirection): void
  /**
   * 重排。形参是引擎自己那个三档 union，不是裸的 preset——这一节里既有预设（补格子）也有均分／
   * 当前格优先（只重排），两者都从这一个口子出去（#486）。
   */
  onArrange(mode: AgentMuxArrangeMode): void
}) {
  const entries = workbenchSplitMenuEntries({ regionCount, split: onSplit, arrange: onArrange })
  return (
    <DropdownMenu.Root>
      <div className="pane-action-group pane-action-group--split">
        <button
          type="button"
          className="pane-action pane-action--split"
          title="Split current tab to the right"
          aria-label="Split current tab to the right"
          disabled={disabled}
          onClick={() => onSplit('right')}
        >
          <ThemeLayoutColumns2Icon size={13} />
          <span>Split</span>
        </button>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="pane-action pane-action--split pane-action--split-menu"
            title="Choose split direction"
            aria-label="Choose split direction"
            disabled={disabled}
          >
            <ThemeNavigationDownIcon size={10} />
          </button>
        </DropdownMenu.Trigger>
      </div>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="tab-context-menu pane-split-menu"
          align="end"
          sideOffset={4}
          collisionPadding={8}
        >
          <WorkbenchLayoutMenuRows entries={entries} Item={DropdownMenu.Item} Group={DropdownMenu.Group} Label={DropdownMenu.Label} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
