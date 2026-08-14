import * as DropdownMenu from './HoverDropdownMenu'
import { ChevronDown, Columns2 } from 'lucide-react'
import type { AgentMuxArrangeMode } from '@agentmux/core/control'
import { workbenchSplitMenuEntries } from '../lib/workbench-tab-actions'
import type { SplitDirection } from '@agentmux/layout'
import { workbenchSplitMenuIcon, workbenchSplitMenuKey } from './workbench-split-menu-icons'

/**
 * Tab 条上的 Split 下拉。内容与「一格的右键菜单」「Tab 的右键菜单」逐项相同，所以三者都只
 * map `workbenchSplitMenuEntries` 给出的那一份清单——见那个函数的注释（为什么在场与顺序必须
 * 是数据而不是 JSX 里的条件）。这层壳只负责它自己的触发按钮与 Radix 容器。
 */
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
  /**
   * 重排。形参是引擎自己那个三档 union，不是裸的 preset——这一节里既有预设（补格子）也有均分／
   * 当前格优先（只重排），两者都从这一个口子出去（#486）。
   */
  onArrange(mode: AgentMuxArrangeMode): void
}) {
  const entries = workbenchSplitMenuEntries({ regionCount, split: onSplit, arrange: onArrange })
  return (
    <DropdownMenu.Root onOpenChange={onOpenChange}>
      <div className="pane-action-group pane-action-group--split">
        <button
          type="button"
          className="pane-action pane-action--split"
          title="Split current tab to the right"
          aria-label="Split current tab to the right"
          disabled={disabled}
          onClick={() => onSplit('right')}
        >
          <Columns2 size={13} />
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
            <ChevronDown size={10} />
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
          {entries.map((entry, index) => {
            const key = workbenchSplitMenuKey(entry, index)
            if (entry.kind === 'separator') {
              return <DropdownMenu.Separator key={key} className="tab-context-menu__separator" />
            }
            const Icon = workbenchSplitMenuIcon(entry)
            return (
              <DropdownMenu.Item
                key={key}
                className="tab-context-menu__item"
                onSelect={entry.onSelect}
              >
                <Icon size={14} />
                <span>{entry.label}</span>
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
