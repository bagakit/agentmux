// @vitest-environment happy-dom
import { act, useEffect, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { tabForFocusedSession } from '../src/renderer/src/lib/focus-tab-projection'
import { executionFocusSessionId } from '../src/renderer/src/lib/agent-focus'
import { openAgentHistory } from './helpers/agent-history-menu'

// Only PTY/xterm paint is isolated. Actual Store, SessionPane, Header, History,
// Activity, Composer, Global, Workbench and shared menus load the complete pinned candidate.
const paint = vi.hoisted(() => ({ mounts: {} as Record<string, number>, refresh: vi.fn(async () => {}) }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({
  TerminalView: ({ session, onObservationRefresh }: { session: { id: string }; onObservationRefresh?: (cb: (() => Promise<void>) | null) => void }) => {
    useEffect(() => { paint.mounts[session.id] = (paint.mounts[session.id] ?? 0) + 1 }, [session.id])
    useLayoutEffect(() => { onObservationRefresh?.(paint.refresh); return () => onObservationRefresh?.(null) }, [onObservationRefresh])
    return <div data-terminal-paint={session.id}>Isolated PTY paint</div>
  }
}))
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})

const initial = useAppStore.getState()
const workspaceId = 'workspace-demo', tabId = 'history-intake-tab', regionId = 'history-intake-region'
let root: Root, container: HTMLDivElement, ids: string[]
let history: MockInstance<typeof api.sessions.historyPage>
let writes: MockInstance<typeof api.sessions.write>
let recover: MockInstance<typeof initial.recoverSession>
function Workface() {
  const surface = useAppStore(state => state.mainSurface)
  const tabs = useAppStore(state => state.tabs)
  const id = useAppStore(state => executionFocusSessionId(state.agentFocus))
  const focused = surface === 'agents' ? tabForFocusedSession(tabs, id) : null
  return <>{surface === 'agents' ? <GlobalFocusSurface /> : null}<WorkspaceWorkbench workspaceId={workspaceId}
    visible focusTabId={focused?.id ?? null} focusPortalTargetId={focused ? 'focus-workspace-slot' : null} /></>
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  paint.mounts = {}; paint.refresh.mockClear()
  const sessions = (await api.sessions.snapshot()).sessions.filter(s => s.kind === 'agent').slice(0, 2)
    .map(s => ({ ...s, processState: 'running' as const }))
  expect(sessions).toHaveLength(2); ids = sessions.map(s => s.id)
  const tab = createWorkbenchTab(tabId, { regionId, kind: 'agent', phase: 'attached', workspaceId, sessionId: ids[0]! })
  const neighbor = createWorkbenchTab('history-intake-neighbor', { regionId: 'history-intake-neighbor-region', kind: 'agent', phase: 'attached', workspaceId, sessionId: ids[1]! })
  useAppStore.setState({ ...initial, config: await api.config.get(), sessions, tabs: { [tab.id]: tab, [neighbor.id]: neighbor },
    layouts: { [workspaceId]: createWorkspaceLayout('history-intake-group', [tab.id, neighbor.id]) },
    activeWorkspaceId: workspaceId, mainSurface: 'agents', agentNames: { [ids[0]!]: 'History intake Agent', [ids[1]!]: 'Neighbor Agent' },
    viewModes: { [ids[0]!]: 'terminal', [ids[1]!]: 'terminal' },
    agentComposerDrafts: { [ids[0]!]: 'Keep target draft', [ids[1]!]: 'Keep neighbor draft' },
    timelines: { [ids[0]!]: { agentSessionId: ids[0]!, revision: 1, items: [{
      id: 'actual-activity-content', agentSessionId: ids[0]!, kind: 'assistant_message', status: 'complete', source: 'native-hook',
      createdAt: 1, updatedAt: 1, title: 'Reply', content: 'Actual Activity message content'
    }] } }
  }, true)
  useAppStore.getState().focusExecutionSession(ids[0]!)
  history = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({
    agentSessionId: control.agentSessionId, source: { providerId: 'codex', nativeSessionId: 'typed-intake-native-source' },
    items: [{ id: 'actual-history-content', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Actual native History content' }] }], nextCursor: null
  }))
  writes = vi.spyOn(api.sessions, 'write')
  recover = vi.spyOn(useAppStore.getState(), 'recoverSession')
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); document.body.replaceChildren()
  useAppStore.setState(initial, true); vi.unstubAllGlobals(); vi.restoreAllMocks()
})
async function mount() { await act(async () => root.render(<Workface />)) }
function region() {
  const node = container.querySelector<HTMLElement>(`[data-workbench-region-id="${regionId}"]`)
  expect(node, 'real target Region mounted').not.toBeNull(); return node!
}
function toolbar() {
  const node = container.querySelector<HTMLElement>('.focus-toolbar')
  expect(node, 'real Focus Header presentation').not.toBeNull(); return node!
}
function stateIdentity() {
  const state = useAppStore.getState()
  return { sessions: state.sessions, tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts,
    controls: state.sessions.filter(s => s.kind === 'agent').map(s => s.control) }
}
async function terminalPositive() {
  await openAgentHistory(toolbar())
  const reader = region().querySelector<HTMLElement>('[aria-label="Conversation history"]')
  expect(reader, 'real History opens from original Header in Terminal').not.toBeNull()
  expect(reader!.hidden).toBe(false)
  expect(reader!.closest('.agent-terminal-stage')?.getAttribute('style') ?? '').not.toContain('display: none')
  expect(reader!.querySelectorAll('[data-history-item-id]')).toHaveLength(1)
  expect(reader!.textContent).toContain('Actual native History content')
  const control = useAppStore.getState().sessions.find(s => s.id === ids[0] && s.kind === 'agent')!.control
  const readerCalls = history.mock.calls.filter(([, options]) => options === undefined)
  expect(readerCalls).toEqual([[control, undefined]])
  const back = reader!.querySelector<HTMLButtonElement>('.session-history__toolbar button')
  expect(back?.textContent?.trim()).toBe('Terminal')
  await act(async () => back!.click())
  expect(region().querySelector('[aria-label="Conversation history"]')).toBeNull()
  return { actualRecordCount: 1, backLabel: 'Terminal', historyCalls: history.mock.calls.length, readerCalls: readerCalls.length }
}

function visibleReader() {
  const node = region().querySelector<HTMLElement>('[aria-label="Conversation history"]')
  expect(node, 'actual visible native reader').not.toBeNull()
  expect(node!.hidden).toBe(false)
  expect(node!.closest('.agent-terminal-stage')?.getAttribute('style') ?? '').not.toContain('display: none')
  expect(node!.querySelectorAll('[data-history-item-id]')).toHaveLength(1)
  return node!
}
function more() {
  const node = toolbar().querySelector<HTMLButtonElement>('.agent-region-header__more')
  expect(node, 'original precise Header control').not.toBeNull()
  return node!
}
function readerReturn(reader: HTMLElement, label: string) {
  const node = reader.querySelector<HTMLButtonElement>('.session-history__toolbar button')
  expect(node?.textContent?.trim()).toBe(label)
  node!.focus()
  expect(document.activeElement, 'true Reader focus before Return/Escape').toBe(node)
  return node!
}
async function activity() {
  const toggle = region().querySelector<HTMLButtonElement>('.composer-tool--view-toggle')
  expect(toggle?.getAttribute('aria-label')).toBe('Show Activity')
  await act(async () => toggle!.click())
  expect(useAppStore.getState().viewModes[ids[0]!]).toBe('activity')
  const node = region().querySelector<HTMLElement>('.activity-feed')
  expect(node).not.toBeNull()
  expect(node!.textContent).toContain('Actual Activity message content')
  return node!
}
async function keyContinuesFrom(original: HTMLButtonElement) {
  expect(document.activeElement).toBe(original)
  expect(original.isConnected).toBe(true)
  expect(original.disabled).toBe(false)
  await act(async () => original.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  await act(async () => vi.waitFor(() => expect(document.querySelectorAll('.agent-region-menu [role="menuitem"]').length).toBeGreaterThan(0)))
  const menu = document.querySelector<HTMLElement>(`.agent-region-menu[data-owner-region-id="${regionId}"]`)
  expect(menu).not.toBeNull()
  expect(menu!.contains(document.activeElement)).toBe(true)
}

it('Terminal retains nonempty reader, terminal instance, original page and drafts across open/return/reopen', async () => {
  await mount()
  const before = stateIdentity(), paintNode = region().querySelector('[data-terminal-paint]')
  expect(paintNode).not.toBeNull()
  await terminalPositive()
  expect(region().querySelector('[data-terminal-paint]')).toBe(paintNode)
  await openAgentHistory(toolbar())
  expect(visibleReader().textContent).toContain('Actual native History content')
  expect(history.mock.calls.filter(([, options]) => options === undefined)).toHaveLength(1)
  expect(stateIdentity()).toEqual(before)
  expect(writes).not.toHaveBeenCalled()
  expect(recover).not.toHaveBeenCalled()
})

it('Activity original Header opens nonempty History and returns to its exact instance, page, selection and drafts', async () => {
  await mount()
  const feed = await activity(), before = stateIdentity(), originalHeader = more()
  feed.scrollTop = 47
  const text = [...feed.querySelectorAll<HTMLElement>('.log-turn__body')].find(node => node.textContent?.includes('Actual Activity message content'))
  expect(text).toBeDefined()
  const walker = document.createTreeWalker(text!, NodeFilter.SHOW_TEXT)
  const textNode = walker.nextNode()
  expect(textNode?.textContent?.length).toBeGreaterThan(8)
  const range = document.createRange(); range.setStart(textNode!, 1); range.setEnd(textNode!, 8)
  const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  const selected = selection.toString(); expect(selected.length).toBeGreaterThan(0)
  await openAgentHistory(toolbar())
  const reader = visibleReader(), close = readerReturn(reader, 'Activity')
  expect(useAppStore.getState().viewModes[ids[0]!]).toBe('activity')
  expect(region().querySelector('.activity-feed')).toBe(feed)
  expect(feed.closest('[inert]'), 'covered Activity is retained outside the keyboard order').not.toBeNull()
  await act(async () => close.click())
  await act(async () => vi.waitFor(() => expect(document.activeElement).toBe(originalHeader)))
  expect(region().querySelector('.activity-feed')).toBe(feed)
  expect(feed.closest('[inert]')).toBeNull()
  expect(feed.scrollTop).toBe(47)
  expect(selection.toString()).toBe(selected)
  expect(stateIdentity()).toEqual(before)
  expect(writes).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
  await keyContinuesFrom(originalHeader)
})

it.each(['Return', 'Escape'] as const)('%s restores exact original Header DOM focus after actual Reader focus, without a stale caret request', async action => {
  await mount(); const original = more()
  await openAgentHistory(toolbar())
  const reader = visibleReader(), close = readerReturn(reader, 'Terminal')
  await act(async () => action === 'Return' ? close.click() : reader.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await act(async () => vi.waitFor(() => expect(document.activeElement).toBe(original)))
  expect(useAppStore.getState().regionCaretFocus).toBeNull()
  expect(useAppStore.getState().viewModes[ids[0]!]).toBe('terminal')
  expect(region().querySelector('[aria-label="Conversation history"]')).toBeNull()
  await keyContinuesFrom(original)
})

it('covered Activity keeps its nonempty original controls inert until Return without replacing the original page', async () => {
  await mount(); const feed = await activity()
  const controls = [...feed.querySelectorAll<HTMLElement>('button, [tabindex="0"]')]
  expect(controls.length, 'actual nonempty original Activity keyboard controls').toBeGreaterThan(0)
  expect(feed.closest('[inert]')).toBeNull()
  await openAgentHistory(toolbar()); const reader = visibleReader()
  expect(feed.closest('[inert]')).not.toBeNull()
  expect([...feed.querySelectorAll('button, [tabindex="0"]')]).toEqual(controls)
  const close = readerReturn(reader, 'Activity'); await act(async () => close.click())
  await act(async () => vi.waitFor(() => expect(document.activeElement).toBe(more())))
  expect(region().querySelector('.activity-feed')).toBe(feed)
  expect(feed.closest('[inert]')).toBeNull()
  expect([...feed.querySelectorAll('button, [tabindex="0"]')]).toEqual(controls)
})

it('later explicit focus wins over a queued History return', async () => {
  await mount(); await openAgentHistory(toolbar())
  const reader = visibleReader(), close = readerReturn(reader, 'Terminal')
  const later = container.querySelector<HTMLInputElement>('.focus-search input') ?? container.querySelector<HTMLInputElement>('input')
  expect(later, 'existing visible Focus control').not.toBeNull()
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  await act(async () => close.click())
  expect(frames.length, 'actual scheduled local return').toBeGreaterThan(0)
  later!.focus(); expect(document.activeElement).toBe(later)
  await act(async () => frames.splice(0).forEach(callback => callback(0)))
  expect(document.activeElement).toBe(later)
  expect(useAppStore.getState().regionCaretFocus).toBeNull()
})

it('hidden reader issues no new page, discards late results, and returns to original Context with its drafts', async () => {
  await mount()
  let accept: ((page: Awaited<ReturnType<typeof api.sessions.historyPage>>) => void) | undefined
  history.mockImplementation(async (control, options) => options ? { agentSessionId: control.agentSessionId,
    source: { providerId: 'codex', nativeSessionId: 'typed-source' }, items: [], nextCursor: null } : new Promise(resolve => { accept = resolve }))
  await openAgentHistory(toolbar()); expect(accept).toBeDefined()
  const calls = history.mock.calls.filter(([, options]) => options === undefined).length
  expect(calls).toBe(1)
  await act(async () => useAppStore.getState().focusExecutionSession(ids[1]!))
  await act(async () => accept!({ agentSessionId: ids[0]!, source: { providerId: 'codex', nativeSessionId: 'typed-source' },
    items: [{ id: 'late-record', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Discard this late old reader page' }] }], nextCursor: null }))
  expect(history.mock.calls.filter(([, options]) => options === undefined)).toHaveLength(calls)
  expect(container.textContent).not.toContain('Discard this late old reader page')
  history.mockResolvedValue({ agentSessionId: ids[0]!, source: { providerId: 'codex', nativeSessionId: 'typed-source' },
    items: [{ id: 'fresh-record', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Fresh original Context page' }] }], nextCursor: null })
  await act(async () => useAppStore.getState().focusExecutionSession(ids[0]!))
  expect(visibleReader().textContent).toContain('Fresh original Context page')
  expect(useAppStore.getState().agentComposerDrafts).toEqual({ [ids[0]!]: 'Keep target draft', [ids[1]!]: 'Keep neighbor draft' })
  expect(writes).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})

it('nonempty unrelated output adds zero target reader work while a related explicit refresh still reads', async () => {
  await mount(); const feed = await activity(); await openAgentHistory(toolbar()); const reader = visibleReader()
  const before = history.mock.calls.filter(([, options]) => options === undefined).length; expect(before).toBe(1)
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(s => s.id === ids[1] ? { ...s, latestOutputBytes: s.latestOutputBytes + 20 } : s),
    timelines: { ...state.timelines, [ids[1]!]: { agentSessionId: ids[1]!, revision: 2, items: [{ id: 'unrelated-nonempty', agentSessionId: ids[1]!,
      kind: 'assistant_message', status: 'complete', source: 'native-hook', createdAt: 3, updatedAt: 3, title: 'Other reply', content: 'Nonempty unrelated output' }] } } })))
  expect(history.mock.calls.filter(([, options]) => options === undefined)).toHaveLength(before)
  expect(region().querySelector('.activity-feed')).toBe(feed)
  const latest = [...reader.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === 'Latest')
  expect(latest).toBeDefined(); await act(async () => latest!.click())
  expect(history.mock.calls.filter(([, options]) => options === undefined)).toHaveLength(before + 1)
  expect(visibleReader().textContent).toContain('Actual native History content')
})

it('original cold inline and pending Session return remain nonempty and readonly', async () => {
  const original = useAppStore.getState().sessions.find(s => s.id === ids[0]!)!
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(s => s.id === ids[0] ? { ...s, processState: 'exited' as const,
    semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: Date.now(), stateEnteredAt: Date.now() - 25 * 60 * 60 * 1000 } } : s) })))
  await mount()
  expect(visibleReader().classList.contains('session-history--inline')).toBe(true)
  expect(visibleReader().textContent).toContain('Actual native History content')
  expect(visibleReader().querySelector('.session-history__toolbar button')?.textContent?.trim()).toBe('Latest')
  expect(writes).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
  expect(original.kind).toBe('agent')
})

it('Space original Header preserves observation refresh and its precise History outlet', async () => {
  useAppStore.getState().setMainSurface('workbench'); await mount()
  const ownHeader = region().querySelector('.agent-region-header'); expect(ownHeader).not.toBeNull()
  const trigger = ownHeader!.querySelector<HTMLButtonElement>('.agent-region-header__more')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await act(async () => vi.waitFor(() => expect(document.querySelectorAll('.agent-region-menu [role="menuitem"]').length).toBeGreaterThan(0)))
  const refresh = [...document.querySelectorAll<HTMLElement>('.agent-region-menu [role="menuitem"]')].find(node => node.textContent?.trim() === 'Refresh observation')
  expect(refresh).toBeDefined(); await act(async () => refresh!.click())
  expect(paint.refresh).toHaveBeenCalledTimes(1)
  await openAgentHistory(ownHeader!)
  expect(visibleReader().textContent).toContain('Actual native History content')
})
