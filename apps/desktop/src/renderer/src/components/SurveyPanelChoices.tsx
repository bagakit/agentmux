import { groupIds, regionIds } from '@agentmux/layout'
import { Bot, ChevronDown, FileText, Globe2, PanelsTopLeft, Plus, Terminal } from 'lucide-react'
import { useState } from 'react'
import { regionDisplayNames, regionSurfaceLabel } from '../lib/region-display-name'
import { useWorkbenchTabSessions } from '../lib/workbench-session-subscriptions'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import type { WorkbenchSurface } from '../lib/workbench-tabs'
import type { useAppStore } from '../store'
import * as DropdownMenu from './HoverDropdownMenu'

type State = ReturnType<typeof useAppStore.getState>
type Facts = Pick<State, 'config' | 'layouts' | 'tabs'>

function contentKind(surface: WorkbenchSurface | undefined) {
  if (!surface) return { name: 'Panel unconfirmed', Icon: PanelsTopLeft }
  switch (surface.kind) {
    case 'browser': return { name: 'Browser', Icon: Globe2 }
    case 'agent': return { name: 'Agent', Icon: Bot }
    case 'terminal': return { name: 'Terminal', Icon: Terminal }
    case 'file': return { name: surface.path.endsWith('.note.json') ? 'Note' : 'File', Icon: FileText }
    case 'git-diff': return { name: 'Diff', Icon: FileText }
    case 'launcher': return { name: 'New Tab', Icon: Plus }
  }
}

function PanelChoice<T extends WorkbenchProjectionSelection>({ reference, facts, ordinal, onSelect }: {
  reference: T; facts: Facts; ordinal: number; onSelect(reference: T): void
}) {
  const tab = facts.tabs[reference.tabId]
  const sessions = useWorkbenchTabSessions(tab)
  const surface = tab?.regions[reference.regionId]
  const kind = contentKind(surface)
  const layout = facts.layouts[reference.displayWorkspaceId]
  const groupOrder = layout ? groupIds(layout.root) : []
  const groupIndex = groupOrder.indexOf(reference.groupId)
  const group = layout?.groups.find(group => group.id === reference.groupId)
  const tabIndex = group?.tabOrder.indexOf(reference.tabId) ?? -1
  const regionOrder = tab ? regionIds(tab.layout.root) : []
  const regionIndex = regionOrder.indexOf(reference.regionId)
  const knownPosition = groupIndex >= 0 && tabIndex >= 0 && regionIndex >= 0 && surface
  const names = tab ? regionDisplayNames(regionOrder.flatMap(regionId => {
    const sibling = tab.regions[regionId]
    if (!sibling) return []
    const label = sibling.kind === 'agent' && !sessions.some(session => session.id === sibling.sessionId && session.label)
      ? 'Agent · name unconfirmed' : regionSurfaceLabel(sibling, sessions)
    return [{ regionId, label }]
  })) : []
  const name = names.find(name => name.regionId === reference.regionId)?.name ?? 'Original panel · name unconfirmed'
  const workspace = facts.config?.workspaces.find(workspace => workspace.id === reference.displayWorkspaceId)
  return <DropdownMenu.Item className="tab-context-menu__item survey-panel-choice" data-survey-panel-reference={JSON.stringify(reference)}
    onSelect={() => onSelect(reference)}>
    <span className="survey-panel-choice-order" aria-label={`Reference ${ordinal + 1}`}>{ordinal + 1}</span><kind.Icon size={14} aria-hidden="true" />
    <span><strong>{name}</strong><small>{workspace?.name ?? 'Workspace unconfirmed'} · {kind.name}</small>
      <small>{knownPosition ? `Group ${groupIndex + 1} · Tab ${tabIndex + 1}${tab?.name ? `: ${tab.name}` : ''} · Panel ${regionIndex + 1}`
        : `Retained reference ${ordinal + 1} · original position unconfirmed`}</small></span>
  </DropdownMenu.Item>
}

/** Labels only describe the original facts. Selection passes the untouched owner reference. */
export function SurveyPanelChoices<T extends WorkbenchProjectionSelection>({ choices, facts, topic = false, open, onOpenChange, onSelect }: {
  choices: readonly T[]; facts: Facts; topic?: boolean; open?: boolean; onOpenChange?(open: boolean): void; onSelect(reference: T): void
}) {
  const [details, setDetails] = useState(false)
  return <DropdownMenu.Root {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
    <DropdownMenu.Trigger asChild><button type="button" className="survey-topic-trigger" aria-label={topic ? 'Choose Topic location' : 'Choose original work surface'}>
      <PanelsTopLeft size={14} aria-hidden="true" /><span>{topic ? 'Topic locations' : 'Choose panel'}</span><ChevronDown size={12} aria-hidden="true" />
    </button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu survey-topic-menu survey-panel-menu" align="end" sideOffset={4} collisionPadding={8}>
      <DropdownMenu.Label className="survey-topic-menu__label">{topic ? 'Open an original Topic location' : 'Select an original panel'}</DropdownMenu.Label>
      {choices.map((reference, ordinal) => <PanelChoice key={JSON.stringify(reference)} reference={reference} facts={facts} ordinal={ordinal} onSelect={onSelect} />)}
      <DropdownMenu.Separator className="tab-context-menu__separator" />
      <DropdownMenu.Item className="tab-context-menu__item" onSelect={event => { event.preventDefault(); setDetails(!details) }}>{details ? 'Hide technical references' : 'Show technical references'}</DropdownMenu.Item>
      {details ? <div className="survey-panel-details">{choices.map((reference, ordinal) => <div key={JSON.stringify(reference)}><strong>Reference {ordinal + 1}</strong>
        <dl><dt>Workspace</dt><dd>{reference.displayWorkspaceId}</dd><dt>Group</dt><dd>{reference.groupId}</dd><dt>Tab</dt><dd>{reference.tabId}</dd><dt>Region</dt><dd>{reference.regionId}</dd></dl>
      </div>)}</div> : null}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}
