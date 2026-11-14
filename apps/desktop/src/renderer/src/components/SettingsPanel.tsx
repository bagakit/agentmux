import { TextInput } from '@agentmux/client-ui/input'
import { Button } from '@agentmux/client-ui/components/Button'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import * as DropdownMenu from './HoverDropdownMenu'
import { SemanticIcon, semanticIconComponent } from '@agentmux/client-ui/icons'
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BrandIcon } from './BrandIcon'
import { normalizeSettingsNavigationRequest, type SettingsNavigationRequest } from './SettingsNavigation'
import { wasWindowOverlayDismissed } from './WindowOverlayHost'
import { useAppStore } from '../store'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { desktopElementVisible } from '../lib/desktop-presentation'
import { GoalsPromptDraftProvider } from './settings/GoalsPromptDrafts'
import { NodePublicationObservation } from './settings/NodePublicationObservation'
import { SettingsOverviewPane } from './settings/SettingsOverviewPane'
import { SettingsSearchResults } from './settings/SettingsSearchResults'
import { SettingsSidebarNavigation } from './settings/SettingsSidebarNavigation'
import { SETTINGS_GROUPS, type SettingsModule } from './settings/settings-catalog'
import { settingsCatalog, settingsModules, visibleSettingsSections, settingsNavGroups, type SettingsPageId, type SettingsSectionId } from './settings/settings-modules'

const ThemeActionSearchIcon = semanticIconComponent('action.search')
const ThemeActionClearIcon = semanticIconComponent('action.clear')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')
const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const OverviewIcon = semanticIconComponent('object.board')


export { visibleSettingsSections, settingsNavGroups } from './settings/settings-modules'
export type { SettingsSectionId, SettingsPageId } from './settings/settings-modules'

/** A channel request whose application no settings section claims still lands on Overview, but says so. */
function unmatchedChannel(request: SettingsNavigationRequest | undefined): string | undefined {
  if (request?.section !== 'overview' || !request.channelOrigin) return undefined
  const { application, adapterId } = request.channelOrigin.connection
  return `No settings section manages ${application.domain} applications (${adapterId}) yet. Choose a section below; the original connection is unchanged.`
}

function sameNormalizedNavigationRequest(a: SettingsNavigationRequest | undefined, b: SettingsNavigationRequest | undefined): boolean {
  return a === b || Boolean(a && b && a.section === b.section && a.field === b.field && a.executorId === b.executorId
    && a.toolId === b.toolId && a.hostId === b.hostId && a.channelOrigin === b.channelOrigin && a.moteConnectionOrigin === b.moteConnectionOrigin)
}

function SettingsPanelView({ onClose, visible = true, initialSection = 'overview', executorId, toolId, navigationRequest, observationRef, inputPolicy = 'target' }: {
  onClose: () => void
  visible?: boolean
  initialSection?: SettingsPageId
  executorId?: string | undefined
  toolId?: string | undefined
  navigationRequest?: SettingsNavigationRequest | undefined
  inputPolicy?: 'preserve' | 'target' | undefined
  observationRef?: { current: { sectionId: string; visible: boolean; hostId?: string | null } | null } | undefined
}) {
  const config = useAppStore((state) => state.config)
  const computedNavigationRequest = useMemo(() => navigationRequest
    ? normalizeSettingsNavigationRequest(navigationRequest, config?.hosts ?? []) : undefined, [navigationRequest, config?.hosts])
  const normalizedCache = useRef<{ source: SettingsNavigationRequest | undefined; result: SettingsNavigationRequest | undefined } | undefined>(undefined)
  if (!normalizedCache.current || normalizedCache.current.source !== navigationRequest
    || !sameNormalizedNavigationRequest(normalizedCache.current.result, computedNavigationRequest)) {
    normalizedCache.current = { source: navigationRequest, result: computedNavigationRequest }
  }
  const normalizedNavigationRequest = normalizedCache.current.result
  const normalizedInitialSection = normalizedNavigationRequest?.section ?? initialSection
  const [active, setActive] = useState<SettingsPageId>(normalizedInitialSection)
  const [activeSubpage, setActiveSubpage] = useState<string>()
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const opener = useRef(typeof document === 'undefined' ? null : document.activeElement)
  const opened = useRef(false)
  const [sectionMenuOpen, setSectionMenuOpen] = useState(false)
  const [visited, setVisited] = useState<SettingsSectionId[]>(normalizedInitialSection === 'overview' ? [] : [normalizedInitialSection])
  const page = useRef<HTMLDivElement>(null)
  const route = useMemo(() => ({}), [normalizedInitialSection, executorId, toolId, normalizedNavigationRequest])
  const searchOrigin = useRef<{ section: SettingsPageId; scrollTop: number; route: object } | null>(null)
  const restoreReading = useRef<number | null>(null)
  const [showResults, setShowResults] = useState(false)
  const [destination, setDestination] = useState<{ section: SettingsPageId; target?: string; route: object; request: SettingsNavigationRequest } | null>(null)
  const [targetIssue, setTargetIssue] = useState('')
  const searching = query.trim().length > 0
  const preserveInput = inputPolicy === 'preserve'
  const preserveInputRef = useRef(preserveInput)
  preserveInputRef.current = preserveInput
  useLayoutEffect(() => {
    if (!observationRef) return
    observationRef.current = { sectionId: active,
      get visible() {
        const pane = originalScroll(active)
        return Boolean(config) && visible && !showResults && (active === 'overview'
          || Boolean(pane && !pane.querySelector('[data-settings-editor-state]')))
      },
      // Presentation only: the original Host pane supplies its actual selection,
      // independently of a requested route. This never grants resource access.
      get hostId() { return active === 'hosts' || active === 'network-node' ? originalScroll(active)?.querySelector<HTMLElement>('[data-settings-host]')?.dataset.settingsHost ?? null : null } }
    return () => { observationRef.current = null }
  }, [active, config, observationRef, showResults, visible])

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

  function chooseSection(section: SettingsPageId, target?: string, fromSidebar = false): void {
    setActive(section)
    setShowResults(false)
    setTargetIssue('')
    const field = target ?? (section === 'hosts' ? 'mesh-paths' : section === 'agents' ? 'executors' : undefined)
    setDestination(searching || fromSidebar && target || section === 'hosts' || section === 'agents' ? { section, ...(target && !fromSidebar ? { target } : {}), route,
      request: normalizeSettingsNavigationRequest({ section, field }, config?.hosts ?? []) } : null)
  }

  useLayoutEffect(() => {
    searchOrigin.current = null
    restoreReading.current = null
    setQuery('')
    setShowResults(false)
    setDestination(normalizedNavigationRequest?.field ? { section: normalizedInitialSection, target: normalizedNavigationRequest.field, route, request: normalizedNavigationRequest } : null)
    setTargetIssue('')
    setActive(normalizedInitialSection)
  }, [route, normalizedInitialSection])
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
    if (preserveInput || !visible || showResults || !destination?.target || destination.route !== route || destination.section !== active) return
    const pane = originalScroll(active)
    if (!pane) return // The visited editor mounts on the following render.
    const fieldId = destination.target
    let cleanupTarget: (() => void) | undefined
    let observer: MutationObserver | undefined, disposed = false, laterFocus = false
    const changedFocus = () => { laterFocus = true }
    const reveal = () => {
      if (pane.querySelector('[data-settings-editor-state="loading"]')) return
      observer?.disconnect()
      observer = undefined
      document.removeEventListener('focusin', changedFocus)
      if (laterFocus || pane.querySelector('[data-settings-editor-state="failed"]')) return
      const target = Array.from(pane.querySelectorAll<HTMLElement>('[data-settings-field]')).find(node => node.dataset.settingsField === fieldId)
      if (!target || !target.isConnected || target.closest('[hidden], [inert]')) {
        setTargetIssue('This setting is not shown in the current view. Your edits are kept.')
        return
      }
      setTargetIssue('')
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
      cleanupTarget = () => {
        window.clearTimeout(timer)
        delete target.dataset.settingsSearchHighlight
        if (previousTabIndex === null) target.removeAttribute('tabindex')
        else target.setAttribute('tabindex', previousTabIndex)
      }
    }
    if (pane.querySelector('[data-settings-editor-state="loading"]')) {
      observer = new MutationObserver(reveal)
      observer.observe(pane, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-settings-editor-state'] })
      // The shell's initial search focus commits first; subsequent input wins over a late editor.
      queueMicrotask(() => { if (!disposed && observer) document.addEventListener('focusin', changedFocus) })
    } else reveal()
    return () => { disposed = true; observer?.disconnect(); document.removeEventListener('focusin', changedFocus); cleanupTarget?.() }
  }, [active, destination, preserveInput, route, searching, showResults, visible, visited])

  useLayoutEffect(() => {
    if (!visible || preserveInputRef.current) return
    // The first opener was captured before the search input's initial autoFocus.
    if (opened.current) opener.current = document.activeElement
    opened.current = true
    return () => {
      if (!preserveInputRef.current && opener.current instanceof HTMLElement && desktopElementVisible(opener.current)) opener.current.focus()
    }
  }, [visible])
  useLayoutEffect(() => {
    if (!visible || preserveInput) return
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused.isConnected && searchInput.current?.closest('.settings-page')?.contains(focused) && !focused.closest('[hidden], [inert]')) return
    searchInput.current?.focus()
  }, [active, preserveInput, visible])

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
  const subpages = (currentSection as SettingsModule | undefined)?.subpages
  const subpage = subpages?.find(item => item.field === activeSubpage)
  const navigationSelection = subpage ? `${active}:${subpage.field}` : active
  const openNavigation = (id: string, field?: string) => chooseSection(id as SettingsPageId, field, true)
  const section = searching && showResults ? { title: 'Search results', description: '' } : active === 'overview' ? { title: 'Overview', description: '' } : currentSection!
  const currentGroup = currentSection && SETTINGS_GROUPS.find(group => group.id === currentSection.group)
  const groupTitle = searching && showResults || !currentGroup ? 'Settings' : currentGroup.title
  const overviewGroups = settingsNavGroups('')

  const renderPane = (pane: SettingsSectionId) => {
    const module = settingsModules.find((module) => module.id === pane)! as SettingsModule
    const Pane = module.Pane
    const paneVisible = visible && active === pane && !(searching && showResults)
    const paneNavigationRequest = destination?.route === route && destination.section === pane ? destination.request
      : normalizedNavigationRequest?.section === pane ? normalizedNavigationRequest : undefined
    return <div key={pane} className="settings-content__scroll" data-settings-pane={pane} hidden={!paneVisible} inert={!paneVisible}>
      {paneVisible && searching ? <div className="settings-search-return"><Button type="button" onClick={() => { setShowResults(true); setDestination(null); setTargetIssue('') }}>Search results</Button><span>“{query}”</span>{targetIssue ? <span role="status">{targetIssue}</span> : null}</div>
        : paneVisible && targetIssue ? <p className="settings-target-issue" role="status" data-settings-target-issue>{targetIssue}</p> : null}
      <Pane config={config} onClose={onClose} onNavigate={chooseSection} active={paneVisible} executorId={executorId} toolId={toolId} navigationRequest={paneNavigationRequest} onSubpageChange={paneVisible && module.subpages ? setActiveSubpage : undefined} />
    </div>
  }

  return (
    <NodePublicationObservation hosts={config.hosts} visible={visible} section={active}>
    <div ref={page} className="settings-page" data-settings-page={active} hidden={!visible} inert={!visible}>
      <div className="window-drag-region" />
      <aside className="settings-sidebar">
        <header>
          <div className="settings-sidebar__identity"><BrandIcon size={22} /><strong>Settings</strong></div>
        </header>
        <label className="settings-search"><ThemeActionSearchIcon size={14} /><TextInput ref={searchInput} aria-label="Search settings" autoFocus={!preserveInput} value={query} onChange={(event) => updateQuery(event.target.value)} placeholder="Search settings" />{query ? <button type="button" aria-label="Clear settings search" onClick={clearSearch}><ThemeActionClearIcon size={12} /></button> : null}</label>
        <DropdownMenu.Root modal={false} open={visible && sectionMenuOpen} onOpenChange={setSectionMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="settings-section-picker" aria-label="Settings section" disabled={!visibleSections.length}>{visibleSections.length ? subpage?.title ?? section.title : 'No matches'}<ThemeNavigationDownIcon size={13} /></button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="settings-section-menu" align="end" sideOffset={6} collisionPadding={{ top: 34, right: 8, bottom: 40, left: 8 }} onEscapeKeyDown={(event) => event.stopPropagation()} onCloseAutoFocus={(event) => {
              // Keep focus the user has already moved to another control.
              const focused = document.activeElement
              if (focused instanceof HTMLElement && focused.isConnected && focused !== document.body
                && !focused.closest('[hidden], [inert]')
                && event.target instanceof HTMLElement && !event.target.contains(focused)) event.preventDefault()
            }}>
              <DropdownMenu.RadioGroup value={showResults ? '' : navigationSelection} onValueChange={value => {
                const [id, field] = value.split(':')
                if (id) openNavigation(id, field)
              }}>
                {!query.trim() ? <DropdownMenu.RadioItem value="overview" className="settings-section-menu__item" data-settings-target="overview"><span><DropdownMenu.ItemIndicator><ThemeStatusSelectedIcon size={13} /></DropdownMenu.ItemIndicator></span><OverviewIcon size={15} aria-hidden="true" />Overview</DropdownMenu.RadioItem> : null}
                {navGroups.map((group) => <Fragment key={group.id}>
                  <DropdownMenu.Label className="settings-section-menu__label"><span className="settings-group-heading"><SemanticIcon name={group.icon} size={12} aria-hidden="true" />{group.title}</span></DropdownMenu.Label>
                  {group.items.map((item) => {
                    const Icon = item.icon
                    return <Fragment key={item.id}><DropdownMenu.RadioItem value={item.id} className="settings-section-menu__item" data-settings-target={item.id}>
                      <span><DropdownMenu.ItemIndicator><ThemeStatusSelectedIcon size={13} /></DropdownMenu.ItemIndicator></span><Icon size={15} animation={!showResults && (item as SettingsModule).selectionAnimation && active === item.id ? 'selection' : 'none'} aria-hidden="true" />{item.title}
                    </DropdownMenu.RadioItem>
                    {!searching ? (item as SettingsModule).subpages?.map(child => <DropdownMenu.RadioItem key={child.field} value={`${item.id}:${child.field}`} className="settings-section-menu__item settings-section-menu__child" data-settings-target={`${item.id}:${child.field}`}>
                      <span><DropdownMenu.ItemIndicator><ThemeStatusSelectedIcon size={13} /></DropdownMenu.ItemIndicator></span>{child.title}
                    </DropdownMenu.RadioItem>) : null}
                    </Fragment>
                  })}
                </Fragment>)}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <SettingsSidebarNavigation groups={navGroups} selected={showResults ? null : navigationSelection} activeGroup={currentSection?.group}
          navigationGroup={settingsModules.find(candidate => candidate.id === normalizedInitialSection)?.group}
          searching={searching} visible={visible} navigationKey={route} onOpen={openNavigation} />
      </aside>
      {/* The open pane names itself, so a wide resource pane can bring the page header out to its own gutter. */}
      <main className="settings-content" data-settings-active={showResults ? undefined : active}>
        <header className="settings-content__header">
          <div className="settings-content__title">
            <div>
              <div className="settings-content__breadcrumb">{groupTitle}{subpage && !showResults ? ` / ${currentSection?.title}` : ''}</div>
              <h2>{searching && showResults ? section.title : subpage?.title ?? section.title}</h2>
              {section.description ? <p>{section.description}</p> : null}
            </div>
          </div>
          <div className="settings-content__actions">
            <span className="settings-content__hint"><kbd>Esc</kbd><span>{query ? 'Clear search' : 'Close'}</span></span>
            <IconButton className="settings-content__close" type="button" onClick={onClose} aria-label="Close settings" title="Close settings"><ThemeActionCloseIcon size={15} /></IconButton>
          </div>
        </header>
        {searching && showResults ? <SettingsSearchResults results={searchResults} query={query} onChoose={chooseSection} /> : null}
        {active === 'overview' && !(searching && showResults) ? <SettingsOverviewPane config={config} groups={overviewGroups} onOpen={chooseSection} active={visible} notice={unmatchedChannel(navigationRequest)} /> : null}
        {visited.map(pane => pane !== 'goals' && pane !== 'prompts' ? renderPane(pane) : null)}
        <GoalsPromptDraftProvider config={config} enabled={active === 'goals' || active === 'prompts' || visited.includes('goals') || visited.includes('prompts')}>
          {visited.map(pane => pane === 'goals' || pane === 'prompts' ? renderPane(pane) : null)}
        </GoalsPromptDraftProvider>
      </main>
    </div>
    </NodePublicationObservation>
  )
}

export const SettingsPanel = memo(SettingsPanelView)
