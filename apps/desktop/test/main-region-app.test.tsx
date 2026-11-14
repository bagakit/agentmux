const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge'
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

it.each([false, true])('an explicit Space Region selection reveals closed Focus without changing execution MRU; same target=%s', async sameTarget => {
  const f = await fixture()
  try {
    if (sameTarget) await f.chooseFile()
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
async function publicFocusFixture() {
  const f = await fixture(), directory = await mkdtemp(_hygiene_fixturePath("tmp/amx-main-region-"))
  let holdReply = false, releaseReply: (() => void) | undefined
  const seen: string[] = [], bridge = new DesktopControlIpcBridge({ isAvailable: () => true,
    sendRequest(request) {
      if (request.operation !== 'focus' && request.operation !== 'inspect.client') throw new Error('This fixture carries only the original public navigation and inspection.')
      void useAppStore.getState().executeControl(request).then(result => {
        const accept = () => bridge.accept({ requestId: request.requestId, ok: true, result })
        if (holdReply && request.operation === 'focus') releaseReply = accept
        else accept()
      },
        error => bridge.accept({ requestId: request.requestId, ok: false, error: { code: 'CONTROL_FAILED', message: String(error) } }))
    }, sendCancellation() {} })
  const server = new AgentMuxControlServer({ execute(request, _name, context) { seen.push(request.operation); return bridge.execute(request, context?.signal) } }, join(directory, 'control.sock'))
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    const unique = createWorkbenchTab('public-unique-agent-tab', { regionId: 'public-unique-agent-region', workspaceId: f.resource.id,
      kind: 'agent', phase: 'attached', sessionId: f.other.id })
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [unique.id]: unique }, layouts: { ...state.layouts,
      [f.resource.id]: { ...state.layouts[f.resource.id]!, groups: state.layouts[f.resource.id]!.groups.map(group =>
        group.id === 'resource-home-group' ? { ...group, tabOrder: [...group.tabOrder, unique.id] } : group) } } }))
    // Admit original spatial persistence through the existing Store initializer.
    useAppStore.setState({ initialize: initial.initialize })
    await initializeSpatialControlFixture()
    useAppStore.setState({ initialize: async () => () => {} })
    await server.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    const client = rpc
    async function beginFocus(target: import('@agentmux/core/control').AgentMuxDesktopFocusTarget, expectedAgentSessionId?: string) {
      let pending!: ReturnType<typeof client.call<'app.focus'>>
      await act(async () => {
        pending = client.call('app.focus', { target, inputPolicy: 'preserve', ...(expectedAgentSessionId ? { expectedAgentSessionId } : {}) })
        await new Promise(resolve => setTimeout(resolve, 30))
      })
      return { pending }
    }
    return { ...f, unique, seen, rpc: client, exactTarget: { kind: 'space' as const, displayWorkspaceId: f.file.displayWorkspaceId,
      groupId: f.file.groupId, tabId: f.file.tabId, regionId: f.file.regionId }, beginFocus,
      async focus(target: import('@agentmux/core/control').AgentMuxDesktopFocusTarget, expectedAgentSessionId?: string) {
        return (await beginFocus(target, expectedAgentSessionId)).pending
      },
      holdNextReply() { holdReply = true },
      async releaseReply() { await vi.waitFor(() => expect(releaseReply).toBeDefined()); holdReply = false; releaseReply!() },
      async close() { await rpc?.dispose(); await server.stop(); bridge.dispose(); await rm(directory, { recursive: true, force: true }); await f.close() }
    }
  } catch (error) { await rpc?.dispose(); await server.stop(); bridge.dispose(); await rm(directory, { recursive: true, force: true }); await f.close(); throw error }
}

it('typed public private-Unix app.focus and app.inspect retain the original common address through every surface', async () => {
  const f = await publicFocusFixture()
  try {
    await f.chooseFile()
    const result = await f.focus(f.exactTarget)
    expect(result.navigation.selection.space).toMatchObject({ workspaceId: f.file.displayWorkspaceId, groupId: f.file.groupId,
      tabId: f.file.tabId, regionId: f.file.regionId })
    expect(result.navigation.state).toMatch(/applied|unchanged/)
    for (const surface of ['focus', 'survey', 'goals', 'space'] as const) {
      expect((await f.focus({ kind: 'surface', surface })).navigation.selection.space).toEqual(result.navigation.selection.space)
      const inspected = await f.rpc!.call('app.inspect', {})
      expect((inspected.observation as { desktop: { selection: { space: unknown; surface: string } } }).desktop.selection).toMatchObject({ space: result.navigation.selection.space, surface })
      if (surface === 'focus') expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).not.toBeNull()
    }
    expect(f.seen.filter(value => value === 'focus')).toHaveLength(5)
    expect(f.seen.filter(value => value === 'inspect.client')).toHaveLength(4)
  } finally { await f.close() }
})

it('same-target public exact navigation explicitly reopens a collapsed Focus workface', async () => {
  const f = await publicFocusFixture()
  try {
    await f.chooseFile(); const held = useAppStore.getState().workbenchSpaceSelection
    await collapseFocus(f)
    expect((await f.focus(f.exactTarget)).navigation.selection.space).toEqual(held)
    await f.focus({ kind: 'surface', surface: 'focus' })
    expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).not.toBeNull()
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(held)
  } finally { await f.close() }
})

it('surface-only public Focus navigation preserves a collapsed workface', async () => {
  const f = await publicFocusFixture()
  try {
    await f.chooseFile(); const held = useAppStore.getState().workbenchSpaceSelection
    await collapseFocus(f)
    await f.focus({ kind: 'surface', surface: 'focus' })
    expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).toBeNull()
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(held)
  } finally { await f.close() }
})

it('a delayed public navigation ACK cannot replay reveal after a later local collapse', async () => {
  const f = await publicFocusFixture()
  try {
    await f.chooseFile(); await collapseFocus(f)
    f.holdNextReply()
    const { pending } = await f.beginFocus(f.exactTarget)
    await act(async () => useAppStore.getState().setMainSurface('agents'))
    await collapseFocus(f)
    await f.releaseReply(); await pending
    expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).toBeNull()
  } finally { await f.close() }
})

it('a rejected public original Agent qualifier cannot reveal the retained File workface', async () => {
  const f = await publicFocusFixture()
  try {
    await f.chooseFile(); await collapseFocus(f)
    expect((await f.focus(f.exactTarget, f.session.id)).navigation.state).toBe('rejected')
    expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).toBeNull()
  } finally { await f.close() }
})

it.each(['multiple', 'unique'] as const)('public focus-agent preserves its %s-location card semantics without guessing a Work target', async occurrence => {
  const f = await publicFocusFixture()
  try {
    await f.chooseFile(); const held = useAppStore.getState().workbenchSpaceSelection
    await collapseFocus(f)
    const session = occurrence === 'multiple' ? f.session : f.other
    expect((await f.focus({ kind: 'focus-agent', hostId: session.control.hostId, agentSessionId: session.id })).focus.agent?.agentSessionId).toBe(session.id)
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(held)
    expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).toBeNull()
    if (occurrence === 'unique') {
      const card = f.container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${session.id}"]`)
      expect(card).not.toBeNull()
      await act(async () => card!.click())
      expect(f.container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(f.unique.id)
      expect(useAppStore.getState().workbenchSpaceSelection?.regionId).toBe('public-unique-agent-region')
    }
    expect(useAppStore.getState().agentComposerDrafts[f.session.id]).toBe('Original unsent draft')
  } finally { await f.close() }
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
    await act(async () => useAppStore.getState().setMainSurface('agents'))
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

async function focusIntentSourceFixture(kind: 'agent' | 'launcher' = 'agent') {
  const f = await fixture(), cleanup: Array<() => unknown | Promise<unknown>> = []
  try {
  const { createSpaceSessionsFixture } = await import('../../../packages/core/test/helpers/space-session-fixture')
  const { AgentProviderRegistry } = await import('../../../packages/core/src/agent-provider')
  const { spaceMountTransport } = await import('./helpers/space-mount-fixture')
  const source = await createSpaceSessionsFixture(cleanup), sid = 'original-focus-intent-source', creation = 'original-focus-intent-creation'
  const physicalReads: Promise<unknown>[] = []
  for (const owner of [source.b, source.d]) {
    const read = owner.core.readSessionHistoryPage.bind(owner.core)
    vi.spyOn(owner.core, 'readSessionHistoryPage').mockImplementation((...args) => {
      const pending = read(...args); physicalReads.push(pending); return pending
    })
  }
  // Unmount closes logical subscribers; finish their own physical reads before
  // disposing these original owners and removing the fixture's private roots.
  cleanup.push(async () => { await Promise.allSettled(physicalReads) })
  source.d.core.providers.register(new AgentProviderRegistry().get('codex'))
  const original = await source.d.put(sid)
  const stored = { ...original, creation: { createOperationId: creation, initialPrompt: 'unknown' as const } }
  const registry = Reflect.get(source.d.core, 'registry') as { put(value: typeof stored, expected: typeof stored.run): Promise<void> }
  await registry.put(stored, original.run)
  const admitted = await source.admit('D-in-B', source.d.owner.runtimeId, sid, creation)
  const target = { hostId: 'focus-intent-source', reference: source.reference,
    zoneId: admitted.address.zoneId!, workspaceId: admitted.address.workspaceId! }
  const main = spaceMountTransport(cleanup, [{ id: target.hostId, carrier: {
    forwardRpc: source.b.rpc.call.bind(source.b.rpc), subscribeRpc: source.b.rpc.subscribe.bind(source.b.rpc)
  } }], useAppStore.getState().config!)
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(main.api.call)
  vi.spyOn(api.spaceMounts, 'watch').mockImplementation(main.api.watch)
  vi.spyOn(api.spaceMounts, 'sessions').mockImplementation(main.api.sessions)
  vi.spyOn(api.spaceMounts, 'member').mockImplementation(main.api.member)
  vi.spyOn(api.spaceMounts, 'reading').mockImplementation(main.api.reading)
  let snapshot = await main.api.call('snapshot', { hostId: target.hostId, reference: target.reference })
  const selectedTabId = kind === 'launcher' ? 'original-source-launcher-tab' : admitted.address.tabId!
  const selectedRegionId = kind === 'launcher' ? 'original-source-launcher-position' : admitted.address.regionId!
  if (kind === 'launcher') {
    const tab = snapshot.scope.tabs.find(tab => tab.tabId === admitted.address.tabId)!
    await main.api.call('apply', { hostId: target.hostId, reference: target.reference, edit: { reference: target.reference,
      expectedRevision: snapshot.revision, changes: { tabs: [{ ...tab, tabId: selectedTabId, name: 'Original Source Launcher', regionIds: [selectedRegionId] }],
        regions: [{ regionId: selectedRegionId, tabId: selectedTabId, kind: 'launcher', agentSessionId: null, runId: null,
          execution: { hostId: 'local', cwd: '/b/project', runtimeId: source.b.owner.runtimeId } }] } } })
    snapshot = await main.api.call('snapshot', { hostId: target.hostId, reference: target.reference })
  }
  const { originalSourceInputOwnerKey } = await import('../src/renderer/src/lib/original-space-navigation')
  const owner = originalSourceInputOwnerKey(source.d.owner.runtimeId, sid), draft = 'Original Source draft remains unsent'
  await act(async () => {
    useAppStore.getState().mountSpace(target, false)
    useAppStore.getState().observeSpaceMount(target, { snapshot, reading: false })
    useAppStore.getState().setAgentComposerDraft(owner, draft)
    useAppStore.getState().openOriginalSpaceLocation({ target, occurrence: {
      tabId: selectedTabId, regionId: selectedRegionId, displayWorkspaceId: target.workspaceId
    } }, false)
  })
  await vi.waitFor(() => expect(f.container.querySelector('.focused-tab-workspace')).not.toBeNull())
  // The original navigation owner supplies its qualified choice after the first
  // presentation has mounted; do not patch a Runtime qualifier into test state.
  await act(async () => useAppStore.getState().openOriginalSpaceLocation({ target, occurrence: {
    tabId: selectedTabId, regionId: selectedRegionId, displayWorkspaceId: target.workspaceId
  } }, false))
  expect(useAppStore.getState().workbenchSpaceSelection?.sourceRuntimeId).toBe(target.reference.runtimeId)
  return { ...f, source, main, target, snapshot, admitted, selectedTabId, selectedRegionId, sid, owner, draft, original,
    async close() { await f.close(); for (const close of cleanup.reverse()) await close() }
  }
  } catch (error) { await f.close(); for (const close of cleanup.reverse()) await close(); throw error }
}
async function collapseFocus(f: Awaited<ReturnType<typeof fixture>>) {
  const close = f.container.querySelector<HTMLButtonElement>('[aria-label="Close Focus workspace"]')
  expect(close).not.toBeNull()
  await act(async () => close!.click())
  expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).toBeNull()
}

it.each(['agent', 'launcher'] as const)('background Source %s snapshots keep Focus collapsed through actual owner changes', async kind => {
  const f = await focusIntentSourceFixture(kind)
  try {
    await collapseFocus(f)
    const before = useAppStore.getState(), held = before.workbenchSpaceSelection
    await act(async () => useAppStore.getState().observeSpaceMount(f.target, { snapshot: f.snapshot, reading: false }))
    expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).toBeNull()
    // Both shapes receive a real Source owner change. Only the Agent case
    // unbinds its original sole occurrence, proving a genuine address change.
    const selectedTab = f.snapshot.scope.tabs.find(tab => tab.tabId === f.selectedTabId)!
    await f.main.api.call('apply', { hostId: f.target.hostId, reference: f.target.reference, edit: {
      reference: f.target.reference, expectedRevision: f.snapshot.revision,
      changes: kind === 'agent' ? { remove: { tabs: [f.selectedTabId], regions: f.snapshot.scope.regions.filter(region => region.tabId === f.selectedTabId).map(region => region.regionId) } }
        : { tabs: [{ ...selectedTab, tabId: 'background-source-tab', name: 'Another original Source Tab', regionIds: ['background-source-launcher'] }],
          regions: [{ regionId: 'background-source-launcher', tabId: 'background-source-tab', kind: 'launcher', agentSessionId: null, runId: null,
            execution: { hostId: 'local', cwd: '/b/project', runtimeId: f.source.b.owner.runtimeId } }] }
    } })
    const changed = await f.main.api.call('snapshot', { hostId: f.target.hostId, reference: f.target.reference })
    await act(async () => useAppStore.getState().observeSpaceMount(f.target, { snapshot: changed, reading: false }))
    const after = useAppStore.getState()
    if (kind === 'agent') {
      expect(after.workbenchSpaceSelection).not.toEqual(held)
      expect(after.workbenchSpaceSelection).toMatchObject({ spaceId: f.target.reference.spaceId, zoneId: f.target.zoneId,
        tabId: null, regionId: null, groupId: null })
    } else expect(after.workbenchSpaceSelection).toEqual(held)
    expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).toBeNull()
    expect(after.agentComposerDrafts[f.owner]).toBe(f.draft)
    expect((await f.source.d.core.readAgentSession(f.sid))!.run).toEqual(f.original.run)
    expect(after.sessions).toBe(before.sessions)
  } finally { await f.close() }
})

it('reselecting the same ordinary Context after collapse opens its exact retained workface', async () => {
  const f = await fixture()
  try {
    const held = useAppStore.getState().workbenchSpaceSelection
    await collapseFocus(f)
    const card = f.container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${f.session.id}"]`)
    expect(card).not.toBeNull()
    await act(async () => card!.click())
    expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).not.toBeNull()
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(held)
    expect(useAppStore.getState().agentComposerDrafts[f.session.id]).toBe('Original unsent draft')
  } finally { await f.close() }
})

it('reselecting the same original Source Context after collapse opens its exact workface without borrowing local identity', async () => {
  const f = await focusIntentSourceFixture()
  try {
    const { focusSourceContextId } = await import('../src/renderer/src/lib/focus-source-model')
    const id = focusSourceContextId(f.source.d.owner.runtimeId, f.sid)
    let card: HTMLButtonElement | null = null
    await vi.waitFor(() => { card = f.container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id='${id}']`); expect(card).not.toBeNull() })
    const held = useAppStore.getState().workbenchSpaceSelection
    await collapseFocus(f)
    await act(async () => card!.click())
    expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).not.toBeNull()
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(held)
    expect(useAppStore.getState().agentComposerDrafts[f.owner]).toBe(f.draft)
    expect((await f.source.d.core.readAgentSession(f.sid))!.run).toEqual(f.original.run)
    expect(useAppStore.getState().sessions.some(session => session.id === f.sid)).toBe(false)
  } finally { await f.close() }
})

it('the real window keyboard navigation explicitly reopens the selected original Region in Focus', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
  const f = await fixture()
  try {
    await f.chooseFile()
    await collapseFocus(f)
    await act(async () => useAppStore.getState().setMainSurface('workbench'))
    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', metaKey: true, altKey: true, bubbles: true, cancelable: true })
    await act(async () => f.container.querySelector('main')!.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(useAppStore.getState().workbenchSpaceSelection?.regionId).toBe(f.file.regionId)
    await act(async () => useAppStore.getState().setMainSurface('agents'))
    expect(f.container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(f.exact.id)
    expect(useAppStore.getState().agentComposerDrafts[f.session.id]).toBe('Original unsent draft')
  } finally { await f.close() }
})

it('the real resource-only Source Folder row never borrows the previously selected workface', async () => {
  const f = await focusIntentSourceFixture(), navigationContainer = document.createElement('div'), root = createRoot(navigationContainer)
  document.body.append(navigationContainer)
  try {
    const { SourceFolderNavigation, useSourceFolderNavigation } = await import('../src/renderer/src/components/SourceFolderNavigation')
    const { originalSpaceResource } = await import('../src/renderer/src/lib/original-space-navigation')
    const state = useAppStore.getState(), resource = originalSpaceResource(state, f.target, f.target.workspaceId)
    expect(resource).toBeDefined()
    await collapseFocus(f)
    await act(async () => useAppStore.getState().openOriginalSpaceLocation({ target: f.target, resource }, false))
    function Navigation() { return createElement(SourceFolderNavigation, { navigation: useSourceFolderNavigation(''), hostId: f.target.hostId }) }
    await act(async () => root.render(createElement(Navigation)))
    const row = navigationContainer.querySelector<HTMLButtonElement>('button[data-space-entry]')
    expect(row).not.toBeNull()
    expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).toBeNull()
    await act(async () => row!.click())
    expect(useAppStore.getState().mainSurface).toBe('workbench')
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ sourceRuntimeId: f.target.reference.runtimeId,
      spaceId: f.target.reference.spaceId, zoneId: f.target.zoneId, tabId: null, groupId: null, regionId: null })
    await act(async () => useAppStore.getState().setMainSurface('agents'))
    expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).toBeNull()
    expect(useAppStore.getState().agentComposerDrafts[f.owner]).toBe(f.draft)
  } finally { await act(async () => root.unmount()); navigationContainer.remove(); await f.close() }
})

it.each([false, true])('explicit Launcher reveal contributes only an accepted foreground navigation: reveal=%s', async reveal => {
  const f = await fixture()
  try {
    const before = useAppStore.getState()
    await collapseFocus(f)
    await act(async () => useAppStore.getState().openLauncher({ workspaceId: f.resource.id, tabGroupId: 'resource-home-group', reveal }))
    await act(async () => useAppStore.getState().setMainSurface('agents'))
    if (reveal) {
      expect(useAppStore.getState().workbenchSpaceSelection).not.toEqual(before.workbenchSpaceSelection)
      expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).not.toBeNull()
    } else {
      expect(useAppStore.getState().workbenchSpaceSelection).toEqual(before.workbenchSpaceSelection)
      expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).toBeNull()
    }
    expect(useAppStore.getState().agentComposerDrafts[f.session.id]).toBe('Original unsent draft')
  } finally { await f.close() }
})


it('an explicit complete original Source location reveals its accepted workface', async () => {
  const f = await focusIntentSourceFixture()
  try {
    const held = useAppStore.getState().workbenchSpaceSelection
    await collapseFocus(f)
    await act(async () => useAppStore.getState().openOriginalSpaceLocation({ target: f.target, occurrence: {
      tabId: f.selectedTabId, regionId: f.selectedRegionId, displayWorkspaceId: f.target.workspaceId } }))
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(held)
    await act(async () => useAppStore.getState().setMainSurface('agents'))
    expect(f.container.querySelector('aside[aria-label="Focus workspace"]')).not.toBeNull()
    expect(useAppStore.getState().agentComposerDrafts[f.owner]).toBe(f.draft)
  } finally { await f.close() }
})
