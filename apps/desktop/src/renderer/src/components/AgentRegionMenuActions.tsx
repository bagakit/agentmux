import { useContext, type FocusEventHandler, type ReactNode } from 'react'
import { WorkbenchMenuScope } from './WorkbenchMenuScope'
import { RegionCopyLinkRow, RegionMenuEntryView, type RegionMenuEntry } from './RegionContextMenu'
import { WorkbenchMenuSubmenu } from './WorkbenchMenuSubmenu'

export function AgentMenuSubmenu(props: { label: string; icon: ReactNode; children: ReactNode; className?: string; onFocusCapture?: FocusEventHandler<HTMLDivElement> }) {
  const DropdownMenu = useContext(WorkbenchMenuScope)
  return <WorkbenchMenuSubmenu {...props} Sub={DropdownMenu.Sub} SubTrigger={DropdownMenu.SubTrigger}
    SubContent={DropdownMenu.SubContent} Portal={DropdownMenu.Portal} />
}

/** Reorganize existing entries by their typed scope, without owning actions or control facts. */
export function AgentRegionMenuActions({ entries, controls, conversation, maintenance }: {
  entries: readonly RegionMenuEntry[]; controls: ReactNode; conversation: ReactNode; maintenance?: ReactNode
}) {
  const DropdownMenu = useContext(WorkbenchMenuScope)
  function render(entry: RegionMenuEntry, index: number) {
    return <RegionMenuEntryView key={index} entry={entry} index={index}
      Item={DropdownMenu.Item} Separator={DropdownMenu.Separator} Group={DropdownMenu.Group} Label={DropdownMenu.Label}
      Sub={DropdownMenu.Sub} SubTrigger={DropdownMenu.SubTrigger} SubContent={DropdownMenu.SubContent} Portal={DropdownMenu.Portal} />
  }
  const workspace = entries.filter(entry => entry.kind === 'layout' || entry.kind === 'swaps' || entry.kind === 'promote' || entry.kind === 'window')
  const connectors = entries.filter(entry => entry.kind === 'connector-group')
  const lifecycle = entries.filter(entry => entry.kind === 'restart' || entry.kind === 'stop')
  const hasLinks = entries.some(entry => entry.kind === 'action')
  return <>
    {hasLinks ? <>
      <RegionCopyLinkRow entries={entries} Item={DropdownMenu.Item} Group={DropdownMenu.Group} Label={DropdownMenu.Label} />
      <DropdownMenu.Separator className="tab-context-menu__separator" />
    </> : null}
    <DropdownMenu.Group aria-label="Conversation">{conversation}</DropdownMenu.Group>
    {controls || lifecycle.length > 0 ? <>
      <DropdownMenu.Separator className="tab-context-menu__separator" />
      <DropdownMenu.Group aria-label="Agent controls">
        {controls}
        {lifecycle.map(render)}
      </DropdownMenu.Group>
    </> : null}
    {workspace.length > 0 ? <>
      <DropdownMenu.Separator className="tab-context-menu__separator" />
      <DropdownMenu.Group aria-label="Workspace">
        <DropdownMenu.Label className="agent-region-menu__label">Workspace</DropdownMenu.Label>
        {workspace.map(render)}
      </DropdownMenu.Group>
    </> : null}
    {connectors.map(render)}
    {maintenance ? <>
      <DropdownMenu.Separator className="tab-context-menu__separator" />
      <DropdownMenu.Group aria-label="Maintenance">
        <DropdownMenu.Label className="agent-region-menu__label">Maintenance</DropdownMenu.Label>
        {maintenance}
      </DropdownMenu.Group>
    </> : null}
  </>
}
