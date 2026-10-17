import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useLayoutEffect, useRef, useState } from 'react'
import { LiquidSelectionSurface } from '../LiquidSelectionSurface'
import type { SettingsNavGroup, SettingsModule } from './settings-catalog'

const OverviewIcon = semanticIconComponent('object.board')
const DisclosureIcon = semanticIconComponent('navigation.disclosure')

/** Local navigation disclosure only; editor lifetime and search remain in SettingsPanel. */
export function SettingsSidebarNavigation({ groups, selected, activeGroup, navigationGroup, searching, visible, navigationKey, onOpen }: {
  groups: SettingsNavGroup[]
  selected: string | null
  activeGroup?: SettingsModule['group'] | undefined
  navigationGroup?: SettingsModule['group'] | undefined
  searching: boolean
  visible: boolean
  navigationKey: object
  onOpen: (id: string) => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['preferences', 'resources', ...(activeGroup ? [activeGroup] : [])]))
  const previousNavigation = useRef({ activeGroup, navigationKey, searching })
  useLayoutEffect(() => {
    const previous = previousNavigation.current
    previousNavigation.current = { activeGroup, navigationKey, searching }
    // Search visits and returning to their origin preserve manual disclosure choices.
    const reveal = previous.navigationKey !== navigationKey ? navigationGroup
      : !searching && !previous.searching && previous.activeGroup !== activeGroup ? activeGroup : undefined
    if (reveal) setExpanded(current => current.has(reveal) ? current : new Set([...current, reveal]))
  }, [activeGroup, navigationGroup, navigationKey, searching])

  return <nav aria-label="Settings sections">
    {/* Disclosure moves later rows without resizing them. Rebind this local decoration to its new geometry. */}
    <LiquidSelectionSurface key={[...expanded].sort().join(' ')} selected={selected} active={visible} targetAttribute="data-settings-target" />
    {!searching ? <button type="button" className={selected === 'overview' ? 'selected' : ''} aria-current={selected === 'overview' ? 'page' : undefined} data-settings-target="overview" data-settings-overview-nav onClick={() => onOpen('overview')}>
      <OverviewIcon size={15} /><span><strong>Overview</strong></span>
    </button> : null}
    {groups.map(group => {
      const open = searching || expanded.has(group.id)
      return <div key={group.id} className="settings-nav-section" data-settings-group={group.id}>
        {searching ? <p className="settings-nav-group">{group.title}</p> : <button type="button" className="settings-nav-group" data-settings-group-toggle={group.id} aria-expanded={open} aria-controls={`settings-nav-${group.id}`} title={group.description}
          onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next })}>
          <span>{group.title}</span><DisclosureIcon size={12} aria-hidden="true" />
        </button>}
        <div id={`settings-nav-${group.id}`} className="settings-nav-items" hidden={!open}>
          {group.items.map(item => {
            const Icon = item.icon
            return <button key={item.id} type="button" className={selected === item.id ? 'selected' : ''} aria-current={selected === item.id ? 'page' : undefined} title={`${item.title}: ${item.description}`} data-settings-target={item.id} onClick={() => onOpen(item.id)}>
              <Icon size={15} /><span><strong>{item.title}</strong></span>
            </button>
          })}
        </div>
      </div>
    })}
  </nav>
}
