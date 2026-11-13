// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, neighborAgent, neighborTab, moteAgent, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { requestPmoTeamsTopicFloatingOpen, readPmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'

let app: MoteAppFixture
const topic = moteTopics[0]!
const research = moteAgent('research-agent', topic.id)
const researchTab = { ...createWorkbenchTab('research-tab', { kind: 'agent', phase: 'attached', workspaceId: scratchWorkspace.id,
  regionId: 'research-region', sessionId: research.id }, 'Research the details'), topicId: topic.id }
const main = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id,
  groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
const dialogue = (target: MoteDialoguePage['main']['target']): MoteDialoguePage => ({ main: { target,
  identity: { hostId: 'local', moteId: topic.id }, status: 'ready', resource: null, documentRevision: 'file-1', roleRevision: 'role-1', current: main, issue: null },
  links: [], incarnation: 'links-1', throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null })
beforeEach(() => {
  app = createMoteApp()
  useAppStore.setState(state => ({ sessions: [...state.sessions, research], tabs: { ...state.tabs, [researchTab.id]: researchTab },
    layouts: { ...state.layouts, [scratchWorkspace.id]: { ...state.layouts[scratchWorkspace.id]!, groups: state.layouts[scratchWorkspace.id]!.groups.map(group => ({ ...group, tabOrder: [...group.tabOrder, researchTab.id] })) } },
    agentComposerDrafts: { ...state.agentComposerDrafts, [neighborAgent.id]: 'Neighbor unsent', [research.id]: 'Research unsent' } }))
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.schedule, 'list').mockResolvedValue({ schedules: [], executionScope: 'connected-host' })
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(async ({ target }) => dialogue(target))
})
afterEach(async () => { await app.dispose() })
const space = () => app.container.querySelector<HTMLElement>('.mote-space-frame__header')!
const chooser = () => document.querySelector<HTMLElement>('.mote-cooperation__popover')!
async function openPicker(header = space()) {
  const button = header.querySelector<HTMLButtonElement>('[data-mote-conversation-switcher] .mote-cooperation__team')!
  expect(button).not.toBeNull(); await moteClick(button); expect(chooser()).not.toBeNull(); return chooser()
}
async function choose(id: string, header = space()) {
  const panel = await openPicker(header), row = panel.querySelector<HTMLElement>(`[data-mote-member="${id}"]`)!
  expect(row).not.toBeNull(); await moteClick(row.querySelector<HTMLButtonElement>('button')!)
}
function execution() {
  const state = useAppStore.getState()
  return { runs: state.sessions.map(item => [item.id, item.control]), drafts: state.agentComposerDrafts, queues: state.agentSteerQueues, tabs: Object.keys(state.tabs) }
}
function quiet(before: ReturnType<typeof execution>) {
  expect(execution()).toEqual(before)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.enqueue).not.toHaveBeenCalled()
}
function current(id: string) {
  expect(useAppStore.getState().workbenchSpaceSelection?.tabId).toBe(id)
  expect(app.container.querySelector('.workbench-context-frame')?.getAttribute('data-mote-section')).toBe(id === defaultTab.id ? 'discussion' : 'threads')
  expect(app.container.querySelector('.workbench-context-frame .mote-workface__original')?.hasAttribute('hidden')).toBe(false)
}

it('switches directly between original members and returns to the logical Main in the real App, retaining original Composer nodes and drafts', async () => {
  await app.mount()
  const before = execution(), original = app.container.querySelector<HTMLElement>('[data-activity-session="default-agent"]')!
  const composer = app.container.querySelector<HTMLElement>('.workbench-context-frame [aria-label="Message Agent"]')!
  expect(original).not.toBeNull(); expect(composer).not.toBeNull()
  await choose(neighborAgent.id); current(neighborTab.id)
  expect(space().querySelector('.mote-cooperation__team')?.textContent).toContain('Other goal')
  await choose(research.id); current(researchTab.id)
  const panel = await openPicker()
  expect(panel.querySelector(`[data-mote-member="${research.id}"] [aria-current="page"]`)).not.toBeNull()
  await moteClick(panel.querySelector<HTMLButtonElement>('[data-mote-main-entry]')!)
  current(defaultTab.id)
  expect(app.container.querySelector('[data-activity-session="default-agent"]')).toBe(original)
  expect(app.container.querySelector('.workbench-context-frame [aria-label="Message Agent"]')).toBe(composer)
  quiet(before)
})

it('uses the same direct switcher inside the floating workface and keeps its Main/member intent separate from the background', async () => {
  await app.mount()
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: topic.id, targetTabId: defaultTab.id }))
  await settleMoteApp()
  const header = app.panel().querySelector<HTMLElement>('.mote-workface__navigation')!, before = execution()
  expect(header.querySelector('[data-mote-conversation-identity]')).not.toBeNull()
  await choose(neighborAgent.id, header)
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ targetTabId: neighborTab.id, conversationIntent: 'member' })
  await choose(research.id, header)
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ targetTabId: researchTab.id, conversationIntent: 'member' })
  await moteClick(header.querySelector<HTMLButtonElement>('[data-mote-main-entry]')!)
  await vi.waitFor(() => expect(readPmoTeamsTopicFloatingState()).toMatchObject({ targetTabId: defaultTab.id, conversationIntent: 'main' }))
  expect(app.panel().querySelector('.mote-workface__thread-navigation')).toBeNull()
  quiet(before)
})

it('filters only this Mote and keeps Main reachable when a query matches nothing, with no invented empty source', async () => {
  await app.mount(); const panel = await openPicker(), before = execution()
  expect(panel.querySelector('[data-mote-member="custom-agent"]')).toBeNull()
  const input = panel.querySelector<HTMLInputElement>('[aria-label="查找对话"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'no such conversation')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(chooser().textContent).toContain('没有匹配的对话')
  expect(chooser().querySelector('[data-mote-main-entry]')).not.toBeNull()
  expect(chooser().textContent).not.toContain('还没有 Agent')
  quiet(before)
})

it('closes the active picker when its original workface becomes hidden without changing any execution or draft', async () => {
  await app.mount(); await openPicker(); const before = execution()
  await act(async () => useAppStore.getState().setMainSurface('board'))
  await vi.waitFor(() => expect(document.querySelector('.mote-cooperation__popover')).toBeNull())
  quiet(before)
})

it('only the visible workface contributes navigation when another retained Workspace carries the same Mote', async () => {
  const projectTab = { ...neighborTab, id: 'project-original-tab', regions: Object.fromEntries(
    Object.entries(neighborTab.regions).map(([id, region]) => [id, { ...region, workspaceId: 'project' }])) }
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [projectTab.id]: projectTab },
    layouts: { ...state.layouts, project: createWorkspaceLayout('project-group', [projectTab.id]) } }))
  await app.mount()
  const before = execution(), retained = app.container.querySelector('[data-workspace-id="project"] [data-mote-workface]')
  expect(retained).not.toBeNull()
  expect(retained!.getAttribute('data-mote-workface')).toBe(topic.id)
  expect(space().querySelectorAll('[data-mote-conversation-switcher]')).toHaveLength(1)
  await openPicker()
  expect(document.querySelectorAll('.mote-cooperation__popover')).toHaveLength(1)
  expect(chooser().querySelector(`[data-mote-member="${neighborAgent.id}"]`)).not.toBeNull()
  quiet(before)
})

it('keeps known member conversations available when the Main role read fails', async () => {
  vi.mocked(api.moteDialogue.read).mockRejectedValue(new Error('Original Main read unavailable'))
  await app.mount(); const before = execution(), panel = await openPicker()
  expect(panel.querySelector('[data-mote-main-entry]')).not.toBeNull()
  expect(panel.textContent).toContain('主对话来源待核对')
  await moteClick(panel.querySelector<HTMLButtonElement>(`[data-mote-member="${neighborAgent.id}"] button`)!)
  current(neighborTab.id); quiet(before)
})

it('shows every exact placement and waits for the person to choose, without guessing the first', async () => {
  useAppStore.setState(state => {
    const original = state.layouts[scratchWorkspace.id]!, second = createWorkspaceLayout('second-original-group', [researchTab.id])
    return { layouts: { ...state.layouts, [scratchWorkspace.id]: { ...original,
      root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: original.root, second: second.root }, groups: [...original.groups, ...second.groups] } } }
  })
  await app.mount(); const before = execution(), panel = await openPicker()
  const positions = panel.querySelectorAll<HTMLButtonElement>(`[data-mote-member="${research.id}"] .mote-cooperation__locations button`)
  expect(positions).toHaveLength(2)
  expect(useAppStore.getState().workbenchSpaceSelection?.tabId).toBe(defaultTab.id)
  await moteClick(positions[1]!)
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ tabId: researchTab.id, groupId: 'second-original-group' })
  quiet(before)
})

it('Escape closes only the switcher and returns keyboard focus to its original trigger', async () => {
  await app.mount(); const trigger = space().querySelector<HTMLButtonElement>('.mote-cooperation__team')!
  const before = execution(); await openPicker()
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await vi.waitFor(() => expect(chooser()).toBeNull())
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
  quiet(before)
})
