import * as ContextMenu from '@radix-ui/react-context-menu'
import type { ReactNode } from 'react'
import { moveAlongWorkbenchActionRow, WorkbenchActionRows, type WorkbenchRowLabelPresentation } from './WorkbenchActionRows'

export type CopyLinkAction = { label: string; icon: ReactNode; onSelect(): void | Promise<void> }

/** Compact object-link shortcuts; callers retain the exact formatter and clipboard operation. */
export function WorkbenchCopyLinkRow({ actions, Item, Group = ContextMenu.Group, Label = ContextMenu.Label, labelPresentation }: {
  actions: readonly CopyLinkAction[]
  Item: typeof ContextMenu.Item
  Group?: typeof ContextMenu.Group
  Label?: typeof ContextMenu.Label
  labelPresentation?: WorkbenchRowLabelPresentation
}) {
  return <WorkbenchActionRows rows={[{ id: 'copy-link', label: 'Copy link', clusters: [actions] }]}
    Group={Group} Label={Label} labelPresentation={labelPresentation} itemKey={action => action.label} renderItem={(action, props) =>
      <Item {...props} className="tab-context-menu__item workbench-menu-row__item"
        aria-label={action.label} textValue={action.label} onSelect={() => { void action.onSelect() }}
        onKeyDown={moveAlongWorkbenchActionRow}>{action.icon}</Item>} />
}
