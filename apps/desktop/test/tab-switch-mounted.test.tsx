import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { tabSwitchObservation } from '../src/renderer/src/lib/tab-switch-observation'
import { rendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import { useAppStore } from '../src/renderer/src/store'

vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: ({ sessionId }: { sessionId: string }) => <output data-session={sessionId} /> }))
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'

it('records actual top Tab selection and retained host placement at the exact occurrence', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const original = useAppStore.getState(), home = document.createElement('div'); document.body.append(home)
  const root = createRoot(home), sourceConfig = await api.config.get(), snapshot = await api.sessions.snapshot()
  const config = { ...sourceConfig, hosts: [{ id: 'local', kind: 'local' as const, label: 'Local' }],
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
    expect(record).toMatchObject({ mode: 'terminal', state: 'pending', target: { presentationId: 'space', displayWorkspaceId: 'workspace-demo', groupId: 'left', tabId: 'b', regionId: 'b:region' } })
    expect(record.selectedMs).not.toBeNull(); expect(record.placedMs).not.toBeNull()
    // This fixture intentionally has no native Terminal; host placement alone must not claim a frame or input readiness.
    expect(record.terminalMs).toBeNull(); expect(record.frameMs).toBeNull(); expect(record.inputReadyMs).toBeNull()
    expect(home.querySelector('[data-session="session-claude"]')).toBe(originalView)
    await act(async () => (home.querySelector('button[data-workbench-tab-id="a"]') as HTMLButtonElement).click())
    expect(tabSwitchObservation.snapshot().at(-1)).toMatchObject({ mode: 'activity', state: 'observed', terminalMs: null, inputReadyMs: null })
    expect(tabSwitchObservation.snapshot().at(-2)!.state).toBe('superseded')
    const mixed = addWorkbenchRegion(tabs.b!, 'b:region', 'horizontal', {
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
