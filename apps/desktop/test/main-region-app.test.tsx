const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { seedMoteWorkface, defaultAgent, executionAgent, moteTopics } from './fixtures/mote-workface'
import { createRequire } from 'node:module'
import { act, createElement, useEffect } from 'react'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { expect, it, vi } from 'vitest'
import { createWorkspaceLayout, splitWorkbenchRegion, type WorkspaceLayout } from '@agentmux/layout'
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)(
  '../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
const leaves = vi.hoisted(() => ({ mounts: [] as string[], unmounts: [] as string[] }))
// Keep the actual App/Global/Workbench/Provider tree; replace SessionPane with a local instance/draft/Range probe. This is not ReaderBody or Native PTY evidence.
vi.mock('../src/renderer/src/components/SessionPane', () => ({
  SessionPane: ({ sessionId, linkOrigin }: { sessionId: string; linkOrigin: { tabId: string; regionId: string } }) => {
    const key = `${linkOrigin.tabId}/${linkOrigin.regionId}`
    useEffect(() => { leaves.mounts.push(key); return () => { leaves.unmounts.push(key) } }, [key])
    const draft = useAppStore(state => state.agentComposerDrafts[sessionId] ?? '')
    const presentation = useWorkbenchBrowserPresentation()
    return createElement('section', { 'data-selection-session': sessionId, 'data-selection-leaf': key,
      'data-selection-surface': presentation.surface, 'data-selection-reference': JSON.stringify(presentation.reference) },
      createElement('p', {}, 'Original readable content stays here'),
      createElement('textarea', { 'aria-label': `Original draft ${key}`, value: draft, readOnly: true }))
  }
}))
// The Launcher's real warm-shell owner also reaches a PTY painting leaf.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => createElement('div', { 'data-warm-pty-paint-isolated': '' }) }))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { requestPmoTeamsTopicFloatingClose } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { installNativePopover } from './fixtures/mote-workface'
import { useWorkbenchBrowserPresentation } from '../src/renderer/src/lib/workbench-presentation'
import { mainRegionReference } from '../src/renderer/src/lib/desktop-focus-navigation'
const initial = useAppStore.getState()
const initialLauncher = useLauncherState.getState()
async function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); window.localStorage.clear()
  useLauncherState.setState({ persistenceIssue: null, sections: {}, drafts: {}, executors: {} })
  leaves.mounts = []; leaves.unmounts = []
  const restorePopover = installNativePopover(), config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const resource = { ...config.workspaces.find(item => item.id === 'workspace-demo')!, path: _hygiene_fixturePath("private/resource-a") }
  const display = { ...resource, id: 'display-b', name: 'Display B', path: _hygiene_fixturePath("private/display-b") }
  const session = { ...snapshot.sessions.find(item => item.id === 'session-codex')!, workspacePath: resource.path }
  const other = { ...snapshot.sessions.find(item => item.id === 'session-claude')!, workspacePath: resource.path }
  expect(session.kind).toBe('agent'); expect(other.kind).toBe('agent')
  const decoy = createWorkbenchTab('decoy-first-tab', { regionId: 'decoy-region', workspaceId: resource.id,
    kind: 'agent', phase: 'attached', sessionId: session.id }, 'Decoy first')
  const exact = createWorkbenchTab('explicit-exact-tab', { regionId: 'exact-r1', workspaceId: resource.id,
    kind: 'file', path: 'selection.txt' }, 'Original mixed Tab')
  exact.regions['exact-r2'] = { regionId: 'exact-r2', workspaceId: resource.id,
    kind: 'agent', phase: 'attached', sessionId: session.id }
  exact.layout = splitWorkbenchRegion(exact.layout, 'exact-r1', 'right', 'exact-r2')
  const first = createWorkspaceLayout('display-first-group', [exact.id])
  const displayLayout: WorkspaceLayout = { ...first, root: { type: 'split', direction: 'horizontal', ratio: .5,
    first: first.root, second: { type: 'leaf', groupId: 'display-exact-group' } },
    groups: [...first.groups, { ...first.groups[0]!, id: 'display-exact-group' }], activeGroupId: first.activeGroupId }
  useAppStore.setState({ ...initial, initialize: async () => () => {}, loading: false,
    config: { ...config, workspaces: [resource, display] }, sessions: [session, other],
    tabs: { [decoy.id]: decoy, [exact.id]: exact },
    layouts: { [resource.id]: createWorkspaceLayout('resource-home-group', [decoy.id, exact.id]), [display.id]: displayLayout },
    mainSurface: 'workbench', activeWorkspaceId: resource.id, toolsOpen: false, projectRailOpen: false,
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [session.id]: 'Original unsent draft' } }, true)
  const reference = { displayWorkspaceId: display.id, groupId: 'display-exact-group', tabId: exact.id, regionId: 'exact-r2' }
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(createElement(App)))
  expect(container.querySelector('main.main-shell')).not.toBeNull()
  await act(async () => {
    useAppStore.getState().focusRegion(reference.displayWorkspaceId, reference.tabId, reference.regionId, 'pointer', reference.groupId)
    useAppStore.getState().setMainSurface('agents')
  })
  expect(container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(exact.id)
  const file = { ...reference, regionId: 'exact-r1' }
  return { container, reference, file, resource, display, session, other, exact,
    async chooseFile() {
      const node = container.querySelector<HTMLElement>('.focused-tab-workspace [data-workbench-region-id="exact-r1"]')
      expect(node).not.toBeNull()
      await act(async () => node!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
    },
    async close() { await act(async () => root.unmount()); container.remove(); restorePopover()
      useAppStore.setState(initial, true); useLauncherState.setState(initialLauncher, true); window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() }
  }
}
it('actual App selects the exact File and returns through every main surface without borrowing execution MRU', async () => {
  const f = await fixture()
  try {
    const before = useAppStore.getState(), leaf = f.container.querySelector<HTMLElement>('[data-selection-leaf="explicit-exact-tab/exact-r2"]')!
    expect(leaf).not.toBeNull()
    const text = leaf.querySelector('p')!.firstChild!, range = document.createRange()
    range.setStart(text, 9); range.setEnd(text, 17)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    const mounts = [...leaves.mounts]
    const reads = { page: vi.spyOn(api.sessions, 'historyPage'), timeline: vi.spyOn(api.sessions, 'timeline'), catalog: vi.spyOn(api.sessions, 'historySources') }
    await f.chooseFile()
    const after = useAppStore.getState(), choice = after.workbenchSpaceSelection!
    expect(choice).toMatchObject({ workspaceId: f.file.displayWorkspaceId, groupId: f.file.groupId, tabId: f.file.tabId, regionId: f.file.regionId })
    expect(after.agentFocus.execution).toBe(before.agentFocus.execution)
    expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts); expect(after.sessions).toBe(before.sessions)
    expect(f.container.querySelector('[data-selection-leaf="explicit-exact-tab/exact-r2"]')).toBe(leaf)
    expect(selection.getRangeAt(0)).toBe(range); expect(selection.toString()).toBe('readable')
    expect(leaf.querySelector('textarea')?.value).toBe('Original unsent draft')
    expect(leaves.mounts).toEqual(mounts); expect(leaves.unmounts).toEqual([])
    for (const read of Object.values(reads)) expect(read).not.toHaveBeenCalled()
    for (const surface of ['workbench', 'survey', 'board', 'agents'] as const) {
      await act(async () => useAppStore.getState().setMainSurface(surface))
      expect(useAppStore.getState().workbenchSpaceSelection).toEqual(choice)
    }
    expect(f.container.querySelector('.focused-tab-workspace [data-workbench-region-id="exact-r1"]')).not.toBeNull()
    expect(f.container.querySelector('.focus-toolbar__identity')?.textContent).not.toContain('Idle')
  } finally { await f.close() }
})
it('floating same-Tab Agent pointer retains the exact main File and actual main Region expression', async () => {
  const f = await fixture()
  try {
    await f.chooseFile()
    await act(async () => useAppStore.getState().setMainSurface('workbench'))
    const before = useAppStore.getState(), choice = before.workbenchSpaceSelection!, execution = before.agentFocus.execution
    const file = f.container.querySelector<HTMLElement>('[data-workbench-region-id="exact-r1"]')!
    expect(file).not.toBeNull()
    await act(async () => useAppStore.getState().focusRegion(f.reference.displayWorkspaceId, f.reference.tabId, f.reference.regionId, 'floating-pointer', f.reference.groupId))
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(choice)
    expect(useAppStore.getState().agentFocus.execution).toBe(execution)
    expect(useAppStore.getState().tabs[f.exact.id]!.layout.activeRegionId).toBe(f.reference.regionId)
    expect(file.dataset.regionActive).not.toBe('false')
    const activeMain = [...f.container.querySelectorAll<HTMLElement>('[data-workbench-region-id="exact-r1"]')].filter(node => node.classList.contains('workbench-region--active') || node.dataset.regionActive === 'true')
    expect(activeMain.length).toBeGreaterThan(0)
    await act(async () => useAppStore.getState().setMainSurface('agents'))
    expect(f.container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(f.exact.id)
    const header = f.container.querySelector('.focus-toolbar__identity')
    expect(header?.textContent).toContain('File')
    expect(useAppStore.getState().agentComposerDrafts[f.session.id]).toBe('Original unsent draft')
  } finally { await f.close() }
})
it('closing Focus only hides its projection and choosing the same Context reveals it again', async () => {
  const f = await fixture()
  try {
    const before = useAppStore.getState()
    const close = f.container.querySelector<HTMLButtonElement>('button[aria-label="Close Focus workspace"]')
    expect(close).not.toBeNull()
    expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).not.toBeNull()
    expect(f.container.querySelector('[role="separator"][aria-label="Resize Focus workspace"]')).not.toBeNull()
    await act(async () => close!.click())
    expect(document.activeElement).toBe(f.container.querySelector('[aria-label="Search contexts"]'))
    expect(f.container.querySelector('.focused-tab-workspace')).toBeNull()
    expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).toBeNull()
    expect(f.container.querySelector('[role="separator"][aria-label="Resize Focus workspace"]')).toBeNull()
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(before.workbenchSpaceSelection)
    expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    const context = f.container.querySelector<HTMLButtonElement>(`button[data-session-id="${f.session.id}"]`) ?? [...f.container.querySelectorAll<HTMLButtonElement>('.focus-context-row')].find(node => node.textContent?.includes(f.session.label))
    expect(context).not.toBeNull(); expect(context).not.toBeUndefined()
    await act(async () => context!.click())
    expect(f.container.querySelector('.focused-tab-workspace')).not.toBeNull()
    expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).not.toBeNull()
    expect(f.container.querySelector('[role="separator"][aria-label="Resize Focus workspace"]')).not.toBeNull()
    expect(useAppStore.getState().tabs).toBe(before.tabs)
  } finally { await f.close() }
})

it('a new explicit Space Region selection reveals the closed Focus projection without changing execution MRU', async () => {
  const f = await fixture()
  try {
    const before = useAppStore.getState()
    await act(async () => f.container.querySelector<HTMLButtonElement>('button[aria-label="Close Focus workspace"]')!.click())
    expect(f.container.querySelector('.focused-tab-workspace')).toBeNull()
    await act(async () => useAppStore.getState().setMainSurface('workbench'))
    const file = f.container.querySelector<HTMLElement>('[data-workbench-region-id="exact-r1"]')
    expect(file).not.toBeNull()
    await act(async () => file!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
    expect(useAppStore.getState().workbenchSpaceSelection?.regionId).toBe(f.file.regionId)
    await act(async () => useAppStore.getState().setMainSurface('agents'))
    expect(f.container.querySelector('.focused-tab-workspace')).not.toBeNull()
    expect(f.container.querySelector('.focus-toolbar__identity')?.textContent).toContain('File')
    expect(useAppStore.getState().agentFocus.execution).toBe(before.agentFocus.execution)
  } finally { await f.close() }
})

it('actual App retains Work Mote in Focus and presents only an explicit exact Survey handoff without following Work', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); window.localStorage.clear()
  const restorePopover = installNativePopover()
  useAppStore.setState({ ...initial, initialize: async () => () => {}, loading: false }, true)
  seedMoteWorkface()
  const before = useAppStore.getState(), execution = before.agentFocus.execution
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(App)))
    await act(async () => useAppStore.getState().selectSession(defaultAgent.id))
    const selected = useAppStore.getState().workbenchSpaceSelection!
    expect(selected.regionId).toBe('default-region')
    expect(useAppStore.getState().agentFocus.execution).toBe(execution)
    await act(async () => useAppStore.getState().setMainSurface('agents'))
    expect(container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(selected.tabId)
    expect(container.querySelector('.focused-tab-workspace [data-selection-session]')?.getAttribute('data-selection-session')).toBe(defaultAgent.id)
    expect(container.querySelector('.focus-toolbar__identity')?.textContent).toContain('Ship the target goal')
    await act(async () => useAppStore.getState().setMainSurface('survey'))
    expect(useAppStore.getState().surveyZoneSelection).toEqual(before.surveyZoneSelection)
    expect(container.querySelector(`[data-selection-surface="survey"][data-selection-session="${defaultAgent.id}"]`)).toBeNull()
    const reference = mainRegionReference(selected)
    expect(reference).not.toBeNull(); expect(selected.zoneId).not.toBeNull()
    await act(async () => useAppStore.getState().setSurveyZoneSelection({ zoneId: selected.zoneId!, selection: [reference!], active: reference! }))
    const survey = container.querySelector<HTMLElement>(`[data-selection-surface="survey"][data-selection-session="${defaultAgent.id}"]`)
    expect(survey).not.toBeNull()
    expect(JSON.parse(survey!.dataset.selectionReference!)).toEqual(reference)
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(selected)
    expect(useAppStore.getState().agentFocus.execution).toBe(execution)
  } finally {
    await act(async () => root.unmount()); container.remove(); restorePopover(); useAppStore.setState(initial, true)
    useLauncherState.setState(initialLauncher, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear()
  }
})
it('typed public private-Unix app.focus and app.inspect consume the original common address and actual App', async () => {
  const f = await fixture(), directory = await mkdtemp(_hygiene_fixturePath("tmp/amx-main-region-"))
  const seen: string[] = [], server = new AgentMuxControlServer({ execute(request) { seen.push(request.operation); return useAppStore.getState().executeControl(request) } }, join(directory, 'control.sock'))
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    // Admit original spatial persistence through the existing Store initializer.
    useAppStore.setState({ initialize: initial.initialize })
    await initializeSpatialControlFixture()
    useAppStore.setState({ initialize: async () => () => {} })
    await server.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    let pending!: ReturnType<typeof rpc.call<'app.focus'>>
    await act(async () => { pending = rpc!.call('app.focus', { target: { kind: 'space', displayWorkspaceId: f.file.displayWorkspaceId, groupId: f.file.groupId, tabId: f.file.tabId, regionId: f.file.regionId }, inputPolicy: 'preserve' }); await new Promise(resolve => setTimeout(resolve, 30)) })
    const result = await pending
    expect(result.navigation.selection.space).toMatchObject({ workspaceId: f.file.displayWorkspaceId, groupId: f.file.groupId, tabId: f.file.tabId, regionId: f.file.regionId })
    expect(result.navigation.state).toMatch(/applied|unchanged/)
    for (const surface of ['focus', 'survey', 'goals', 'space'] as const) {
      let changed!: ReturnType<typeof rpc.call<'app.focus'>>
      await act(async () => { changed = rpc!.call('app.focus', { target: { kind: 'surface', surface }, inputPolicy: 'preserve' }); await new Promise(resolve => setTimeout(resolve, 30)) })
      expect((await changed).navigation.selection.space).toEqual(result.navigation.selection.space)
      const inspected = await rpc.call('app.inspect', {})
      expect((inspected.observation as { desktop: { selection: { space: unknown; surface: string } } }).desktop.selection.space).toEqual(result.navigation.selection.space)
      expect((inspected.observation as { desktop: { selection: { space: unknown; surface: string } } }).desktop.selection.surface).toBe(surface)
    }
    expect(seen.filter(value => value === 'focus')).toHaveLength(5)
    expect(seen.filter(value => value === 'inspect.client')).toHaveLength(4)
  } finally { await rpc?.dispose(); await server.stop(); await rm(directory, { recursive: true, force: true }); await f.close() }
})

it('actual App Attention opens Mote, selects another discussion locally, then closes without changing the main File', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); window.localStorage.clear(); requestPmoTeamsTopicFloatingClose()
  const restorePopover = installNativePopover()
  useAppStore.setState({ ...initial, initialize: async () => () => {}, loading: false }, true); seedMoteWorkface()
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(moteTopics)
  vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue(moteTopics[0]!)
  const state = useAppStore.getState(), original = state.tabs['default-tab']!
  expect(original).toBeTruthy()
  const withExecution = addWorkbenchRegion(original, 'default-region', 'right', { kind: 'agent', phase: 'attached', workspaceId: original.workspaceId, regionId: 'floating-execution', sessionId: executionAgent.id })
  const tab = addWorkbenchRegion(withExecution, 'default-region', 'down', { kind: 'file', workspaceId: original.workspaceId, regionId: 'main-mote-file', path: 'main-mote-file.txt' })
  useAppStore.setState({ tabs: { ...state.tabs, [tab.id]: tab }, mainSurface: 'agents', sessions: state.sessions.map(session => session.id === defaultAgent.id && session.kind === 'agent' ? { ...session,
    pendingInteraction: { kind: 'question', id: 'original-question', agentSessionId: session.id, evidence: { source: 'native-hook', observedAt: 3, run: session.control.run, hookReceiptId: 'original-question' }, questions: [{ id: 'release', title: 'Release?', prompt: 'Which release?', options: [{ id: 'stable', label: 'Stable' }] }] } } : session) })
  const reference = { displayWorkspaceId: original.workspaceId, groupId: 'mote-group', tabId: tab.id, regionId: 'main-mote-file' }
  expect(useAppStore.getState().selectMainRegion(reference)).toBe(true)
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(App)))
    const before = useAppStore.getState(), execution = before.agentFocus.execution, choice = before.workbenchSpaceSelection
    const attention = container.querySelector<HTMLButtonElement>('.focus-pmo-attention'); expect(attention).not.toBeNull()
    await act(async () => attention!.click())
    const panel = document.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]'); expect(panel).not.toBeNull()
    // The entire SessionPane is a local probe in this test; original secondary
    // Agent stage slots are not a clickable Native/Reader body qualification.
    const discussion = panel!.querySelector<HTMLButtonElement>('button[data-workbench-tab-id="neighbor-tab"]')
    expect(discussion).not.toBeNull()
    await act(async () => discussion!.click())
    expect(panel!.dataset.moteTargetTab).toBe('neighbor-tab')
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(choice)
    expect(useAppStore.getState().agentFocus.execution).toBe(execution)
    expect(container.querySelector('.focus-toolbar__identity')?.textContent).toContain('File')
    const close = panel!.querySelector<HTMLButtonElement>('button[aria-label="Close Mote"]'); expect(close).not.toBeNull()
    await act(async () => close!.click())
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(choice)
    expect(useAppStore.getState().agentFocus.execution).toBe(execution)
    expect(container.querySelector('.focused-tab-workspace [data-workbench-region-id="main-mote-file"].workbench-region--active')).not.toBeNull()
  } finally { requestPmoTeamsTopicFloatingClose(); await act(async () => root.unmount()); container.remove(); restorePopover(); useAppStore.setState(initial, true); useLauncherState.setState(initialLauncher, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear() }
})

it('a new unplaced Agent is explicitly unconfirmed and never borrows the held File as its workface', async () => {
  const f = await fixture()
  try {
    await f.chooseFile(); const before = useAppStore.getState(), choice = before.workbenchSpaceSelection
    const card = f.container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${f.other.id}"]`)
    expect(card).not.toBeNull()
    await act(async () => card!.click())
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(f.other.id)
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(choice)
    expect(f.container.querySelector('.focused-tab-workspace')).toBeNull()
    expect(f.container.querySelector('.focus-location-recovery')?.textContent).toContain('No work surface occurrence')
    await act(async () => useAppStore.getState().setMainSurface('workbench'))
    await act(async () => useAppStore.getState().setMainSurface('agents'))
    expect(f.container.querySelector('.focused-tab-workspace [data-workbench-region-id="exact-r1"]')).not.toBeNull()
    expect(f.container.querySelector('.focus-toolbar__identity')?.textContent).toContain('File')
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(f.other.id)
  } finally { await f.close() }
})

it('actual File Markdown navigation consumes its exact foreign display occurrence instead of the first resource Group', async () => {
  const f = await fixture()
  try {
    await f.chooseFile()
    const held = useAppStore.getState(), tab = held.tabs[f.file.tabId]!, original = tab.regions[f.file.regionId]!
    expect(original.kind).toBe('file')
    const open = vi.fn((...args: Parameters<typeof held.openFile>) => held.openFile(...args))
    await act(async () => useAppStore.setState({ openFile: open, editorRegionModes: { ...held.editorRegionModes, [f.file.regionId]: 'preview' }, tabs: { ...held.tabs, [tab.id]: { ...tab, regions: { ...tab.regions, [f.file.regionId]: { ...original, kind: 'file', path: 'exact-reference.md' } } } },
      documents: { ...held.documents, [documentKey(f.resource.id, 'exact-reference.md')]: { path: 'exact-reference.md', content: '[Continue in original resource](next-reference.md)', revision: 'original-file' } } }))
    await vi.waitFor(() => expect(f.container.querySelector('[data-workbench-region-id="exact-r1"] .md-link')).not.toBeNull())
    const link = f.container.querySelector<HTMLButtonElement>('[data-workbench-region-id="exact-r1"] .md-link')!
    await act(async () => link.click())
    await vi.waitFor(() => expect(open).toHaveBeenCalled())
    expect(open.mock.calls[0]!.slice(0,4)).toEqual(['next-reference.md', f.file.groupId, undefined, f.resource.id])
    expect(open.mock.calls[0]![5]).toMatchObject({ displayWorkspaceId: f.display.id, resource: { hostId: f.resource.hostId, path: f.resource.path } })
    expect(useAppStore.getState().agentFocus.execution).toBe(held.agentFocus.execution)
  } finally { await f.close() }
})
