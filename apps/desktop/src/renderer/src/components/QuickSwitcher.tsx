import { useWorkbenchDocument } from '../lib/workbench-document'
import { TextInput } from '@agentmux/client-ui/input'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { attentionAccentFor } from '../lib/attention-event'
import {
  buildQuickSwitchIndex,
  buildSessionLocationItems,
  rankQuickSwitchItems,
  type QuickSwitchItem
} from '../lib/quick-switch'
import { sessionWorkbenchLocationChoices, workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { workbenchDocumentIdentity } from '../lib/workbench-window-registry'
import { focusWorkbenchWindow } from '../lib/workbench-windows'
import { tabGroupForTab } from '../lib/workbench-tabs'
import { isImeCompositionKeyDown } from '../lib/ime-composition-keyboard-event'
import { AgentAvatar } from './AgentAvatar'
import { StatusDot } from './StatusDot'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { agentRegionExecutionForSession, useAppStore } from '../store'
import { sessionPresentationById } from '../lib/session-presentation'
import { QuickOpenFiles } from './QuickOpenFiles'
import { desktopElementVisible } from '../lib/desktop-presentation'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'

const NO_ITEMS: QuickSwitchItem[] = []

const ThemeSpaceIcon = semanticIconComponent('navigation.space')
const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')
const ThemeObjectLauncherIcon = semanticIconComponent('object.launcher')
const ThemeObjectBrowserIcon = semanticIconComponent('object.browser')
const ThemeFileCodeIcon = semanticIconComponent('file.code')
const ThemeGitCompareIcon = semanticIconComponent('git.compare')
const ThemeActionSearchIcon = semanticIconComponent('action.search')
const ThemeKeyEnterIcon = semanticIconComponent('control.key-enter')
const ThemeKeyUpIcon = semanticIconComponent('control.key-up')
const ThemeKeyDownIcon = semanticIconComponent('control.key-down')


// One modal overlay a single keystroke summons to jump anywhere in the window — any agent session or
// any open non-session tab — without reaching for the mouse. It reuses the Radix Dialog shell the app
// already ships (BranchesPanel) rather than adding a second modal primitive,
// and every activation runs through the Store verbs that are already the only way to switch:
// selectSession for a session row, activateTab for a tab row. Ranking is state-aware (quick-switch.ts)
// so the agents that need you float to the top: the switcher doubles as an attention router.

function KindGlyph({ item }: { item: QuickSwitchItem }) {
  if (item.kind === 'location') return <ThemeSpaceIcon size={13} />
  if (item.kind === 'session') {
    if (item.providerId) return <AgentAvatar label={item.title} sessionId={item.target.kind === 'session' ? item.target.sessionId : undefined} state={item.state ?? undefined} providerId={item.providerId} size={14} />
    return <ThemeObjectTerminalIcon size={13} />
  }
  // Non-session tab rows take their glyph from the typed surface kind, never from title or subtitle text.
  switch (item.surfaceKind) {
    case 'launcher': return <ThemeObjectLauncherIcon size={13} />
    case 'browser': return <ThemeObjectBrowserIcon size={13} />
    case 'git':
    case 'git-diff': return <ThemeGitCompareIcon size={13} />
    case 'file': return <ThemeFileCodeIcon size={13} />
    case 'agent':
    case 'terminal':
    case null: return <ThemeObjectTerminalIcon size={13} />
    default: {
      const unhandled: never = item.surfaceKind
      // Keep compile-time exhaustiveness without making an unknown glyph a navigation failure.
      void unhandled
      return <ThemeObjectTerminalIcon size={13} />
    }
  }
}

export function QuickSwitcher({ open, onClose, returnFocus }: { open: boolean; onClose: () => void; returnFocus?: () => HTMLElement | null }) {
  const ownerDocument = useWorkbenchDocument()
  const locationRequest = useAppStore(state => state.sessionLocationRequest)
  const chooseLocation = useAppStore(state => state.chooseSessionLocation)
  const dismissLocation = useAppStore(state => state.dismissSessionLocationRequest)
  const spaceZoneBindings = useAppStore(state => state.spaceZoneBindings)
  const topicCategories = useAppStore(state => state.topicCategories)
  const projectGroups = useAppStore(state => state.projectGroups)
  const scratchTopicSnapshots = useAppStore(state => state.scratchTopicSnapshots)
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const tabs = useAppStore((state) => state.tabs)
  const layouts = useAppStore((state) => state.layouts)
  const selectSession = useAppStore((state) => state.selectSession)
  const activateTab = useAppStore((state) => state.activateTab)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [activeLocationId, setActiveLocationId] = useState<string | null>(null)
  const [windowIssue, setWindowIssue] = useState<string | null>(null)
  const [mode, setMode] = useState<'sessions' | 'files'>('sessions')
  const listRef = useRef<HTMLDivElement>(null)
  const queryRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const activated = useRef(false)
  const optionId = useId()
  const localOrigin = useRef<HTMLElement | null>(null)
  const useShortcutOrigin = useRef(false)
  const previousRequest = useRef<string | undefined>(undefined)
  const wasOpen = useRef(false)
  const isOpen = open || Boolean(locationRequest)
  const effectiveMode = locationRequest ? 'sessions' : mode
  const requestId = locationRequest?.requestId

  // This is the main window's existing picker. Focus only its registered native document;
  // a late receipt cannot take focus for a newer request or navigate any Session.
  useEffect(() => {
    setWindowIssue(null)
    if (!requestId || ownerDocument.hasFocus()) return
    const identity = workbenchDocumentIdentity(ownerDocument)
    if (!identity) { setWindowIssue('Main window identity is unconfirmed. Choose a location in this window.'); return }
    let current = true
    void focusWorkbenchWindow(identity).then(confirmed => {
      if (!current || useAppStore.getState().sessionLocationRequest?.requestId !== requestId ||
          workbenchDocumentIdentity(ownerDocument) !== identity) return
      setWindowIssue(confirmed ? null : 'Main window focus is unconfirmed. Open this window to choose a location.')
      if (confirmed) queryRef.current?.focus({ preventScroll: true })
    })
    return () => { current = false }
  }, [requestId, ownerDocument])

  const locationItems = useMemo(() => {
    if (!locationRequest) return NO_ITEMS
    const catalog = workbenchSelectionCatalog(useAppStore.getState())
    let references = sessionWorkbenchLocationChoices(tabs, catalog, locationRequest.sessionId, locationRequest.groupId)
    const subject = locationRequest.subject
    if (subject?.expectedRunId !== undefined) {
      const session = sessionPresentationById(sessions).get(locationRequest.sessionId)
      references = session?.control.run.runId === subject.expectedRunId ? references.filter(reference => {
        const execution = agentRegionExecutionForSession(reference, session)
        return execution?.hostId === subject.hostId && execution.runtimeId === subject.runtimeId
      }) : []
    }
    return buildSessionLocationItems({ label: locationRequest.label, config, tabs, layouts, catalog, references })
  }, [locationRequest, locationRequest?.subject?.expectedRunId === undefined ? null : sessions,
    config, tabs, layouts, scratchTopicSnapshots, spaceZoneBindings, topicCategories, projectGroups])

  const items = useMemo(
    () => open && !locationRequest && mode === 'sessions' ?
      buildQuickSwitchIndex({ topics: scratchTopicsForConfig(config, scratchTopicSnapshots),
        config,
        sessions,
        tabs,
        tabGroupOf: (workspaceId, tabId) => tabGroupForTab(layouts[workspaceId], tabId)
      }) : NO_ITEMS,
    [open, requestId, mode, config, scratchTopicSnapshots, sessions, tabs, layouts]
  )
  const candidates = locationRequest ? locationItems : items
  const results = useMemo(() => isOpen && effectiveMode === 'sessions' ? rankQuickSwitchItems(candidates, query) : NO_ITEMS,
    [isOpen, effectiveMode, candidates, query])
  const highlightedIndex = locationRequest ? results.findIndex(item => item.id === activeLocationId) : activeIndex
  function highlight(index: number) {
    if (locationRequest) setActiveLocationId(results[index]?.id ?? null)
    else setActiveIndex(index)
  }
  function close() {
    if (requestId) dismissLocation(requestId)
    onClose()
  }

  // The highlighted row must always sit within the current results, so any narrowing of the list
  // pins the selection back to the first (best-ranked, above-the-fold) row.
  useEffect(() => { setActiveIndex(0); setActiveLocationId(results[0]?.id ?? null) }, [query, requestId])
  // A fresh open starts clean: empty query, top row highlighted.
  useEffect(() => {
    if (isOpen) {
      useShortcutOrigin.current = open
      if (wasOpen.current && previousRequest.current && requestId !== previousRequest.current && !open) localOrigin.current = null
      previousRequest.current = requestId
      activated.current = false
      setQuery('')
      setActiveIndex(0)
      // Replacing an already-open file picker does not dispatch Dialog open autofocus again.
      if (requestId && wasOpen.current && ownerDocument.hasFocus()) queryRef.current?.focus({ preventScroll: true })
    }
    wasOpen.current = isOpen
  }, [isOpen, requestId])

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex, results])

  function activate(item: QuickSwitchItem | undefined): void {
    if (!item) return
    if (item.target.kind === 'session-location') {
      if (!requestId || !chooseLocation(requestId, item.target.reference)) return
    } else if (item.target.kind === 'session') {
      if (!selectSession(item.target.sessionId)) return
    } else activateTab(item.target.workspaceId, item.target.tabGroupId, item.target.tabId)
    activated.current = true
    onClose()
  }

  return (
    <Dialog.Root open={isOpen} onOpenChange={(next) => !next && close()}>
      <DocumentOverlayPortal component={Dialog.Portal}>
        <Dialog.Overlay className="quick-switch__overlay dialog-scrim" />
        <Dialog.Content
          ref={contentRef}
          className="quick-switch dialog-surface"
          data-session-locations={Boolean(locationRequest)}
          aria-label={locationRequest ? 'Choose a Session location' : effectiveMode === 'files' ? 'Open a project file' : 'Jump to a session or tab'}
          onOpenAutoFocus={event => {
            if (requestId && !open) {
              const origin = ownerDocument.activeElement
              localOrigin.current = origin instanceof HTMLElement && origin !== ownerDocument.body && !contentRef.current?.contains(origin) ? origin : null
            }
            const field = contentRef.current?.querySelector<HTMLInputElement>('[role="combobox"]')
            if (field) { event.preventDefault(); field.focus({ preventScroll: true }) }
          }}
          onCloseAutoFocus={event => {
            event.preventDefault()
            if (activated.current) return
            const target = useShortcutOrigin.current ? returnFocus?.() : localOrigin.current, active = ownerDocument.activeElement
            if (target && desktopElementVisible(target) &&
                (active === ownerDocument.body || active === target || !active?.isConnected || contentRef.current?.contains(active))) target.focus({ preventScroll: true })
          }}
          onKeyDown={(event) => {
            if (effectiveMode === 'files' || event.target !== queryRef.current) return
            // 组字确认用的 Enter（CJK 输入法）不能激活选中项，否则一次组字确认会误跳到某个会话/标签。
            if (isImeCompositionKeyDown(event)) return
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              highlight(Math.min(highlightedIndex + 1, results.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              highlight(Math.max(highlightedIndex - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              activate(results[highlightedIndex])
            }
          }}
        >
          <Dialog.Title className="quick-switch__title">{locationRequest ? 'Choose a Session location' : effectiveMode === 'files' ? 'Open a project file' : 'Jump to a session or tab'}</Dialog.Title>
          <Dialog.Description className="quick-switch__description">
            {locationRequest ? `Choose an existing location for ${locationRequest.label}.` : effectiveMode === 'files' ? 'Search project file names. Add a line and column to reveal source.' : 'Search by name or amux Agent ID. Agents that need you rank first.'}
          </Dialog.Description>
          {locationRequest && <div className="quick-switch__scope"><strong>Choose a location</strong><span>{locationRequest.label}</span></div>}
          {!locationRequest && <SurfaceModeSwitch className="quick-switch__modes" ariaLabel="Quick switch mode" semantics="pressed" active={open} value={mode}
            options={[{ value: 'sessions', label: 'Sessions & tabs' }, { value: 'files', label: 'Project files' }]} onChange={setMode} />}
          {(locationRequest?.issue || windowIssue) && <p className="quick-switch__notice" role="status">{locationRequest?.issue || windowIssue}</p>}
          {locationRequest && activeLocationId && highlightedIndex < 0 && !query && results.length > 0 && <p className="quick-switch__notice" role="status">The highlighted location changed. Choose a current location.</p>}
          {effectiveMode === 'files' ? open ? <QuickOpenFiles onClose={() => { activated.current = true; onClose() }} /> : null : <>
          <div className="quick-switch__input">
            <ThemeActionSearchIcon size={15} />
            <TextInput
              ref={queryRef}
              autoFocus={!locationRequest}
              value={query}
              placeholder={locationRequest ? "Search locations…" : "Search sessions, tabs or amux ID…"}
              aria-label={locationRequest ? "Search Session locations" : "Search sessions and tabs"}
              role="combobox"
              aria-expanded={results.length > 0}
              aria-autocomplete="list"
              aria-activedescendant={results[highlightedIndex] ? `${optionId}-${highlightedIndex}` : undefined}
              aria-controls="quick-switch-list"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {results.length === 0 ? (
            <div className="quick-switch__empty" role="status">
              {locationRequest ? query.trim() ? <>No location matches “{query.trim()}”.</> : 'No confirmed locations remain. The original Session and work are kept.' : query.trim() ? <>No open session or tab matches “{query.trim()}”.</> : 'No open sessions or tabs yet.'}
            </div>
          ) : null}
          <div className="quick-switch__list" id="quick-switch-list" role="listbox" aria-label={locationRequest ? "Session locations" : "Sessions and tabs"} ref={listRef} hidden={results.length === 0}>
            {results.map((item, index) => (
                <button
                  key={item.id}
                  id={`${optionId}-${index}`}
                  type="button"
                  title={item.target.kind === 'session-location' ? JSON.stringify(item.target.reference) : undefined}
                  tabIndex={-1}
                  role="option"
                  aria-selected={index === highlightedIndex}
                  data-active={index === highlightedIndex}
                  data-kind={item.kind}
                  data-attention={item.state === null ? undefined : attentionAccentFor(item.state) ?? undefined}
                  className="quick-switch__row"
                  onMouseMove={() => highlight(index)}
                  onClick={() => activate(item)}
                >
                  <span className="quick-switch__glyph"><KindGlyph item={item} /></span>
                  <span className="quick-switch__labels">
                    <span className="quick-switch__row-title" title={item.title}>{item.title}</span>
                    <span className="quick-switch__row-subtitle" title={item.subtitle}>{item.subtitle}</span>
                  </span>
                  {item.state && !item.providerId ? <StatusDot status={{ state: item.state, source: 'native-hook' }} /> : null}
                </button>
              ))}
          </div>
          </>}
          <div className="quick-switch__footer">
            <span><kbd aria-label="Up arrow"><ThemeKeyUpIcon size={11} /></kbd><kbd aria-label="Down arrow"><ThemeKeyDownIcon size={11} /></kbd> to navigate</span>
            <span><kbd aria-label="Enter"><ThemeKeyEnterIcon size={11} /></kbd> to open · <kbd>Esc</kbd> to dismiss</span>
          </div>
        </Dialog.Content>
      </DocumentOverlayPortal>
    </Dialog.Root>
  )
}
