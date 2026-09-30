import { groupIds, regionIds } from '@agentmux/layout'
import { Bot, ChevronDown, ChevronRight, FileText, Globe2, PanelsTopLeft, Plus, Terminal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { regionDisplayNames, regionSurfaceLabel } from '../lib/region-display-name'
import { useWorkbenchTabSessions } from '../lib/workbench-session-subscriptions'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import type { WorkbenchSurface } from '../lib/workbench-tabs'
import type { useAppStore } from '../store'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { resolveOverlayContainer } from './WindowOverlayHost'

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

/** One content projection serves the Item submenu and the explicit recovery entry. */
function PanelChoiceItems<T extends WorkbenchProjectionSelection>({ choices, facts, topic, onSelect }: {
  choices: readonly T[]; facts: Facts; topic: boolean; onSelect(reference: T): void
}) {
  const [details, setDetails] = useState(false)
  return <>
    <DropdownMenu.Label className="survey-topic-menu__label">{topic ? 'Open an original Topic location' : 'Select an original panel'}</DropdownMenu.Label>
    {choices.map((reference, ordinal) => <PanelChoice key={JSON.stringify(reference)} reference={reference} facts={facts} ordinal={ordinal} onSelect={onSelect} />)}
    <DropdownMenu.Separator className="tab-context-menu__separator" />
    <DropdownMenu.Item className="tab-context-menu__item" onSelect={event => { event.preventDefault(); setDetails(!details) }}>{details ? 'Hide technical references' : 'Show technical references'}</DropdownMenu.Item>
    {details ? <div className="survey-panel-details">{choices.map((reference, ordinal) => <div key={JSON.stringify(reference)}><strong>Reference {ordinal + 1}</strong>
      <dl><dt>Workspace</dt><dd>{reference.displayWorkspaceId}</dd><dt>Group</dt><dd>{reference.groupId}</dd><dt>Tab</dt><dd>{reference.tabId}</dd><dt>Region</dt><dd>{reference.regionId}</dd></dl>
    </div>)}</div> : null}
  </>
}

/** Labels describe original facts. Both real entries pass the untouched owner reference. */
export function SurveyPanelChoices<T extends WorkbenchProjectionSelection>({ choices, facts, mode, visible = true, topic = false, open: controlled, onOpenChange, onSelect }: {
  choices: readonly T[]; facts: Facts; mode: 'submenu' | 'button'; visible?: boolean; topic?: boolean
  open?: boolean; onOpenChange?(open: boolean): void; onSelect(reference: T): void
}) {
  const [localOpen, setLocalOpen] = useState(false)
  useEffect(() => { if (!visible) setLocalOpen(false) }, [visible])
  const open = visible && (controlled ?? localOpen)
  function change(next: boolean) { setLocalOpen(next); onOpenChange?.(next) }
  const label = topic ? 'Choose Topic location' : 'Choose original work surface'
  const contents = <PanelChoiceItems choices={choices} facts={facts} topic={topic} onSelect={onSelect} />
  return mode === 'submenu' ? <DropdownMenu.Sub>
    <DropdownMenu.SubTrigger className="tab-context-menu__item" aria-label={label}><PanelsTopLeft size={14} aria-hidden="true" /><span>Choose panel</span><ChevronRight size={12} aria-hidden="true" /></DropdownMenu.SubTrigger>
    <DropdownMenu.Portal container={resolveOverlayContainer()}><DropdownMenu.SubContent className="tab-context-menu survey-topic-menu survey-panel-menu" sideOffset={4} collisionPadding={8}>{contents}</DropdownMenu.SubContent></DropdownMenu.Portal>
  </DropdownMenu.Sub> : <DropdownMenu.Root modal={false} open={open} onOpenChange={change}>
    <DropdownMenu.Trigger asChild><button type="button" className="survey-topic-trigger" aria-label={label}>
      <span>{topic ? 'Topic locations' : 'Choose panel…'}</span><ChevronDown size={12} aria-hidden="true" />
    </button></DropdownMenu.Trigger>
    <DropdownMenu.Portal container={resolveOverlayContainer()}><DropdownMenu.Content className="tab-context-menu survey-topic-menu survey-panel-menu" align="end" sideOffset={4} collisionPadding={8}
      onCloseAutoFocus={event => { if (!visible) event.preventDefault() }}>{contents}</DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}
