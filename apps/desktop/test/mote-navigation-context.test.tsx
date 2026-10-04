// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultTab, defaultAgent, neighborTab, neighborAgent, customTab, savedMoteKey } from './fixtures/mote-workface'
import { desktopWorkbenchObservationSchema } from '../src/shared/client-observation'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'

let app: MoteAppFixture
beforeEach(() => { app = createMoteApp() })
afterEach(async () => { await app.dispose() })
const reference = { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: defaultTab.id, regionId: 'default-region' }
function saved() { return JSON.parse(localStorage.getItem(savedMoteKey)!) }
function choice(label: string) {
  const button = [...app.panel().querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)
  expect(button).not.toBeUndefined(); return button!
}

it('mounted Mote and public observation keep their exact Region while Work selects a sibling of the same Tab', async () => {
  const mixed = addWorkbenchRegion(defaultTab, reference.regionId, 'right', { kind: 'file', workspaceId: SCRATCH_WORKSPACE_ID,
    regionId: 'work-file', path: 'work.txt' })
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [mixed.id]: mixed }, workbenchSpaceSelection: {
    ...state.workbenchSpaceSelection!, tabId: mixed.id, regionId: 'work-file' } }))
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID,
    targetTabId: mixed.id, reference }))
  await app.mount()
  expect(app.panel().dataset.moteTargetRegion).toBe(reference.regionId)
  expect(app.panel().dataset.moteTargetSession).toBe(defaultAgent.id)
  const work = useAppStore.getState().workbenchSpaceSelection
  await act(async () => useAppStore.getState().focusRegion(SCRATCH_WORKSPACE_ID, mixed.id, 'work-file', 'pointer', reference.groupId))
  await settleMoteApp()
  expect(app.panel().dataset.moteTargetRegion).toBe(reference.regionId)
  expect(app.panel().dataset.moteTargetSession).toBe(defaultAgent.id)
  expect(saved().reference).toEqual(reference)
  const inspected = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'mote-local-inspection', operation: 'inspect.client' })
  expect(inspected.operation).toBe('inspect.client')
  if (inspected.operation !== 'inspect.client') throw new Error('Wrong public observation')
  expect(desktopWorkbenchObservationSchema.parse(inspected.observation).desktop.floating).toMatchObject({ tabId: mixed.id, regionId: reference.regionId, sessionId: defaultAgent.id })
  expect(useAppStore.getState().workbenchSpaceSelection).toEqual(work)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it('an explicit cross-context handoff captures its exact Region once and keeps an unconfirmed handoff raw', async () => {
  const mixed = addWorkbenchRegion(defaultTab, reference.regionId, 'right', { kind: 'file', workspaceId: SCRATCH_WORKSPACE_ID,
    regionId: 'work-file', path: 'work.txt' })
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [mixed.id]: mixed } }))
  const work = useAppStore.getState().workbenchSpaceSelection
  await app.mount()
  const location = { ...reference, spaceId: null, zoneId: null }
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, reference: location }))
  await settleMoteApp()
  expect(useAppStore.getState().tabs[mixed.id]!.layout.activeRegionId).toBe('work-file')
  expect(app.panel().dataset.moteTargetRegion).toBe(reference.regionId)
  expect(app.panel().dataset.moteTargetSession).toBe(defaultAgent.id)
  expect(saved().reference).toEqual(reference)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(work)
  const unknown = { ...reference, regionId: 'unconfirmed-handoff' }
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, reference: unknown }))
  await settleMoteApp()
  expect(saved().reference).toEqual(unknown)
  expect(app.panel().dataset.moteTargetRegion).toBeUndefined()
  expect(app.panel().textContent).toContain('exact discussion location is not confirmed')
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(work)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it('an unsaved Mote with several discussions asks for a local choice and then ignores Work and semantic focus ordering', async () => {
  localStorage.removeItem(savedMoteKey)
  await app.mount()
  await act(async () => requestPmoTeamsTopicFloatingOpen())
  await settleMoteApp()
  expect(app.panel().dataset.moteTargetTab).toBeUndefined()
  expect(app.panel().textContent).toContain('Choose a discussion to continue')
  expect(saved().targetTabId).toBeUndefined()
  await moteClick(choice(neighborTab.name!))
  expect(app.panel().dataset.moteTargetTab).toBe(neighborTab.id)
  expect(app.panel().dataset.moteTargetSession).toBe(neighborAgent.id)
  expect(saved().targetTabId).toBe(neighborTab.id)
  await act(async () => useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id))
  await settleMoteApp()
  expect(useAppStore.getState().agentFocus.pmo.sessionId).toBe(defaultAgent.id)
  expect(app.panel().dataset.moteTargetTab).toBe(neighborTab.id)
  const laterWork = useAppStore.getState().workbenchSpaceSelection
  await moteClick(app.panel().querySelector<HTMLButtonElement>('[aria-label="Close Mote"]')!)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(laterWork)
  await act(async () => requestPmoTeamsTopicFloatingOpen())
  await settleMoteApp()
  expect(app.panel().dataset.moteTargetTab).toBe(neighborTab.id)
  expect(saved().targetTabId).toBe(neighborTab.id)
})

it('an unknown saved Mote Region stays unknown through shared Region changes and remount', async () => {
  const unknown = { ...reference, regionId: 'saved-unconfirmed-region' }
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID,
    targetTabId: defaultTab.id, reference: unknown }))
  await app.mount()
  expect(app.panel().dataset.moteTargetRegion).toBeUndefined()
  expect(app.panel().dataset.moteTargetSession).toBeUndefined()
  expect(app.panel().textContent).toContain('exact discussion location is not confirmed')
  const work = useAppStore.getState().workbenchSpaceSelection
  await act(async () => useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', customTab.id))
  await settleMoteApp(); await app.remount()
  expect(saved().reference).toEqual(unknown)
  expect(saved().targetTabId).toBe(defaultTab.id)
  expect(app.panel().dataset.moteTargetRegion).toBeUndefined()
  expect(app.panel().dataset.moteTargetSession).toBeUndefined()
  expect(useAppStore.getState().workbenchSpaceSelection).not.toBe(work)
  expect(useAppStore.getState().workbenchSpaceSelection?.tabId).toBe(customTab.id)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it.each([false, true])('an unknown Region keeps both healthy Regions of its confirmed parent through cold mount/remount=%s until a local pointer choice', async remount => {
  const split = addWorkbenchRegion(defaultTab, reference.regionId, 'right', { kind: 'agent', phase: 'attached',
    workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'surviving-peer', sessionId: neighborAgent.id })
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [split.id]: split }, mainSurface: 'board',
    viewModes: { [defaultAgent.id]: 'activity', [neighborAgent.id]: 'activity' } }))
  const unknown = { ...reference, regionId: 'moved-original-region' }
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID,
    targetTabId: split.id, reference: unknown }))
  await app.mount()
  if (remount) await app.remount()
  const editors = [...app.panel().querySelectorAll<HTMLElement>('[data-workbench-region-id] [role="textbox"]')]
  expect(editors).toHaveLength(2)
  expect(editors.map(editor => editor.closest<HTMLElement>('[data-workbench-region-id]')!.dataset.workbenchRegionId).sort())
    .toEqual([reference.regionId, 'surviving-peer'].sort())
  expect(saved().reference).toEqual(unknown)
  expect(app.panel().dataset.moteTargetRegion).toBeUndefined()
  expect(app.panel().dataset.moteTargetSession).toBeUndefined()
  expect(app.panel().querySelectorAll('.workbench-region--active')).toHaveLength(0)
  const before = useAppStore.getState()
  const original = editors.find(editor => editor.closest<HTMLElement>('[data-workbench-region-id]')!.dataset.workbenchRegionId === reference.regionId)!
  await moteClick(original)
  expect(saved().reference).toEqual(reference)
  expect(app.panel().dataset.moteTargetRegion).toBe(reference.regionId)
  expect(app.panel().dataset.moteTargetSession).toBe(defaultAgent.id)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  expect(useAppStore.getState().tabs[split.id]!.layout.activeRegionId).toBe(before.tabs[split.id]!.layout.activeRegionId)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it('Open in Space hands the exact local reference to the public owner once and closes only after its receipt', async () => {
  useAppStore.setState({ mainSurface: 'board', activeWorkspaceId: 'project' })
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID,
    targetTabId: defaultTab.id, reference }))
  await app.mount()
  const owner = vi.spyOn(useAppStore.getState(), 'executeControl')
  await moteClick(app.panel().querySelector<HTMLButtonElement>('button[aria-label="Open in Space"], button[aria-label="Open Mote Space"]')!)
  const requests = owner.mock.calls.flatMap(([request], index) => request.operation === 'focus' ? [{ request, index }] : [])
  expect(requests).toHaveLength(1)
  expect(requests[0]!.request).toMatchObject({ operation: 'focus', inputPolicy: 'preserve', target: { kind: 'space', ...reference } })
  let receipt!: Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['executeControl']>>
  await act(async () => { receipt = await owner.mock.results[requests[0]!.index]!.value })
  await settleMoteApp()
  expect(receipt.operation).toBe('focus')
  if (receipt.operation !== 'focus') throw new Error('Wrong public focus receipt')
  expect(receipt.navigation.state).toMatch(/^(applied|unchanged)$/)
  expect(saved().open).toBe(false)
  expect(saved().reference).toEqual(reference)
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ workspaceId: reference.displayWorkspaceId,
    groupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId })
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it('a later local Region choice cancels an earlier exact Open Mote Space action', async () => {
  const mixed = addWorkbenchRegion(defaultTab, reference.regionId, 'right', { kind: 'file', workspaceId: SCRATCH_WORKSPACE_ID,
    regionId: 'later-local-file', path: 'local.txt' })
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [mixed.id]: mixed }, mainSurface: 'board' }))
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID,
    targetTabId: mixed.id, reference }))
  await app.mount()
  let signal: AbortSignal | undefined
  let finish!: () => void
  const execute = useAppStore.getState().executeControl
  const delayed = vi.fn<typeof execute>((request, originalSignal) => {
    if (request.operation !== 'focus') return execute(request, originalSignal)
    signal = originalSignal
    return new Promise(resolve => { finish = () => resolve({ operation: 'focus', navigation: { state: 'applied' } } as Awaited<ReturnType<typeof execute>>) })
  })
  await act(async () => useAppStore.setState({ executeControl: delayed }))
  await moteClick(app.panel().querySelector<HTMLButtonElement>('button[aria-label="Open in Space"], button[aria-label="Open Mote Space"]')!)
  expect(signal?.aborted).toBe(false)
  expect(delayed).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({
    kind: 'space', tabId: reference.tabId, regionId: reference.regionId,
    displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId
  }), inputPolicy: 'preserve' }), expect.any(AbortSignal))
  const sibling = app.panel().querySelector<HTMLElement>('[data-workbench-region-id="later-local-file"]')
  expect(sibling).not.toBeNull()
  await moteClick(sibling!)
  expect(saved().reference.regionId).toBe('later-local-file')
  expect(signal?.aborted).toBe(true)
  await act(async () => finish()); await settleMoteApp()
  expect(saved().open).toBe(true)
  expect(saved().reference.regionId).toBe('later-local-file')
})

it('a later Work choice latches cancellation during an exact handoff before the final surface, including A→B→A', async () => {
  useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, reference.groupId, customTab.id)
  useAppStore.setState({ mainSurface: 'board' })
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID,
    targetTabId: defaultTab.id, reference }))
  await app.mount()
  let signal: AbortSignal | undefined
  let finish!: () => void
  const execute = useAppStore.getState().executeControl
  await act(async () => useAppStore.setState({ executeControl: (request, originalSignal) => {
    if (request.operation !== 'focus') return execute(request, originalSignal)
    signal = originalSignal
    return new Promise(resolve => { finish = () => resolve({ operation: 'focus', navigation: { state: 'applied' } } as Awaited<ReturnType<typeof execute>>) })
  } }))
  await moteClick(app.panel().querySelector<HTMLButtonElement>('button[aria-label="Open in Space"], button[aria-label="Open Mote Space"]')!)
  const sourceChoice = useAppStore.getState().workbenchSpaceSelection!
  const sourceReference = { displayWorkspaceId: sourceChoice.workspaceId, groupId: sourceChoice.groupId!,
    tabId: sourceChoice.tabId!, regionId: sourceChoice.regionId! }
  await act(async () => {
    const current = useAppStore.getState()
    expect(current.selectMainRegion(reference, sourceChoice)).toBe(true)
    expect(useAppStore.getState().mainSurface).toBe('board')
    expect(signal?.aborted).toBe(false)
    expect(current.selectMainRegion(sourceReference, useAppStore.getState().workbenchSpaceSelection)).toBe(true)
    expect(signal?.aborted).toBe(true)
    expect(current.selectMainRegion(reference, useAppStore.getState().workbenchSpaceSelection)).toBe(true)
  })
  const laterWork = useAppStore.getState().workbenchSpaceSelection
  await act(async () => finish()); await settleMoteApp()
  expect(saved().open).toBe(true)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(laterWork)
  expect(useAppStore.getState().mainSurface).toBe('board')
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})
