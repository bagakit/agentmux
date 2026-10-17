import * as ContextMenu from '@radix-ui/react-context-menu'
import type { WorkbenchSplitMenuEntry } from '../lib/workbench-tab-actions'
import { workbenchSplitMenuIcon, workbenchSplitMenuKey } from './workbench-split-menu-icons'
import { moveAlongWorkbenchActionRow, WorkbenchActionRows } from './WorkbenchActionRows'

type Action = Exclude<WorkbenchSplitMenuEntry, { kind: 'separator' }>

/** Shared presentation of the existing commands, not another layout or selection owner. */
export function WorkbenchLayoutMenuRows({ entries, Item, Group = ContextMenu.Group, Label = ContextMenu.Label, splitLabel = 'New region' }: {
  entries: readonly WorkbenchSplitMenuEntry[]
  Item: typeof ContextMenu.Item
  Group?: typeof ContextMenu.Group
  Label?: typeof ContextMenu.Label
  splitLabel?: string
}) {
  const splits = entries.filter((entry): entry is Extract<Action, { kind: 'split' }> => entry.kind === 'split')
  const layout = entries.filter((entry): entry is Exclude<Action, { kind: 'split' }> => entry.kind === 'preset' || entry.kind === 'rearrange')
  if (splits.length === 0 && layout.length === 0) return null
  return <WorkbenchActionRows<Action> Group={Group} Label={Label} rows={[
    { id: 'split', label: splitLabel, clusters: [splits] },
    { id: 'layout', label: 'Layout', clusters: [layout.filter(entry => entry.kind === 'preset'), layout.filter(entry => entry.kind === 'rearrange')] }
  ]} itemKey={workbenchSplitMenuKey} renderItem={(entry, props, divider) => {
    const Icon = workbenchSplitMenuIcon(entry)
    return <Item {...props} className="tab-context-menu__item workbench-menu-row__item"
      aria-label={entry.label} textValue={entry.label} onSelect={entry.onSelect} onKeyDown={moveAlongWorkbenchActionRow}>
      {divider}<Icon size={16} aria-hidden="true" />
    </Item>
  }} />
}
