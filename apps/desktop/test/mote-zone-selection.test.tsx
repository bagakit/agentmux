// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createWorkspaceLayout } from '@agentmux/layout'
import * as spaceAgentControl from '../src/renderer/src/lib/space-agent-control'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { createMoteApp, moteClick, motePointer, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultTab, neighborTab, ordinaryTab, savedMoteKey } from './fixtures/mote-workface'

let app: MoteAppFixture
beforeEach(() => { app = createMoteApp() })
afterEach(async () => { await app.dispose() })

for (const emptyChoice of [false, true]) it(`opens multiple original members with one shared strip and a selected Tab (empty preference: ${emptyChoice})`, async () => {
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID,
    ...(emptyChoice ? { targetTabId: null, reference: null } : {}) }))
  const before = useAppStore.getState()
  await app.mount()
  const panel = app.panel()
  const rows = panel.querySelectorAll('.pane-tabbar .workbench-tab-strip')
  expect(rows).toHaveLength(1)
  const buttons = [...panel.querySelectorAll<HTMLButtonElement>('button[data-workbench-tab-id]')]
  expect(buttons.map(button => button.dataset.workbenchTabId)).toEqual([defaultTab.id, neighborTab.id])
  const selected = buttons.filter(button => button.classList.contains('workbench-tab--active'))
  expect(selected).toHaveLength(1)
  expect(panel.querySelector('[aria-label="Message Agent"]')).not.toBeNull()
  await moteClick(buttons.find(button => button !== selected[0])!)
  expect(panel.querySelectorAll('.workbench-tab--active')).toHaveLength(1)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().sessions.map(session => [session.id, session.control, session.processState]))
    .toEqual(before.sessions.map(session => [session.id, session.control, session.processState]))
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('does not borrow unrelated placed Tabs when original members have no placement', async () => {
  const state = useAppStore.getState()
  useAppStore.setState({ layouts: { ...state.layouts,
    [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('other-topic-group', [ordinaryTab.id]) } })
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID }))
  await app.mount()
  const panel = app.panel()
  expect(panel.querySelectorAll('.pane-tabbar .workbench-tab-strip')).toHaveLength(1)
  expect([...panel.querySelectorAll<HTMLButtonElement>('button[data-workbench-tab-id]')].map(button => button.dataset.workbenchTabId))
    .toEqual([defaultTab.id, neighborTab.id])
  expect(panel.querySelectorAll('.workbench-tab--active')).toHaveLength(1)
  expect(panel.querySelector('[aria-label="Message Agent"]')).not.toBeNull()
  const before = useAppStore.getState()
  await moteClick(panel.querySelector<HTMLButtonElement>(`button[data-workbench-tab-id="${defaultTab.id}"]`)!)
  await settleMoteApp()
  expect(panel.querySelector<HTMLButtonElement>(`button[data-workbench-tab-id="${defaultTab.id}"]`)?.classList.contains('workbench-tab--active')).toBe(true)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().sessions.map(session => [session.id, session.control, session.processState]))
    .toEqual(before.sessions.map(session => [session.id, session.control, session.processState]))
})


it('keeps both real Groups selected after choosing another Tab', async () => {
  const state = useAppStore.getState()
  const extra = { ...createWorkbenchTab('another-discussion', { kind: 'launcher', regionId: 'another-region',
    workspaceId: SCRATCH_WORKSPACE_ID }), topicId: PMO_TEAMS_TOPIC_ID }
  const first = createWorkspaceLayout('first-mote-group', [defaultTab.id, extra.id])
  const second = createWorkspaceLayout('second-mote-group', [neighborTab.id])
  useAppStore.setState({ tabs: { ...state.tabs, [extra.id]: extra }, layouts: { ...state.layouts,
    [SCRATCH_WORKSPACE_ID]: { root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: first.root, second: second.root },
      groups: [...first.groups, ...second.groups], activeGroupId: first.activeGroupId } } })
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: null, reference: null }))
  await app.mount()
  expect(app.panel().querySelectorAll('.workbench-tab--active')).toHaveLength(2)
  await moteClick(app.panel().querySelector<HTMLButtonElement>('button[data-workbench-tab-id="default-tab"]')!)
  expect([...app.panel().querySelectorAll<HTMLButtonElement>('.workbench-tab--active')].map(button => button.dataset.workbenchTabId))
    .toEqual([defaultTab.id, neighborTab.id])
  expect(app.panel().querySelectorAll('[aria-label="Message Agent"]')).toHaveLength(2)
})

it('keeps a saved unknown exact placement instead of replacing it with a default', async () => {
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID,
    targetTabId: defaultTab.id, reference: null }))
  await app.mount()
  expect(JSON.parse(localStorage.getItem(savedMoteKey)!).reference).toBeNull()
  expect(app.panel().dataset.moteTargetTab).toBe(defaultTab.id)
  expect(app.panel().textContent).toContain('Original Tab retained')
  expect(app.panel().querySelectorAll('.pane-tabbar .workbench-tab-strip')).toHaveLength(1)
})

for (const unplaced of [false, true]) it('opens the current Mote in Space from a saved empty preference, unplaced=' + unplaced, async () => {
  const state = useAppStore.getState(), execute = vi.fn(state.executeControl)
  useAppStore.setState({ executeControl: execute, ...(unplaced ? { layouts: { ...state.layouts,
    [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('other-topic-group', [ordinaryTab.id]) } } : {}) })
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: null, reference: null }))
  await app.mount()
  await moteClick(app.panel().querySelector<HTMLButtonElement>('[aria-label="Open in Space"]')!)
  expect(execute).toHaveBeenCalledOnce()
  const request = execute.mock.calls[0]![0]
  expect(request.operation).toBe('focus')
  if (request.operation !== 'focus') throw new Error('Expected original Space navigation')
  expect(request.target).toMatchObject({ kind: 'space' })
  if (unplaced) {
    expect(request.target).toHaveProperty('zoneId')
    expect(request.target).not.toHaveProperty('groupId')
  } else expect(request.target).toHaveProperty('tabId')
})

it('creates a new discussion from an unplaced Zone in a real original Group', async () => {
  const state = useAppStore.getState()
  useAppStore.setState({ layouts: { ...state.layouts,
    [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('original-resource-group', [ordinaryTab.id]) } })
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID }))
  await app.mount()
  await moteClick(app.panel().querySelector<HTMLButtonElement>('[aria-label="New discussion"]')!)
  const current = useAppStore.getState(), created = Object.values(current.tabs).filter(tab => !state.tabs[tab.id])
  expect(created).toHaveLength(1)
  expect(created[0]!.topicId).toBe(PMO_TEAMS_TOPIC_ID)
  expect(current.layouts[SCRATCH_WORKSPACE_ID]!.groups.find(group => group.id === 'original-resource-group')?.tabOrder).toContain(created[0]!.id)
  expect(app.panel().querySelector('[data-workbench-tab-id="' + created[0]!.id + '"].workbench-tab--active')).not.toBeNull()
  expect(app.launch).not.toHaveBeenCalled()
})


it('keeps an unplaced Space failure and its Retry visible in the original Mote', async () => {
  const state = useAppStore.getState()
  useAppStore.setState({ executeControl: vi.fn().mockRejectedValue(new Error('Original Space request failed')),
    layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('other-topic-group', [ordinaryTab.id]) } })
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID }))
  await app.mount()
  await moteClick(app.panel().querySelector<HTMLButtonElement>('[aria-label="Open in Space"]')!)
  expect(app.panel().textContent).toContain('Space 打开待重试')
  const failures = Object.values(useAppStore.getState().moteContextOperations).filter(operation => operation.action === 'open-space' && operation.failure)
  expect(failures).toHaveLength(1)
  expect(failures[0]!.target.reference).toBeNull()
  await moteClick(app.panel().querySelector<HTMLButtonElement>('.mote-context-status button')!)
  expect(document.querySelector('[data-mote-context-retry="open-space"]')).not.toBeNull()
  expect(document.body.textContent).toContain('Original Space request failed')
  expect(app.panel().querySelector('[aria-label="Message Agent"]')).not.toBeNull()
})


for (const unrelatedCount of [0, 128]) it('keeps placed selection callback local during global directory observation failure with unrelated members=' + unrelatedCount, async () => {
  const state = useAppStore.getState()
  const unrelated = Object.fromEntries(Array.from({ length: unrelatedCount }, (_, index) => {
    const tab = createWorkbenchTab('unrelated-' + index, { kind: 'launcher', workspaceId: 'project', regionId: 'unrelated-region-' + index })
    return [tab.id, tab]
  }))
  useAppStore.setState({ tabs: { ...state.tabs, ...unrelated } })
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: null, reference: null }))
  await app.mount()
  const original = useAppStore.getState()
  const selected = app.panel().dataset.moteTargetTab
  const tabId = selected === defaultTab.id ? neighborTab.id : defaultTab.id
  const button = app.panel().querySelector<HTMLButtonElement>('button[data-workbench-tab-id="' + tabId + '"]')!
  await motePointer(button, 'down')
  const buildCatalog = spaceAgentControl.spatialCatalog
  let selecting = false
  const executionReads: { tabs: string[]; sessions: number }[] = []
  const directory = vi.spyOn(spaceAgentControl, 'spatialCatalog').mockImplementation((facts, topics) => {
    if (selecting) {
      executionReads.push({ tabs: Object.keys(facts.tabs), sessions: facts.sessions.length })
      if (Object.keys(facts.tabs).length > 1) throw new Error('Global directory observation is unavailable')
    }
    return buildCatalog(facts, topics)
  })
  await act(async () => {
    selecting = true
    try { button.click() } finally { selecting = false }
  })
  await settleMoteApp()
  expect(app.panel().dataset.moteTargetTab).toBe(tabId)
  expect(app.panel().querySelector('button[data-workbench-tab-id="' + tabId + '"].workbench-tab--active')).not.toBeNull()
  expect(app.panel().querySelector('[aria-label="Message Agent"]')).not.toBeNull()
  // Scope the cost contract to the synchronous selection callback. Subsequent
  // rendering owns separate catalogs; selection retains its local identity check.
  expect(directory).toHaveBeenCalled()
  expect(executionReads).toEqual([{ tabs: [tabId], sessions: 1 }])
  expect(useAppStore.getState().tabs).toBe(original.tabs)
  expect(useAppStore.getState().layouts).toBe(original.layouts)
  expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})
