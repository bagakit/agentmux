// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { act, createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { addTabOccurrence, createWorkspaceLayout, type WorkspaceLayout } from '@agentmux/layout'
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
import { createWorkbenchTab, replaceWorkbenchRegion, documentKey, fileTabId } from '../src/renderer/src/lib/workbench-tabs'
import { createSessionProjectFileContextSelector } from '../src/renderer/src/lib/session-project-file-context'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { scratchTopicsScope, scratchTopicsForWorkspace } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { spatialCatalog, zoneContext } from '../src/renderer/src/lib/space-agent-control'
import * as spatialOwner from '../src/renderer/src/lib/space-agent-control'
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
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: '/fixture/topics', name: 'Topics', kind: 'folder' as const }
  const topicId = 'launcher:activity-original', directoryPath = workspace.path + '/' + scratchTopicDirectoryName(topicId)
  const topic = { id: topicId, title: 'Original Agent', summary: '', directoryPath, topicPath: directoryPath + '/topic.md', collaborators: [],
    soul: { path: directoryPath + '/SOUL.md', content: '# Identity', version: 'actual-store-fixture' } }
  const session = { ...known, workspacePath: directoryPath }
  const tab = { ...createWorkbenchTab('activity-original-tab', { kind: 'agent', phase: 'attached', regionId: 'activity-original-region', workspaceId: workspace.id, sessionId: session.id }), topicId }
  const scratch = [vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic]), vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic), vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue(topic)]
  const controls = [vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'resume'), vi.spyOn(api.sessions, 'write')]
  const source = { providerId: session.providerId, nativeSessionId: 'activity-native-fixture' }
  let nativeText = 'Native input visible in both places'
  let changed: ((observation: AgentSessionHistoryObservation) => void) | undefined
  let activeObservers = 0
  const reads = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async () => ({ agentSessionId: session.id, source,
    items: [{ id: 'native-input', kind: 'user-message', startedAt: 1, contentParts: [{ kind: 'text', text: nativeText }] }], nextCursor: null }))
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
    close: async () => { await act(async () => root.unmount()); container.remove(); restorePopover(); useAppStore.setState(initial, true)
      for (const spy of [...scratch, ...controls, reads, observation]) spy.mockRestore(); vi.useRealTimers(); vi.unstubAllGlobals() }
  }
}


vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: ({ surface }: { surface: { workspaceId: string; path: string } }) => {
  const document = useAppStore(state => state.documents[documentKey(surface.workspaceId, surface.path)])
  return createElement('pre', { 'data-file-paint-probe': '' }, document?.content)
} }))
const record = (name: string, value: unknown) => {
  const directory = process.env.LINK_COUNTER_EVIDENCE
  if (directory) writeFileSync(directory + '/' + name + '.json', JSON.stringify(value, null, 2))
}
const httpUrl = 'https://example.test/shared-occurrence'
async function addLink(scene: Awaited<ReturnType<typeof mountScene>>, content: string) {
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [scene.session.id]: {
    ...state.timelines[scene.session.id]!, revision: 2,
    items: [...state.timelines[scene.session.id]!.items, { ...scene.captured, id: 'actual-link-counter-message', createdAt: 4, updatedAt: 4, content }]
  } } })))
}
async function selectOccurrence(scene: Awaited<ReturnType<typeof mountScene>>, target: 'foreign' | 'second') {
  const state = useAppStore.getState(), first = state.layouts[scene.workspace.id]!
  const double: WorkspaceLayout = { ...first, root: { type: 'split', direction: 'horizontal', ratio: .5, first: first.root, second: { type: 'leaf', groupId: 'second-group' } },
    groups: [...first.groups, { ...first.groups[0]!, id: 'second-group' }] }
  const foreign = { id: 'foreign-display', hostId: 'local', path: '/fixture/foreign', name: 'Foreign display', kind: 'folder' as const }
  await act(async () => useAppStore.setState({ config: { ...state.config!, workspaces: [...state.config!.workspaces, foreign] },
    layouts: { ...state.layouts, [scene.workspace.id]: double, [foreign.id]: (() => { const original = createWorkspaceLayout('foreign-group', [scene.tab.id]); return { ...original, root: { type: 'split' as const, direction: 'horizontal' as const, ratio: .5, first: original.root, second: { type: 'leaf' as const, groupId: 'foreign-second-group' } }, groups: [...original.groups, { ...original.groups[0]!, id: 'foreign-second-group' }] } })() },
    activeWorkspaceId: target === 'foreign' ? foreign.id : scene.workspace.id }))
  const displayId = target === 'foreign' ? foreign.id : scene.workspace.id
  const groupId = target === 'foreign' ? 'foreign-second-group' : 'second-group'
  const getSlot = () => document.getElementById('workbench-tab-slot:' + JSON.stringify([displayId, groupId, scene.tab.id]))!
  await vi.waitFor(async () => { await act(async () => {}); expect(getSlot()?.textContent).toContain(bodyText) })
  const slot = getSlot(), presentation = slot.querySelector<HTMLElement>('[data-session-presentation]')!
  expect(presentation).not.toBeNull()
  expect(presentation.textContent).toContain(bodyText)
  return { slot, presentation, displayId, groupId }
}
function actualResources() {
  const state = useAppStore.getState()
  return Object.values(state.tabs).flatMap(tab => Object.values(tab.regions).filter(region => region.kind === 'browser' || region.kind === 'file').map(region => ({
    tabId: tab.id, tabResourceWorkspaceId: tab.workspaceId, region,
    occurrences: Object.entries(state.layouts).flatMap(([workspaceId, layout]) => layout.groups.filter(group => group.tabOrder.includes(tab.id)).map(group => ({ displayWorkspaceId: workspaceId, groupId: group.id })))
  })))
}
for (const scenario of [{ target: 'foreign' as const, destination: 'tab' }, { target: 'second' as const, destination: 'right' }, { target: 'foreign' as const, destination: 'right' }]) {
  it('actual B HTTP ' + scenario.target + ' ' + scenario.destination + ' should commit to its exact display occurrence', async () => {
    const scene = await mountScene()
    const original = useAppStore.getState().openHttpLink, calls: Array<{ args: Parameters<typeof original>; result: string; error?: string }> = []
    const passthrough = async (...args: Parameters<typeof original>) => {
      try { await original(...args); calls.push({ args, result: 'resolved' }) }
      catch (error) { calls.push({ args, result: 'rejected', error: error instanceof Error ? error.message : String(error) }); throw error }
    }
    const create = vi.spyOn(api.browser, 'create')
    try {
      await act(async () => useAppStore.setState({ openHttpLink: passthrough }))
      await addLink(scene, '[Open web destination](' + httpUrl + ')')
      const occurrence = await selectOccurrence(scene, scenario.target)
      const link = [...occurrence.presentation.querySelectorAll<HTMLElement>('.md-link')].find(element => element.textContent === 'Open web destination')!
      expect(link).not.toBeNull()
      expect(link.textContent).toBe('Open web destination')
      await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })))
      await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelectorAll('[role="dialog"][aria-label="Choose where to open the link"]')).toHaveLength(1) })
      const button = document.querySelector<HTMLButtonElement>('button[data-destination="' + scenario.destination + '"]')!
      expect(button).not.toBeNull(); expect(button.disabled).toBe(false)
      await act(async () => button.click())
      await vi.waitFor(async () => { await act(async () => {}); expect(calls).toHaveLength(1) })
      const resources = actualResources()
      record('http-' + scenario.target + '-' + scenario.destination, { enteredActualSecondaryDOM: true, actualDestinationButton: scenario.destination, wanted: { displayWorkspaceId: occurrence.displayId, groupId: occurrence.groupId, originalTabId: scene.tab.id, originalRegionId: 'activity-original-region' },
        actualStoreCalls: calls, actualBrowserAPICalls: create.mock.calls, resources, originalSessionControl: useAppStore.getState().sessions.find(item => item.id === scene.session.id)?.control,
        nativeRuntimeControlled: false, APIBoundary: 'Original public web-preview Browser API, no native painting/Runtime', openHttpLinkMocked: false })
      expect(calls[0]!.result).toBe('resolved')
      expect(create).toHaveBeenCalledTimes(1)
      expect(resources.filter(item => item.region.kind === 'browser')).toHaveLength(1)
      expect(resources[0]!.occurrences).toContainEqual({ displayWorkspaceId: occurrence.displayId, groupId: occurrence.groupId })
      expect(resources[0]!.tabResourceWorkspaceId).toBe(scenario.destination === 'tab' ? occurrence.displayId : scene.workspace.id)
      expect(useAppStore.getState().tabs[scene.tab.id]!.workspaceId).toBe(scene.workspace.id)
      expect(useAppStore.getState().tabs[scene.tab.id]!.regions['activity-original-region']).toEqual(scene.tab.regions['activity-original-region'])
      expect(useAppStore.getState().sessions).toEqual([scene.session])
      expect(useAppStore.getState().agentComposerDrafts[scene.session.id]).toBe('Retained unsent draft')
      for (const control of scene.controls) expect(control).not.toHaveBeenCalled()
    } finally { await act(async () => useAppStore.setState({ openHttpLink: original })); create.mockRestore(); await scene.close() }
  })
}
it('actual B original Topic owner keeps the file link available without a stored Tab.space', async () => {
  const scene = await mountScene()
  const open = vi.spyOn(useAppStore.getState(), 'openFile'), read = vi.spyOn(api.files, 'read').mockImplementation(async (_workspaceId, path) => ({ status: 'read', document: { path, content: 'original Topic resource', revision: 'topic-1' } }))
  try {
    await addLink(scene, '[Open original sample](./sample.ts:7)')
    const occurrence = await selectOccurrence(scene, 'foreign')
    const ownerState = useAppStore.getState(), ownerTopics = scratchTopicsForWorkspace(ownerState.scratchTopicSnapshots, scene.workspace)
    if (ownerTopics === null) throw new Error('Expected the original non-empty Topic snapshot')
    const catalog = spatialCatalog(ownerState, ownerTopics)
    const originalTab = catalog.tabs.find(tab => tab.tabId === scene.tab.id)
    const originalZone = catalog.zones.find(zone => zone.zoneId === originalTab?.zoneId)
    let birthContext: string | undefined, birthIssue: string | undefined
    try { if (originalZone) birthContext = zoneContext(ownerState, ownerTopics, originalZone) } catch (error) { birthIssue = String(error) }
    record('file-original-owner-metadata', { originalTab, originalZone, birthContext, birthIssue,
      exactLocations: catalog.locations.filter(location => location.tabId === scene.tab.id && location.regionId === 'activity-original-region' && location.displayWorkspaceId === occurrence.displayId && location.groupId === occurrence.groupId),
      resourceWorkspace: scene.workspace, tabStoredSpace: ownerState.tabs[scene.tab.id]!.space, topics: ownerTopics })
    const context = createSessionProjectFileContextSelector(scene.session.id, {
      workspaceId: occurrence.displayId, tabGroupId: occurrence.groupId, tabId: scene.tab.id,
      regionId: 'activity-original-region', sessionId: scene.session.id
    })(useAppStore.getState())
    expect(useAppStore.getState().tabs[scene.tab.id]!.space).toBeUndefined()
    expect(originalZone).toBeDefined(); expect(birthContext).toBeDefined()
    expect(context.kind).toBe('session')
    expect(context.placement).toEqual({ displayWorkspaceId: occurrence.displayId, space: { zoneId: originalZone!.zoneId, spaceId: birthContext },
      resource: { hostId: scene.workspace.hostId, path: scene.workspace.path } })
    const link = [...occurrence.presentation.querySelectorAll<HTMLButtonElement>('.md-link--file')].find(element => element.textContent === 'Open original sample')!
    expect(link).toBeDefined(); expect(link.textContent).toBe('Open original sample')
    await act(async () => link.click())
    await vi.waitFor(async () => { await act(async () => {}); expect(open).toHaveBeenCalledTimes(1) })
    expect(read.mock.calls).toEqual([[scene.workspace.id, 'sample.ts']])
    expect(open.mock.calls[0]![5]).toEqual(context.placement)
    expect(actualResources()).toHaveLength(1)
    expect(actualResources()[0]!.occurrences).toContainEqual({ displayWorkspaceId: occurrence.displayId, groupId: occurrence.groupId })
    expect(useAppStore.getState().sessions).toEqual([scene.session])
    expect(useAppStore.getState().agentComposerDrafts[scene.session.id]).toBe('Retained unsent draft')
    for (const control of scene.controls) expect(control).not.toHaveBeenCalled()
    record('file-original-topic', { context, actualFileCalls: open.mock.calls, actualFileReadAPICalls: read.mock.calls,
      resources: actualResources(), originalSessionControl: scene.session.control, missingStoredSpaceIsNotUnknown: true })
  } finally { open.mockRestore(); read.mockRestore(); await scene.close() }
})

it.each(['missing', 'conflicting'] as const)('actual B %s original Topic metadata keeps prose and refuses orphan creation', async mode => {
  const scene = await mountScene(), open = vi.spyOn(useAppStore.getState(), 'openFile'), read = vi.spyOn(api.files, 'read')
  try {
    await addLink(scene, '[Open original sample](./sample.ts:7)')
    const occurrence = await selectOccurrence(scene, 'foreign')
    if (mode === 'missing') await act(async () => useAppStore.setState({ scratchTopicSnapshots: {} }))
    else {
      const state = useAppStore.getState(), topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, scene.workspace)
      if (topics === null) throw new Error('Expected the original Topic snapshot')
      const catalog = spatialCatalog(state, topics), original = catalog.tabs.find(tab => tab.tabId === scene.tab.id)!
      expect(original.zoneId).not.toBeNull()
      await act(async () => useAppStore.setState({ tabs: { ...state.tabs, [scene.tab.id]: { ...state.tabs[scene.tab.id]!,
        space: { zoneId: original.zoneId!, spaceId: JSON.stringify(['local', state.config!.workspaces.find(workspace => workspace.id === occurrence.displayId)!.path]) } } } }))
    }
    const context = createSessionProjectFileContextSelector(scene.session.id, {
      workspaceId: occurrence.displayId, tabGroupId: occurrence.groupId, tabId: scene.tab.id,
      regionId: 'activity-original-region', sessionId: scene.session.id
    })(useAppStore.getState())
    expect(context.kind).toBe('unconfirmed'); expect(context.placement).toBeUndefined()
    expect(occurrence.presentation.textContent).toContain('file resource, Space or display occurrence is unconfirmed')
    expect(occurrence.presentation.textContent).toContain('Open original sample')
    expect(occurrence.presentation.querySelectorAll('.md-link--file')).toHaveLength(0)
    expect(open).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(actualResources()).toEqual([])
    expect(useAppStore.getState().sessions).toEqual([scene.session])
    expect(useAppStore.getState().agentComposerDrafts[scene.session.id]).toBe('Retained unsent draft')
    for (const control of scene.controls) expect(control).not.toHaveBeenCalled()
    record('file-unknown-topic-' + mode, { context, actualFileCalls: open.mock.calls, actualFileReadAPICalls: read.mock.calls,
      resources: actualResources(), originalSessionControl: scene.session.control, missingRawSnapshot: mode === 'missing', contradictoryStoredSpace: mode === 'conflicting' })
  } finally { open.mockRestore(); read.mockRestore(); await scene.close() }
})

it('actual B owner-created Space file link preserves resource and reaches the exact foreign Group', async () => {
  const scene = await mountScene()
  const original = useAppStore.getState().openFile, calls: Array<{ args: Parameters<typeof original>; result?: boolean; error?: string }> = []
  const passthrough = async (...args: Parameters<typeof original>) => {
    try { const result = await original(...args); calls.push({ args, result }); return result }
    catch (error) { calls.push({ args, error: error instanceof Error ? error.message : String(error) }); throw error }
  }
  const read = vi.spyOn(api.files, 'read').mockImplementation(async (_workspaceId, path) => ({ status: 'read', document: { path, content: 'export const originalSessionResource = true\n', revision: 'private-link-fixture-v1' } }))
  try {
    await act(async () => useAppStore.setState({ openFile: passthrough }))
    await addLink(scene, '[Open original sample](./sample.ts:7)')
    const foreign = await selectOccurrence(scene, 'foreign')
    let created: Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['createWorkbenchZone']>> | undefined
    await act(async () => { created = await useAppStore.getState().createWorkbenchZone({ workspaceId: scene.workspace.id, spaceIds: [] }) })
    expect(created).toBeDefined(); expect(created!.zone.zoneId.length).toBeGreaterThan(0)
    expect(created!.zone).toMatchObject({ workspaceId: scene.workspace.id, hostId: 'local', directoryPath: scene.workspace.path })
    let tabId: string | undefined
    await act(async () => { tabId = useAppStore.getState().openLauncher({ workspaceId: scene.workspace.id,
      zoneId: created!.zone.zoneId, displayWorkspaceId: scene.workspace.id, tabGroupId: 'activity-original-group', reveal: false }) })
    expect(tabId).toBeDefined()
    const born = useAppStore.getState().tabs[tabId!]!
    expect(born.space).toBeDefined(); expect(born.space!.zoneId).toBe(created!.zone.zoneId)
    const regionId = born.layout.activeRegionId
    expect(born.regions[regionId]!.kind).toBe('launcher')
    // Same original leaf and typed existing Session reference; this creates no Run or Agent.
    await act(async () => useAppStore.setState(state => ({
      tabs: { ...state.tabs, [born.id]: replaceWorkbenchRegion(born, regionId,
        { kind: 'agent', phase: 'attached', regionId, workspaceId: scene.workspace.id, sessionId: scene.session.id }) },
      layouts: { ...state.layouts, [foreign.displayId]: addTabOccurrence(addTabOccurrence(state.layouts[foreign.displayId]!, 'foreign-group', born.id)!, foreign.groupId, born.id)! }
    })))
    await act(async () => useAppStore.getState().activateTab(foreign.displayId, foreign.groupId, born.id))
    const slot = () => document.getElementById('workbench-tab-slot:' + JSON.stringify([foreign.displayId, foreign.groupId, born.id]))!
    try {
      await vi.waitFor(async () => { await act(async () => {}); expect(slot()?.querySelector('[data-session-presentation]')?.textContent).toContain('Open original sample') })
    } catch (error) {
      record('file-owner-space-readiness', { factory: created, born, state: { activeWorkspaceId: useAppStore.getState().activeWorkspaceId, layouts: useAppStore.getState().layouts },
        slot: slot()?.outerHTML, presentations: [...document.querySelectorAll('[data-session-presentation]')].map(element => ({ id: element.id, html: element.outerHTML })), error: String(error) })
      throw error
    }
    const presentation = slot().querySelector<HTMLElement>('[data-session-presentation]')!
    expect(presentation).not.toBeNull()
    const link = [...presentation.querySelectorAll<HTMLButtonElement>('.md-link--file')].find(element => element.textContent === 'Open original sample')!
    expect(link).toBeDefined(); expect(link.textContent).toBe('Open original sample')
    await act(async () => link.click())
    await vi.waitFor(async () => { await act(async () => {}); expect(calls).toHaveLength(1) })
    const resources = actualResources()
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]).toEqual([scene.workspace.id, 'sample.ts'])
    expect(calls[0]!.result).toBe(true)
    expect(calls[0]!.args[2]).toEqual({ line: 7 })
    expect(calls[0]!.args[5]).toMatchObject({ displayWorkspaceId: foreign.displayId, space: born.space,
      resource: { hostId: 'local', path: scene.workspace.path } })
    expect(resources.filter(item => item.region.kind === 'file')).toHaveLength(1)
    expect(resources[0]!.occurrences).toContainEqual({ displayWorkspaceId: foreign.displayId, groupId: foreign.groupId })
    expect(resources[0]!.tabResourceWorkspaceId).toBe(scene.workspace.id)
    expect(useAppStore.getState().tabs[born.id]!.space).toEqual(born.space)
    expect(useAppStore.getState().sessions).toEqual([scene.session])
    expect(useAppStore.getState().agentComposerDrafts[scene.session.id]).toBe('Retained unsent draft')
    for (const control of scene.controls) expect(control).not.toHaveBeenCalled()
    record('file-owner-space', { factory: created, originalTabSpace: born.space, actualStoreCalls: calls,
      actualFileReadAPICalls: read.mock.calls, resources, requestedDisplay: { displayWorkspaceId: foreign.displayId, groupId: foreign.groupId },
      originalSessionControl: scene.session.control, nativeRuntimeControlled: false, openFileMocked: false })
  } finally { await act(async () => useAppStore.setState({ openFile: original })); read.mockRestore(); await scene.close() }
})

it('original file context retains its related metadata memo and invalidates real source facts', async () => {
  const scene = await mountScene()
  try {
    await addLink(scene, '[Open original sample](./sample.ts:7)')
    const occurrence = await selectOccurrence(scene, 'foreign')
    const catalogRead = vi.spyOn(spatialOwner, 'spatialCatalog'), contextRead = vi.spyOn(spatialOwner, 'zoneContext')
    try {
      const selector = createSessionProjectFileContextSelector(scene.session.id, { workspaceId: occurrence.displayId,
        tabGroupId: occurrence.groupId, tabId: scene.tab.id, regionId: 'activity-original-region', sessionId: scene.session.id })
      const state = useAppStore.getState(), context = selector(state)
      expect(context.kind).toBe('session'); expect(context.placement).toBeDefined()
      const baseline = { catalog: catalogRead.mock.calls.length, context: contextRead.mock.calls.length, pages: scene.reads.mock.calls.length }
      expect(baseline.catalog).toBeGreaterThan(0); expect(baseline.context).toBeGreaterThan(0)
      const body = occurrence.presentation.querySelector<HTMLElement>('.log-turn__body')!
      expect(body).not.toBeNull(); expect(body.textContent!.length).toBeGreaterThan(0)
      const range = document.createRange(); range.selectNodeContents(body); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      const selected = selection.toString()
      expect(selected.length).toBeGreaterThan(0)
      const unrelated = (await api.sessions.snapshot()).sessions.find(session => session.id !== scene.session.id)
      expect(unrelated).toBeDefined()
      await act(async () => useAppStore.setState(current => ({ sessions: [...current.sessions, unrelated!],
        timelines: { ...current.timelines, [unrelated!.id]: { agentSessionId: unrelated!.id, revision: 1, items: [] } } })))
      expect(selector(useAppStore.getState())).toBe(context)
      expect({ catalog: catalogRead.mock.calls.length, context: contextRead.mock.calls.length, pages: scene.reads.mock.calls.length }).toEqual(baseline)
      expect(body.isConnected).toBe(true); expect(range.commonAncestorContainer).toBe(body); expect(selection.toString()).toBe(selected)
      const changedHost = selector({ ...state, sessions: [{ ...scene.session, hostId: 'unconfirmed-other-host' }] })
      expect(changedHost.kind).toBe('unconfirmed'); expect(changedHost.placement).toBeUndefined()
      const beforeReturn = catalogRead.mock.calls.length
      expect(selector(state).kind).toBe('session'); expect(catalogRead.mock.calls.length).toBeGreaterThan(beforeReturn)
      const beforePath = catalogRead.mock.calls.length
      selector({ ...state, sessions: [{ ...scene.session, workspacePath: scene.session.workspacePath + '/subdirectory' }] })
      expect(catalogRead.mock.calls.length).toBeGreaterThan(beforePath)
      const current = useAppStore.getState(), raw = current.scratchTopicSnapshots[scene.workspace.id]!
      await act(async () => useAppStore.setState({ scratchTopicSnapshots: { ...current.scratchTopicSnapshots, [scene.workspace.id]: { ...raw, topics: null } } }))
      expect(selector(useAppStore.getState()).kind).toBe('unconfirmed')
      expect(occurrence.presentation.textContent).toContain('file resource, Space or display occurrence is unconfirmed')
      expect(occurrence.presentation.querySelectorAll('.md-link--file')).toHaveLength(0)
      expect(actualResources()).toEqual([])
      for (const control of scene.controls) expect(control).not.toHaveBeenCalled()
      record('file-metadata-memo', { baseline, afterUnrelated: baseline, sourceInvalidationsObserved: true, sameBodyNode: body.isConnected,
        originalRangeText: selected, resources: actualResources(), nativeRuntimeControlled: false })
    } finally { catalogRead.mockRestore(); contextRead.mockRestore() }
  } finally { await scene.close() }
})

for (const scenario of ['same', 'different', 'legacy-known', 'unknown', 'conflicting-stored'] as const) it('canonical File ' + scenario + ' context preserves its original entity and body', async () => {
  const scene = await mountScene()
  const read = vi.spyOn(api.files, 'read').mockImplementation(async (_workspaceId, path) => ({ status: 'read', document: { path, content: 'Original canonical file body', revision: 'canonical-1' } }))
  const original = useAppStore.getState().openFile, calls: Array<{ args: Parameters<typeof original>; result?: boolean; error?: string }> = []
  try {
    await addLink(scene, '[Open original sample](./sample.ts:7)')
    const occurrence = await selectOccurrence(scene, 'foreign')
    const selector = createSessionProjectFileContextSelector(scene.session.id, { workspaceId: occurrence.displayId,
      tabGroupId: occurrence.groupId, tabId: scene.tab.id, regionId: 'activity-original-region', sessionId: scene.session.id })
    const context = selector(useAppStore.getState())
    expect(context.kind).toBe('session'); expect(context.placement).toBeDefined()
    let placement = context.placement
    if (scenario === 'different') {
      await act(async () => {
        const created = await useAppStore.getState().createWorkbenchZone({ workspaceId: scene.workspace.id, spaceIds: [] })
        const birth = useAppStore.getState().spaceZoneBindings[created.zone.zoneId]!
        expect(birth).toBeDefined(); expect(created.zone.zoneId).not.toBe(context.placement!.space.zoneId)
        placement = { ...context.placement!, space: { zoneId: created.zone.zoneId, spaceId: birth.spaceId } }
      })
    }
    await act(async () => { expect(await original('sample.ts', scenario === 'legacy-known' || scenario === 'unknown' ? 'activity-original-group' : occurrence.groupId,
      undefined, scene.workspace.id, undefined, scenario === 'legacy-known' || scenario === 'unknown' ? undefined : placement)).toBe(true) })
    const id = fileTabId(scene.workspace.id, 'sample.ts')
    if (scenario === 'unknown' || scenario === 'conflicting-stored') await act(async () => useAppStore.setState(state => {
      const tab = state.tabs[id]!
      return { tabs: { ...state.tabs, [id]: scenario === 'unknown'
        ? { ...tab, topicId: 'unknown-original-topic' }
        : { ...tab, space: { ...tab.space!, spaceId: 'contradictory-stored-context' } } } }
    }))
    const canonical = useAppStore.getState().tabs[id]!
    expect(canonical).toBeDefined()
    await act(async () => useAppStore.getState().updateDocument(id, 'Original unsaved canonical file body'))
    const key = documentKey(scene.workspace.id, 'sample.ts'), documentBefore = useAppStore.getState().documents[key]!
    expect(documentBefore.content).toBe('Original unsaved canonical file body'); expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[data-file-paint-probe]')?.textContent).toBe(documentBefore.content) })
    const fileNode = document.querySelector('[data-file-paint-probe]')!
    await act(async () => {
      useAppStore.getState().activateTab(occurrence.displayId, 'foreign-group', scene.tab.id)
      useAppStore.getState().activateTab(occurrence.displayId, occurrence.groupId, scene.tab.id)
      useAppStore.setState({ openFile: async (...args) => {
        try { const result = await original(...args); calls.push({ args, result }); return result }
        catch (error) { calls.push({ args, error: String(error) }); throw error }
      } })
    })
    const slot = () => document.getElementById('workbench-tab-slot:' + JSON.stringify([occurrence.displayId, occurrence.groupId, scene.tab.id]))!
    await vi.waitFor(async () => { await act(async () => {}); expect(slot()?.querySelector('[data-session-presentation]')?.textContent).toContain('Open original sample') })
    const presentation = slot().querySelector<HTMLElement>('[data-session-presentation]')!
    const link = [...presentation.querySelectorAll<HTMLButtonElement>('.md-link--file')].find(element => element.textContent === 'Open original sample')!
    expect(link).toBeDefined(); expect(link.textContent).toBe('Open original sample')
    await act(async () => link.click())
    await vi.waitFor(async () => { await act(async () => {}); expect(calls).toHaveLength(1) })
    const state = useAppStore.getState(), topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, scene.workspace)
    if (topics === null) throw new Error('Expected original retained Topic metadata')
    const catalog = spatialCatalog(state, topics), fact = catalog.tabs.find(tab => tab.tabId === id)!
    expect(fact).toBeDefined()
    const zone = catalog.zones.find(zone => zone.zoneId === fact.zoneId)
    const knownContext = zone ? zoneContext(state, topics, zone) : undefined
    record('canonical-file-' + scenario, { calls, canonicalBefore: canonical, canonicalAfter: state.tabs[id],
      documentBefore, documentAfter: state.documents[key], sameTab: state.tabs[id] === canonical, sameDocument: state.documents[key] === documentBefore,
      fileNodeConnected: fileNode.isConnected, fileNodeSame: document.querySelector('[data-file-paint-probe]') === fileNode,
      catalogFact: fact, originalZone: zone, originalContext: knownContext, desiredContext: context.placement,
      resources: actualResources(), readCalls: read.mock.calls, visibleError: state.error })
    expect(state.tabs[id]).toBe(canonical); expect(state.documents[key]).toBe(documentBefore); expect(state.dirtyDocuments[key]).toBe(true)
    expect(fileNode.isConnected).toBe(true); expect(document.querySelector('[data-file-paint-probe]')).toBe(fileNode)
    expect(actualResources()).toHaveLength(1); expect(read.mock.calls).toEqual([[scene.workspace.id, 'sample.ts']])
    expect(state.agentComposerDrafts[scene.session.id]).toBe('Retained unsent draft')
    for (const control of scene.controls) expect(control).not.toHaveBeenCalled()
    if (scenario === 'unknown' || scenario === 'conflicting-stored') {
      expect(calls[0]!.result).toBe(false); expect(calls[0]!.error).toBeUndefined()
      expect(state.error).toContain(scenario === 'unknown' ? 'Zone context is unconfirmed' : 'contradicts its original Zone')
      expect(state.error).toContain('original Tab and body are retained')
      if (scenario === 'unknown') expect(fact.zoneId).toBeNull()
    } else if (scenario === 'different') {
      expect(calls[0]!.result).toBe(false); expect(calls[0]!.error).toBeUndefined()
      expect(state.error).toContain('another Zone context'); expect(state.error).toContain('original placement is retained')
    } else {
      expect(knownContext).toBe(context.placement!.space.spaceId); expect(fact.zoneId).toBe(context.placement!.space.zoneId)
      expect(calls[0]!.error).toBeUndefined(); expect(calls[0]!.result).toBe(true)
      expect(actualResources()[0]!.occurrences).toContainEqual({ displayWorkspaceId: occurrence.displayId, groupId: occurrence.groupId })
    }
  } finally { await act(async () => useAppStore.setState({ openFile: original })); read.mockRestore(); await scene.close() }
})
