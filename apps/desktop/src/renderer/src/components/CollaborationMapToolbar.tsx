import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { InputGroup, TextInput } from '@agentmux/client-ui/input'
import * as Menu from './HoverDropdownMenu'
import { FocusViewSwitch } from './FocusViewSwitch'
import { TopRowLeadingChrome } from './TopRowChrome'
import { COLLABORATION_LABELS } from '../lib/collaboration-relation-presentation'
import { CollaborationRelationKey } from './CollaborationRelationMark'
import type { CollaborationAgent, CollaborationRelation } from '../lib/agent-collaboration'
import { collaborationAgentName } from '../lib/collaboration-map-presentation'

const kinds = ['communication', 'creation', 'supervision'] as const

export function CollaborationMapToolbar({ active, agents, selectedKinds, onToggleKind, onLocate, sourcesOpen, onSources, issues, loading, connections, participants, onRefresh }: {
  active: boolean; agents: ReadonlyMap<string, CollaborationAgent>; selectedKinds: ReadonlySet<CollaborationRelation['kind']>
  onToggleKind(kind: CollaborationRelation['kind']): void; onLocate(id: string): void
  sourcesOpen: boolean; onSources(): void; issues: number; loading: boolean; connections: number; participants: number; onRefresh(): void
}) {
  const [filtersOpen, setFiltersOpen] = useState(false)
  const status = `${agents.size} Agents · ${connections} connections · ${participants} participants observed${loading ? ' · Reading…' : ''}${issues ? ` · ${issues} source issues` : ''}`
  return <header className="collaboration-map__header">
    <TopRowLeadingChrome /><FocusViewSwitch />
    <div className="collaboration-map__tools">
      <MapSearch agents={agents} active={active} onLocate={onLocate} />
      <Menu.Root open={active && filtersOpen} onOpenChange={setFiltersOpen}>
        <Menu.Trigger asChild><button type="button" className="small-button collaboration-map__filter" aria-label="Filter map relations" title="Filter map relations" data-active={selectedKinds.size !== kinds.length || undefined}>
          <SemanticIcon name="action.filter" size={14} /><span>Relations</span>{selectedKinds.size !== kinds.length ? <small>{selectedKinds.size}</small> : null}
        </button></Menu.Trigger>
        <Menu.Portal><Menu.Content className="tab-context-menu collaboration-filter-menu" align="end" sideOffset={6} collisionPadding={8}>
          <Menu.Label className="tab-context-menu__hint">Show relations</Menu.Label>
          {kinds.map(kind => <Menu.CheckboxItem key={kind} className="tab-context-menu__item" data-kind={kind} checked={selectedKinds.has(kind)} onCheckedChange={() => onToggleKind(kind)} onSelect={event => event.preventDefault()}>
            <span className="collaboration-filter-menu__check"><Menu.ItemIndicator><SemanticIcon name="status.selected" size={13} /></Menu.ItemIndicator></span>
            <CollaborationRelationKey kind={kind} />{COLLABORATION_LABELS[kind]}
          </Menu.CheckboxItem>)}
        </Menu.Content></Menu.Portal>
      </Menu.Root>
      <button type="button" className="small-button collaboration-map__sources" aria-label="Map sources" title={status} aria-expanded={sourcesOpen} data-issue={issues > 0 || undefined} onClick={onSources}>
        <SemanticIcon name={issues ? 'status.warning' : 'object.inbox'} size={14} /><span>Sources</span>{issues ? <small>{issues}</small> : loading ? <span className="collaboration-map__reading" role="status" aria-label="Reading sources" /> : null}
      </button>
      <button type="button" className="icon-button" aria-label="Refresh graph sources" title="Refresh graph sources" onClick={onRefresh}><SemanticIcon name="action.refresh" size={14} /></button>
    </div>
  </header>
}

function MapSearch({ agents, active, onLocate }: { agents: ReadonlyMap<string, CollaborationAgent>; active: boolean; onLocate(id: string): void }) {
  const [query, setQuery] = useState(''), [open, setOpen] = useState(false), [highlight, setHighlight] = useState(0)
  const listId = useId(), list = useRef<HTMLDivElement>(null)
  const matches = useMemo(() => {
    const value = query.trim().toLocaleLowerCase()
    return value ? [...agents.values()].filter(agent => collaborationAgentName(agent).toLocaleLowerCase().includes(value) || agent.sessionId.toLocaleLowerCase().includes(value)) : []
  }, [agents, query])
  const options = matches.slice(0, 30), index = Math.min(highlight, Math.max(0, options.length - 1)), expanded = active && open && Boolean(query.trim())
  useEffect(() => { if (!active) setOpen(false) }, [active])
  useEffect(() => { if (expanded) list.current?.children.item(index)?.scrollIntoView?.({ block: 'nearest' }) }, [expanded, index])
  const locate = (id: string) => { onLocate(id); setOpen(false); setQuery('') }
  return <InputGroup className="collaboration-map__search" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <SemanticIcon name="action.search" size={14} />
    <TextInput role="combobox" aria-label="Find Agent in map" aria-autocomplete="list" aria-expanded={expanded} aria-controls={listId} aria-activedescendant={expanded && options[index] ? `${listId}-${index}` : undefined}
      placeholder="Find Agent" value={query} onFocus={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setHighlight(0); setOpen(true) }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setOpen(true)
          setHighlight(open ? (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % (options.length || 1) : 0)
        } else if (event.key === 'Enter' && expanded && options[index]) { event.preventDefault(); locate(options[index].id) }
      }} />
    {expanded ? <div className="collaboration-map__results">
      <div ref={list} id={listId} role="listbox" aria-label="Matching Agents">{options.map((agent, position) => <button type="button" key={agent.id} id={`${listId}-${position}`} role="option" tabIndex={-1} aria-selected={position === index}
        onMouseDown={event => event.preventDefault()} onPointerMove={() => setHighlight(position)} onClick={() => locate(agent.id)}>
        <span>{collaborationAgentName(agent)}</span><small>{agent.subject?.hostId ?? agent.provenance} · {agent.sessionId}</small>
      </button>)}</div>
      {!matches.length ? <p role="status">No matching Agent</p> : matches.length > options.length ? <p>Refine to find more Agents</p> : null}
    </div> : null}
  </InputGroup>
}
