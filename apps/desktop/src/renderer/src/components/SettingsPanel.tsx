import * as DropdownMenu from './HoverDropdownMenu'
import { Check, ChevronDown, LayoutDashboard, Search, Settings2, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { BrandIcon } from './BrandIcon'
import { useAppStore } from '../store'
import { SettingsOverviewPane } from './settings/SettingsOverviewPane'
import { SETTINGS_GROUPS as GROUPS } from './settings/settings-catalog'
import { settingsModules, visibleSettingsSections, settingsNavGroups, type SettingsPageId, type SettingsSectionId } from './settings/settings-modules'

export { visibleSettingsSections, settingsNavGroups } from './settings/settings-modules'
export type { SettingsSectionId, SettingsPageId } from './settings/settings-modules'

export function SettingsPanel({ onClose, initialSection = 'overview', executorId }: {
  onClose: () => void
  initialSection?: SettingsPageId
  executorId?: string | undefined
}) {
  const config = useAppStore((state) => state.config)
  const [active, setActive] = useState<SettingsPageId>(initialSection)
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const [visited, setVisited] = useState<SettingsSectionId[]>(initialSection === 'overview' ? [] : [initialSection])

  function clearSearch(): void {
    setQuery('')
    searchInput.current?.focus()
  }

  useEffect(() => {
    setQuery('')
    setActive(initialSection)
  }, [initialSection, executorId])
  useEffect(() => {
    if (active === 'overview') return
    setVisited((current) => current.includes(active) ? current : [...current, active])
  }, [active])
  const visibleSections = useMemo(() => visibleSettingsSections(query), [query])
  // Search and grouping have one owner; the shell only consumes their result.
  const navGroups = useMemo(() => settingsNavGroups(query), [query])

  useEffect(() => {
    if (!query.trim()) return
    if (visibleSections.some((section) => section.id === active)) return
    const first = visibleSections[0]
    if (first) setActive(first.id)
  }, [active, query, visibleSections])

  useEffect(() => {
    const opener = document.activeElement
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus() }
  }, [])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (query) { setQuery(''); return }
      if (event.target instanceof HTMLSelectElement) return
      onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose, query])

  if (!config) return null
  const currentSection = settingsModules.find((candidate) => candidate.id === active)
  const section = active === 'overview' ? { title: 'Overview', description: '' } : currentSection!
  const groupTitle = currentSection ? GROUPS.find((group) => group.id === currentSection.group)!.title : 'Settings'
  const overviewGroups = settingsNavGroups('')

  return (
    <div className="settings-page" data-settings-page={active}>
      <div className="window-drag-region" />
      <aside className="settings-sidebar">
        <header>
          {active === 'overview'
            ? <div className="settings-sidebar__brand"><Settings2 size={24} aria-hidden="true" /><span><strong>Settings</strong></span></div>
            : <div className="settings-sidebar__brand"><BrandIcon size={26} /><span><strong>AgentMux</strong><small>Settings</small></span></div>}
        </header>
        <label className="settings-search"><Search size={14} /><input ref={searchInput} aria-label="Search settings" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search settings" />{query ? <button aria-label="Clear settings search" onClick={clearSearch}><X size={12} /></button> : null}</label>
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="settings-section-picker" aria-label="Settings section" disabled={!visibleSections.length}>{visibleSections.length ? section.title : 'No matches'}<ChevronDown size={13} /></button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="settings-section-menu" align="end" sideOffset={6} collisionPadding={{ top: 34, right: 8, bottom: 40, left: 8 }} onEscapeKeyDown={(event) => event.stopPropagation()} onCloseAutoFocus={(event) => {
              // Keep focus the user has already moved to another control.
              const focused = document.activeElement
              if (focused instanceof HTMLElement && focused.isConnected && focused !== document.body
                && !focused.closest('[hidden], [inert]')
                && event.target instanceof HTMLElement && !event.target.contains(focused)) event.preventDefault()
            }}>
              <DropdownMenu.RadioGroup value={active} onValueChange={(value) => setActive(value as SettingsPageId)}>
                {!query.trim() ? <DropdownMenu.RadioItem value="overview" className="settings-section-menu__item" data-settings-target="overview"><span><DropdownMenu.ItemIndicator><Check size={13} /></DropdownMenu.ItemIndicator></span>Overview</DropdownMenu.RadioItem> : null}
                {navGroups.map((group) => <Fragment key={group.id}>
                  <DropdownMenu.Label className="settings-section-menu__label">{group.title}</DropdownMenu.Label>
                  {group.items.map((item) => <DropdownMenu.RadioItem key={item.id} value={item.id} className="settings-section-menu__item">
                    <span><DropdownMenu.ItemIndicator><Check size={13} /></DropdownMenu.ItemIndicator></span>{item.title}
                  </DropdownMenu.RadioItem>)}
                </Fragment>)}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <nav aria-label="Settings sections">
          {!query.trim() ? <button type="button" className={active === 'overview' ? 'selected' : ''} aria-current={active === 'overview' ? 'page' : undefined} data-settings-target="overview" data-settings-overview-nav onClick={() => setActive('overview')}><LayoutDashboard size={15} /><span><strong>Overview</strong></span></button> : null}
          {navGroups.map((group) => (
            <Fragment key={group.id}>
              <p>{group.title}</p>
              {group.items.map((item) => {
                const Icon = item.icon
                return <button key={item.id} className={active === item.id ? 'selected' : ''} aria-current={active === item.id ? 'page' : undefined} title={item.description} data-settings-target={item.id} onClick={() => setActive(item.id)}><Icon size={15} /><span><strong>{item.title}</strong></span></button>
              })}
            </Fragment>
          ))}
        </nav>
      </aside>
      <main className="settings-content">
        <header className="settings-content__header">
          <div className="settings-content__title">
            <div>
              <div className="settings-content__breadcrumb"><span>{groupTitle}</span></div>
              <h2>{section.title}</h2>
              {section.description ? <p>{section.description}</p> : null}
            </div>
          </div>
          <div className="settings-content__actions">
            <span className="settings-content__hint"><kbd>Esc</kbd><span>Close</span></span>
            <button className="settings-content__close icon-button" type="button" onClick={onClose} aria-label="Close settings" title="Close settings"><X size={16} /></button>
          </div>
        </header>
        {visibleSections.length === 0 ? <div className="settings-nav-empty" role="status">No settings match “{query}”. Try a different word.</div> : null}
        {active === 'overview' && visibleSections.length > 0 ? <SettingsOverviewPane config={config} groups={overviewGroups} onOpen={setActive} /> : null}
        {visited.map((pane) => {
          const Pane = settingsModules.find((module) => module.id === pane)!.Pane
          const visible = active === pane && visibleSections.length > 0
          return <div key={pane} className="settings-content__scroll" data-settings-pane={pane} hidden={!visible} inert={!visible}>
            <Pane config={config} onClose={onClose} active={visible} executorId={executorId} />
          </div>
        })}
      </main>
    </div>
  )
}
