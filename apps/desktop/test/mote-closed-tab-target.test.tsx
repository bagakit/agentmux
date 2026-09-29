// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { subscribeWorkbenchTabRemoved } from '../src/renderer/src/lib/workbench-tab-removal'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customMoteId, customTab, defaultAgent, defaultTab, moteTopics, neighborTab, savedMoteKey } from './fixtures/mote-workface'

let app: MoteAppFixture
beforeEach(() => { app = createMoteApp() })
afterEach(async () => { await app.dispose() })

async function openSavedTarget(tabId: string | null = defaultTab.id, topicId = PMO_TEAMS_TOPIC_ID) {
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: topicId, targetTabId: tabId }))
  await app.mount()
  expect(app.panel().dataset.moteTargetTopic).toBe(topicId)
}
function persisted() { return JSON.parse(localStorage.getItem(savedMoteKey)!) }
function removeNeighbor() {
  const { [neighborTab.id]: removed, ...tabs } = useAppStore.getState().tabs
  expect(removed).toBe(neighborTab)
  useAppStore.setState({ tabs, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', Object.keys(tabs)) } })
}
function button(text: string, owner: ParentNode = document) {
  const found = Array.from(owner.querySelectorAll<HTMLButtonElement>('button')).find(one => one.textContent === text)
  expect(found).not.toBeUndefined(); return found!
}
async function closeSelected(keep = true) {
  const id = app.panel().dataset.moteTargetTab
  expect(id).toBeTruthy()
  const close = app.panel().querySelector<HTMLElement>(`button[data-workbench-tab-id="${id}"] .workbench-tab__close`)
  expect(close).not.toBeNull(); await moteClick(close!)
  await moteClick(button(keep ? 'Keep Session & Close' : 'Stop & Close'))
}
async function choose(topicId: string) {
  const choice = app.panel().querySelector<HTMLButtonElement>(`[data-mote-topic-id="${topicId}"]`)
  expect(choice).not.toBeNull(); await moteClick(choice!)
}
function expectQuiet(before: ReturnType<typeof useAppStore.getState>, stop: MockInstance<typeof api.sessions.stop>) {
  const after = useAppStore.getState()
  expect(after.sessions).toBe(before.sessions)
  expect(after.agentFocus.execution).toEqual(before.agentFocus.execution)
  expect(after.tabs[customTab.id]).toBe(before.tabs[customTab.id])
  expect(after.agentComposerDrafts).toEqual(before.agentComposerDrafts)
  expect(stop).not.toHaveBeenCalled()
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.enqueue).not.toHaveBeenCalled()
}

it('actual App Tab X → Keep Session & Close selects the same Mote original remaining Tab', async () => {
  await openSavedTarget()
  const before = useAppStore.getState(), stop = vi.spyOn(api.sessions, 'stop')
  expect([defaultTab.id, neighborTab.id].map(id => before.tabs[id])).toEqual([defaultTab, neighborTab])
  await closeSelected()
  expect(useAppStore.getState().tabs[defaultTab.id]).toBeUndefined()
  expect(useAppStore.getState().tabs[neighborTab.id]).toBe(before.tabs[neighborTab.id])
  expect(app.panel().dataset.moteTargetTab).toBe(neighborTab.id)
  expect(persisted().targetTabId).toBe(neighborTab.id)
  expect(app.panel().textContent).not.toContain('Original Tab retained')
  expectQuiet(before, stop)
})

it('last actual Tab close persists null, survives remount and Mote switching, and creates only via explicit New Tab', async () => {
  removeNeighbor(); await openSavedTarget()
  const before = useAppStore.getState(), stop = vi.spyOn(api.sessions, 'stop')
  await closeSelected()
  expect(useAppStore.getState().tabs[defaultTab.id]).toBeUndefined()
  expect(Object.values(useAppStore.getState().tabs).filter(tab => tab.topicId === PMO_TEAMS_TOPIC_ID)).toEqual([])
  expect(persisted().targetTabId).toBeNull()
  expect(app.panel().dataset.moteTargetTab).toBeUndefined()
  expect(app.panel().textContent).not.toContain('Original Tab retained')
  expectQuiet(before, stop)
  await app.remount()
  expect(persisted().targetTabId).toBeNull()
  await choose(customMoteId); expect(app.panel().dataset.moteTargetTab).toBe(customTab.id)
  await choose(PMO_TEAMS_TOPIC_ID)
  expect(persisted().targetTabId).toBeNull()
  expect(Object.values(useAppStore.getState().tabs).filter(tab => tab.topicId === PMO_TEAMS_TOPIC_ID)).toEqual([])
  const newTab = app.panel().querySelector<HTMLButtonElement>('button[aria-label="New Tab"]')
  expect(newTab).not.toBeNull(); await moteClick(newTab!)
  const created = Object.values(useAppStore.getState().tabs).filter(tab => tab.topicId === PMO_TEAMS_TOPIC_ID)
  expect(created).toHaveLength(1)
  expect(created[0]!.id).not.toBe(defaultTab.id)
  expect(created[0]!.regions[created[0]!.layout.activeRegionId]!.kind).toBe('launcher')
  expect(app.panel().dataset.moteTargetTab).toBe(created[0]!.id)
  expectQuiet(before, stop)
})

it('empty Open Mote Space selects the same Topic without preparing a launcher', async () => {
  removeNeighbor(); await openSavedTarget(); await closeSelected()
  expect(persisted().targetTabId).toBeNull()
  const before = useAppStore.getState()
  const open = app.panel().querySelector<HTMLButtonElement>('button[aria-label="Open Mote Space"]')
  expect(open).not.toBeNull(); await moteClick(open!)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID)
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  expect(useAppStore.getState().workbenchSpaceSelection?.topicId).toBe(PMO_TEAMS_TOPIC_ID)
  expect(useAppStore.getState().workbenchSpaceSelection?.tabId).toBeNull()
  expect(useAppStore.getState().agentFocus.execution).toEqual(before.agentFocus.execution)
  const empty = document.querySelector<HTMLElement>(`[data-mote-empty-space="${PMO_TEAMS_TOPIC_ID}"]`)
  expect(empty).not.toBeNull()
  expect(empty!.textContent).toContain('Mote')
  expect(empty!.querySelector('[role="status"]')?.textContent).toBe('No Tab in this context')
  const create = empty!.querySelector<HTMLButtonElement>('[aria-label="New Tab"]')
  expect(create).not.toBeNull(); await moteClick(create!)
  const created = Object.values(useAppStore.getState().tabs).filter(tab => tab.topicId === PMO_TEAMS_TOPIC_ID)
  expect(created).toHaveLength(1)
  expect(created[0]!.id).not.toBe(defaultTab.id)
  expect(created[0]!.regions[created[0]!.layout.activeRegionId]!.kind).toBe('launcher')
  expect(useAppStore.getState().tabs[customTab.id]).toBe(before.tabs[customTab.id])
  expect(useAppStore.getState().agentFocus.execution).toEqual(before.agentFocus.execution)
  expect(app.launch).not.toHaveBeenCalled()
})

it('saved explicit null stays empty even while another placed original Tab exists in its Topic', async () => {
  expect([defaultTab.id, neighborTab.id].map(id => useAppStore.getState().tabs[id])).toEqual([defaultTab, neighborTab])
  await openSavedTarget(null)
  expect(app.panel().dataset.moteTargetTab).toBeUndefined()
  expect(persisted().targetTabId).toBeNull()
  expect(useAppStore.getState().tabs[defaultTab.id]).toBe(defaultTab)
  await app.remount()
  expect(app.panel().dataset.moteTargetTab).toBeUndefined()
  expect(persisted().targetTabId).toBeNull()
  expect(app.launch).not.toHaveBeenCalled()
})

it('an unconfirmed Topic with no target keeps the preparation notice without claiming an empty workface', async () => {
  await openSavedTarget(null, 'launcher:not-confirmed')
  expect(app.panel().dataset.moteTargetTab).toBeUndefined()
  expect(app.panel().textContent).toContain('Topic directory is still being confirmed')
  expect(app.panel().textContent).not.toContain('No Tab in this context')
  expect(app.panel().querySelector('[aria-label="New Tab"]')).toBeNull()
  expect(useAppStore.getState().tabs[defaultTab.id]).toBe(defaultTab)
  expect(app.launch).not.toHaveBeenCalled()
  await act(async () => { useAppStore.setState({ mainSurface: 'workbench', workbenchSpaceSelection: {
    workspaceId: SCRATCH_WORKSPACE_ID, spaceId: SCRATCH_WORKSPACE_ID, zoneId: 'home',
    topicId: 'launcher:not-confirmed', tabId: null, groupId: null, regionId: null
  } }) }); await settleMoteApp()
  expect(document.querySelector('[data-mote-empty-space]')).toBeNull()
  expect(document.body.textContent).toContain('Topic or Tab placement is still being confirmed')
  expect(useAppStore.getState().tabs[defaultTab.id]).toBe(defaultTab)
})

it('an exact custom Tab saved without Topic preference consumes its actual close in the same Topic', async () => {
  const neighbor = { ...neighborTab, id: 'custom-neighbor', topicId: customMoteId }
  useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [neighbor.id]: neighbor },
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [...Object.keys(useAppStore.getState().tabs), neighbor.id]) } })
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: false, targetTabId: customTab.id }))
  await app.mount()
  expect(persisted().targetTopicId).toBeUndefined()
  // The original floating owner is mounted but not pinned, so no pin-normalization has written a Topic yet.
  await act(async () => { expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', customTab.id, { keepAgentSessions: true })).toBe(true) })
  expect(useAppStore.getState().tabs[customTab.id]).toBeUndefined()
  expect(useAppStore.getState().tabs[neighbor.id]).toBe(neighbor)
  expect(persisted().targetTopicId).toBe(customMoteId)
  expect(persisted().targetTabId).toBe(neighbor.id)
})

it('confirmed custom empty Topic uses only its own object name', async () => {
  const { [customTab.id]: removed, ...tabs } = useAppStore.getState().tabs
  expect(removed).toBe(customTab)
  useAppStore.setState({ tabs })
  await openSavedTarget(null, customMoteId)
  expect(app.panel().getAttribute('aria-label')).toBe(moteTopics.find(topic => topic.id === customMoteId)!.title)
  expect(app.panel().getAttribute('aria-label')).not.toContain(' · Mote')
})

it('cancel and unselected close preserve the current target; no-plan true is not a deletion', async () => {
  await openSavedTarget()
  const close = app.panel().querySelector<HTMLElement>(`button[data-workbench-tab-id="${defaultTab.id}"] .workbench-tab__close`)
  expect(close).not.toBeNull(); await moteClick(close!)
  await moteClick(button('Cancel'))
  expect(useAppStore.getState().tabs[defaultTab.id]).toBe(defaultTab)
  await act(async () => { expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'missing-group', defaultTab.id, { keepAgentSessions: true })).toBe(true) })
  expect(useAppStore.getState().tabs[defaultTab.id]).toBe(defaultTab)
  await act(async () => { expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', neighborTab.id, { keepAgentSessions: true })).toBe(true) })
  expect(useAppStore.getState().tabs[neighborTab.id]).toBeUndefined()
  expect(persisted().targetTabId).toBe(defaultTab.id)
})

it('closing one placement keeps the original Tab and floating reference', async () => {
  const layout = createWorkspaceLayout('mote-group', Object.keys(useAppStore.getState().tabs))
  // A retained group can sit outside the visible split tree; its real membership still owns the Tab.
  layout.groups.push({ ...layout.groups[0]!, id: 'other-group', tabOrder: [defaultTab.id], activeTabId: defaultTab.id, recentTabIds: [defaultTab.id] })
  useAppStore.setState({ layouts: { [SCRATCH_WORKSPACE_ID]: layout } })
  await openSavedTarget()
  await act(async () => { expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id, { keepAgentSessions: true })).toBe(true) })
  expect(useAppStore.getState().tabs[defaultTab.id]).toBe(defaultTab)
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.groups.find(group => group.id === 'other-group')?.tabOrder).toEqual([defaultTab.id])
  expect(persisted().targetTabId).toBe(defaultTab.id)
})

it('resource close failure retains its original View and target', async () => {
  await openSavedTarget()
  const stop = vi.spyOn(api.sessions, 'stop').mockRejectedValue(new Error('Original stop failed'))
  await act(async () => { expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id)).toBe(false) })
  expect(stop).toHaveBeenCalledOnce()
  expect(useAppStore.getState().tabs[defaultTab.id]?.regions['default-region']).toMatchObject({ kind: 'agent', sessionId: defaultAgent.id })
  expect(persisted().targetTabId).toBe(defaultTab.id)
  expect(useAppStore.getState().reportError).toHaveBeenCalled()
})

it('an observer failure reports the original service warning without blocking a healthy close', async () => {
  await openSavedTarget()
  const error = new Error('Original UI observer failed'), unsubscribe = subscribeWorkbenchTabRemoved(() => { throw error })
  try {
    await act(async () => { expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id, { keepAgentSessions: true })).toBe(true) })
    expect(useAppStore.getState().tabs[defaultTab.id]).toBeUndefined()
    expect(persisted().targetTabId).toBe(neighborTab.id)
    expect(useAppStore.getState().reportError).toHaveBeenCalledWith(error)
  } finally { unsubscribe() }
})

it('late metadata prepare does not create a closed Tab or replace a newly selected Mote', async () => {
  let release!: () => void
  app.ensureMote.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(moteTopics[0]!) }))
  await openSavedTarget()
  expect(app.ensureMote).toHaveBeenCalledOnce()
  await choose(customMoteId)
  const before = useAppStore.getState()
  await act(async () => { release() }); await settleMoteApp()
  expect(persisted().targetTabId).toBe(customTab.id)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(app.launch).not.toHaveBeenCalled()
})

it('deferred empty Topic ensure failure and Retry context preserve empty until explicit New Tab', async () => {
  const { [customTab.id]: removed, ...tabs } = useAppStore.getState().tabs
  expect(removed).toBe(customTab)
  useAppStore.setState({ tabs, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', Object.keys(tabs)) } })
  let fail!: (error: Error) => void
  app.ensureMote.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  await openSavedTarget(null, customMoteId)
  const before = useAppStore.getState()
  expect(app.panel().dataset.moteTargetTab).toBeUndefined()
  await act(async () => { fail(new Error('Original directory unavailable')) }); await settleMoteApp()
  expect(app.panel().textContent).toContain('Context preparation did not complete')
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  await moteClick(button('Retry context', app.panel()))
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(app.panel().dataset.moteTargetTab).toBeUndefined()
  expect(app.warm).not.toHaveBeenCalled()
  const newTab = app.panel().querySelector<HTMLButtonElement>('[aria-label="New Tab"]')
  expect(newTab).not.toBeNull(); await moteClick(newTab!)
  const created = Object.values(useAppStore.getState().tabs).filter(tab => tab.topicId === customMoteId)
  expect(created).toHaveLength(1)
  expect(created[0]!.id).not.toBe(customTab.id)
  expect(created[0]!.regions[created[0]!.layout.activeRegionId]!.kind).toBe('launcher')
  expect(app.panel().dataset.moteTargetTab).toBe(created[0]!.id)
})

it('deferred metadata read failure preserves the exact existing Tab and original workface', async () => {
  let fail!: (error: Error) => void
  vi.mocked(api.scratch.readTopic).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  await openSavedTarget()
  const before = useAppStore.getState()
  expect(app.panel().dataset.moteTargetTab).toBe(defaultTab.id)
  await act(async () => { fail(new Error('Original Topic read failed')) }); await settleMoteApp()
  expect(app.panel().textContent).toContain('Context preparation did not complete')
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(persisted().targetTabId).toBe(defaultTab.id)
  expect(app.launch).not.toHaveBeenCalled()
})

it('late closing result cannot replace a newly selected different Mote', async () => {
  await openSavedTarget()
  let finish!: () => void
  vi.spyOn(api.sessions, 'stop').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  let pending!: Promise<boolean>
  await act(async () => { pending = useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id) })
  await choose(customMoteId)
  expect(persisted().targetTabId).toBe(customTab.id)
  await act(async () => { finish(); expect(await pending).toBe(true) })
  expect(useAppStore.getState().tabs[defaultTab.id]).toBeUndefined()
  expect(persisted().targetTabId).toBe(customTab.id)
})

it('a Run replacement during close retains the changed View and original target', async () => {
  await openSavedTarget()
  let finish!: () => void
  vi.spyOn(api.sessions, 'stop').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  let pending!: Promise<boolean>
  await act(async () => {
    pending = useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id)
    useAppStore.setState({ sessions: useAppStore.getState().sessions.map(session => session.id === defaultAgent.id
      ? { ...defaultAgent, control: { ...defaultAgent.control, run: { runId: 'replacement-run' } } } : session) })
  })
  await act(async () => { finish(); expect(await pending).toBe(false) })
  expect(useAppStore.getState().tabs[defaultTab.id]?.regions['default-region']).toMatchObject({ kind: 'agent', sessionId: defaultAgent.id })
  expect(persisted().targetTabId).toBe(defaultTab.id)
})

it('post-delete file cleanup failure reports its error and still consumes the committed deletion', async () => {
  const file = { ...createWorkbenchTab('file-tab', { regionId: 'file-region', workspaceId: SCRATCH_WORKSPACE_ID, kind: 'file', path: '/topics/document.md' }), topicId: PMO_TEAMS_TOPIC_ID }
  useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [file.id]: file },
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [file.id, neighborTab.id, customTab.id]) } })
  await openSavedTarget(file.id)
  const error = new Error('Original file unobserve failed')
  vi.spyOn(api.files, 'unobserve').mockRejectedValue(error)
  await act(async () => { expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', file.id)).toBe(false) })
  expect(useAppStore.getState().tabs[file.id]).toBeUndefined()
  expect(useAppStore.getState().reportError).toHaveBeenCalledWith(error)
  expect(persisted().targetTabId).toBe(neighborTab.id)
})

it.each(['missing', 'other-topic', 'other-workspace', 'unplaced'] as const)('keeps exact %s saved target as unknown recovery', async kind => {
  const { [defaultTab.id]: removed, ...tabs } = useAppStore.getState().tabs
  expect(removed).toBe(defaultTab)
  if (kind === 'other-topic') tabs[defaultTab.id] = { ...defaultTab, topicId: customMoteId }
  if (kind === 'other-workspace') tabs[defaultTab.id] = { ...defaultTab, workspaceId: 'project' }
  if (kind === 'unplaced') tabs[defaultTab.id] = defaultTab
  useAppStore.setState({ tabs, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [neighborTab.id, customTab.id]) } })
  await openSavedTarget()
  expect(app.panel().dataset.moteTargetTab).toBe(defaultTab.id)
  expect(persisted().targetTabId).toBe(defaultTab.id)
  expect(app.panel().textContent).toContain('Original Tab retained')
  expect(useAppStore.getState().tabs[neighborTab.id]).toBe(neighborTab)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})
