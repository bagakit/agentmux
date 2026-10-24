// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout, moveTabToNewGroup } from '@agentmux/layout'
import type { AppWindowTarget } from '@agentmux/core/control'
import type { WorkbenchWindowDocument } from '../src/shared/workbench-windows'
import type { AppConfig, BrowserEvent, BrowserSnapshot } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { addWorkbenchRegion, createWorkbenchTab, type BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { projectNativeBrowserOpening, resolveBrowserSource } from '../src/renderer/src/lib/browser-child-projection'
import { createBrowserProjectionEventQueue } from '../src/renderer/src/lib/browser-state'
import { hydratePersistedTab, reducePersistedTab } from '../src/renderer/src/lib/workbench-persistence'
import { placeWorkbenchWindow, registerWorkbenchDocument, registerWorkbenchHost } from '../src/renderer/src/lib/workbench-window-registry'
import { createClientUiRoot } from './helpers/client-ui-render'

const windows = vi.hoisted(() => ({ open: vi.fn(async (_target: AppWindowTarget) => {}), focus: vi.fn(async (_document: WorkbenchWindowDocument) => true),
  retire: vi.fn(async (_regions: readonly { tabId: string; regionId: string }[]) => {}) }))
vi.mock('../src/renderer/src/lib/workbench-windows', () => ({ openWorkbenchWindow: windows.open, focusWorkbenchWindow: windows.focus,
  returnClosedWorkbenchWindows: windows.retire }))

const original = useAppStore.getState()
const sourceLocation = { displayWorkspaceId: 'source-display', groupId: 'source-group', tabId: 'source-tab', regionId: 'source-region' }
const source = { browserId: 'source-browser', navigationId: 'source-navigation', location: sourceLocation }
const snapshot: BrowserSnapshot = { id: 'native-child', source, mode: 'normal', profileId: 'original-profile', navigationId: 'child-navigation',
  url: 'https://child.example.test/original', title: 'Original native child', loading: false, canGoBack: false, canGoForward: false,
  viewport: 'responsive', error: null, driving: false, appLinkPrompt: null }
const event: Extract<BrowserEvent, { type: 'native-opened' }> = { type: 'native-opened', browser: snapshot, workspaceId: 'resource-workspace', window: { width: 800, height: 600 } }
let host: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>, disposers: Array<() => void>

function sourceFixture() {
  const { source: _source, ...nativeSnapshot } = snapshot
  const surface: BrowserWorkbenchSurface = { ...nativeSnapshot, id: source.browserId, browserId: source.browserId,
    navigationId: source.navigationId, regionId: sourceLocation.regionId, workspaceId: 'resource-workspace', kind: 'browser', title: 'Source page' }
  let tab = { ...createWorkbenchTab(sourceLocation.tabId, surface), space: { spaceId: 'original-space', zoneId: 'original-zone' }, topicId: 'original-topic' }
  tab = { ...addWorkbenchRegion(tab, sourceLocation.regionId, 'right', { kind: 'file', regionId: 'dirty-sibling', workspaceId: 'resource-workspace', path: 'draft.md' }),
    space: tab.space, topicId: tab.topicId }
  const unrelated = createWorkbenchTab('unrelated-tab', { kind: 'launcher', regionId: 'human-region', workspaceId: 'human-workspace' })
  const layout = createWorkspaceLayout(sourceLocation.groupId, [tab.id])
  useAppStore.setState({ ...original, tabs: { [tab.id]: tab, [unrelated.id]: unrelated },
    layouts: { [sourceLocation.displayWorkspaceId]: layout, 'human-workspace': createWorkspaceLayout('human-group', [unrelated.id]) },
    activeWorkspaceId: 'human-workspace', loading: false, toolsOpen: false, config: null,
    documents: { draft: { path: 'draft.md', content: 'Unsent source sibling', revision: 'disk' } }, dirtyDocuments: { draft: true } }, true)
  return { tab, layout, unrelated }
}
const childSurface = () => Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions))
  .find(surface => surface.kind === 'browser' && surface.browserId === snapshot.id) as BrowserWorkbenchSurface | undefined
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  windows.open.mockClear(); windows.focus.mockClear(); windows.retire.mockClear()
  disposers = []
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
  sourceFixture()
})
afterEach(async () => {
  await act(async () => root.unmount())
  // Retire the exact queued original event so no later fixture can supply its missing source.
  useAppStore.getState().applyBrowserEvent({ type: 'closed', id: snapshot.id })
  await flush()
  for (const dispose of disposers.reverse()) dispose()
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(original, true)
})

describe('native Browser child uses the ordinary Renderer workface', () => {
  it('preserves more than 256 native lifecycle events while coalescing only their Browser snapshots', () => {
    const queue = createBrowserProjectionEventQueue()
    for (let index = 0; index < 300; index++) {
      const browser = { ...snapshot, id: `native-${index}` }
      queue.push({ ...event, browser }); queue.push({ type: 'updated', browser }); queue.push({ type: 'updated', browser: { ...browser, title: `Latest ${index}` } })
      queue.push({ type: 'closed', id: browser.id })
    }
    const retained = queue.drain()
    expect(retained).toHaveLength(900)
    for (let index = 0; index < 300; index++) expect(retained.slice(index * 3, index * 3 + 3)).toMatchObject([
      { type: 'native-opened', browser: { id: `native-${index}` } }, { type: 'updated', browser: { id: `native-${index}`, title: `Latest ${index}` } },
      { type: 'closed', id: `native-${index}` }
    ])
    expect(queue.drain()).toEqual([])
  })

  it('keeps snapshot segments on their own side of native creation and every lifecycle boundary', () => {
    const queue = createBrowserProjectionEventQueue()
    queue.push({ type: 'updated', browser: { ...snapshot, title: 'Before native creation' } })
    queue.push(event)
    queue.push({ type: 'updated', browser: { ...snapshot, title: 'Child loading' } })
    queue.push({ type: 'updated', browser: { ...snapshot, title: 'Child loaded' } })
    queue.push({ type: 'released', id: snapshot.id, navigationId: snapshot.navigationId })
    queue.push({ type: 'updated', browser: { ...snapshot, title: 'After release' } })
    queue.push({ type: 'unavailable', id: snapshot.id, error: 'Native document unavailable' })
    queue.push({ type: 'updated', browser: { ...snapshot, title: 'After unavailable' } })
    queue.push({ type: 'closed', id: snapshot.id })
    expect(queue.drain()).toMatchObject([
      { type: 'updated', browser: { title: 'Before native creation' } }, { type: 'native-opened', browser: { title: snapshot.title } },
      { type: 'updated', browser: { title: 'Child loaded' } }, { type: 'released' }, { type: 'updated', browser: { title: 'After release' } },
      { type: 'unavailable' }, { type: 'updated', browser: { title: 'After unavailable' } }, { type: 'closed' }
    ])
  })

  it('the actual startup subscription retains native creation through an unrelated snapshot flood', async () => {
    const state = useAppStore.getState()
    const { space: _space, topicId: _topic, ...sourceTab } = state.tabs[sourceLocation.tabId]!
    useAppStore.setState({ loading: true, restoredWorkbench: { tabs: { ...state.tabs,
      [sourceTab.id]: { ...sourceTab, name: 'Original source tab' } }, layouts: state.layouts } })
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
    let configuration!: (config: AppConfig) => void
    vi.spyOn(api.config, 'get').mockReturnValue(new Promise(resolve => { configuration = resolve }))
    const retainLabels = api.spatial.retainLabels.bind(api.spatial)
    let labelsEntered = false, finishLabels!: () => void
    const labelsGate = new Promise<void>(resolve => { finishLabels = resolve })
    vi.spyOn(api.spatial, 'retainLabels').mockImplementation(async values => { labelsEntered = true; await labelsGate; return retainLabels(values) })
    let receive!: (event: BrowserEvent) => void
    vi.spyOn(api.browser, 'onEvent').mockImplementation(listener => { receive = listener; return () => {} })
    const initializing = useAppStore.getState().initialize()
    expect(receive).toBeTypeOf('function')
    receive({ type: 'updated', browser: { ...snapshot, url: 'about:blank', title: 'Initial native document' } })
    receive(event)
    for (let index = 0; index < 300; index++) receive({ type: 'updated', browser: { ...snapshot, id: `unrelated-${index}` } })
    configuration({ version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Native child fixture' }], executors: {},
      workspaces: ['resource-workspace', 'source-display', 'human-workspace'].map(id => ({ id, name: id, hostId: 'local', path: `${new URL('file:///').pathname}tmp/native-child-fixture/${id}`, kind: 'folder' })),
      appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } })
    // Session publication already happened; the original native creation is still queued
    // while durable labels finish. Its later snapshot must stay after that creation.
    let labelFailure: unknown
    try {
      await vi.waitFor(() => expect(labelsEntered, useAppStore.getState().workbenchSaveWarning ?? 'The original label handoff has not started').toBe(true))
      receive({ type: 'updated', browser: { ...snapshot, title: 'Loaded during startup' } })
    } catch (error) { labelFailure = error }
    finally { finishLabels() }
    disposers.push(await initializing)
    if (labelFailure) throw labelFailure
    await flush()
    expect(childSurface()).toMatchObject({ id: snapshot.id, title: 'Loaded during startup', source })
    expect(windows.open).toHaveBeenCalledTimes(1)
  })

  it('attaches the existing native identity in its source Group and opens the existing window owner without replay', async () => {
    const before = useAppStore.getState(), sourceTab = before.tabs[sourceLocation.tabId]!, sourceLayout = before.layouts[sourceLocation.displayWorkspaceId]!
    const create = vi.spyOn(api.browser, 'create'), navigate = vi.spyOn(api.browser, 'navigate')
    useAppStore.getState().applyBrowserEvent(event)
    await flush()
    const after = useAppStore.getState(), child = childSurface()!
    expect(child).toMatchObject({ ...snapshot, browserId: snapshot.id, workspaceId: 'resource-workspace', kind: 'browser' })
    const target = windows.open.mock.calls[0]?.[0]
    expect(target).toMatchObject({ kind: 'region', displayWorkspaceId: sourceLocation.displayWorkspaceId, groupId: sourceLocation.groupId, regionId: snapshot.id })
    expect(after.tabs[target!.tabId]).toMatchObject({ space: sourceTab.space, topicId: sourceTab.topicId })
    expect(after.tabs[sourceLocation.tabId]).toBe(sourceTab)
    expect(after.layouts[sourceLocation.displayWorkspaceId]!.groups[0]!.activeTabId).toBe(sourceLayout.groups[0]!.activeTabId)
    expect(after.activeWorkspaceId).toBe('human-workspace'); expect(after.documents.draft?.content).toBe('Unsent source sibling')
    expect(after.dirtyDocuments.draft).toBe(true); expect(create).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
  })

  it('deduplicates the original creation event and consumes ordinary updates and confirmed close for that same page', async () => {
    useAppStore.getState().applyBrowserEvent(event); useAppStore.getState().applyBrowserEvent(event)
    await flush()
    expect(windows.open).toHaveBeenCalledTimes(1)
    const target = windows.open.mock.calls[0]![0]!
    if (target.kind !== 'region') throw new Error('Native child must use its exact Region presentation')
    useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...snapshot, title: 'Native title changed', canGoBack: true } })
    expect(childSurface()).toMatchObject({ title: 'Native title changed', canGoBack: true, source })
    useAppStore.getState().applyBrowserEvent({ type: 'closed', id: snapshot.id })
    await flush()
    expect(childSurface()).toBeUndefined(); expect(useAppStore.getState().tabs[sourceLocation.tabId]).toBeDefined()
    expect(windows.retire).toHaveBeenCalledWith([{ tabId: target.tabId, regionId: target.regionId }])
  })

  it('shows the same child for ambiguous source displays without inventing its original occurrence or following human focus', async () => {
    const current = useAppStore.getState(), duplicate = createWorkbenchTab('source-copy', { ...current.tabs[sourceLocation.tabId]!.regions[sourceLocation.regionId]!, regionId: 'copy-region' })
    useAppStore.setState({ tabs: { ...current.tabs, [duplicate.id]: duplicate }, layouts: { ...current.layouts,
      'second-display': createWorkspaceLayout('second-group', [duplicate.id]) } })
    const ambiguous = { ...event, browser: { ...snapshot, source: { browserId: source.browserId, navigationId: source.navigationId } } }
    const before = useAppStore.getState()
    const create = vi.spyOn(api.browser, 'create'), navigate = vi.spyOn(api.browser, 'navigate')
    useAppStore.getState().applyBrowserEvent(ambiguous); await flush()
    expect(childSurface()).toMatchObject({ id: snapshot.id, browserId: snapshot.id, source: ambiguous.browser.source })
    expect(childSurface()!.source).not.toHaveProperty('location')
    expect(windows.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'region', displayWorkspaceId: 'second-display', groupId: 'second-group', regionId: snapshot.id }))
    expect(resolveBrowserSource(useAppStore.getState(), ambiguous.browser.source)).toMatchObject({ status: 'ambiguous' })
    expect(useAppStore.getState().activeWorkspaceId).toBe(before.activeWorkspaceId)
    expect(useAppStore.getState().error).toBeNull(); expect(create).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
  })

  it('prefers a still valid recorded Group when the original occurrence is gone and other source displays are ambiguous', async () => {
    const before = useAppStore.getState()
    const surface = before.tabs[sourceLocation.tabId]!.regions[sourceLocation.regionId]!
    const first = createWorkbenchTab('copy-one', { ...surface, regionId: 'copy-one-region' })
    const second = createWorkbenchTab('copy-two', { ...surface, regionId: 'copy-two-region' })
    useAppStore.setState({ tabs: { [first.id]: first, [second.id]: second }, layouts: {
      'a-copy': createWorkspaceLayout('a-copy-group', [first.id]), 'b-copy': createWorkspaceLayout('b-copy-group', [second.id]),
      [sourceLocation.displayWorkspaceId]: createWorkspaceLayout(sourceLocation.groupId, []) } })
    useAppStore.getState().applyBrowserEvent(event); await flush()
    expect(windows.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'region',
      displayWorkspaceId: sourceLocation.displayWorkspaceId, groupId: sourceLocation.groupId, regionId: snapshot.id }))
    expect(childSurface()!.source).toEqual(source)
    expect(resolveBrowserSource(useAppStore.getState(), source)).toMatchObject({ status: 'ambiguous' })
  })

  it('shows a child with no source in a Group containing its actual resource workspace', async () => {
    const { source: _source, ...browser } = snapshot
    useAppStore.getState().applyBrowserEvent({ ...event, browser }); await flush()
    expect(childSurface()).toMatchObject({ id: snapshot.id, browserId: snapshot.id, workspaceId: event.workspaceId })
    expect(childSurface()).not.toHaveProperty('source')
    expect(windows.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'region',
      displayWorkspaceId: sourceLocation.displayWorkspaceId, groupId: sourceLocation.groupId, regionId: snapshot.id }))
    expect(useAppStore.getState().activeWorkspaceId).toBe('human-workspace')
  })

  it('uses layout reading order and a real existing resource binding when neither source nor event workspace is known', async () => {
    const before = useAppStore.getState(), { source: _source, ...browser } = snapshot
    const layout = moveTabToNewGroup(createWorkspaceLayout('right-group', [sourceLocation.tabId, 'unrelated-tab']),
      'unrelated-tab', 'right-group', 'right-group', 'left', 'left-group')
    useAppStore.setState({ layouts: { 'container-display': layout }, activeWorkspaceId: 'some-other-current-display' })
    useAppStore.getState().applyBrowserEvent({ ...event, browser, workspaceId: null }); await flush()
    expect(windows.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'region', displayWorkspaceId: 'container-display', groupId: 'left-group', regionId: snapshot.id }))
    expect(childSurface()).toMatchObject({ id: snapshot.id, browserId: snapshot.id, workspaceId: before.tabs['unrelated-tab']!.workspaceId })
    expect(useAppStore.getState().layouts['container-display']!.activeGroupId).toBe(layout.activeGroupId)
    expect(useAppStore.getState().layouts['container-display']!.groups.find(group => group.id === 'left-group')!.activeTabId).toBe('unrelated-tab')
    expect(useAppStore.getState().activeWorkspaceId).toBe('some-other-current-display')
  })

  it('does not use an orphan Group record, an empty display identity, or an empty workspace binding', () => {
    const { source: _source, ...browser } = snapshot
    const empty = createWorkspaceLayout('empty-group', [])
    const orphan = { ...empty, root: { type: 'leaf' as const, groupId: 'missing-group' } }
    expect(projectNativeBrowserOpening({ tabs: {}, layouts: { valid: orphan } }, { ...event, browser }).target).toBeNull()
    expect(projectNativeBrowserOpening({ tabs: {}, layouts: { '': empty } }, { ...event, browser }).target).toBeNull()
    expect(projectNativeBrowserOpening({ tabs: {}, layouts: { valid: empty } }, { ...event, browser, workspaceId: '' }).target).toBeNull()
    expect(projectNativeBrowserOpening({ tabs: {}, layouts: { valid: empty } }, { ...event, browser }).target)
      .toMatchObject({ displayWorkspaceId: 'valid', groupId: 'empty-group', regionId: snapshot.id })
  })

  it('finishes the retained same-page projection after any legal workspace layout recovers, using its newest native snapshot', async () => {
    const before = useAppStore.getState(), { source: _source, ...browser } = snapshot
    useAppStore.setState({ tabs: {}, layouts: {} })
    const create = vi.spyOn(api.browser, 'create'), navigate = vi.spyOn(api.browser, 'navigate')
    useAppStore.getState().applyBrowserEvent({ ...event, browser, workspaceId: null })
    expect(childSurface()).toBeUndefined(); expect(windows.open).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toContain('No existing workspace Group')
    useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...browser, title: 'Loaded while layout unavailable' } })
    useAppStore.setState({ tabs: { 'unrelated-tab': before.tabs['unrelated-tab']! }, layouts: { 'human-workspace': before.layouts['human-workspace']! } })
    await flush()
    expect(childSurface()).toMatchObject({ id: snapshot.id, browserId: snapshot.id, title: 'Loaded while layout unavailable', workspaceId: 'human-workspace' })
    expect(windows.open).toHaveBeenCalledTimes(1); expect(create).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toBeNull()
  })

  it('cancels only a confirmed closed pending child when a legal layout returns later', async () => {
    const before = useAppStore.getState()
    useAppStore.setState({ tabs: {}, layouts: {} })
    useAppStore.getState().applyBrowserEvent(event)
    useAppStore.getState().applyBrowserEvent({ type: 'closed', id: snapshot.id })
    expect(useAppStore.getState().error).toBeNull()
    useAppStore.setState({ tabs: before.tabs, layouts: before.layouts })
    await flush(); expect(windows.open).not.toHaveBeenCalled(); expect(childSurface()).toBeUndefined()
  })

  it('retains the source relationship through the normal durable Browser projection', () => {
    useAppStore.getState().applyBrowserEvent(event)
    const tab = Object.values(useAppStore.getState().tabs).find(tab => Object.values(tab.regions).some(surface => surface.kind === 'browser' && surface.browserId === snapshot.id))!
    const saved = reducePersistedTab(tab), restored = hydratePersistedTab(saved)
    expect(saved.regions[snapshot.id]).toMatchObject({ source })
    expect(restored.regions[snapshot.id]).toMatchObject({ source, browserId: snapshot.id, nativeOwnerDeferred: true })
  })

  it('follows the original Region when it moves and does not confuse another projection of the same Browser', () => {
    const before = useAppStore.getState(), moved = moveTabToNewGroup(createWorkspaceLayout(sourceLocation.groupId, [sourceLocation.tabId, 'unrelated-tab']), sourceLocation.tabId,
      sourceLocation.groupId, sourceLocation.groupId, 'right', 'moved-group')
    const duplicate = createWorkbenchTab('source-copy', { ...before.tabs[sourceLocation.tabId]!.regions[sourceLocation.regionId]!, regionId: 'copy-region' })
    const state = { tabs: { ...before.tabs, [duplicate.id]: duplicate }, layouts: { ...before.layouts,
      [sourceLocation.displayWorkspaceId]: moved, copy: createWorkspaceLayout('copy-group', [duplicate.id]) } }
    expect(resolveBrowserSource(state, source)).toEqual({ status: 'available', location: { ...sourceLocation, groupId: 'moved-group' } })
    expect(resolveBrowserSource(state, { browserId: source.browserId, navigationId: source.navigationId })).toMatchObject({ status: 'ambiguous' })
  })

  it('tracks the same source Region promoted into another Tab while other Browser displays remain', () => {
    const before = useAppStore.getState(), originalSurface = before.tabs[sourceLocation.tabId]!.regions[sourceLocation.regionId]!
    const promoted = createWorkbenchTab('promoted-source', originalSurface)
    const copy = createWorkbenchTab('source-copy', { ...originalSurface, regionId: 'copy-region' })
    const state = { tabs: { [promoted.id]: promoted, [copy.id]: copy }, layouts: {
      promoted: createWorkspaceLayout('promoted-group', [promoted.id]), copied: createWorkspaceLayout('copy-group', [copy.id]) } }
    expect(resolveBrowserSource(state, source)).toEqual({ status: 'available', location: {
      displayWorkspaceId: 'promoted', groupId: 'promoted-group', tabId: promoted.id, regionId: sourceLocation.regionId } })
  })

  it('renders Source in the actual BrowserPane and navigates its exact source native window in one click', async () => {
    const focus = vi.fn(); useAppStore.setState({ focusRegion: focus })
    const main = { windowId: 'main-window', documentGeneration: 'main-document' }
    disposers.push(registerWorkbenchDocument(document, main))
    useAppStore.getState().applyBrowserEvent(event)
    await act(async () => root.render(<BrowserPane tab={childSurface()!} visible />))
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Go to source Browser"]')!
    expect(button).not.toBeNull(); expect(button.title).toContain('Source page')
    await act(async () => button.click())
    expect(focus).toHaveBeenCalledWith(sourceLocation.displayWorkspaceId, sourceLocation.tabId, sourceLocation.regionId, 'navigation', sourceLocation.groupId)
    expect(windows.focus).toHaveBeenLastCalledWith(main)
    expect(host.querySelector('[aria-label="Browser address"]')).not.toBeNull()
  })

  it('focuses the source existing borrowed shell rather than creating a second window', async () => {
    const focus = vi.fn(); useAppStore.setState({ focusRegion: focus })
    const target = { kind: 'region' as const, ...sourceLocation }, shell = { windowId: 'source-window', documentGeneration: 'source-document' }
    disposers.push(registerWorkbenchHost({ target, host, place: async () => {} }))
    await placeWorkbenchWindow(target, { destination: host, window: shell })
    disposers.push(() => { void placeWorkbenchWindow(target, null) })
    useAppStore.getState().applyBrowserEvent(event)
    await act(async () => root.render(<BrowserPane tab={childSurface()!} visible />))
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Go to source Browser"]')!.click())
    expect(windows.focus).toHaveBeenLastCalledWith(shell)
    expect(focus).toHaveBeenLastCalledWith(sourceLocation.displayWorkspaceId, sourceLocation.tabId, sourceLocation.regionId, 'navigation', sourceLocation.groupId)
  })

  it('keeps ordinary Browser input usable when its source display is gone', async () => {
    const focus = vi.fn(); useAppStore.setState({ focusRegion: focus })
    useAppStore.getState().applyBrowserEvent(event)
    const child = childSurface()!
    useAppStore.setState({ tabs: {} })
    await act(async () => root.render(<BrowserPane tab={child} visible />))
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Go to source Browser"]')!
    expect(button.disabled).toBe(false)
    await act(async () => button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })))
    expect(document.body.textContent).toContain('The source page no longer has an available display')
    expect(host.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!.disabled).toBe(false)
    expect(focus).not.toHaveBeenCalled(); expect(windows.focus).not.toHaveBeenCalled()
  })

  it('lets the person choose among real current source displays without guessing or exposing random IDs', async () => {
    const focus = vi.fn(); useAppStore.setState({ focusRegion: focus })
    useAppStore.getState().applyBrowserEvent(event)
    const child = childSurface()!, state = useAppStore.getState(), copy = { ...createWorkbenchTab('copy-source', {
      ...state.tabs[sourceLocation.tabId]!.regions[sourceLocation.regionId]!, regionId: 'random-copy-region' }), name: 'Second source display' }
    useAppStore.setState({ tabs: { ...state.tabs, [copy.id]: copy }, layouts: { ...state.layouts, copy: createWorkspaceLayout('copy-group', [copy.id]) } })
    disposers.push(registerWorkbenchDocument(document, { windowId: 'main-window', documentGeneration: 'main-document' }))
    await act(async () => root.render(<BrowserPane tab={{ ...child, source: { browserId: source.browserId, navigationId: source.navigationId } }} visible />))
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Go to source Browser"]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })))
    const options = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const second = options.find(item => item.textContent?.includes(copy.name))
    expect(second).toBeDefined(); expect(second!.textContent).toContain('Region 1'); expect(second!.textContent).not.toContain('random-copy-region')
    expect(focus).not.toHaveBeenCalled()
    await act(async () => second!.click())
    expect(focus).toHaveBeenLastCalledWith('copy', copy.id, 'random-copy-region', 'navigation', 'copy-group')
  })
})
