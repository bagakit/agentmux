import * as Dialog from '@radix-ui/react-dialog'
import { CornerDownLeft, FileCode2, Globe2, Search, Sparkles, SquareTerminal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { attentionAccentFor } from '../lib/attention-event'
import {
  buildQuickSwitchIndex,
  rankQuickSwitchItems,
  type QuickSwitchItem
} from '../lib/quick-switch'
import { tabGroupForTab } from '../lib/workbench-tabs'
import { AgentProviderIcon } from './AgentProviderIcon'
import { StatusDot } from './StatusDot'
import { useAppStore } from '../store'

// One modal overlay a single keystroke summons to jump anywhere in the window — any agent session or
// any open non-session tab — without reaching for the mouse. It reuses the Radix Dialog shell the app
// already ships (BranchesPanel, BoardDiscussionCanvas) rather than adding a second modal primitive,
// and every activation runs through the Store verbs that are already the only way to switch:
// selectSession for a session row, activateTab for a tab row. Ranking is state-aware (quick-switch.ts)
// so the agents that need you float to the top: the switcher doubles as an attention router.

function KindGlyph({ item }: { item: QuickSwitchItem }) {
  if (item.kind === 'session') {
    if (item.providerId) return <AgentProviderIcon providerId={item.providerId} size={14} />
    return <SquareTerminal size={13} />
  }
  // Non-session tab rows: file / browser / launcher get their own quiet kind glyph.
  if (item.title === 'New Tab') return <Sparkles size={13} />
  return item.subtitle.includes('://') ? <Globe2 size={13} /> : <FileCode2 size={13} />
}

export function QuickSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const tabs = useAppStore((state) => state.tabs)
  const layouts = useAppStore((state) => state.layouts)
  const selectSession = useAppStore((state) => state.selectSession)
  const activateTab = useAppStore((state) => state.activateTab)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const items = useMemo(
    () =>
      buildQuickSwitchIndex({
        config,
        sessions,
        tabs,
        tabGroupOf: (workspaceId, tabId) => tabGroupForTab(layouts[workspaceId], tabId)
      }),
    [config, sessions, tabs, layouts]
  )
  const results = useMemo(() => rankQuickSwitchItems(items, query), [items, query])

  // The highlighted row must always sit within the current results, so any narrowing of the list
  // pins the selection back to the first (best-ranked, above-the-fold) row.
  useEffect(() => setActiveIndex(0), [query])
  // A fresh open starts clean: empty query, top row highlighted.
  useEffect(() => {
    if (open) {
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
    if (item.target.kind === 'session') selectSession(item.target.sessionId)
    else activateTab(item.target.workspaceId, item.target.tabGroupId, item.target.tabId)
    onClose()
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="quick-switch__overlay" />
        <Dialog.Content
          className="quick-switch"
          aria-label="Jump to a session or tab"
          onKeyDown={(event) => {
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
          <Dialog.Title className="quick-switch__title">Jump to a session or tab</Dialog.Title>
          <Dialog.Description className="quick-switch__description">
            Type to filter open agent sessions and tabs. Agents that need you rank first.
          </Dialog.Description>
          <div className="quick-switch__input">
            <Search size={15} />
            {/* autoFocus is honest here: the dialog exists only to take this query. */}
            <input
              autoFocus
              value={query}
              placeholder="Search sessions and tabs…"
              aria-label="Search sessions and tabs"
              aria-controls="quick-switch-list"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="quick-switch__list" id="quick-switch-list" role="listbox" ref={listRef}>
            {results.length === 0 ? (
              <div className="quick-switch__empty">No open session or tab matches “{query}”.</div>
            ) : (
              results.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
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
                  {item.state ? <StatusDot status={{ state: item.state, source: 'native-hook', observedAt: item.observedAt }} /> : null}
                </button>
              ))
            )}
          </div>
          <div className="quick-switch__footer">
            <span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span>
            <span><kbd><CornerDownLeft size={11} /></kbd> to open · <kbd>Esc</kbd> to dismiss</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
