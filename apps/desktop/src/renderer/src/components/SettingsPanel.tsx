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
import { LiquidSelectionSurface } from './LiquidSelectionSurface'
import { SETTINGS_GROUPS as GROUPS } from './settings/settings-catalog'
import { settingsModules, visibleSettingsSections, settingsNavGroups, type SettingsPageId, type SettingsSectionId } from './settings/settings-modules'

const ThemeObjectSettingsIcon = semanticIconComponent('object.settings')
const ThemeActionSearchIcon = semanticIconComponent('action.search')
const ThemeActionClearIcon = semanticIconComponent('action.clear')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')
const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')
const ThemeObjectBoardIcon = semanticIconComponent('object.board')
const ThemeActionCloseIcon = semanticIconComponent('action.close')


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

  function clearSearch(): void {
    setQuery('')
    searchInput.current?.focus()
  }

  useEffect(() => {
    setQuery('')
    setActive(initialSection)
  }, [initialSection, executorId, toolId, navigationRequest])
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
      if (query) { setQuery(''); return }
      if (event.target instanceof HTMLSelectElement) return
      onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose, query, visible])

  if (!config) return null
  const currentSection = settingsModules.find((candidate) => candidate.id === active)
  const section = active === 'overview' ? { title: 'Overview', description: '' } : currentSection!
  const groupTitle = currentSection ? GROUPS.find((group) => group.id === currentSection.group)!.title : 'Settings'
  const overviewGroups = settingsNavGroups('')

  return (
    <div className="settings-page" data-settings-page={active} hidden={!visible} inert={!visible}>
      <div className="window-drag-region" />
      <aside className="settings-sidebar">
        <header>
          {active === 'overview'
            ? <div className="settings-sidebar__brand"><ThemeObjectSettingsIcon size={24} aria-hidden="true" /><span><strong>Settings</strong></span></div>
            : <div className="settings-sidebar__brand"><BrandIcon size={26} /><span><strong>AgentMux</strong><small>Settings</small></span></div>}
        </header>
        <label className="settings-search"><ThemeActionSearchIcon size={14} /><TextInput ref={searchInput} aria-label="Search settings" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search settings" />{query ? <button aria-label="Clear settings search" onClick={clearSearch}><ThemeActionClearIcon size={12} /></button> : null}</label>
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
              <DropdownMenu.RadioGroup value={active} onValueChange={(value) => setActive(value as SettingsPageId)}>
                {!query.trim() ? <DropdownMenu.RadioItem value="overview" className="settings-section-menu__item" data-settings-target="overview"><span><DropdownMenu.ItemIndicator><ThemeStatusSelectedIcon size={13} /></DropdownMenu.ItemIndicator></span>Overview</DropdownMenu.RadioItem> : null}
                {navGroups.map((group) => <Fragment key={group.id}>
                  <DropdownMenu.Label className="settings-section-menu__label">{group.title}</DropdownMenu.Label>
                  {group.items.map((item) => <DropdownMenu.RadioItem key={item.id} value={item.id} className="settings-section-menu__item">
                    <span><DropdownMenu.ItemIndicator><ThemeStatusSelectedIcon size={13} /></DropdownMenu.ItemIndicator></span>{item.title}
                  </DropdownMenu.RadioItem>)}
                </Fragment>)}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <nav aria-label="Settings sections">
          <LiquidSelectionSurface selected={active} active={visible} targetAttribute="data-settings-target" />
          {!query.trim() ? <button type="button" className={active === 'overview' ? 'selected' : ''} aria-current={active === 'overview' ? 'page' : undefined} data-settings-target="overview" data-settings-overview-nav onClick={() => setActive('overview')}><ThemeObjectBoardIcon size={15} /><span><strong>Overview</strong></span></button> : null}
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
            <button className="settings-content__close icon-button" type="button" onClick={onClose} aria-label="Close settings" title="Close settings"><ThemeActionCloseIcon size={16} /></button>
          </div>
        </header>
        {visibleSections.length === 0 ? <div className="settings-nav-empty" role="status">No settings match “{query}”. Try a different word.</div> : null}
        {active === 'overview' && visibleSections.length > 0 ? <SettingsOverviewPane config={config} groups={overviewGroups} onOpen={setActive} active={visible} /> : null}
        {visited.map((pane) => {
          const Pane = settingsModules.find((module) => module.id === pane)!.Pane
          const paneVisible = visible && active === pane && visibleSections.length > 0
          return <div key={pane} className="settings-content__scroll" data-settings-pane={pane} hidden={!paneVisible} inert={!paneVisible}>
            <Pane config={config} onClose={onClose} onNavigate={setActive} active={paneVisible} executorId={executorId} toolId={toolId} navigationRequest={navigationRequest} />
          </div>
        })}
      </main>
    </div>
  )
}

export const SettingsPanel = memo(SettingsPanelView)
