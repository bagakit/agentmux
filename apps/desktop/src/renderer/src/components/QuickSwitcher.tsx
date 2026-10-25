import { useWorkbenchDocument } from '../lib/workbench-document'
import { TextInput } from '@agentmux/client-ui/input'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { attentionAccentFor } from '../lib/attention-event'
import {
  buildQuickSwitchIndex,
  rankQuickSwitchItems,
  type QuickSwitchItem
} from '../lib/quick-switch'
import { tabGroupForTab } from '../lib/workbench-tabs'
import { isImeCompositionKeyDown } from '../lib/ime-composition-keyboard-event'
import { AgentAvatar } from './AgentAvatar'
import { StatusDot } from './StatusDot'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { useAppStore } from '../store'
import { QuickOpenFiles } from './QuickOpenFiles'
import { desktopElementVisible } from '../lib/desktop-presentation'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'

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
// already ships (BranchesPanel, BoardDiscussionCanvas) rather than adding a second modal primitive,
// and every activation runs through the Store verbs that are already the only way to switch:
// selectSession for a session row, activateTab for a tab row. Ranking is state-aware (quick-switch.ts)
// so the agents that need you float to the top: the switcher doubles as an attention router.

function KindGlyph({ item }: { item: QuickSwitchItem }) {
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
  const scratchTopicSnapshots = useAppStore(state => state.scratchTopicSnapshots)
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const tabs = useAppStore((state) => state.tabs)
  const layouts = useAppStore((state) => state.layouts)
  const selectSession = useAppStore((state) => state.selectSession)
  const activateTab = useAppStore((state) => state.activateTab)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [mode, setMode] = useState<'sessions' | 'files'>('sessions')
  const listRef = useRef<HTMLDivElement>(null)
  const queryRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const activated = useRef(false)
  const optionId = useId()

  const items = useMemo(
    () => open && mode === 'sessions' ?
      buildQuickSwitchIndex({ topics: scratchTopicsForConfig(config, scratchTopicSnapshots),
        config,
        sessions,
        tabs,
        tabGroupOf: (workspaceId, tabId) => tabGroupForTab(layouts[workspaceId], tabId)
      }) : [],
    [open, mode, config, scratchTopicSnapshots, sessions, tabs, layouts]
  )
  const results = useMemo(() => open && mode === 'sessions' ? rankQuickSwitchItems(items, query) : [], [open, mode, items, query])

  // The highlighted row must always sit within the current results, so any narrowing of the list
  // pins the selection back to the first (best-ranked, above-the-fold) row.
  useEffect(() => setActiveIndex(0), [query])
  // A fresh open starts clean: empty query, top row highlighted.
  useEffect(() => {
    if (open) {
      activated.current = false
      setQuery('')
      setActiveIndex(0)
    }
  }, [open])

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, results])

  function activate(item: QuickSwitchItem | undefined): void {
    if (!item) return
    activated.current = true
    if (item.target.kind === 'session') selectSession(item.target.sessionId)
    else activateTab(item.target.workspaceId, item.target.tabGroupId, item.target.tabId)
    onClose()
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DocumentOverlayPortal component={Dialog.Portal}>
        <Dialog.Overlay className="quick-switch__overlay dialog-scrim" />
        <Dialog.Content
          ref={contentRef}
          className="quick-switch dialog-surface"
          aria-label={mode === 'files' ? 'Open a project file' : 'Jump to a session or tab'}
          onOpenAutoFocus={event => {
            const field = contentRef.current?.querySelector<HTMLInputElement>('[role="combobox"]')
            if (field) { event.preventDefault(); field.focus({ preventScroll: true }) }
          }}
          onCloseAutoFocus={event => {
            event.preventDefault()
            if (activated.current) return
            const target = returnFocus?.(), active = ownerDocument.activeElement
            if (target && desktopElementVisible(target) &&
                (active === ownerDocument.body || active === target || !active?.isConnected || contentRef.current?.contains(active))) target.focus({ preventScroll: true })
          }}
          onKeyDown={(event) => {
            if (mode === 'files' || event.target !== queryRef.current) return
            // 组字确认用的 Enter（CJK 输入法）不能激活选中项，否则一次组字确认会误跳到某个会话/标签。
            if (isImeCompositionKeyDown(event)) return
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActiveIndex((index) => Math.min(index + 1, results.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActiveIndex((index) => Math.max(index - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              activate(results[activeIndex])
            }
          }}
        >
          <Dialog.Title className="quick-switch__title">{mode === 'files' ? 'Open a project file' : 'Jump to a session or tab'}</Dialog.Title>
          <Dialog.Description className="quick-switch__description">
            {mode === 'files' ? 'Search project file names. Add a line and column to reveal source.' : 'Search by name or amux Agent ID. Agents that need you rank first.'}
          </Dialog.Description>
          <SurfaceModeSwitch className="quick-switch__modes" ariaLabel="Quick switch mode" semantics="pressed" active={open} value={mode}
            options={[{ value: 'sessions', label: 'Sessions & tabs' }, { value: 'files', label: 'Project files' }]} onChange={setMode} />
          {mode === 'files' ? open ? <QuickOpenFiles onClose={() => { activated.current = true; onClose() }} /> : null : <>
          <div className="quick-switch__input">
            <ThemeActionSearchIcon size={15} />
            {/* autoFocus is honest here: the dialog exists only to take this query. */}
            <TextInput
              ref={queryRef}
              autoFocus
              value={query}
              placeholder="Search sessions, tabs or amux ID…"
              aria-label="Search sessions and tabs"
              role="combobox"
              aria-expanded={results.length > 0}
              aria-autocomplete="list"
              aria-activedescendant={results[activeIndex] ? `${optionId}-${activeIndex}` : undefined}
              aria-controls="quick-switch-list"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {results.length === 0 ? (
            <div className="quick-switch__empty" role="status">
              {query.trim() ? <>No open session or tab matches “{query.trim()}”.</> : 'No open sessions or tabs yet.'}
            </div>
          ) : null}
          <div className="quick-switch__list" id="quick-switch-list" role="listbox" aria-label="Sessions and tabs" ref={listRef} hidden={results.length === 0}>
            {results.map((item, index) => (
                <button
                  key={item.id}
                  id={`${optionId}-${index}`}
                  type="button"
                  tabIndex={-1}
                  role="option"
                  aria-selected={index === activeIndex}
                  data-active={index === activeIndex}
                  data-attention={item.state === null ? undefined : attentionAccentFor(item.state) ?? undefined}
                  className="quick-switch__row"
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => activate(item)}
                >
                  <span className="quick-switch__glyph"><KindGlyph item={item} /></span>
                  <span className="quick-switch__labels">
                    <span className="quick-switch__row-title">{item.title}</span>
                    <span className="quick-switch__row-subtitle">{item.subtitle}</span>
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
