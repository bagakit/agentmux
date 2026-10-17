import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useContext, type ReactNode } from 'react'
import { WorkbenchMenuScope } from './WorkbenchMenuScope'
import { RegionMenuEntryView, type RegionMenuEntry } from './RegionContextMenu'
import { WorkbenchMenuSubmenu } from './WorkbenchMenuSubmenu'

const CopyIcon = semanticIconComponent('action.copy')
const LayoutIcon = semanticIconComponent('layout.grid-4')
const ChatIcon = semanticIconComponent('object.conversations')

export function AgentMenuSubmenu(props: { label: string; icon: ReactNode; children: ReactNode; className?: string }) {
  const DropdownMenu = useContext(WorkbenchMenuScope)
  return <WorkbenchMenuSubmenu {...props} Sub={DropdownMenu.Sub} SubTrigger={DropdownMenu.SubTrigger}
    SubContent={DropdownMenu.SubContent} Portal={DropdownMenu.Portal} />
}

/** Reorganize existing entries by their typed scope, without owning actions or control facts. */
export function AgentRegionMenuActions({ entries, details }: { entries: readonly RegionMenuEntry[]; details: ReactNode }) {
  const DropdownMenu = useContext(WorkbenchMenuScope)
  function render(entry: RegionMenuEntry, index: number) {
    return <RegionMenuEntryView key={index} entry={entry} index={index}
      Item={DropdownMenu.Item} Separator={DropdownMenu.Separator} Group={DropdownMenu.Group} Label={DropdownMenu.Label}
      Sub={DropdownMenu.Sub} SubTrigger={DropdownMenu.SubTrigger} SubContent={DropdownMenu.SubContent} Portal={DropdownMenu.Portal} />
  }
  const workspace = entries.filter(entry => entry.kind === 'layout' || entry.kind === 'swaps' || entry.kind === 'promote' || entry.kind === 'window')
  const copies = entries.filter(entry => entry.kind === 'action')
  const connectors = entries.filter(entry => entry.kind === 'connector-group')
  const lifecycle = entries.filter(entry => entry.kind === 'restart' || entry.kind === 'stop')
  return <>
    {workspace.length > 0 ? <>
      <DropdownMenu.Separator className="tab-context-menu__separator" />
      <DropdownMenu.Group aria-label="Workspace">
        <DropdownMenu.Label className="agent-region-menu__label">Workspace</DropdownMenu.Label>
        {workspace.map((entry, index) => entry.kind === 'layout'
          ? <AgentMenuSubmenu key={index} label="Split and layout" icon={<LayoutIcon size={14} />} className="agent-region-menu__layout">{render(entry, index)}</AgentMenuSubmenu>
          : render(entry, index))}
      </DropdownMenu.Group>
    </> : null}
    <DropdownMenu.Separator className="tab-context-menu__separator" />
    {copies.length > 0 ? <AgentMenuSubmenu label="Copy link" icon={<CopyIcon size={14} />}>{copies.map(render)}</AgentMenuSubmenu> : null}
    {connectors.map((entry, index) => entry.kind === 'connector-group' ? <AgentMenuSubmenu key={index} label={entry.group.label} icon={<ChatIcon size={14} />}>
      <DropdownMenu.Group aria-label={entry.group.label} data-connector-menu-group="">
        {entry.group.entries.map(action => <DropdownMenu.Item key={action.label} className="tab-context-menu__item" onSelect={action.onSelect}>
          <ChatIcon size={14} /><span>{action.label}</span>
        </DropdownMenu.Item>)}
        {entry.group.issue ? <DropdownMenu.Label className="agent-region-menu__context" role="status">{entry.group.issue}</DropdownMenu.Label> : null}
      </DropdownMenu.Group>
    </AgentMenuSubmenu> : null)}
    {details}
    {lifecycle.length > 0 ? <><DropdownMenu.Separator className="tab-context-menu__separator" />{lifecycle.map(render)}</> : null}
  </>
}
