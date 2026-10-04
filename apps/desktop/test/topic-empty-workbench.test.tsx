import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { MoteWorkface } from '../src/renderer/src/components/MoteWorkface'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { api } from '../src/renderer/src/lib/api'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { useAppStore } from '../src/renderer/src/store'
import { workbenchSelectionCatalog, resolveDesktopSpaceSelection, projectWorkbenchSpaceSelection } from '../src/renderer/src/lib/desktop-focus-navigation'
import { projectWorkbenchProjection, resolveWorkbenchZone, type WorkbenchProjection } from '../src/renderer/src/lib/workbench-projection'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { topicSpatialAddress, directoryIdentity } from '../src/shared/space-addresses'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { installNativePopover, moteConfig, moteTopic, ordinaryAgent, scratchWorkspace } from './fixtures/mote-workface'

vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => createElement('div', { 'data-original-agent': 'kept' }) }))
const initial = useAppStore.getState()
const initialLauncher = useLauncherState.getState()
const topic = moteTopic('launcher:empty-target', 'Original ordinary Topic', false)
const other = moteTopic('launcher:empty-neighbor', 'Other Topic', false)
const category = { categoryId: '00000000-0000-4000-8000-000000000001', spaceId: directoryIdentity('local', _hygiene_fixturePath("categories/work")),
  hostId: 'local', directoryPath: _hygiene_fixturePath("categories/work"), title: 'Work', revision: null }
const address = topicSpatialAddress(moteConfig, topic, {}, [])!
const neighborAddress = topicSpatialAddress(moteConfig, other, {}, [])!
const target = { ...createWorkbenchTab('empty-target-tab', { kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'empty-target-region' }),
  topicId: topic.id, space: { ...address, spaceId: category.spaceId } }
const neighbor = { ...createWorkbenchTab('empty-neighbor-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID,
  regionId: 'empty-neighbor-region', sessionId: ordinaryAgent.id }), topicId: other.id, space: neighborAddress }
const groupId = 'original-empty-group'
let root: Root, container: HTMLDivElement, restorePopover: () => void
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear(); restorePopover = installNativePopover()
  // Explicit original section preference isolates empty rendering from real Launcher speculative PTY.
  useLauncherState.setState({ sections: { [SCRATCH_WORKSPACE_ID]: { terminal: 'collapsed' } } })
  useAppStore.setState({ config: moteConfig, activeWorkspaceId: SCRATCH_WORKSPACE_ID, mainSurface: 'workbench',
    tabs: { [target.id]: target, [neighbor.id]: neighbor }, sessions: [ordinaryAgent], timelines: {}, agentNames: {},
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout(groupId, [target.id, neighbor.id]), project: createWorkspaceLayout('project-start') },
    topicCategories: [category], spaceZoneBindings: { [address.zoneId]: { workspaceId: SCRATCH_WORKSPACE_ID, spaceId: address.spaceId,
      topicId: topic.id, directoryPath: topic.directoryPath, contentKind: 'topic', relations: { [category.spaceId]: true, [address.spaceId]: false } } },
    scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(scratchWorkspace), revision: 0, topics: [topic, other], reading: false, error: null } },
    workspaceFileRevisions: {}, workbenchSpaceSelection: null, retainedSpatialFocus: null, workbenchNavigationInputPolicy: null,
    pendingAgentLaunches: {}, recoveryCandidates: [], error: null, warmTerminal: null,
    agentComposerDrafts: { [target.layout.activeRegionId]: 'Original target draft', [neighbor.layout.activeRegionId]: 'Original neighbor draft' } })
  const catalog = workbenchSelectionCatalog(useAppStore.getState())
  useAppStore.setState({ workbenchSpaceSelection: { ...resolveDesktopSpaceSelection(useAppStore.getState(), catalog,
    { spaceId: category.spaceId, zoneId: address.zoneId, tabId: target.id, displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId }), topicId: topic.id } })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic, other])
  vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic)
  vi.spyOn(api.sessions, 'launchTerminal').mockRejectedValue(new Error('Unexpected speculative Terminal in empty-state proof'))
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation(() => new Promise(() => {}))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); restorePopover()
  useAppStore.setState(initial, true); useLauncherState.setState(initialLauncher, true); window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const mount = async (props: Partial<Parameters<typeof WorkspaceWorkbench>[0]> = {}) => {
  await act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID, topicId: topic.id, visible: true, ...props })))
}
async function closeTarget() {
  // When mounted, use the actual Tab close button and its requestTabsClose/Store operation.
  const close = container.querySelector<HTMLElement>('.workbench-tab[data-workbench-tab-id="empty-target-tab"] .workbench-tab__close')
  if (close) await act(async () => close.click())
  else await act(async () => expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, groupId, target.id, { keepAgentSessions: true })).toBe(true))
}
function startButton() { return container.querySelector<HTMLButtonElement>('.pane-state button[aria-label="New Tab"]') }

it('actual last-Tab close retains the Category/Topic Zone and shows a normal scoped starting surface without automatic creation', async () => {
  await mount(); expect(container.querySelector('[data-workbench-tab-id="empty-target-tab"]')).not.toBeNull()
  const before = useAppStore.getState(); expect(Object.keys(before.tabs)).toHaveLength(2); expect(before.sessions).toHaveLength(1)
  await closeTarget()
  const current = useAppStore.getState(), catalog = workbenchSelectionCatalog(current)
  expect(current.workbenchSpaceSelection).toMatchObject({ spaceId: category.spaceId, zoneId: address.zoneId, topicId: topic.id, tabId: null, groupId: null, regionId: null })
  expect(catalog.zones.some(zone => zone.zoneId === address.zoneId)).toBe(true)
  expect(catalog.bindings.some(binding => binding.spaceId === category.spaceId && binding.zoneId === address.zoneId)).toBe(true)
  expect(catalog.tabs.filter(tab => tab.zoneId === address.zoneId)).toEqual([])
  expect(current.tabs[neighbor.id]).toBe(before.tabs[neighbor.id]); expect(current.sessions).toBe(before.sessions)
  expect(current.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(container.textContent).not.toMatch(/placement is still being confirmed|Original work surface retained/)
  expect(startButton()).not.toBeNull(); expect(Object.keys(current.tabs)).toEqual([neighbor.id])
  expect(api.sessions.launchTerminal).not.toHaveBeenCalled(); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
})
it('the original empty-surface New Tab action creates exactly one Launcher in its original Zone and Category', async () => {
  await mount(); await closeTarget(); const before = useAppStore.getState()
  const button = startButton(); expect(button).not.toBeNull()
  await act(async () => button!.click())
  const current = useAppStore.getState(), created = Object.values(current.tabs).filter(tab => tab.id !== neighbor.id)
  expect(created).toHaveLength(1)
  expect(created[0]).toMatchObject({ workspaceId: SCRATCH_WORKSPACE_ID, topicId: topic.id, space: { zoneId: address.zoneId } })
  expect(created[0]!.regions[created[0]!.layout.activeRegionId]?.kind).toBe('launcher')
  expect(current.workbenchSpaceSelection).toMatchObject({ spaceId: category.spaceId, zoneId: address.zoneId, topicId: topic.id, tabId: created[0]!.id, groupId })
  expect(current.tabs[neighbor.id]).toBe(before.tabs[neighbor.id]); expect(current.sessions).toBe(before.sessions)
  expect(api.sessions.launchTerminal).not.toHaveBeenCalled(); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
})
it('reselecting an existing empty Topic does not reopen a Terminal or make a placeholder', async () => {
  await mount(); await closeTarget(); const before = useAppStore.getState()
  await act(async () => {
    const result = await useAppStore.getState().openScratchTopic(topic.id, SCRATCH_WORKSPACE_ID).catch(error => error)
    expect(api.sessions.launchTerminal).not.toHaveBeenCalled(); expect(result).toBe(true)
  })
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().workbenchSpaceSelection).toEqual(before.workbenchSpaceSelection)
  expect(api.sessions.launchTerminal).not.toHaveBeenCalled(); expect(startButton()).not.toBeNull()
  await act(async () => expect(await useAppStore.getState().openScratchTopic(topic.id, SCRATCH_WORKSPACE_ID, { reveal: false })).toBe(true))
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(api.sessions.launchTerminal).not.toHaveBeenCalled()
})
it('missing original Zone facts remain unknown and keep one notice within the content surface below Tabs', async () => {
  await mount(); await closeTarget()
  const before = useAppStore.getState()
  await act(async () => useAppStore.setState({ spaceZoneBindings: {}, scratchTopicSnapshots: {}, topicCategories: [] }))
  const chrome = container.querySelector('.pane-tabbar'), notice = container.querySelector('.service-window')
  expect(chrome).not.toBeNull(); expect(notice).not.toBeNull()
  expect(chrome!.compareDocumentPosition(notice!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(notice!.closest('.pane-body')).not.toBeNull()
  expect(container.querySelectorAll('.service-window')).toHaveLength(1)
  expect(startButton()).toBeNull(); expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
})
it('ordinary project branch still uses the existing virtual Launcher without creating a persistent Tab', async () => {
  useAppStore.setState({ activeWorkspaceId: 'project', workbenchSpaceSelection: null })
  await act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId: 'project', visible: true })))
  expect(container.querySelector('.launch-surface')).not.toBeNull()
  expect(useAppStore.getState().tabs).toEqual({ [target.id]: target, [neighbor.id]: neighbor })
})
it('a direct known empty Zone projection resolves to a starting surface, while a missing loaded member never becomes empty', async () => {
  const originalMember = workbenchSelectionCatalog(useAppStore.getState()).tabs.find(tab => tab.tabId === target.id)!
  await closeTarget(); const state = useAppStore.getState(), catalog = workbenchSelectionCatalog(state)
  const projection = resolveWorkbenchZone(address.zoneId, catalog, state.layouts, state.tabs, 'direct-zone', [], vi.fn())
  expect(projection).not.toBeNull()
  await mount({ viewOwnership: 'projection', projection: projection! })
  expect(startButton()).not.toBeNull(); expect(container.textContent).not.toContain('restoring')
  // A catalog member is original identity even when the renderer hasn't loaded its content.
  const retainedCatalog = { ...catalog, tabs: [originalMember, ...catalog.tabs] }
  const choice = state.workbenchSpaceSelection!
  const projected = projectWorkbenchSpaceSelection(state.layouts[SCRATCH_WORKSPACE_ID], state.tabs, retainedCatalog, choice)
  expect(projected.confirmed).toBe(false); expect(projected.layout).toBeNull(); expect(projected.issues.length).toBeGreaterThan(0)
  const retained = projectWorkbenchProjection(state.layouts[SCRATCH_WORKSPACE_ID], state.tabs, { ...projection!, catalog: retainedCatalog })
  expect(retained.layout).toBeNull(); expect(retained.issues.length).toBeGreaterThan(0)
})
it('unknown Zone resource or an explicit missing occurrence is never a confirmed empty Zone', async () => {
  await closeTarget(); const state = useAppStore.getState(), catalog = workbenchSelectionCatalog(state)
  const unknownCatalog = { ...catalog, zones: catalog.zones.map(zone => zone.zoneId === address.zoneId
    ? { ...zone, kind: 'unknown' as const, hostId: null, directoryPath: null, branch: null, issue: 'Original resource unavailable' } : zone) }
  const choice = state.workbenchSpaceSelection!
  const unknown = projectWorkbenchSpaceSelection(state.layouts[SCRATCH_WORKSPACE_ID], state.tabs, unknownCatalog, choice)
  expect(unknown.confirmed).toBe(false); expect(unknown.issues.join(' ')).toContain('Original resource unavailable')
  const scope: WorkbenchProjection = { entity: { kind: 'zone', zoneId: address.zoneId }, catalog, presentationId: 'missing', displayWorkspaceId: SCRATCH_WORKSPACE_ID,
    selectionMode: 'occurrence', selection: [{ displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId, tabId: target.id, regionId: 'empty-target-region' }], onSelect: vi.fn() }
  const result = projectWorkbenchProjection(state.layouts[SCRATCH_WORKSPACE_ID], state.tabs, scope)
  expect(result.layout).toBeNull(); expect(result.issues.length).toBeGreaterThan(0)
})

it('a missing stored layout keeps the last confirmed empty workface as recovery, never a confirmed starting target', async () => {
  await mount(); await closeTarget(); const before = useAppStore.getState()
  await act(async () => useAppStore.setState({ layouts: { project: before.layouts.project! } }))
  expect(startButton()).toBeNull()
  const notice = container.querySelector('.service-window')!
  expect(notice).not.toBeNull(); expect(notice.textContent).toContain('Display layout is still restoring')
  expect(notice.closest('.pane-body')).not.toBeNull()
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().sessions).toBe(before.sessions)
})
it('the real shared Mote workface keeps its original empty discussion language and exact New discussion action', async () => {
  const mote = moteTopic(topic.id, 'Original Mote', true)
  const current = useAppStore.getState(), layout = current.layouts[SCRATCH_WORKSPACE_ID]!
  useAppStore.setState({ topicCategories: [], tabs: { ...current.tabs, [target.id]: { ...target, space: address } },
    spaceZoneBindings: { [address.zoneId]: { workspaceId: SCRATCH_WORKSPACE_ID, spaceId: address.spaceId, topicId: topic.id,
      directoryPath: topic.directoryPath, contentKind: 'mote' } },
    scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(scratchWorkspace), revision: 0, topics: [mote, other], reading: false, error: null } },
    workbenchSpaceSelection: { ...current.workbenchSpaceSelection!, spaceId: address.spaceId } })
  vi.mocked(api.scratch.listTopics).mockResolvedValue([mote, other]); vi.mocked(api.scratch.readTopic).mockResolvedValue(mote)
  await act(async () => root.render(createElement(MoteWorkface, { workspaceId: SCRATCH_WORKSPACE_ID, topicId: topic.id,
    children: createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID, topicId: topic.id, visible: true }) })))
  await closeTarget()
  const empty = container.querySelector(`[data-mote-empty-space="${mote.id}"]`)
  expect(empty).not.toBeNull(); expect(empty!.textContent).toContain('Original Mote')
  expect(empty!.textContent).toContain('No discussion yet')
  const button = empty!.querySelector<HTMLButtonElement>('[aria-label="New discussion"]')!
  expect(button).not.toBeNull(); await act(async () => button.click())
  expect(Object.values(useAppStore.getState().tabs).filter(tab => tab.topicId === mote.id)).toHaveLength(1)
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.activeGroupId).toBe(layout.activeGroupId)
  expect(api.sessions.launchTerminal).not.toHaveBeenCalled()
})
it('explicit original Topic creation still creates its first attached Terminal through the original lifecycle', async () => {
  // Only Host RPC/FS and Session responses are controlled; the real create/refresh/placement/Terminal owners execute.
  let born = topic
  vi.spyOn(api.topics, 'call').mockImplementation((async (method: string, input: { topicId: string; title: string }) => {
    expect(method).toBe('topic.create'); born = moteTopic(input.topicId, input.title, false)
    const original = topicSpatialAddress(moteConfig, born, {}, [])!
    return { topic: { topicId: born.id, hostId: 'local', zoneId: original.zoneId, directoryPath: born.directoryPath,
      title: born.title, summary: '', categorySpaceIds: [], chatIds: [], spatialRevision: 1 }, diskDurability: 'confirmed' }
  }) as typeof api.topics.call)
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph: {
    spaces: [], zones: [], tabs: [], regions: [], bindings: [], resources: {}, layouts: {}, tabLayouts: {}
  } })
  vi.mocked(api.scratch.readTopic).mockImplementation(async () => born)
  const terminal = { ...ordinaryAgent, id: 'explicit-created-terminal', kind: 'terminal' as const, providerId: null,
    control: { kind: 'terminal' as const, hostId: 'local', runId: 'explicit-created-run', run: { runId: 'explicit-created-run' } } }
  vi.mocked(api.sessions.launchTerminal).mockResolvedValue(terminal)
  const before = useAppStore.getState()
  let created = topic
  await act(async () => { created = await useAppStore.getState().createScratchTopic() })
  expect(api.topics.call).toHaveBeenCalledWith('topic.create', { topicId: created.id, title: 'New Topic' })
  expect(api.sessions.launchTerminal).toHaveBeenCalledOnce()
  const tabs = Object.values(useAppStore.getState().tabs).filter(tab => tab.topicId === created.id)
  expect(tabs).toHaveLength(1)
  expect(tabs[0]!.regions[tabs[0]!.layout.activeRegionId]).toMatchObject({ kind: 'terminal', phase: 'attached', sessionId: terminal.id })
  expect(useAppStore.getState().tabs[neighbor.id]).toBe(before.tabs[neighbor.id])
})

it('the real retained-Tab branch keeps its durable disclosure inside the original Pane below Tabs', async () => {
  const state = useAppStore.getState(), catalog = workbenchSelectionCatalog(state)
  const projection = resolveWorkbenchZone(address.zoneId, catalog, state.layouts, state.tabs, 'retained-zone', [], vi.fn())!
  expect(projection).not.toBeNull()
  await mount({ viewOwnership: 'projection', projection, retainedTabId: target.id })
  const originalSlot = container.querySelector(`.workbench-tab-slot[data-workbench-tab-id="${target.id}"]`)
  expect(originalSlot).not.toBeNull()
  const before = useAppStore.getState()
  await mount({ viewOwnership: 'projection', projection: undefined, retainedTabId: target.id })
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="View service notice: Original Tab retained"]')
  expect(trigger).not.toBeNull()
  const pane = trigger!.closest('.pane-body')!
  expect(pane).not.toBeNull()
  const chrome = pane.closest('.pane-group')!.querySelector('.pane-tabbar')!
  expect(chrome.compareDocumentPosition(trigger!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(container.querySelectorAll('.service-disclosure')).toHaveLength(1)
  const collapse = container.querySelector<HTMLButtonElement>('[aria-label="Collapse service notice: Original Tab retained"]')!
  expect(collapse).not.toBeNull(); await act(async () => collapse.click())
  expect(trigger!.closest('.service-disclosure')?.getAttribute('data-unread')).toBe('false')
  await mount({ viewOwnership: 'projection', projection, retainedTabId: target.id })
  await mount({ viewOwnership: 'projection', projection: undefined, retainedTabId: target.id })
  expect(container.querySelector('[aria-label="View service notice: Original Tab retained"]')).toBe(trigger)
  expect(trigger!.closest('.service-disclosure')?.getAttribute('data-unread')).toBe('false')
  expect(container.querySelector(`.workbench-tab-slot[data-workbench-tab-id="${target.id}"]`)).toBe(originalSlot)
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('retained recovery controls stay outside the original Tab positioning surface without remounting its content', async () => {
  const styles = document.createElement('style')
  styles.textContent = readFileSync(new NodeURL('../src/renderer/src/styles/workbench.css', import.meta.url), 'utf8')
  document.head.append(styles)
  try {
    const state = useAppStore.getState(), catalog = workbenchSelectionCatalog(state)
    const projection = resolveWorkbenchZone(address.zoneId, catalog, state.layouts, state.tabs, 'retained-content', [], vi.fn())!
    await mount({ viewOwnership: 'projection', projection, retainedTabId: target.id })
    const originalSlot = container.querySelector(`[data-workbench-tab-id="${target.id}"].workbench-tab-slot`)!
    expect(originalSlot).not.toBeNull()
    const region = originalSlot.closest('.pane-body__region')!
    const content = region.parentElement!
    const pane = content.parentElement!
    expect(content.classList.contains('pane-body__content')).toBe(true)
    // Read actual production CSS on the mounted consumer. HappyDOM does not perform
    // hit testing; real Chromium pointer reachability is independently reviewed.
    expect(getComputedStyle(pane).display).toBe('flex')
    expect(getComputedStyle(pane).flexDirection).toBe('column')
    expect(getComputedStyle(content).position).toBe('relative')
    expect(getComputedStyle(content).flexGrow).toBe('1')
    expect(Number.parseFloat(getComputedStyle(content).minHeight)).toBe(0)
    expect(getComputedStyle(region).position).toBe('absolute')
    expect(pane.querySelector('.service-disclosure')).toBeNull()
    const before = useAppStore.getState()
    await mount({ viewOwnership: 'projection', projection: undefined, retainedTabId: target.id })
    const disclosure = pane.querySelector('.service-disclosure')!
    expect(disclosure).not.toBeNull()
    const noticeSurface = Array.from(pane.children).find(child => child.contains(disclosure))!
    expect(noticeSurface).not.toBe(content)
    expect(content.contains(disclosure)).toBe(false)
    expect(noticeSurface.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelector(`[data-workbench-tab-id="${target.id}"].workbench-tab-slot`)).toBe(originalSlot)
    expect(region.parentElement).toBe(content)
    await mount({ viewOwnership: 'projection', projection, retainedTabId: target.id })
    expect(pane.querySelector('.service-disclosure')).toBe(disclosure)
    expect(disclosure.closest('[hidden]')).not.toBeNull()
    expect(container.querySelector(`[data-workbench-tab-id="${target.id}"].workbench-tab-slot`)).toBe(originalSlot)
    expect(region.parentElement).toBe(content)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  } finally { styles.remove() }
})
