import { TextInput } from '@agentmux/client-ui/input'
import * as DropdownMenu from './HoverDropdownMenu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BrandIcon } from './BrandIcon'
import type { SettingsNavigationRequest } from './SettingsNavigation'
import { wasWindowOverlayDismissed } from './WindowOverlayHost'
import { useAppStore } from '../store'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { desktopElementVisible } from '../lib/desktop-presentation'
import { SettingsOverviewPane } from './settings/SettingsOverviewPane'
import { SettingsSearchResults } from './settings/SettingsSearchResults'
import { SettingsSidebarNavigation } from './settings/SettingsSidebarNavigation'
import { SETTINGS_GROUPS } from './settings/settings-catalog'
import { settingsCatalog, settingsModules, visibleSettingsSections, settingsNavGroups, type SettingsPageId, type SettingsSectionId } from './settings/settings-modules'
import '../styles/settings-search.css'

const ThemeActionSearchIcon = semanticIconComponent('action.search')
const ThemeActionClearIcon = semanticIconComponent('action.clear')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')
const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const OverviewIcon = semanticIconComponent('object.board')


export { visibleSettingsSections, settingsNavGroups } from './settings/settings-modules'
export type { SettingsSectionId, SettingsPageId } from './settings/settings-modules'

function SettingsPanelView({ onClose, visible = true, initialSection = 'overview', executorId, toolId, navigationRequest }: {
  onClose: () => void
  visible?: boolean
  initialSection?: SettingsPageId
  executorId?: string | undefined
  toolId?: string | undefined
  navigationRequest?: SettingsNavigationRequest | undefined
}) {
  const config = useAppStore((state) => state.config)
  const [active, setActive] = useState<SettingsPageId>(initialSection)
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const opener = useRef(typeof document === 'undefined' ? null : document.activeElement)
  const opened = useRef(false)
  const [sectionMenuOpen, setSectionMenuOpen] = useState(false)
  const [visited, setVisited] = useState<SettingsSectionId[]>(initialSection === 'overview' ? [] : [initialSection])
  const page = useRef<HTMLDivElement>(null)
  const route = useMemo(() => ({}), [initialSection, executorId, toolId, navigationRequest])
  const searchOrigin = useRef<{ section: SettingsPageId; scrollTop: number; route: object } | null>(null)
  const restoreReading = useRef<number | null>(null)
  const [showResults, setShowResults] = useState(false)
  const [destination, setDestination] = useState<{ section: SettingsPageId; target?: string; route: object } | null>(null)
  const [targetIssue, setTargetIssue] = useState('')
  const searching = query.trim().length > 0

  function originalScroll(section: SettingsPageId): HTMLElement | null {
    return section === 'overview' ? page.current?.querySelector('[data-settings-overview]') ?? null
      : Array.from(page.current?.querySelectorAll<HTMLElement>('[data-settings-pane]') ?? []).find(pane => pane.dataset.settingsPane === section) ?? null
  }

  function clearSearch(): void {
    const origin = searchOrigin.current
    if (origin?.route === route) { setActive(origin.section); restoreReading.current = origin.scrollTop }
    searchOrigin.current = null
    setQuery('')
    setShowResults(false)
    setDestination(null)
    setTargetIssue('')
    searchInput.current?.focus({ preventScroll: true })
  }

  function updateQuery(value: string): void {
    if (!value.trim()) { clearSearch(); setQuery(value); return }
    if (!searchOrigin.current) searchOrigin.current = { section: active, scrollTop: originalScroll(active)?.scrollTop ?? 0, route }
    setQuery(value)
    setShowResults(true)
    setDestination(null)
    setTargetIssue('')
  }

  function chooseSection(section: SettingsPageId, target?: string): void {
    setActive(section)
    setShowResults(false)
    setTargetIssue('')
    setDestination(searching ? { section, ...(target ? { target } : {}), route } : null)
  }

  useLayoutEffect(() => {
    searchOrigin.current = null
    restoreReading.current = null
    setQuery('')
    setShowResults(false)
    setDestination(navigationRequest?.field ? { section: initialSection, target: navigationRequest.field, route } : null)
    setTargetIssue('')
    setActive(initialSection)
  }, [route, initialSection])
  useEffect(() => {
    if (active === 'overview') return
    setVisited((current) => current.includes(active) ? current : [...current, active])
  }, [active])
  const visibleSections = useMemo(() => visibleSettingsSections(query), [query])
  // Search and grouping have one owner; the shell only consumes their result.
  const navGroups = useMemo(() => settingsNavGroups(query), [query])
  const searchResults = useMemo(() => settingsCatalog.searchResults(query), [query])

  useLayoutEffect(() => {
    if (!visible || searching || restoreReading.current === null) return
    const scroll = originalScroll(active)
    if (!scroll) return
    scroll.scrollTop = restoreReading.current
    restoreReading.current = null
  }, [active, searching, visible, visited])

  useLayoutEffect(() => {
    if (!visible || showResults || !destination?.target || destination.route !== route || destination.section !== active) return
    const pane = originalScroll(active)
    if (!pane) return // The visited editor mounts on the following render.
    const target = Array.from(pane.querySelectorAll<HTMLElement>('[data-settings-field]')).find(node => node.dataset.settingsField === destination.target)
    if (!target || !target.isConnected || target.closest('[hidden], [inert]')) {
      setTargetIssue('This setting is not shown in the current view. Your edits are kept.')
      return
    }
    // Native disclosure changes presentation only; the original field and draft stay mounted.
    for (let parent: HTMLElement | null = target; parent && parent !== pane; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true
    }
    const previousTabIndex = target.getAttribute('tabindex')
    target.tabIndex = -1
    target.focus({ preventScroll: true })
    pane.scrollTop += target.getBoundingClientRect().top - pane.getBoundingClientRect().top - 16
    target.dataset.settingsSearchHighlight = ''
    const timer = window.setTimeout(() => { delete target.dataset.settingsSearchHighlight }, 1400)
    return () => {
      window.clearTimeout(timer)
      delete target.dataset.settingsSearchHighlight
      if (previousTabIndex === null) target.removeAttribute('tabindex')
      else target.setAttribute('tabindex', previousTabIndex)
    }
  }, [active, destination, route, searching, showResults, visible, visited])

  useLayoutEffect(() => {
    if (!visible) return
    // The first opener was captured before the search input's initial autoFocus.
    if (opened.current) opener.current = document.activeElement
    opened.current = true
    return () => {
      if (opener.current instanceof HTMLElement && desktopElementVisible(opener.current)) opener.current.focus()
    }
  }, [visible])
  useLayoutEffect(() => {
    if (!visible) return
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused.isConnected && searchInput.current?.closest('.settings-page')?.contains(focused) && !focused.closest('[hidden], [inert]')) return
    searchInput.current?.focus()
  }, [active, visible])

  useEffect(() => { if (!visible) setSectionMenuOpen(false) }, [visible])

  useEffect(() => {
    if (!visible) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isImeOwnedKeyboardEvent(event) || wasWindowOverlayDismissed(event)) return
      if (query) { event.preventDefault(); clearSearch(); return }
      if (event.target instanceof HTMLSelectElement) return
      onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose, query, visible])

  if (!config) return null
  const currentSection = settingsModules.find((candidate) => candidate.id === active)
  const section = searching && showResults ? { title: 'Search results', description: '' } : active === 'overview' ? { title: 'Overview', description: '' } : currentSection!
  const currentGroup = currentSection && SETTINGS_GROUPS.find(group => group.id === currentSection.group)
  const groupTitle = searching && showResults || !currentGroup ? 'Settings' : currentGroup.title
  const overviewGroups = settingsNavGroups('')

  return (
    <div ref={page} className="settings-page" data-settings-page={active} hidden={!visible} inert={!visible}>
      <div className="window-drag-region" />
      <aside className="settings-sidebar">
        <header>
          <div className="settings-sidebar__identity"><BrandIcon size={22} /><strong>Settings</strong></div>
        </header>
        <label className="settings-search"><ThemeActionSearchIcon size={14} /><TextInput ref={searchInput} aria-label="Search settings" autoFocus value={query} onChange={(event) => updateQuery(event.target.value)} placeholder="Search settings" />{query ? <button type="button" aria-label="Clear settings search" onClick={clearSearch}><ThemeActionClearIcon size={12} /></button> : null}</label>
        <DropdownMenu.Root modal={false} open={visible && sectionMenuOpen} onOpenChange={setSectionMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="settings-section-picker" aria-label="Settings section" disabled={!visibleSections.length}>{visibleSections.length ? section.title : 'No matches'}<ThemeNavigationDownIcon size={13} /></button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="settings-section-menu" align="end" sideOffset={6} collisionPadding={{ top: 34, right: 8, bottom: 40, left: 8 }} onEscapeKeyDown={(event) => event.stopPropagation()} onCloseAutoFocus={(event) => {
              // Keep focus the user has already moved to another control.
              const focused = document.activeElement
              if (focused instanceof HTMLElement && focused.isConnected && focused !== document.body
                && !focused.closest('[hidden], [inert]')
                && event.target instanceof HTMLElement && !event.target.contains(focused)) event.preventDefault()
            }}>
              <DropdownMenu.RadioGroup value={showResults ? '' : active} onValueChange={(value) => chooseSection(value as SettingsPageId)}>
                {!query.trim() ? <DropdownMenu.RadioItem value="overview" className="settings-section-menu__item" data-settings-target="overview"><span><DropdownMenu.ItemIndicator><ThemeStatusSelectedIcon size={13} /></DropdownMenu.ItemIndicator></span><OverviewIcon size={15} aria-hidden="true" />Overview</DropdownMenu.RadioItem> : null}
                {navGroups.map((group) => <Fragment key={group.id}>
                  <DropdownMenu.Label className="settings-section-menu__label">{group.title}</DropdownMenu.Label>
                  {group.items.map((item) => {
                    const Icon = item.icon
                    return <DropdownMenu.RadioItem key={item.id} value={item.id} className="settings-section-menu__item" data-settings-target={item.id}>
                      <span><DropdownMenu.ItemIndicator><ThemeStatusSelectedIcon size={13} /></DropdownMenu.ItemIndicator></span><Icon size={15} aria-hidden="true" />{item.title}
                    </DropdownMenu.RadioItem>
                  })}
                </Fragment>)}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <SettingsSidebarNavigation groups={navGroups} selected={showResults ? null : active} activeGroup={currentSection?.group}
          navigationGroup={settingsModules.find(candidate => candidate.id === initialSection)?.group}
          searching={searching} visible={visible} navigationKey={route} onOpen={section => chooseSection(section as SettingsPageId)} />
      </aside>
      <main className="settings-content">
        <header className="settings-content__header">
          <div className="settings-content__title">
            <div>
              <div className="settings-content__breadcrumb">{groupTitle}</div>
              <h2>{section.title}</h2>
              {section.description ? <p>{section.description}</p> : null}
            </div>
          </div>
          <div className="settings-content__actions">
            <span className="settings-content__hint"><kbd>Esc</kbd><span>{query ? 'Clear search' : 'Close'}</span></span>
            <button className="settings-content__close icon-button" type="button" onClick={onClose} aria-label="Close settings" title="Close settings"><ThemeActionCloseIcon size={15} /></button>
          </div>
        </header>
        {searching && showResults ? <SettingsSearchResults results={searchResults} query={query} onChoose={chooseSection} /> : null}
        {active === 'overview' && !(searching && showResults) ? <SettingsOverviewPane config={config} groups={overviewGroups} onOpen={chooseSection} active={visible} /> : null}
        {visited.map((pane) => {
          const Pane = settingsModules.find((module) => module.id === pane)!.Pane
          const paneVisible = visible && active === pane && !(searching && showResults)
          return <div key={pane} className="settings-content__scroll" data-settings-pane={pane} hidden={!paneVisible} inert={!paneVisible}>
            {paneVisible && searching ? <div className="settings-search-return"><button type="button" className="small-button" onClick={() => { setShowResults(true); setDestination(null); setTargetIssue('') }}>Search results</button><span>“{query}”</span>{targetIssue ? <span role="status">{targetIssue}</span> : null}</div> : null}
            <Pane config={config} onClose={onClose} onNavigate={chooseSection} active={paneVisible} executorId={executorId} toolId={toolId} navigationRequest={navigationRequest} />
          </div>
        })}
      </main>
    </div>
  )
}

export const SettingsPanel = memo(SettingsPanelView)
