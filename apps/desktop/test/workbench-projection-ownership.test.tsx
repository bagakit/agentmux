// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { PmoTeamsTopicEntry } from '../src/renderer/src/components/PmoTeamsTopicEntry'
import { PmoTeamsTopicFloatingPanel } from '../src/renderer/src/components/PmoTeamsTopicFloatingPanel'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'

const baseline = useAppStore.getState()
const first = { ...createWorkbenchTab('first-tab', { kind: 'launcher', regionId: 'first-region', workspaceId: SCRATCH_WORKSPACE_ID }, 'First context'), topicId: PMO_TEAMS_TOPIC_ID }
const second = { ...createWorkbenchTab('second-tab', { kind: 'launcher', regionId: 'second-region', workspaceId: SCRATCH_WORKSPACE_ID }, 'Second context'), topicId: PMO_TEAMS_TOPIC_ID }
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear()
  useAppStore.setState({ tabs: { [first.id]: first, [second.id]: second }, sessions: [], agentNames: {}, timelines: {},
    config: null, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('group', [first.id, second.id]) },
    mainSurface: 'board', projectRailOpen: false, toolsOpen: false })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); window.localStorage.clear()
  vi.restoreAllMocks(); useAppStore.setState(baseline, true)
})

it.each(['board', 'agents'] as const)('lets only the window workbench own global chrome above %s', async (mainSurface) => {
  useAppStore.setState({ mainSurface })
  await act(async () => root.render(createElement(Fragment, null,
    createElement('div', { 'data-owner': true }, createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID, visible: false })),
    createElement('div', { 'data-projection': true }, createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID,
      topicId: PMO_TEAMS_TOPIC_ID, viewOwnership: 'projection', projectionTabId: first.id, viewHostPrefix: 'projection-slot' }))
  )))
  const owner = container.querySelector('[data-owner]')!, projection = container.querySelector('[data-projection]')!
  expect(owner.querySelector('.top-row-leading-chrome')).not.toBeNull()
  expect(owner.querySelector('.breadcrumbs')?.textContent).toContain(mainSurface === 'board' ? 'Goals' : 'Focus')
  expect(projection.querySelector('.top-row-leading-chrome')).toBeNull()
  expect(projection.querySelector('.breadcrumbs')).toBeNull()
  expect(projection.querySelectorAll('.workbench-tab')).toHaveLength(2)
  expect(projection.querySelector('.pane-tabbar__actions')).not.toBeNull()
  expect(projection.querySelector('[title="New tab"]')).not.toBeNull()
})

it('retains only the missing projection target slot while other Tabs are available', async () => {
  await act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID,
    topicId: PMO_TEAMS_TOPIC_ID, viewOwnership: 'projection', projectionTabId: 'restoring-tab', viewHostPrefix: 'projection-slot' })))
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Original Tab retained')
  expect(container.querySelector('#projection-slot\\:restoring-tab')).not.toBeNull()
  expect(container.querySelectorAll('.workbench-tab')).toHaveLength(0)
  expect(container.textContent).not.toContain('First context')
  expect(useAppStore.getState().tabs).toEqual({ [first.id]: first, [second.id]: second })
})

it('reports actual Tab clicks and native focus in retained content through the visible projection', async () => {
  const selected = vi.fn()
  await act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID,
    topicId: PMO_TEAMS_TOPIC_ID, viewOwnership: 'projection', projectionTabId: first.id, viewHostPrefix: 'projection-slot', onTabSelect: selected })))
  const button = container.querySelector<HTMLButtonElement>(`button[data-workbench-tab-id="${second.id}"]`)!
  expect(button).not.toBeNull()
  await act(async () => button.click())
  expect(selected).toHaveBeenCalledWith(second.id)
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.activeTabId).toBe(second.id)
  selected.mockClear()
  // The retained portal's DOM enters this host even though its React owner is
  // elsewhere. Native focus must therefore identify the visible slot's exact Tab.
  const slot = container.querySelector<HTMLElement>(`[id="projection-slot:${first.id}"]`)!
  expect(slot).not.toBeNull()
  const input = document.createElement('input'); slot.append(input)
  await act(async () => input.focus())
  expect(selected).toHaveBeenCalledWith(first.id)
})

it.each([
  { missing: false, choice: 'select', outcome: 'success' },
  { missing: false, choice: 'select', outcome: 'failure' },
  { missing: true, choice: 'select', outcome: 'success' },
  { missing: true, choice: 'select', outcome: 'failure' },
  { missing: true, choice: 'keep', outcome: 'success' },
  { missing: true, choice: 'keep', outcome: 'failure' },
  { missing: false, choice: 'close-reopen', outcome: 'success' },
  { missing: false, choice: 'close-reopen', outcome: 'failure' },
  { missing: true, choice: 'navigate', outcome: 'success' }
] as const)('owns full Space continuation with missing=$missing, choice=$choice, outcome=$outcome', async ({ missing, choice, outcome }) => {
  const report = vi.fn()
  useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: {},
    workspaces: [{ id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: '/topics', name: 'Topics', kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } },
    agentComposerDrafts: { original: 'Original input' }, prewarmTerminal: vi.fn(), reportError: report,
    ...(missing ? { tabs: { [second.id]: second }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('group', [second.id]) } } : {}) })
  const topic = { id: PMO_TEAMS_TOPIC_ID, directoryPath: '/topics/topic--launcher--leader', topicPath: '/topics/topic--launcher--leader/topic.md',
    title: 'Mote', summary: '', collaborators: [] }
  vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue(topic)
  const read = vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic)
  const launch = vi.spyOn(api.sessions, 'launchTerminal')
  const key = 'agentmux.leader-topic-floating.v1'
  window.localStorage.setItem(key, JSON.stringify({ open: false, targetTabId: first.id }))
  function Floating() {
    const [floating, setFloating] = usePmoTeamsTopicFloatingState()
    return createElement(PmoTeamsTopicFloatingPanel, { floating, setFloating })
  }
  await act(async () => root.render(createElement(Fragment, null, createElement(PmoTeamsTopicEntry), createElement(Floating))))
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open Mote"]')!.click())
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
  let finish!: (value: typeof topic) => void
  let fail!: (error: Error) => void
  read.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
  report.mockClear()
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open Mote Space"]')!.click())
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.activeTabId).toBe(missing ? second.id : first.id)
  if (missing) await act(async () => useAppStore.setState({ tabs: { [first.id]: first, [second.id]: second },
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('group', [second.id, first.id]) } }))
  if (choice === 'select') {
    const other = container.querySelector<HTMLButtonElement>(`button[data-workbench-tab-id="${second.id}"]`)!
    expect(other).not.toBeNull()
    await act(async () => other.click())
    expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.activeTabId).toBe(second.id)
    expect(JSON.parse(window.localStorage.getItem(key)!).targetTabId).toBe(second.id)
  } else if (choice === 'close-reopen') {
    await act(async () => container.querySelector<HTMLButtonElement>('[data-pmo-teams-topic-launcher] button')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[data-pmo-teams-topic-launcher] button')!.click())
  } else if (choice === 'navigate') {
    await act(async () => useAppStore.getState().setMainSurface('board'))
  }
  const error = new Error('Metadata completion failed')
  await act(async () => { if (outcome === 'success') finish(topic); else fail(error) })
  const completed = choice === 'keep' && outcome === 'success'
  const selectedTab = choice === 'select' || (missing && !completed) ? second.id : first.id
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.activeTabId).toBe(selectedTab)
  const floating = JSON.parse(window.localStorage.getItem(key)!)
  expect(floating.open).toBe(!completed)
  expect(floating.targetTabId).toBe(choice === 'select' ? second.id : first.id)
  expect(container.querySelector<HTMLElement>('[role="dialog"]')!.dataset.moteTargetTab).toBe(floating.targetTabId)
  expect(useAppStore.getState().mainSurface).toBe(choice === 'navigate' ? 'board' : 'workbench')
  if (choice === 'keep' && outcome === 'failure') {
    expect(report).toHaveBeenCalledExactlyOnceWith(error)
    expect(container.textContent).toContain('Opening this context in Space did not complete')
  } else {
    expect(report).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Opening this context in Space did not complete')
  }
  expect(useAppStore.getState().agentComposerDrafts).toEqual({ original: 'Original input' })
  expect(useAppStore.getState().tabs).toEqual({ [first.id]: first, [second.id]: second })
  expect(useAppStore.getState().sessions).toEqual([])
  expect(launch).not.toHaveBeenCalled()
})
