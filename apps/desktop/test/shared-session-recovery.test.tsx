const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement, useEffect } from 'react'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentSessionHistoryObservation } from '@agentmux/core'
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
const paint = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))
// Only isolate xterm/PTY paint. App, placement, Region, Session, messages and Composer are actual.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => {
  useEffect(() => { paint.mounts++; return () => { paint.unmounts++ } }, [])
  return createElement('div', { 'data-terminal-paint-probe': '' }, 'Original retained Agent output')
} }))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { scratchTopicsScope, scratchTopicsForConfig } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { installNativePopover } from './fixtures/mote-workface'

const bodyText = 'Actual retained Activity body in both places'
async function mountScene() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear()
  const initial = useAppStore.getState(), restorePopover = installNativePopover()
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const known = snapshot.sessions.find(session => session.id === 'session-codex')!
  expect(known.kind).toBe('agent')
  if (known.kind !== 'agent') throw new Error('Expected actual Agent fixture')
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: _hygiene_fixturePath("fixture/topics"), name: 'Topics', kind: 'folder' as const }
  const topicId = 'launcher:activity-original', directoryPath = workspace.path + '/' + scratchTopicDirectoryName(topicId)
  const topic = { id: topicId, title: 'Original Agent', summary: '', directoryPath, topicPath: directoryPath + '/topic.md', collaborators: [],
    soul: { path: directoryPath + '/SOUL.md', content: '# Identity', version: 'actual-store-fixture' } }
  const session = { ...known, workspacePath: directoryPath }
  const tab = { ...createWorkbenchTab('activity-original-tab', { kind: 'agent', phase: 'attached', regionId: 'activity-original-region', workspaceId: workspace.id, sessionId: session.id }), topicId }
  const scratch = [vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic]), vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic), vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue(topic)]
  const controls = [vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'resume'), vi.spyOn(api.sessions, 'write')]
  const source = { providerId: session.providerId, nativeSessionId: 'activity-native-fixture' }
  let nativeText = 'Native input visible in both places'
  let appendedText: string | undefined
  let changed: ((observation: AgentSessionHistoryObservation) => void) | undefined
  let activeObservers = 0
  const reads = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async () => ({ agentSessionId: session.id, source,
    items: [{ id: 'native-input', kind: 'user-message', startedAt: 1, contentParts: [{ kind: 'text', text: nativeText }] },
      ...(appendedText ? [{ id: 'native-append', kind: 'user-message' as const, startedAt: 3, contentParts: [{ kind: 'text' as const, text: appendedText }] }] : [])], nextCursor: null }))
  const observation = vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async (_control, onChange) => {
    changed = onChange; activeObservers++
    let disposed = false
    return { source, dispose: () => { if (!disposed) { disposed = true; activeObservers-- } } }
  })
  window.localStorage.setItem('agentmux.leader-topic-floating.v1', JSON.stringify({ open: false, targetTopicId: topicId, targetTabId: tab.id, railMode: 'avatars' }))
  const captured = { id: 'activity-body-message', agentSessionId: session.id, kind: 'assistant_message' as const, status: 'complete' as const,
    source: 'native-hook' as const, createdAt: 2, updatedAt: 2, title: 'Response', content: bodyText }
  useAppStore.setState({ ...initial, loading: false, initialize: async () => () => {}, config: { ...config, workspaces: [workspace] }, sessions: [session],
    activeWorkspaceId: workspace.id, mainSurface: 'workbench', tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('activity-original-group', [tab.id]) }, toolsOpen: false, projectRailOpen: false,
    scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 0, topics: [topic], error: null, reading: false } },
    viewModes: { [session.id]: 'activity' }, timelines: { [session.id]: { agentSessionId: session.id, items: [captured, { ...captured, id: 'activity-tool', kind: 'tool_call', title: 'Read sample', content: '', toolName: 'Read', toolInput: '{"file_path":"sample.txt"}', toolOutput: 'Independent reading detail' }], revision: 1 } }, agentComposerDrafts: { [session.id]: 'Retained unsent draft' },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } }, true)
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(createElement(App)))
  await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain(nativeText) })
  const primary = container.querySelector<HTMLElement>('.agent-surface:not([data-session-presentation])')!
  const primaryMessage = [...primary.querySelectorAll<HTMLElement>('.log-turn__body')].find(element => element.textContent === bodyText)!
  expect(primaryMessage).toBeDefined()
  const draft = primary.querySelector<HTMLElement>('.ProseMirror')!
  expect(draft.textContent).toBe('Retained unsent draft')
  const trigger = document.querySelector<HTMLButtonElement>('[data-pmo-teams-topic-launcher] button')!
  expect(trigger).not.toBeNull()
  const before = useAppStore.getState()
  const visibleSlots = () => {
    const floating = document.getElementById('pmo-teams-topic-floating-panel')!
    const slots = [...container.querySelectorAll<HTMLElement>(`[data-workbench-tab-id="${tab.id}"]`)].filter(element => element.classList.contains('workbench-tab-slot'))
    const space = slots.filter(element => !floating.contains(element)), mote = slots.filter(element => floating.contains(element))
    expect(space).toHaveLength(1); expect(mote).toHaveLength(1)
    return { space: space[0]!, mote: mote[0]!, floating }
  }
  const openMote = async () => {
    await act(async () => trigger.click())
    await vi.waitFor(async () => { await act(async () => {}); const { space, mote, floating } = visibleSlots()
      expect(floating.matches(':popover-open')).toBe(true)
      expect([space.querySelectorAll('.agent-surface').length, mote.querySelectorAll('.agent-surface').length]).toEqual([1, 1])
      expect(mote.textContent).toContain(bodyText)
    })
    return visibleSlots()
  }
  return { container, root, session, tab, workspace, captured, primary, primaryMessage, draft, before, controls, reads, observation, openMote, visibleSlots, trigger,
    activeObservers: () => activeObservers,
    invalidate: (text: string) => { nativeText = text; expect(changed).toBeDefined(); changed!({ agentSessionId: session.id, kind: 'invalidated', source }) },
    append: (text: string) => { appendedText = text; expect(changed).toBeDefined(); changed!({ agentSessionId: session.id, kind: 'invalidated', source }) },
    close: async () => { await act(async () => root.unmount()); container.remove(); restorePopover(); useAppStore.setState(initial, true)
      for (const spy of [...scratch, ...controls, reads, observation]) spy.mockRestore(); vi.useRealTimers(); vi.unstubAllGlobals() }
  }
}

import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { surveyInitialZoneSelection } from '../src/renderer/src/lib/survey-workface'
async function surveyAndMote(scene: Awaited<ReturnType<typeof mountScene>>) {
 const state = useAppStore.getState(), catalog = spatialCatalog(state, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots))
 const zoneId = catalog.tabs.find(tab => tab.tabId === scene.tab.id)!.zoneId!
 expect(zoneId).toBeTruthy()
 const selection = surveyInitialZoneSelection(catalog, zoneId, state.layouts, state.tabs, scene.workspace.id)
 expect(selection).not.toBeNull()
 await act(async () => useAppStore.setState({ mainSurface:'survey', surveyToolsOpen:false, surveyCollectedZones:{[zoneId]:true}, surveyZoneSelection:selection, surveySidebarCollapsed:false }))
 await act(async () => scene.trigger.click())
 await vi.waitFor(async () => { await act(async () => {});expect(document.getElementById('pmo-teams-topic-floating-panel')?.querySelector('.agent-surface')).not.toBeNull() })
 const floating = document.getElementById('pmo-teams-topic-floating-panel')!
 const pane = floating.querySelector<HTMLElement>('[data-session-presentation]')!
 expect(pane, 'Actual selected Mote is a secondary Session presentation behind visible Survey').not.toBeNull()
 return { floating, pane, zoneId, selection }
}
it('a failed shared Session keeps its original cause, recovery action, content and Composer in the selected secondary', async () => {
 const scene = await mountScene()
 try {
  const { floating, pane } = await surveyAndMote(scene)
  const beforeHost = pane.dataset.sessionPresentation
  const body = [...pane.querySelectorAll<HTMLElement>('.log-turn__body')].find(node => node.textContent === bodyText)!
  const input = pane.querySelector<HTMLElement>('.ProseMirror')!
  const text = body.querySelector('p')!.firstChild!, range = document.createRange()
  range.setStart(text, 2); range.setEnd(text, 8)
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  await act(async () => useAppStore.setState(state => ({sessions:state.sessions.map(session => session.id === scene.session.id
   ? {...session, processState:'exited',status:{...session.status,state:'error',detail:'Codex account/read workspace routing discovery timeout',exitCode:1,exitReason:'crashed'}} :session)})))
  const next = floating.querySelector<HTMLElement>('[data-session-presentation]')
  expect(useAppStore.getState().tabs[scene.tab.id]).toBe(scene.tab)
  expect(useAppStore.getState().agentComposerDrafts[scene.session.id]).toBe('Retained unsent draft')
  expect(scene.controls.map(spy=>spy.mock.calls.length)).toEqual([0,0,0,0])
  expect(next).toBe(pane)
  expect(next?.dataset.sessionPresentation).toBe(beforeHost)
  expect(next?.querySelector('.agent-body')?.textContent).toContain('The process exited on its own.')
  expect([...next!.querySelectorAll<HTMLButtonElement>('button')].some(button => /Restore/.test(button.textContent ?? ''))).toBe(true)
  expect(next?.querySelector<HTMLElement>('.agent-terminal-stage')?.hidden).toBe(true)
  expect(next?.querySelector('.ProseMirror')).toBe(input)
  expect(body.isConnected).toBe(true)
  expect([range.startContainer, range.startOffset, range.endContainer, range.endOffset]).toEqual([text, 2, text, 8])
  const pausedReads = scene.reads.mock.calls.length
  await act(async () => {})
  expect(scene.reads.mock.calls.length).toBe(pausedReads)
  await act(async () => useAppStore.setState({ sessions: [scene.session] }))
  expect(floating.querySelector('[data-session-presentation]')).toBe(pane)
  expect(pane.querySelector('.ProseMirror')).toBe(input)
  expect([...pane.querySelectorAll('.log-turn__body')].find(node => node.textContent === bodyText)).toBe(body)
  expect([range.startContainer, range.startOffset, range.endContainer, range.endOffset]).toEqual([text, 2, text, 8])
 } finally {await scene.close()}
})
it('an unconfirmed appearance keeps the same selected secondary nonempty without changing its original Session', async () => {
 const scene = await mountScene()
 try {
  const {floating,pane}=await surveyAndMote(scene)
  const beforeHost=pane.dataset.sessionPresentation, state=useAppStore.getState()
  await act(async()=>useAppStore.setState({config:{...state.config!,appearance:{...state.config!.appearance,terminalTheme:undefined}}}))
  expect(useAppStore.getState().tabs[scene.tab.id]).toBe(scene.tab)
  expect(useAppStore.getState().agentComposerDrafts[scene.session.id]).toBe('Retained unsent draft')
  expect(scene.controls.map(spy=>spy.mock.calls.length)).toEqual([0,0,0,0])
  expect(floating.querySelector('[data-session-presentation]')).toBe(pane)
  expect(pane.querySelector('.agent-body')?.textContent).toContain('Connecting to this session')
  expect(pane.querySelector('.agent-body')?.textContent).toContain('Waiting for this session to reconnect.')
  expect(pane.dataset.sessionPresentation).toBe(beforeHost)
 }finally {await scene.close()}
})

import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { workbenchSessionStageHostId, type WorkbenchViewTarget } from '../src/renderer/src/lib/workbench-presentation'

it('a hidden secondary retained conversation does not create native or captured-history reads while its primary stays readable', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useAppStore.getState(), config = await api.config.get()
  const workspace = { id: 'retained-workspace', hostId: 'local', path: _hygiene_fixturePath("fixture/retained"), name: 'Retained', kind: 'folder' as const }
  const sid = 'retained-history-original', regionId = 'retained-history-region'
  const tab = createWorkbenchTab('retained-history-tab', { kind: 'agent', phase: 'attached', regionId, workspaceId: workspace.id, sessionId: sid })
  const source = { agentSessionId: sid, hostId: 'local', state: 'retired' as const, retiredAt: 42,
    history: { providerId: 'codex', executorId: 'codex', workspacePath: workspace.path, createdAt: 1,
      nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'retained-native' } } }
  const sources = vi.spyOn(api.sessions, 'historySources').mockResolvedValue([source])
  const page = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: sid,
    source: { providerId: 'codex', nativeSessionId: 'retained-native' },
    items: [{ id: 'retained-reply', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original closed reply' }] }], nextCursor: null })
  const timeline = vi.spyOn(api.sessions, 'timeline').mockResolvedValue({ agentSessionId: sid, revision: 1, items: [] })
  const controls = [vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'resume'), vi.spyOn(api.sessions, 'write')]
  useAppStore.setState({ ...initial, config: { ...config, workspaces: [workspace] }, loading: false, sessions: [],
    tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('retained-primary-group', [tab.id]) },
    activeWorkspaceId: workspace.id, viewModes: { [sid]: 'activity' }, recoveryCandidates: [],
    agentComposerDrafts: { [sid]: 'Original retained draft' } }, true)
  const target: WorkbenchViewTarget = { hostId: 'retained-secondary', active: false, visible: false,
    reference: { displayWorkspaceId: workspace.id, groupId: 'retained-secondary-group', tabId: tab.id, regionId } }
  const slot = document.createElement('div'); slot.id = workbenchSessionStageHostId(target, regionId); document.body.append(slot)
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(SessionPane, { sessionId: sid, surfaceKind: 'agent', interactiveResize: false,
      visible: true, presentations: [target], renderPresentationFrame: content => content,
      linkOrigin: { workspaceId: workspace.id, tabGroupId: 'retained-primary-group', tabId: tab.id, regionId } })))
    await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain('Original closed reply') })
    expect(document.querySelector('[data-session-presentation]')?.getAttribute('aria-hidden')).toBe('true')
    expect(page).toHaveBeenCalledTimes(1)
    expect(timeline).toHaveBeenCalledTimes(1)
    expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0])
    expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
    expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Original retained draft')
  } finally {
    await act(async () => root.unmount()); slot.remove(); container.remove(); useAppStore.setState(initial, true)
    for (const spy of [sources, page, timeline, ...controls]) spy.mockRestore(); vi.unstubAllGlobals()
  }
})
