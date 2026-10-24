import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import * as Menu from './HoverDropdownMenu'
import { EMPTY_FOCUS_FILTERS, FOCUS_FILTER_STATES, type FocusFilters as Selection, type FocusStateFilter } from '../lib/focus-filters'
import { FOCUS_SOURCE_TYPES, type FocusSourceType } from '../lib/focus-lane-origin'

const FilterIcon = semanticIconComponent('action.filter')
const CheckIcon = semanticIconComponent('status.selected')
const CloseIcon = semanticIconComponent('action.close')
type Option = { id: string; name: string; count: number; unavailable?: boolean }
export type FocusFilterOptions = { projects: readonly Option[]; states: ReadonlyMap<FocusStateFilter, number>; types: ReadonlyMap<FocusSourceType, number> }
const TYPE_NAMES: Record<FocusSourceType, string> = { project: 'Project', topic: 'Topic', mote: 'Mote', survey: 'Survey', unknown: 'Source unknown' }
const TYPE_ICONS = {
  project: semanticIconComponent('object.folder'), topic: semanticIconComponent('object.notebook'),
  mote: semanticIconComponent('object.team'), survey: semanticIconComponent('navigation.survey'), unknown: semanticIconComponent('status.neutral')
}

function ExplicitFilterTrigger({ onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const branch = Menu.useHoverMenuBranch()
  return <button {...props} onClick={event => { branch.enterKeyboard(); onClick?.(event) }} />
}

/** Only presentation conditions live here. Original owner facts and card membership stay at Focus. */
export function FocusFilters({ value, onChange, onInspectChange, options, visible, onClear, onHistory, historyAvailable }: {
  value: Selection; onChange(value: Selection): void; options: FocusFilterOptions; visible: boolean
  onInspectChange?(open: boolean): void
  onClear(): void; onHistory(): void; historyAvailable: boolean
}) {
  const [open, setOpen] = useState(false)
  const [optionQuery, setOptionQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionSearchRef = useRef<HTMLInputElement>(null)
  const originRef = useRef<HTMLButtonElement | null>(null)
  const selectedNames = useRef(new Map<string, string>())
  useEffect(() => {
    const selected = new Set(value.projects.map(item => item.id))
    for (const item of value.projects) selectedNames.current.set(item.id, options.projects.find(option => option.id === item.id)?.name ?? selectedNames.current.get(item.id) ?? item.name)
    for (const id of selectedNames.current.keys()) if (!selected.has(id)) selectedNames.current.delete(id)
  }, [options.projects, value.projects])
  useEffect(() => { if (!visible) { setOpen(false); onInspectChange?.(false) } }, [visible, onInspectChange])
  const changeOpen = (next: boolean) => { setOpen(next); onInspectChange?.(next); if (!next) setOptionQuery('') }
  const projects = useMemo(() => {
    const known = new Set(options.projects.map(option => option.id))
    return [...options.projects, ...value.projects.filter(option => !known.has(option.id)).map(option => ({ ...option, name: selectedNames.current.get(option.id) ?? option.name, count: 0, unavailable: true }))]
  }, [options.projects, value.projects])
  const stateNames = value.states.map(id => FOCUS_FILTER_STATES.find(option => option.id === id)!.name)
  const typeNames = value.types.map(id => TYPE_NAMES[id])
  const projectNames = value.projects.map(item => { const current = projects.find(option => option.id === item.id); return current?.unavailable ? `${current.name} · Unavailable` : current?.name ?? item.name })
  const count = Number(value.projects.length > 0) + Number(value.states.length > 0) + Number(value.types.length > 0)
  const summary = [projectNames.join(' or ') || 'All projects', stateNames.join(' or ') || 'All states', typeNames.join(' or ') || 'All types'].join(' · ')
  const toggleState = (id: FocusStateFilter) => onChange({ ...value, states: value.states.includes(id) ? value.states.filter(item => item !== id) : [...value.states, id] })
  const toggleType = (id: FocusSourceType) => onChange({ ...value, types: value.types.includes(id) ? value.types.filter(item => item !== id) : [...value.types, id] })
  const match = (name: string) => name.toLocaleLowerCase().includes(optionQuery.trim().toLocaleLowerCase())
  const option = (dimension: 'project' | 'state' | 'type', item: Option, checked: boolean, change: () => void) => <Menu.CheckboxItem key={item.id}
    {...{ [`data-focus-${dimension}`]: item.id }} checked={checked} onCheckedChange={change} onSelect={event => event.preventDefault()}
    className="tab-context-menu__item focus-filter-menu__item">
    <span className="focus-filter-menu__check"><Menu.ItemIndicator><CheckIcon size={13} /></Menu.ItemIndicator></span>
    {dimension === 'type' && item.id !== 'all' ? (() => { const Icon = TYPE_ICONS[item.id as FocusSourceType]; return <Icon size={13} /> })() : null}
    <span className="focus-filter-menu__name">{item.name}{item.unavailable ? <small>Unavailable · Original condition kept</small> : null}</span>
    {item.id !== 'all' ? <span className="focus-filter-menu__count">{item.count}</span> : null}
  </Menu.CheckboxItem>
  const chip = (field: 'projects' | 'states' | 'types', label: string, names: readonly string[]) => names.length ? <span className="focus-filter-chip" key={field}>
    <ExplicitFilterTrigger type="button" className="focus-filter-chip__value" title={names.join(' or ')} aria-label={`Edit ${label} filter: ${names.join(' or ')}`} onClick={event => { originRef.current = event.currentTarget; setOptionQuery(''); changeOpen(true) }}><span>{label}</span><strong>{names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0]}</strong></ExplicitFilterTrigger>
    <button type="button" className="focus-filter-chip__remove" aria-label={`Remove ${label} filter`} onClick={() => { onChange({ ...value, [field]: [] }); triggerRef.current?.focus() }}><CloseIcon size={11} /></button>
  </span> : null
  return <Menu.Root open={visible && open} onOpenChange={changeOpen}>
    <div className="focus-filter-chips" aria-label="Applied Focus filters">{chip('projects', 'Project', projectNames)}{chip('states', 'State', stateNames)}{chip('types', 'Type', typeNames)}</div>
      <Menu.Trigger asChild><button ref={triggerRef} type="button" className="focus-filter-trigger" aria-label="Focus filters" aria-description={summary} title={summary} data-active={count > 0 || undefined} onPointerDown={() => { originRef.current = triggerRef.current }} onKeyDown={() => { originRef.current = triggerRef.current }}>
        <FilterIcon size={14} /><span className="focus-filter-trigger__summary">Filter</span>{count ? <span className="focus-filter-trigger__count">{count}</span> : null}
      </button></Menu.Trigger>
      <Menu.Portal><Menu.Content className="tab-context-menu focus-filter-menu" align="end" sideOffset={4} collisionPadding={8} onKeyDown={event => {
        // Radix menus reserve Tab for dismissal prevention. Give the embedded
        // option search a direct keyboard route without changing hover focus.
        if (event.key === 'Tab') { event.preventDefault(); optionSearchRef.current?.focus() }
      }} onCloseAutoFocus={event => {
        const focused = document.activeElement
        if (focused instanceof HTMLElement && focused.isConnected && focused !== document.body
          && !focused.closest('[hidden], [inert]') && event.target instanceof HTMLElement && !event.target.contains(focused)) event.preventDefault()
        if (!event.defaultPrevented && originRef.current) {
          event.preventDefault()
          const origin = originRef.current
          ;(origin.isConnected && origin.getClientRects().length ? origin : triggerRef.current)?.focus()
        }
      }}>
        <Menu.Label className="focus-filter-menu__heading">Filter contexts</Menu.Label>
        <div className="focus-filter-menu__search"><TextInput ref={optionSearchRef} aria-label="Find Focus filter options" placeholder="Find a project, state or type…" value={optionQuery} onChange={event => setOptionQuery(event.target.value)} onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); event.currentTarget.closest('[role="menu"]')?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus() }
          else if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation()
        }} /></div>
        <div className="focus-filter-menu__options">
          <Menu.Group aria-label="Focus type filter"><Menu.Label className="focus-filter-menu__label">Type · match any</Menu.Label>
            {option('type', { id: 'all', name: 'All types', count: 0 }, !value.types.length, () => onChange({ ...value, types: [] }))}
            {FOCUS_SOURCE_TYPES.filter(id => match(TYPE_NAMES[id]) || value.types.includes(id)).map(id => option('type', { id, name: TYPE_NAMES[id], count: options.types.get(id) ?? 0 }, value.types.includes(id), () => toggleType(id)))}
          </Menu.Group>
          <Menu.Separator className="tab-context-menu__separator" />
          <Menu.Group aria-label="Focus project filter"><Menu.Label className="focus-filter-menu__label">Project · match any</Menu.Label>
            {option('project', { id: 'all', name: 'All projects', count: 0 }, !value.projects.length, () => onChange({ ...value, projects: [] }))}
            {projects.filter(item => match(item.name) || value.projects.some(selected => selected.id === item.id)).map(item => option('project', item, value.projects.some(selected => selected.id === item.id), () => onChange({ ...value, projects: value.projects.some(selected => selected.id === item.id) ? value.projects.filter(selected => selected.id !== item.id) : [...value.projects, { id: item.id, name: item.name }] })))}
          </Menu.Group>
          <Menu.Separator className="tab-context-menu__separator" />
          <Menu.Group aria-label="Focus state filter"><Menu.Label className="focus-filter-menu__label">State · match any</Menu.Label>
            {option('state', { id: 'all', name: 'All states', count: 0 }, !value.states.length, () => onChange({ ...value, states: [] }))}
            {FOCUS_FILTER_STATES.filter(item => match(item.name) || value.states.includes(item.id)).map(item => option('state', { ...item, count: options.states.get(item.id) ?? 0 }, value.states.includes(item.id), () => toggleState(item.id)))}
          </Menu.Group>
        </div>
        <Menu.Separator className="tab-context-menu__separator" />
        <Menu.Label className="focus-filter-menu__scope">Match all groups · Any value within a group. Types may overlap.</Menu.Label>
        <Menu.Item className="tab-context-menu__item" onSelect={() => { onChange(EMPTY_FOCUS_FILTERS); onClear() }}>Clear filters</Menu.Item>
        <Menu.Item className="tab-context-menu__item" disabled={!historyAvailable} onSelect={onHistory}>Search all retained conversation text</Menu.Item>
        <Menu.Item className="tab-context-menu__item" onSelect={() => {}}>Done</Menu.Item>
      </Menu.Content></Menu.Portal>
    </Menu.Root>
}
