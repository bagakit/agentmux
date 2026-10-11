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
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


it.each(['returned', 'refused', 'reentrant', 'threw'] as const)('keeps the original Mote action and its %s tail at the exact occurrence', async outcome => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const original = useAppStore.getState(), home = document.createElement('div'); document.body.append(home)
  const root = createRoot(home), sourceConfig = await api.config.get(), snapshot = await api.sessions.snapshot()
  const workspace = { id: 'workspace-demo', hostId: 'local', kind: 'folder' as const, name: 'Project', path: _hygiene_fixturePath("repo") }
  const config = { ...sourceConfig, hosts: [{ id: 'local' as const, kind: 'local' as const, label: 'Local' }], workspaces: [workspace] }
  const tabs = Object.fromEntries([['a', 'session-codex'], ['b', 'session-claude']].map(([id, sessionId]) => [id,
    createWorkbenchTab(id!, { regionId: `${id}:region`, kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: sessionId! })]))
  const layout = { root: { type: 'leaf' as const, groupId: 'left' }, groups: [{ id: 'left', tabOrder: ['a', 'b'], activeTabId: 'a', recentTabIds: ['a', 'b'] }], activeGroupId: 'left' }
  let now = _historyFixtureEpoch(0, 1, 0)
  const originalError = new Error('Private callback error'), errors: unknown[] = []
  const onError = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault() }
  window.addEventListener('error', onError)
  const selectTab = vi.fn((tabId: string, groupId: string) => {
    now += 25
    if (outcome === 'threw') throw originalError
    if (outcome === 'refused') return
    useAppStore.getState().activateTab(workspace.id, groupId, tabId, 'local')
    if (outcome === 'reentrant' && tabId === 'b') (home.querySelector('button[data-workbench-tab-id="a"]') as HTMLButtonElement).click()
  })
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
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const firstId = (tabSwitchObservation.snapshot().at(-1)?.id ?? 0) + 1
    await act(async () => (home.querySelector('button[data-workbench-tab-id="b"]') as HTMLButtonElement).click())
    clock.mockRestore()
    expect(selectTab).toHaveBeenCalledWith('b', 'left')
    const record = tabSwitchObservation.snapshot().find(record => record.id === firstId)!
    expect(record).toMatchObject({ handlerStartMonoMs: 1000, eventAtMonoMs: null, inputDelayMs: null,
      actionEndedMs: outcome === 'reentrant' ? 50 : 25, actionResult: outcome === 'threw' ? 'threw' : 'returned' })
    expect(selectTab).toHaveBeenCalledTimes(outcome === 'reentrant' ? 2 : 1)
    expect(errors).toEqual(outcome === 'threw' ? [originalError] : [])
    expect(JSON.stringify(record)).not.toContain(originalError.message)
    if (outcome === 'refused' || outcome === 'threw') {
      expect(useAppStore.getState().layouts[workspace.id]!.groups[0]!.activeTabId).toBe('a')
      expect(record.selectedMs).toBeNull(); expect(record.selectedSource).toBeNull()
    } else if (outcome === 'reentrant') {
      expect(record.state).toBe('superseded')
      expect(tabSwitchObservation.snapshot().at(-1)).toMatchObject({ target: { tabId: 'a' }, actionEndedMs: 25, actionResult: 'returned', selectedSource: 'already-selected-handler' })
    } else { expect(record.selectedSource).toBe('layout-effect'); expect(record.selectedMs).not.toBeNull() }
    expect(record.target).toEqual({ presentationId: 'space', displayWorkspaceId: workspace.id, groupId: 'left', tabId: 'b', regionId: 'b:region' })
    if (outcome === 'returned') expect(record.placedMs).not.toBeNull()
    expect(record.terminalMs).toBeNull(); expect(record.frameMs).toBeNull(); expect(record.inputReadyMs).toBeNull()
    expect(home.querySelector('[data-session="session-claude"]')).toBe(originalView)
  } finally {
    window.removeEventListener('error', onError); vi.restoreAllMocks()
    await act(async () => root.unmount()); home.remove(); useAppStore.setState(original, true); vi.unstubAllGlobals()
  }
})
