import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { expect, it, vi } from 'vitest'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { MoteWorkfaceContext } from '../src/renderer/src/lib/mote-workface'
import { tabSwitchObservation } from '../src/renderer/src/lib/tab-switch-observation'
import { useAppStore } from '../src/renderer/src/store'

vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: ({ sessionId }: { sessionId: string }) => <output data-session={sessionId} /> }))
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'

it('uses the original Space presentation for a nonfloating Mote context top Tab click', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const original = useAppStore.getState(), home = document.createElement('div'); document.body.append(home)
  const root = createRoot(home), sourceConfig = await api.config.get(), snapshot = await api.sessions.snapshot()
  const workspace = { id: 'workspace-demo', hostId: 'local', kind: 'folder' as const, name: 'Project', path: _hygiene_fixturePath("repo") }
  const config = { ...sourceConfig, hosts: [{ id: 'local', kind: 'local' as const, label: 'Local' }], workspaces: [workspace] }
  const tabs = Object.fromEntries([['a', 'session-codex'], ['b', 'session-claude']].map(([id, sessionId]) => [id,
    createWorkbenchTab(id!, { regionId: `${id}:region`, kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: sessionId! })]))
  const layout = { root: { type: 'leaf' as const, groupId: 'left' }, groups: [{ id: 'left', tabOrder: ['a', 'b'], activeTabId: 'a', recentTabIds: ['a', 'b'] }], activeGroupId: 'left' }
  const selectTab = vi.fn((tabId: string, groupId: string) => useAppStore.getState().activateTab(workspace.id, groupId, tabId, 'local'))
  // App wraps its ordinary workspace in this nonfloating context when a valid Mote owns its materials.
  // That object context does not change the retained host's Space presentation identity.
  const context = { workspace, rootPath: 'topic--launcher--leader', floating: false, selectTab,
    topic: { id: 'launcher:leader', directoryPath: 'topic--launcher--leader', topicPath: 'topic--launcher--leader/topic.md', title: 'Mote', summary: '', collaborators: [] } }
  try {
    useAppStore.setState({ config, sessions: snapshot.sessions.map(session => ({ ...session, hostId: 'local', workspacePath: _hygiene_fixturePath("repo") })),
      scratchTopicSnapshots: {}, providerCatalog: [], tabs, layouts: { [workspace.id]: layout },
      activeWorkspaceId: workspace.id, mainSurface: 'workbench', viewModes: { 'session-claude': 'terminal' } })
    await act(async () => root.render(createElement(MoteWorkfaceContext.Provider, { value: context },
      createElement(WorkspaceWorkbench, { workspaceId: workspace.id, visible: true }))))
    const originalView = home.querySelector('[data-session="session-claude"]')
    expect(originalView).not.toBeNull()
    await act(async () => (home.querySelector('button[data-workbench-tab-id="b"]') as HTMLButtonElement).click())
    expect(selectTab).toHaveBeenCalledWith('b', 'left')
    const record = tabSwitchObservation.snapshot().at(-1)!
    expect(record.target).toEqual({ presentationId: 'space', displayWorkspaceId: workspace.id, groupId: 'left', tabId: 'b', regionId: 'b:region' })
    expect(record.selectedMs).not.toBeNull(); expect(record.placedMs).not.toBeNull()
    expect(record.terminalMs).toBeNull(); expect(record.frameMs).toBeNull(); expect(record.inputReadyMs).toBeNull()
    expect(home.querySelector('[data-session="session-claude"]')).toBe(originalView)
  } finally {
    await act(async () => root.unmount()); home.remove(); useAppStore.setState(original, true); vi.unstubAllGlobals()
  }
})
