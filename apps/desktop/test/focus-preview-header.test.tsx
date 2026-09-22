// @vitest-environment happy-dom
import { act, useEffect, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { SessionSnapshot } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { tabForFocusedSession } from '../src/renderer/src/lib/focus-tab-projection'
import { executionFocusSessionId } from '../src/renderer/src/lib/agent-focus'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { formatRegionAddress } from '../src/renderer/src/lib/agent-address'
import { openAgentHistory } from './helpers/agent-history-menu'

const paint = vi.hoisted(() => ({ mounts: {} as Record<string, number>, refresh: vi.fn(async () => {}) }))
const panels = vi.hoisted(() => ({ handles: [] as Array<{ getLayout(): number[] }> }))
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  const { forwardRef, useCallback } = await import('react')
  const actual: typeof import('react-resizable-panels') = createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
  return { ...actual, PanelGroup: forwardRef<import('react-resizable-panels').ImperativePanelGroupHandle, import('react-resizable-panels').PanelGroupProps>((props, ref) => {
    const capture = useCallback((handle: import('react-resizable-panels').ImperativePanelGroupHandle | null) => {
      if (handle && !panels.handles.includes(handle)) panels.handles.push(handle)
      if (typeof ref === 'function') ref(handle); else if (ref) ref.current = handle
    }, [ref])
    return <actual.PanelGroup {...props} ref={capture} />
  }) }
})
// Isolate PTY paint only. SessionPane, Header, History, menus and Store are production owners.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session, onObservationRefresh }: {
  session: SessionSnapshot; onObservationRefresh?: (refresh: (() => Promise<void>) | null) => void
}) => {
  useEffect(() => { paint.mounts[session.id] = (paint.mounts[session.id] ?? 0) + 1 }, [session.id])
  useLayoutEffect(() => { onObservationRefresh?.(paint.refresh); return () => onObservationRefresh?.(null) }, [onObservationRefresh])
  return <div data-terminal-paint={session.id}><textarea aria-label={`Fixture PTY ${session.id}`} /></div>
} }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { SessionPane } from '../src/renderer/src/components/SessionPane'

const initial = useAppStore.getState(), workspaceId = 'workspace-demo', tabId = 'header-single', regionId = 'header-agent'
const name = 'Layout coordinator · recovery audit'
let root: Root, container: HTMLDivElement, sessionIds: string[]

// Same existing App projection seam: one Workbench owner survives surface/Focus changes.
// No new App seam is added by this slice. Both sides load their actual Global/Workbench callers.
function Workface({ showGlobal = true }: { showGlobal?: boolean }) {
  const surface = useAppStore(state => state.mainSurface)
  const tabs = useAppStore(state => state.tabs)
  const id = useAppStore(state => executionFocusSessionId(state.agentFocus))
  const focused = surface === 'agents' ? tabForFocusedSession(tabs, id) : null
  return <>{surface === 'agents' && showGlobal ? <GlobalFocusSurface /> : null}<WorkspaceWorkbench workspaceId={workspaceId}
    visible focusTabId={focused?.id ?? null} focusPortalTargetId={focused ? 'focus-workspace-slot' : null} /></>
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  paint.mounts = {}; paint.refresh.mockClear(); panels.handles = []
  const sessions = (await api.sessions.snapshot()).sessions.filter(s => s.kind === 'agent').slice(0, 2)
    .map(session => ({ ...session, processState: 'running' as const }))
  expect(sessions).toHaveLength(2); sessionIds = sessions.map(s => s.id)
  const tab = createWorkbenchTab(tabId, { regionId, kind: 'agent', phase: 'attached', workspaceId, sessionId: sessionIds[0]! })
  const neighbor = createWorkbenchTab('header-neighbor', { regionId: 'neighbor-agent', kind: 'agent', phase: 'attached', workspaceId, sessionId: sessionIds[1]! })
  useAppStore.setState({ ...initial, config: await api.config.get(), sessions, tabs: { [tabId]: tab, [neighbor.id]: neighbor },
    layouts: { [workspaceId]: createWorkspaceLayout('header-group', [tabId, neighbor.id]) }, activeWorkspaceId: workspaceId, mainSurface: 'agents',
    agentNames: { [sessionIds[0]!]: name, [sessionIds[1]!]: 'Neighbor reviewer' }, agentComposerDrafts: { [sessionIds[0]!]: 'Keep the draft', [sessionIds[1]!]: 'Neighbor draft' },
    viewModes: Object.fromEntries(sessionIds.map(id => [id, 'terminal'])) }, true)
  useAppStore.getState().focusExecutionSession(sessionIds[0]!)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); document.body.replaceChildren()
  useAppStore.setState(initial, true); vi.unstubAllGlobals(); vi.restoreAllMocks()
})
async function mount() { await act(async () => root.render(<Workface />)) }
function toolbar() { const bar = container.querySelector<HTMLElement>('.focus-toolbar'); expect(bar).not.toBeNull(); return bar! }
function region(id = regionId) { const node = container.querySelector<HTMLElement>(`[data-workbench-region-id="${id}"]`); expect(node).not.toBeNull(); return node! }
function localHeaderName(scope: ParentNode = region()) {
  const text = scope.querySelector<HTMLElement>('.agent-region-header__name')
  expect(text, 'original local Header identity is nonempty').not.toBeNull()
  return text!.textContent
}
async function regionMenu(scope: ParentNode) {
  const trigger = scope.querySelector<HTMLButtonElement>('.agent-region-header__more'); expect(trigger).not.toBeNull()
  await act(async () => { trigger!.focus(); trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await act(async () => vi.waitFor(() => expect(document.querySelector('.agent-region-menu [role="menuitem"]')).not.toBeNull()))
  const menu = document.querySelector<HTMLElement>('.agent-region-menu')!; expect(menu.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0); return menu
}
function item(menu: HTMLElement, text: string) {
  const found = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(x => x.textContent?.trim() === text)
  expect(found, `actual ${text}`).toBeDefined(); return found!
}

it('puts the original single Agent controls in the Focus bar with one identity and no second local header row', async () => {
  await mount()
  expect(toolbar().querySelector('.focus-toolbar__identity strong')!.textContent).toBe(name)
  expect(toolbar().querySelectorAll('.agent-region-header')).toHaveLength(1)
  expect(region().querySelectorAll('.agent-region-header')).toHaveLength(0)
  expect(toolbar().querySelectorAll('.agent-region-header__name')).toHaveLength(0)
  expect(toolbar().querySelector('.agent-region-header')!.getAttribute('aria-label')).toContain(sessionIds[0]!)
  expect(region().querySelectorAll('[aria-label="Close split"]')).toHaveLength(0)
})

it('runs History/return and observation refresh through the same SessionPane, preserving its paint and exact Region address', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const history = vi.spyOn(api.sessions, 'historyPage')
  await mount(); const originalPaint = region().querySelector('[data-terminal-paint]')
  expect(history.mock.calls).toEqual([[useAppStore.getState().sessions[0]!.control, { limit: 30 }]])
  const initialReads = history.mock.calls.length
  await openAgentHistory(toolbar())
  expect(region().querySelector('[aria-label="Conversation history"]')).not.toBeNull()
  expect(history.mock.calls.slice(initialReads)).toEqual([[useAppStore.getState().sessions[0]!.control, undefined]])
  const back = region().querySelector<HTMLButtonElement>('.session-history__toolbar button'); expect(back?.textContent?.trim()).toBe('Terminal')
  await act(async () => back!.click())
  expect(region().querySelector('[aria-label="Conversation history"]')).toBeNull()
  expect(region().querySelector('[data-terminal-paint]')).toBe(originalPaint)
  const menu = await regionMenu(toolbar())
  await act(async () => item(menu, 'Refresh observation').click()); expect(paint.refresh).toHaveBeenCalledTimes(1)
  const again = await regionMenu(toolbar())
  expect(again.dataset.ownerRegionId).toBe(regionId); expect(again.dataset.agentSessionId).toBe(sessionIds[0])
  await act(async () => item(again, 'Copy Region Address').click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(formatRegionAddress(regionId))
  expect(useAppStore.getState().agentComposerDrafts[sessionIds[0]!]).toBe('Keep the draft')
  expect(paint.mounts).toEqual({ [sessionIds[0]!]: 1, [sessionIds[1]!]: 1 })
})

it('keeps multi-Agent headers/real Panels and the exact original Region menu while its neighbor is active', async () => {
  const before = useAppStore.getState(), tab = addWorkbenchRegion(before.tabs[tabId]!, regionId, 'right', {
    regionId: 'split-neighbor', kind: 'agent', phase: 'attached', workspaceId, sessionId: sessionIds[1]!
  })
  useAppStore.setState({ tabs: { ...before.tabs, [tabId]: tab } })
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await mount()
  expect(toolbar().querySelectorAll('.agent-region-header')).toHaveLength(0)
  const target = container.querySelector('#focus-workspace-slot')!; expect(target.querySelectorAll('[data-panel]')).toHaveLength(2)
  expect(panels.handles).toHaveLength(1); expect(panels.handles[0]!.getLayout()).toEqual([50, 50])
  expect(target.querySelectorAll('.agent-region-header')).toHaveLength(2)
  const menu = await regionMenu(region())
  await act(async () => useAppStore.getState().focusRegion(workspaceId, tabId, 'split-neighbor', 'pointer'))
  await act(async () => item(menu, 'Copy Region Address').click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(formatRegionAddress(regionId))
  expect(useAppStore.getState().tabs[tabId]!.layout.activeRegionId).toBe('split-neighbor')
  expect(useAppStore.getState().agentComposerDrafts[sessionIds[1]!]).toBe('Neighbor draft')
  expect(target.querySelectorAll('[aria-label="Close split"]')).toHaveLength(2)
})

it('retains the original single owner across History, Space, Focus rename and projection close without adding Tab close', async () => {
  const stop = vi.spyOn(api.sessions, 'stop'), close = vi.spyOn(useAppStore.getState(), 'closeRegion')
  await mount(); const before = useAppStore.getState(), originalPaint = region().querySelector('[data-terminal-paint]')
  await openAgentHistory(toolbar())
  const identity = toolbar().querySelector<HTMLButtonElement>('.focus-toolbar__identity')!
  await act(async () => { identity.focus(); identity.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })) })
  const focusMenu = document.querySelector<HTMLElement>('[role="menu"]')!; expect(focusMenu).not.toBeNull()
  expect([...focusMenu.querySelectorAll('[role="menuitem"]')].map(x => x.textContent?.trim())).toEqual(['Rename Agent', 'Continue in Space', 'Close Focus workspace'])
  await act(async () => item(focusMenu, 'Rename Agent').click())
  const rename = toolbar().querySelector<HTMLInputElement>('[aria-label="Rename Focus context"]')!; expect(document.activeElement).toBe(rename)
  await act(async () => rename.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(useAppStore.getState().agentNames[sessionIds[0]!]).toBe(name)
  expect(document.activeElement).toBe(toolbar().querySelector('.focus-toolbar__identity'))
  const currentIdentity = toolbar().querySelector<HTMLButtonElement>('.focus-toolbar__identity')!
  await act(async () => currentIdentity.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })))
  const spaceMenu = document.querySelector<HTMLElement>('[role="menu"]')!; expect(spaceMenu).not.toBeNull()
  await act(async () => item(spaceMenu, 'Continue in Space').click())
  expect(localHeaderName()).toBe(name)
  expect(region().querySelector('[aria-label="Conversation history"]')).not.toBeNull()
  expect(region().querySelector('[data-terminal-paint]')).toBe(originalPaint)
  await act(async () => useAppStore.getState().setMainSurface('agents'))
  expect(toolbar().querySelectorAll('.agent-region-header')).toHaveLength(1)
  expect(region().querySelector('[aria-label="Conversation history"]')).not.toBeNull()
  await act(async () => toolbar().querySelector<HTMLButtonElement>('[aria-label="Close Focus workspace"]')!.click())
  expect(document.activeElement).toBe(container.querySelector('[aria-label="Search contexts"]'))
  expect(executionFocusSessionId(useAppStore.getState().agentFocus)).toBeNull()
  expect(localHeaderName()).toBe(name)
  expect(useAppStore.getState().tabs).toEqual(before.tabs); expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(close).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  expect(paint.mounts).toEqual({ [sessionIds[0]!]: 1, [sessionIds[1]!]: 1 })
})

it('returns a retained but currently unconfirmed durable owner to its original local Header', async () => {
  await mount(); const originalPaint = region().querySelector('[data-terminal-paint]'), before = useAppStore.getState()
  await act(async () => useAppStore.setState({ layouts: {} }))
  expect(container.textContent).toContain('Workspace layout is still restoring')
  expect(toolbar().querySelectorAll('.agent-region-header')).toHaveLength(0)
  expect(localHeaderName()).toBe(name)
  expect(region().querySelector('[data-terminal-paint]')).toBe(originalPaint)
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().sessions).toBe(before.sessions)
})

it('keeps a read-only SessionPane Header local even if a presentation target exists', async () => {
  await act(async () => root.render(<><div id="focus-workspace-slot-header" /><SessionPane sessionId={sessionIds[0]!} surfaceKind="agent"
    visible interactiveResize={false} readOnly headerPortalTargetId="focus-workspace-slot-header" linkOrigin={{ workspaceId, tabGroupId: 'header-group', tabId, regionId }} /></>))
  expect(container.querySelector('#focus-workspace-slot-header')!.childElementCount).toBe(0)
  const header = container.querySelector('.agent-surface .agent-region-header'); expect(header).not.toBeNull()
  expect(header!.querySelector('strong')!.textContent).toBe(name); expect(header!.textContent).toContain('Read-only')
  expect(container.querySelectorAll('.composer')).toHaveLength(0)
})

it('keeps mixed file/Agent controls local and the original dirty-close cancellation bound to the precise file Region', async () => {
  const state = useAppStore.getState(), mixed = addWorkbenchRegion(state.tabs[tabId]!, regionId, 'right', {
    regionId: 'dirty-file', kind: 'file', workspaceId, path: 'notes.md'
  })
  useAppStore.setState({ tabs: { ...state.tabs, [tabId]: mixed }, dirtyDocuments: { [documentKey(workspaceId, 'notes.md')]: true } })
  await mount()
  expect(toolbar().querySelectorAll('.agent-region-header')).toHaveLength(0)
  expect(localHeaderName()).toBe(name)
  const before = useAppStore.getState(), file = region('dirty-file')
  await act(async () => file.querySelector<HTMLButtonElement>('[aria-label="Close split"]')!.click())
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]'); expect(dialog).not.toBeNull(); expect(dialog!.textContent).toContain('Discard unsaved changes?')
  const cancel = [...dialog!.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent?.trim() === 'Cancel'); expect(cancel).toBeDefined()
  await act(async () => cancel!.click())
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(region('dirty-file').querySelector('[aria-label="Close split"]')).not.toBeNull()
})

it('does no further slot lookup or History I/O for unrelated observation timestamp or DOM output after attachment', async () => {
  const lookup = vi.spyOn(document, 'getElementById'), history = vi.spyOn(api.sessions, 'historyPage')
  const headerLookups = () => lookup.mock.calls.filter(([id]) => id === 'focus-workspace-slot-header').length
  await mount(); const host = toolbar().querySelector('.agent-region-header-host'), beforeLookups = headerLookups()
  expect(host).not.toBeNull(); expect(beforeLookups).toBeGreaterThan(0)
  expect(history.mock.calls).toEqual([[useAppStore.getState().sessions[0]!.control, { limit: 30 }]])
  const initialReads = history.mock.calls.length
  const before = useAppStore.getState(), originalPaint = region().querySelector('[data-terminal-paint]')
  await act(async () => {
    useAppStore.setState({ sessions: before.sessions.map(session => session.id === sessionIds[1] ? {
      ...session, status: { ...session.status, observedAt: session.status.observedAt + 1 }
    } : session) })
    container.append(document.createElement('span')); await new Promise(resolve => setTimeout(resolve, 0))
  })
  expect(headerLookups()).toBe(beforeLookups); expect(history.mock.calls.slice(initialReads)).toEqual([])
  expect(toolbar().querySelector('.agent-region-header-host')).toBe(host); expect(region().querySelector('[data-terminal-paint]')).toBe(originalPaint)
})

it('keeps the local Header until a delayed controlled Focus slot arrives, then moves the same host and paint once', async () => {
  await act(async () => root.render(<Workface showGlobal={false} />))
  const header = region().querySelector('.agent-region-header'), paintNode = region().querySelector('[data-terminal-paint]')
  expect(header).not.toBeNull(); expect(header!.querySelector('strong')!.textContent).toBe(name)
  await act(async () => { root.render(<Workface />); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(toolbar().querySelector('.agent-region-header')).toBe(header)
  expect(region().querySelectorAll('.agent-region-header')).toHaveLength(0)
  expect(region().querySelector('[data-terminal-paint]')).toBe(paintNode)
  expect(paint.mounts).toEqual({ [sessionIds[0]!]: 1, [sessionIds[1]!]: 1 })
})

it('keeps a durable Region with an unobserved Session in the original connecting surface without manufacturing merged controls', async () => {
  const before = useAppStore.getState()
  useAppStore.setState({ sessions: before.sessions.filter(session => session.id !== sessionIds[0]) })
  await mount()
  expect(toolbar().querySelectorAll('.agent-region-header')).toHaveLength(0)
  expect(region().querySelector('[data-agent-surface-mode="connecting"]')).not.toBeNull()
  expect(region().querySelector('[role="status"]')).not.toBeNull()
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual([sessionIds[1]])
})
