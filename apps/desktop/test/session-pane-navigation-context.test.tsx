const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, useEffect, useLayoutEffect } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout, type WorkspaceLayout } from '@agentmux/layout'
import type { SessionSnapshot } from '../src/shared/contracts'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { openAgentHistory } from './helpers/agent-history-menu'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { WorkbenchPresentationContext, type WorkbenchPresentation } from '../src/renderer/src/lib/workbench-presentation'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

const paint = vi.hoisted(() => ({ mounts: 0, refresh: vi.fn(async () => {}) }))
// The real SessionPane, Header, History, request card and Store own the actions.
// Only PTY painting is outside this DOM test's boundary.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session, onObservationRefresh }: {
  session: SessionSnapshot; onObservationRefresh?: (refresh: (() => Promise<void>) | null) => void
}) => {
  useEffect(() => { paint.mounts += 1 }, [])
  useLayoutEffect(() => { onObservationRefresh?.(paint.refresh); return () => onObservationRefresh?.(null) }, [onObservationRefresh])
  return <textarea aria-label={`Retained PTY ${session.id}`} />
} }))

const initial = useAppStore.getState()
const resourceId = 'workspace-demo', displayId = 'navigation-display'
const tabId = 'navigation-tab', regionId = 'navigation-agent'
const reference = { displayWorkspaceId: displayId, groupId: 'exact-display-group', tabId, regionId }
let root: Root, container: HTMLDivElement, session: Extract<SessionSnapshot, { kind: 'agent' }>

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  paint.mounts = 0
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const resource = { ...config.workspaces.find(workspace => workspace.id === resourceId)!, path: _hygiene_fixturePath("private/navigation-resource") }
  const display = { ...resource, id: displayId, path: _hygiene_fixturePath("private/navigation-display"), name: 'Navigation display' }
  const source = snapshot.sessions.find(item => item.kind === 'agent')
  expect(source?.kind).toBe('agent')
  if (source?.kind !== 'agent') throw new Error('Agent fixture source required')
  session = { ...source, workspacePath: resource.path, processState: 'running',
    pendingInteraction: { kind: 'question', id: 'native-question', agentSessionId: source.id,
      questions: [{ id: 'question', prompt: 'Answer through the original terminal', options: [] }],
      responseUnavailableReason: 'This request requires native terminal input.',
      evidence: { source: 'native-hook', observedAt: 1, run: source.control.run } } }
  const tab = createWorkbenchTab(tabId, { regionId, workspaceId: resourceId, kind: 'agent', phase: 'attached', sessionId: session.id })
  const background = createWorkbenchTab('background-tab', { regionId: 'background-launcher', workspaceId: resourceId, kind: 'launcher' })
  const first = createWorkspaceLayout('first-display-group', [tabId])
  const displayLayout: WorkspaceLayout = { ...first,
    root: { type: 'split', direction: 'horizontal', ratio: .5, first: first.root, second: { type: 'leaf', groupId: reference.groupId } },
    groups: [...first.groups, { ...first.groups[0]!, id: reference.groupId }] }
  useAppStore.setState({ ...initial, config: { ...config, workspaces: [resource, display] }, sessions: [session],
    tabs: { [tabId]: tab, [background.id]: background },
    layouts: { [resourceId]: createWorkspaceLayout('resource-group', [background.id, tabId]), [displayId]: displayLayout },
    activeWorkspaceId: resourceId, mainSurface: 'workbench', viewModes: { [session.id]: 'terminal' },
    agentComposerDrafts: { [session.id]: 'Original unsent draft' },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }
  }, true)
  useAppStore.getState().focusRegion(resourceId, background.id, 'background-launcher', 'pointer', 'resource-group')
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
    source: { providerId: 'codex', nativeSessionId: 'navigation-history' },
    items: [{ id: 'record', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original retained history' }] }], nextCursor: null }))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); document.body.replaceChildren()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function mount(presentation: WorkbenchPresentation = { active: true, retainedRegionId: null }) {
  await act(async () => root.render(<WorkbenchPresentationContext.Provider value={presentation}>
    <SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible
      linkOrigin={{ workspaceId: resourceId, tabGroupId: 'resource-group', tabId, regionId, sessionId: session.id }} />
    <input aria-label="Later control" />
  </WorkbenchPresentationContext.Provider>))
}
function workSelection() {
  const state = useAppStore.getState()
  return { activeWorkspaceId: state.activeWorkspaceId, selection: state.workbenchSpaceSelection,
    layouts: state.layouts, tabs: state.tabs, sessions: state.sessions, drafts: state.agentComposerDrafts }
}
async function returnFromHistory() {
  await openAgentHistory(container)
  const reader = currentHistoryReader()
  await act(async () => vi.waitFor(() => {
    expect(reader.querySelectorAll('[data-native-record-id="record"]').length).toBeGreaterThan(0)
    expect(reader.textContent).toContain('Original retained history')
  }))
  const back = historyReturnButton(reader)
  await act(async () => { back.focus(); back.click() })
}
function currentHistoryReader() {
  const readers = [...container.querySelectorAll<HTMLElement>('.activity-feed-frame')].filter(reader =>
    reader.querySelector('button[aria-label="Return to Terminal"]'))
  expect(readers).toHaveLength(1)
  return readers[0]!
}
function historyReturnButton(reader: HTMLElement) {
  const buttons = reader.querySelectorAll<HTMLButtonElement>('button[aria-label="Return to Terminal"]')
  expect(buttons).toHaveLength(1)
  expect(buttons[0]!.textContent?.trim()).toBe('Return')
  return buttons[0]!
}
async function openTerminal() {
  const action = container.querySelector<HTMLButtonElement>('.agent-interaction__actions button')
  expect(action?.textContent).toBe('Open terminal')
  await act(async () => action!.click())
}
function selectionCallback(surface: 'survey' | 'mote' | 'focus') {
  const expected = useAppStore.getState().workbenchSpaceSelection
  return vi.fn((id: string) => {
    const state = useAppStore.getState(), target = { ...reference, regionId: id }
    if (surface === 'focus') state.selectMainRegion(target, expected)
    else state.focusExecutionSession(session.id, target, { navigate: false })
  })
}
function expectOwnedSelection(surface: 'survey' | 'mote' | 'focus', before: ReturnType<typeof workSelection>) {
  const after = workSelection()
  if (surface === 'focus') {
    expect(after.selection).toMatchObject({ workspaceId: displayId, groupId: reference.groupId, tabId, regionId })
    expect(after.activeWorkspaceId).toBe(displayId)
    expect({ ...after, selection: before.selection, activeWorkspaceId: before.activeWorkspaceId }).toEqual(before)
  } else expect(after).toEqual(before)
}

it.each(['survey', 'mote', 'focus'] as const)('%s History return selects its own navigation and real semantic focus', async surface => {
  if (surface === 'focus') useAppStore.getState().setMainSurface('agents')
  const select = selectionCallback(surface)
  await mount({ active: true, retainedRegionId: regionId, surface, reference, tabHostId: `${surface}-host`, onSelectRegion: select })
  const before = workSelection(), terminal = container.querySelector('textarea'), global = vi.spyOn(useAppStore.getState(), 'focusRegion')
  await returnFromHistory()
  expect(select).toHaveBeenCalledExactlyOnceWith(regionId); expect(global).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentFocus.execution.reference).toEqual(reference)
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(session.id)
  expect(useAppStore.getState().agentFocus.execution.history.map(event => event.sessionId)).toEqual([session.id])
  expectOwnedSelection(surface, before)
  expect(container.querySelector('textarea')).toBe(terminal); expect(paint.mounts).toBe(1)
  const more = container.querySelector<HTMLButtonElement>('.agent-region-header__more')!
  await act(async () => vi.waitFor(() => expect(document.activeElement).toBe(more)))
  expect(useAppStore.getState().regionCaretFocus).toBeNull()
})

it.each(['survey', 'mote', 'focus'] as const)('%s native terminal action uses the local callback and retains the same Session, Run and draft', async surface => {
  if (surface === 'focus') useAppStore.getState().setMainSurface('agents')
  const select = selectionCallback(surface)
  await act(async () => useAppStore.getState().setViewMode(session.id, 'activity'))
  await mount({ active: true, retainedRegionId: regionId, surface, reference, onSelectRegion: select })
  const before = workSelection(), global = vi.spyOn(useAppStore.getState(), 'focusRegion')
  await openTerminal()
  expect(select).toHaveBeenCalledExactlyOnceWith(regionId); expect(global).not.toHaveBeenCalled()
  expect(useAppStore.getState().viewModes[session.id]).toBe('terminal')
  expect(useAppStore.getState().agentFocus.execution.reference).toEqual(reference)
  expectOwnedSelection(surface, before)
  expect(useAppStore.getState().sessions[0]!.control).toBe(session.control)
  expect(paint.mounts).toBe(1)
})

it.each(['History return', 'Open terminal'] as const)('%s in Space preserves the full display occurrence instead of choosing the active sibling Group or resource home', async action => {
  useAppStore.getState().focusRegion(displayId, tabId, regionId, 'navigation', reference.groupId)
  useAppStore.setState(state => ({ layouts: { ...state.layouts, [displayId]: { ...state.layouts[displayId]!, activeGroupId: 'first-display-group' } } }))
  await mount({ active: true, retainedRegionId: null, surface: 'space', reference })
  const global = vi.spyOn(useAppStore.getState(), 'focusRegion')
  if (action === 'History return') await returnFromHistory(); else await openTerminal()
  expect(global).toHaveBeenCalledExactlyOnceWith(displayId, tabId, regionId, 'pointer', reference.groupId)
  expect(useAppStore.getState().layouts[displayId]!.activeGroupId).toBe(reference.groupId)
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ workspaceId: displayId, groupId: reference.groupId, tabId, regionId })
})

it('ordinary unprojected Space passes the origin Group to the original focus owner', async () => {
  useAppStore.getState().focusRegion(resourceId, tabId, regionId, 'navigation', 'resource-group')
  await mount()
  const global = vi.spyOn(useAppStore.getState(), 'focusRegion')
  await openTerminal()
  expect(global).toHaveBeenCalledExactlyOnceWith(resourceId, tabId, regionId, 'pointer', 'resource-group')
})

it('a local presentation with unconfirmed selection does not fall through to Work while its terminal remains available', async () => {
  await mount({ active: true, retainedRegionId: regionId, surface: 'mote', reference })
  const before = workSelection(), global = vi.spyOn(useAppStore.getState(), 'focusRegion')
  await openTerminal()
  expect(global).not.toHaveBeenCalled(); expect(workSelection()).toEqual(before)
  expect(container.querySelector(`textarea[aria-label="Retained PTY ${session.id}"]`)).not.toBeNull()
  expect(useAppStore.getState().viewModes[session.id]).toBe('terminal')
})

it.each(['later input', 'different Group', 'different context'] as const)('a queued History return preserves %s intent', async change => {
  const select = vi.fn()
  const context: WorkbenchPresentation = { active: true, retainedRegionId: regionId, surface: 'survey', reference, tabHostId: 'survey-host', onSelectRegion: select }
  await mount(context)
  const frames: FrameRequestCallback[] = []
  await openAgentHistory(container)
  const reader = currentHistoryReader()
  await act(async () => vi.waitFor(() => {
    expect(reader.querySelectorAll('[data-native-record-id="record"]')).toHaveLength(1)
    expect(reader.textContent).toContain('Original retained history')
  }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  const back = historyReturnButton(currentHistoryReader())
  await act(async () => { back.focus(); back.click() })
  expect(select).toHaveBeenCalledExactlyOnceWith(regionId)
  expect(frames.length).toBeGreaterThan(0)
  const later = container.querySelector<HTMLInputElement>('[aria-label="Later control"]')!
  if (change === 'later input') later.focus()
  else {
    await mount(change === 'different Group' ? { ...context, reference: { ...reference, groupId: 'first-display-group' } }
      : { ...context, surface: 'mote', tabHostId: 'mote-host' })
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    expect(document.activeElement).toBe(document.body)
  }
  const currentInput = document.activeElement
  await act(async () => frames.splice(0).forEach(callback => callback(0)))
  expect(select).toHaveBeenCalledExactlyOnceWith(regionId)
  expect(document.activeElement).toBe(currentInput)
  expect(useAppStore.getState().regionCaretFocus).toBeNull()
})
