import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { tabSwitchObservation } from '../src/renderer/src/lib/tab-switch-observation'
import { rendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import { mainRegionReference } from '../src/renderer/src/lib/desktop-focus-navigation'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import type { WorkbenchProjection } from '../src/renderer/src/lib/workbench-projection'
import { useAppStore } from '../src/renderer/src/store'

vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: ({ sessionId }: { sessionId: string }) => <output data-session={sessionId}><p>Original readable content</p><textarea readOnly value={useAppStore(state => state.agentComposerDrafts[sessionId] ?? '')} /></output> }))
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'

it('records actual top Tab selection and retained host placement at the exact occurrence', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const original = useAppStore.getState(), home = document.createElement('div'); document.body.append(home)
  const root = createRoot(home), sourceConfig = await api.config.get(), snapshot = await api.sessions.snapshot()
  const config = { ...sourceConfig, hosts: [{ id: 'local' as const, kind: 'local' as const, label: 'Local' }],
    workspaces: [{ id: 'workspace-demo', hostId: 'local', kind: 'folder' as const, name: 'Project', path: _hygiene_fixturePath("repo") }] }
  const tabs = Object.fromEntries([['a', 'session-codex'], ['b', 'session-claude']].map(([id, sessionId]) => [id,
    createWorkbenchTab(id!, { regionId: `${id}:region`, kind: 'agent', phase: 'attached', workspaceId: 'workspace-demo', sessionId: sessionId! })]))
  const layout = { root: { type: 'leaf' as const, groupId: 'left' }, groups: [{ id: 'left', tabOrder: ['a', 'b'], activeTabId: 'a', recentTabIds: ['a', 'b'] }], activeGroupId: 'left' }
  try {
    useAppStore.setState({ config, sessions: snapshot.sessions.map(s => ({ ...s, hostId: 'local', workspacePath: _hygiene_fixturePath("repo") })),
      scratchTopicSnapshots: {}, providerCatalog: [], tabs, layouts: { 'workspace-demo': layout },
      activeWorkspaceId: 'workspace-demo', mainSurface: 'workbench', viewModes: { 'session-claude': 'terminal', 'session-codex': 'activity' } })
    await act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId: 'workspace-demo', visible: true })))
    const originalView = home.querySelector('[data-session="session-claude"]')
    expect(originalView).not.toBeNull()
    await act(async () => (home.querySelector('button[data-workbench-tab-id="b"]') as HTMLButtonElement).click())
    const record = rendererPerformance.snapshot().tabSwitches.at(-1)!
    expect(useAppStore.getState().layouts['workspace-demo']!.groups[0]!.activeTabId).toBe('b')
    expect(record).toMatchObject({ mode: 'terminal', state: 'pending', pendingStage: 'terminal', target: { presentationId: 'space', displayWorkspaceId: 'workspace-demo', groupId: 'left', tabId: 'b', regionId: 'b:region' } })
    expect(record).toMatchObject({ eventAtMonoMs: null, inputDelayMs: null, actionResult: 'returned', selectedSource: 'layout-effect' })
    expect(record.handlerStartMonoMs).toBeGreaterThan(0); expect(record.actionEndedMs).not.toBeNull()
    expect(record.selectedMs).not.toBeNull(); expect(record.placedMs).not.toBeNull()
    // This fixture intentionally has no native Terminal; host placement alone must not claim a frame or input readiness.
    expect(record.terminalMs).toBeNull(); expect(record.frameMs).toBeNull(); expect(record.inputReadyMs).toBeNull()
    expect(home.querySelector('[data-session="session-claude"]')).toBe(originalView)
    const readable = originalView!.querySelector('p')!.firstChild!, range = document.createRange(), selection = window.getSelection()!
    range.setStart(readable, 9); range.setEnd(readable, 17); selection.removeAllRanges(); selection.addRange(range)
    ;(originalView as HTMLElement).scrollTop = 37
    await act(async () => useAppStore.getState().setAgentComposerDraft('session-claude', 'Original unsent draft'))
    await act(async () => (home.querySelector('button[data-workbench-tab-id="a"]') as HTMLButtonElement).click())
    expect(tabSwitchObservation.snapshot().at(-1)).toMatchObject({ mode: 'activity', state: 'observed', terminalMs: null, inputReadyMs: null })
    expect(tabSwitchObservation.snapshot().at(-2)!.state).toBe('superseded')
    expect(home.querySelector('[data-session="session-claude"]')).toBe(originalView)
    expect(selection.getRangeAt(0).startContainer).toBe(readable); expect(selection.toString()).toBe('readable')
    expect((originalView as HTMLElement).scrollTop).toBe(37)
    expect(originalView!.querySelector('textarea')!.value).toBe('Original unsent draft')
    await act(async () => useAppStore.getState().setAgentComposerDraft('session-claude', 'Original unsent draft + later update'))
    expect(originalView!.querySelector('textarea')!.value).toBe('Original unsent draft + later update')
    // SessionPane is a retained leaf here; this verifies parent selection and draft projection, not Tiptap input.
    const mixed = addWorkbenchRegion(tabs.b!, 'b:region', 'right', {
      kind: 'terminal', phase: 'attached', regionId: 'raw:region', workspaceId: 'workspace-demo', sessionId: 'raw'
    })
    expect(mixed.titleRegionId).toBe('b:region'); expect(mixed.layout.activeRegionId).toBe('raw:region')
    await act(async () => useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, b: mixed },
      viewModes: { 'session-claude': 'activity', 'session-codex': 'activity' } }))
    await act(async () => (home.querySelector('button[data-workbench-tab-id="b"]') as HTMLButtonElement).click())
    expect(tabSwitchObservation.snapshot().at(-1)).toMatchObject({ mode: 'terminal', target: { regionId: 'raw:region' }, terminalMs: null })
  } finally {
    await act(async () => root.unmount()); home.remove(); useAppStore.setState(original, true); vi.unstubAllGlobals()
  }
})


it('records the actual projection selection callback and keeps its original occurrence', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const original = useAppStore.getState(), home = document.createElement('div'); document.body.append(home)
  const root = createRoot(home), sourceConfig = await api.config.get(), snapshot = await api.sessions.snapshot()
  const config = { ...sourceConfig, hosts: [{ id: 'local' as const, kind: 'local' as const, label: 'Local' }],
    workspaces: [{ id: 'workspace-demo', hostId: 'local', kind: 'folder' as const, name: 'Project', path: _hygiene_fixturePath('repo') }] }
  const workspaceId = 'workspace-demo', groupId = 'left'
  const tabs = Object.fromEntries([['a', 'session-codex'], ['b', 'session-claude']].map(([id, sessionId]) => [id,
    createWorkbenchTab(id!, { regionId: `${id}:region`, kind: 'agent', phase: 'attached', workspaceId, sessionId: sessionId! })]))
  const layout = { root: { type: 'leaf' as const, groupId }, groups: [{ id: groupId, tabOrder: ['a', 'b'], activeTabId: 'a', recentTabIds: ['a', 'b'] }], activeGroupId: groupId }
  const calls: Parameters<WorkbenchProjection['onSelect']>[0][] = []
  try {
    useAppStore.setState({ config, sessions: snapshot.sessions.map(session => ({ ...session, hostId: 'local', workspacePath: _hygiene_fixturePath('repo') })), scratchTopicSnapshots: {}, providerCatalog: [],
      tabs, layouts: { [workspaceId]: layout }, activeWorkspaceId: workspaceId, mainSurface: 'workbench',
      workbenchSpaceSelection: null, viewModes: { 'session-codex': 'activity', 'session-claude': 'activity' } })
    const catalog = spatialCatalog(useAppStore.getState(), [])
    expect(catalog.locations.filter(location => location.displayWorkspaceId === workspaceId)).toHaveLength(2)
    const zoneId = catalog.tabs.find(tab => tab.tabId === 'a')!.zoneId!
    function Projection() {
      const [selection, setSelection] = useState([{ displayWorkspaceId: workspaceId, groupId, tabId: 'a', regionId: 'a:region' }])
      const scope: WorkbenchProjection = { entity: { kind: 'zone', zoneId }, presentationId: 'original-projection',
        displayWorkspaceId: workspaceId, catalog, selectionMode: 'occurrence', selection,
        onSelect(reference) { calls.push(reference); useAppStore.getState().selectMainRegion(reference); setSelection([reference]) } }
      return createElement(WorkspaceWorkbench, { workspaceId, visible: true, projection: scope })
    }
    await act(async () => root.render(createElement(Projection)))
    const view = home.querySelector('[data-session="session-claude"]')
    expect(view).not.toBeNull()
    await act(async () => (home.querySelector('button[data-workbench-tab-id="b"]') as HTMLButtonElement).click())
    const reference = { displayWorkspaceId: workspaceId, groupId, tabId: 'b', regionId: 'b:region' }
    expect(calls).toEqual([reference])
    expect(mainRegionReference(useAppStore.getState().workbenchSpaceSelection)).toEqual(reference)
    expect(tabSwitchObservation.snapshot().at(-1)).toMatchObject({ target: { ...reference, presentationId: 'original-projection' },
      mode: 'activity', state: 'observed', actionResult: 'returned', selectedSource: 'layout-effect', eventAtMonoMs: null })
    expect(tabSwitchObservation.snapshot().at(-1)!.actionEndedMs).not.toBeNull()
    expect(home.querySelector('[data-session="session-claude"]')).toBe(view)
  } finally {
    await act(async () => root.unmount()); home.remove(); useAppStore.setState(original, true); vi.unstubAllGlobals()
  }
})
