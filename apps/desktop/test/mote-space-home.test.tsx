// @vitest-environment happy-dom
import { act } from 'react'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { ContinuousProgressLoop, FileReadParams, FileReadResult } from '@agentmux/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, moteType, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, neighborTab, customTab, customAgent, customMoteId, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { beginMoteStartupRecovery } from '../src/renderer/src/lib/mote-session-recovery'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'

let app: MoteAppFixture
const rootPath = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)
const revision = 'sha256:' + 'b'.repeat(64)
const node = <T extends HTMLElement>(selector: string): T => {
  const found = app.container.querySelector<T>(selector)
  expect(found, selector).not.toBeNull(); return found!
}
const button = (label: string) => {
  const found = [...app.container.querySelectorAll<HTMLButtonElement>('[data-mote-details] button')]
    .find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
  expect(found, label).toBeDefined(); return found!
}
function material(params: FileReadParams): FileReadResult {
  return { resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: scratchWorkspace.path + '/' + rootPath, path: rootPath + '/' + params.path },
    result: { status: 'read', document: { path: rootPath + '/' + params.path, revision,
      content: params.path === 'MEMORY.md' ? '# Our working notes\nGive me a concrete next step.' : '# Saved original source\nKeep the source and its decisions.' } } }
}
async function type(selector: string, value: string) {
  const input = node<HTMLTextAreaElement>(selector)
  await act(async () => {
    input.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }); await settleMoteApp()
}
beforeEach(() => {
  app = createMoteApp()
  useLauncherState.setState({ drafts: {}, persistenceIssue: null })
  useAppStore.setState({ toolsOpen: true, explorerCollapsed: { [SCRATCH_WORKSPACE_ID]: false } })
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([{ path: rootPath + '/experiment.md', name: 'experiment.md', isDirectory: false, isSymlink: false, ignored: false, mtimeMs: 2 }])
  vi.spyOn(api.files, 'readPublic').mockImplementation(async params => material(params))
  vi.spyOn(api.files, 'observe').mockResolvedValue()
  vi.spyOn(api.files, 'unobserve').mockResolvedValue()
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'goals').mockResolvedValue([])
  vi.spyOn(api.schedule, 'list').mockResolvedValue({ schedules: [], executionScope: 'connected-host' })
  vi.spyOn(api.schedule, 'onChanged').mockImplementation(() => () => {})
})
afterEach(async () => { await app.dispose() })

it('makes original memory a first-class home entry while keeping its exact source lazy and editable', async () => {
  await app.mount()
  const memory = node<HTMLDetailsElement>('[data-mote-memory]')
  expect(memory.closest('.mote-profile__preferences')).toBeNull()
  expect(memory.open).toBe(false)
  expect(vi.mocked(api.files.readPublic).mock.calls.filter(([params]) => params.path === 'MEMORY.md')).toEqual([])
  const before = useAppStore.getState()
  await act(async () => { memory.open = true; memory.dispatchEvent(new Event('toggle')) }); await settleMoteApp()
  const reads = vi.mocked(api.files.readPublic).mock.calls.filter(([params]) => params.path === 'MEMORY.md')
  expect(reads).toHaveLength(1)
  expect(reads[0]![0]).toMatchObject({ path: 'MEMORY.md', expectedResource: { hostId: scratchWorkspace.hostId, workspaceId: SCRATCH_WORKSPACE_ID, workspacePath: scratchWorkspace.path } })
  expect(memory.textContent).toContain('Give me a concrete next step.')
  expect(memory.querySelector('[data-memory-revision]')?.textContent).toBe(revision)
  expect(memory.querySelector('[aria-label="Correct or remove a memory detail in editor"]')).not.toBeNull()
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('returns to each original home and Ideas reading position with its unsent inputs intact', async () => {
  await app.mount()
  const profile = node<HTMLElement>('[aria-label="Mote profile"]')
  await type('[aria-label="A question for this Mote"]', 'Keep our question beside the original work.')
  await act(async () => { profile.scrollTop = 144; profile.dispatchEvent(new Event('scroll')) })
  await moteClick(button('Ideas'))
  const ideas = node<HTMLElement>('[aria-label="Mote ideas"]')
  expect(ideas.scrollTop).toBe(0)
  await moteClick(node('.mote-details__ideas .mote-details__note'))
  await type('[aria-label="Idea direction"]', 'Compare one exact source.')
  await type('[aria-label="Idea feedback comment"]', 'Retain the unsent source feedback.')
  await act(async () => { ideas.scrollTop = 312; ideas.dispatchEvent(new Event('scroll')) })
  await moteClick(button('Profile'))
  expect(node<HTMLElement>('[aria-label="Mote profile"]').scrollTop).toBe(144)
  expect(node<HTMLTextAreaElement>('[aria-label="A question for this Mote"]').value).toBe('Keep our question beside the original work.')
  await moteClick(button('Calendar')); await moteClick(button('Ideas'))
  expect(node<HTMLElement>('[aria-label="Mote ideas"]').scrollTop).toBe(312)
  expect(node<HTMLTextAreaElement>('[aria-label="Idea direction"]').value).toBe('Compare one exact source.')
  expect(node<HTMLTextAreaElement>('[aria-label="Idea feedback comment"]').value).toBe('Retain the unsent source feedback.')
  expect(node('.mote-details__preview').textContent).toContain('Keep the source and its decisions.')
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

const homeExpanded = () => app.container.querySelector('[data-surface-tool-dock][data-content-expanded="true"]')
const originalComposer = () => node<HTMLElement>('.workspace-workbench-slot[data-workspace-id="' + SCRATCH_WORKSPACE_ID + '"] .workbench-tab-slot[data-workbench-tab-id="' + defaultTab.id + '"] [aria-label="Message Agent"]')
async function openHome() {
  await moteClick(node<HTMLButtonElement>('[data-space-nav="topic:' + PMO_TEAMS_TOPIC_ID + '"]'))
  expect(homeExpanded()).not.toBeNull()
}

it('opens the companion home from the actual directory and returns to the same original discussion and Composer', async () => {
  useAppStore.setState({ projectRailOpen: true })
  await app.mount()
  const input = originalComposer()
  await moteType(input, 'Keep this exact original conversation draft.')
  const before = useAppStore.getState()
  await openHome()
  const workface = input.closest<HTMLElement>('.workspace-main-surface')!
  expect(workface).not.toBeNull()
  expect(workface.hasAttribute('inert')).toBe(true)
  expect(workface.getAttribute('aria-hidden')).toBe('true')
  expect(originalComposer()).toBe(input)
  const covered = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'companion-covered-observation', operation: 'inspect.client' })
  expect(covered.operation).toBe('inspect.client')
  if (covered.operation !== 'inspect.client') throw new Error('Wrong original observation')
  expect(covered.observation.desktop.presentation).toMatchObject({ state: 'covered', blockers: [] })
  await moteClick(button('Continue discussion'))
  expect(homeExpanded()).toBeNull()
  const revealed = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'companion-revealed-observation', operation: 'inspect.client' })
  expect(revealed.operation).toBe('inspect.client')
  if (revealed.operation !== 'inspect.client') throw new Error('Wrong original observation')
  expect(revealed.observation.desktop.presentation.state).not.toBe('covered')
  expect(workface.hasAttribute('inert')).toBe(false)
  expect(originalComposer()).toBe(input)
  expect(input.textContent).toContain('Keep this exact original conversation draft.')
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ tabId: defaultTab.id, regionId: 'default-region' })
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('lets an explicit public focus of the same original address reveal the existing workface', async () => {
  useAppStore.setState({ projectRailOpen: true })
  await app.mount(); const input = originalComposer()
  await openHome()
  const choice = useAppStore.getState().workbenchSpaceSelection!
  expect(choice.tabId).toBe(defaultTab.id)
  let result: unknown
  await act(async () => { result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'companion-same-original-focus', operation: 'focus',
    target: { kind: 'space', spaceId: choice.spaceId, zoneId: choice.zoneId, tabId: choice.tabId!, regionId: choice.regionId!, displayWorkspaceId: choice.workspaceId, groupId: choice.groupId! }, inputPolicy: 'preserve' }) })
  await settleMoteApp()
  expect(result).toBeDefined()
  expect(homeExpanded()).toBeNull()
  expect(originalComposer()).toBe(input)
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('prepares a home question in one original Launcher and reveals it without submitting or replacing existing work', async () => {
  useAppStore.setState({ projectRailOpen: true })
  await app.mount(); await openHome()
  await type('[aria-label="A question for this Mote"]', 'Prepare our next decision with the original source.')
  const before = useAppStore.getState()
  await moteClick(button('Prepare this question in a new discussion'))
  const current = useAppStore.getState(), created = Object.values(current.tabs).filter(tab => !before.tabs[tab.id])
  expect(created).toHaveLength(1)
  const launcher = created[0]!
  expect(launcher.topicId).toBe(PMO_TEAMS_TOPIC_ID)
  expect(Object.values(launcher.regions).map(region => region.kind)).toEqual(['launcher'])
  expect(current.agentComposerDrafts[launcher.layout.activeRegionId]).toBe('Prepare our next decision with the original source.')
  expect(current.agentComposerNotes[launcher.layout.activeRegionId]).toContain(revision)
  expect(homeExpanded()).toBeNull()
  expect(current.sessions).toBe(before.sessions)
  expect(current.tabs[defaultTab.id]).toBe(before.tabs[defaultTab.id])
  expect(current.agentComposerDrafts[defaultAgent.id]).toBe(before.agentComposerDrafts[defaultAgent.id])
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('reveals retained unplaced original members without inventing a selected Agent or physical Group', async () => {
  useAppStore.setState({ projectRailOpen: true, activeWorkspaceId: 'project', workbenchSpaceSelection: null,
    retainedSpatialFocus: null, spaceZoneBindings: {}, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [customTab.id]), project: createWorkspaceLayout('project-group') } })
  const before = useAppStore.getState()
  await app.mount(); await openHome()
  expect(app.container.querySelector('[data-mote-details] [aria-label="Continue discussion"]')).toBeNull()
  await moteClick(button('Open workface'))
  expect(homeExpanded()).toBeNull()
  const main = node<HTMLElement>('.workspace-workbench-slot[data-workspace-id="' + SCRATCH_WORKSPACE_ID + '"]')
  expect(main.querySelector('button[data-workbench-tab-id="' + defaultTab.id + '"]')).not.toBeNull()
  expect(main.querySelector('button[data-workbench-tab-id="' + neighborTab.id + '"]')).not.toBeNull()
  expect(main.textContent).not.toContain('This original entity has no confirmed display occurrence here')
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

function confirmOriginalHome() {
  const topics = moteTopics.map(topic => topic.id === PMO_TEAMS_TOPIC_ID ? { ...topic, physicalDirectoryPath: topic.directoryPath, confirmedDirectoryPaths: [topic.directoryPath] } : topic)
  vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
  useAppStore.setState(state => ({ scratchTopicSnapshots: { ...state.scratchTopicSnapshots,
    [SCRATCH_WORKSPACE_ID]: { ...state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!, topics } } }))
}
const arrangement = (id: string, offset: number, status: ContinuousProgressLoop['status'] = 'active'): ContinuousProgressLoop => ({
  hostId: defaultAgent.hostId, providerId: defaultAgent.providerId, agentSessionId: defaultAgent.control.agentSessionId,
  workspacePath: defaultAgent.workspacePath, loopId: id, status, revision: 1, creationOperationId: 'saved-' + id,
  futureIntentId: 'intent-' + id, afterMs: 60000, intervalMs: 1000, nextCheckAt: Date.now() + offset,
  prompt: 'Original arrangement ' + id
})

it('shows a bounded reading of original arrangements and opens the selected row in the existing Calendar', async () => {
  confirmOriginalHome()
  const saved = [arrangement('later', 40000), arrangement('ended', 1, 'stopped'), arrangement('next', 20000), arrangement('first', 10000), arrangement('third', 30000)]
  vi.mocked(api.schedule.list).mockImplementation(async params => ({ schedules: params.scope ? saved : saved.filter(record => record.agentSessionId === params.target?.agentSessionId), executionScope: 'connected-host' }))
  const listeners = new Set<(value: ContinuousProgressLoop) => void>()
  vi.mocked(api.schedule.onChanged).mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
  await app.mount()
  expect(vi.mocked(api.schedule.list).mock.calls.filter(([params]) => params.scope).map(([params]) => params)).toEqual([{ scope: { hostId: defaultAgent.hostId, workspacePath: defaultAgent.workspacePath } }])
  const upcoming = node('[aria-label="Next arrangements"]')
  expect([...upcoming.querySelectorAll('[data-upcoming-id]')].map(row => row.getAttribute('data-upcoming-id'))).toEqual(['first', 'next', 'third'])
  const visibleConsumers = listeners.size
  expect(visibleConsumers).toBeGreaterThan(0)
  const drafts = useAppStore.getState().agentComposerDrafts
  await moteClick(button('Ideas'))
  expect(listeners.size).toBe(visibleConsumers - 1)
  const reads = vi.mocked(api.schedule.list).mock.calls.filter(([params]) => params.scope).length
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, updatedAt: session.updatedAt + 1 })) })))
  await settleMoteApp(); expect(vi.mocked(api.schedule.list).mock.calls.filter(([params]) => params.scope)).toHaveLength(reads)
  await moteClick(button('Profile'))
  expect(listeners.size).toBe(visibleConsumers)
  await moteClick(node('[data-upcoming-id="next"]'))
  expect(button('Calendar').getAttribute('aria-selected')).toBe('true')
  await vi.waitFor(() => expect(node<HTMLDetailsElement>('.mote-calendar [data-schedule-id="next"] details').open).toBe(true))
  await moteClick(button('Profile'))
  await moteClick(node('[data-upcoming-id="third"]'))
  expect(node<HTMLDetailsElement>('.mote-calendar [data-schedule-id="third"] details').open).toBe(true)
  expect(document.activeElement).toBe(node('.mote-calendar [data-schedule-id="third"] summary'))
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('keeps confirmed upcoming rows and independent work available when the original read fails, then recovers on the same scope', async () => {
  confirmOriginalHome()
  vi.mocked(api.schedule.list).mockResolvedValue({ schedules: [arrangement('retained', 10000)], executionScope: 'connected-host' })
  await app.mount()
  const original = node('[data-upcoming-id="retained"]')
  await moteClick(button('Ideas'))
  vi.mocked(api.schedule.list).mockRejectedValueOnce(new Error('Original arrangement observation unavailable.'))
  await moteClick(button('Profile'))
  expect(node('[aria-label="Next arrangements"]').textContent).toContain('Original arrangement observation unavailable.')
  expect(node('[data-upcoming-id="retained"]')).toBe(original)
  const question = node<HTMLTextAreaElement>('[aria-label="A question for this Mote"]')
  expect(question.disabled).toBe(false)
  await type('[aria-label="A question for this Mote"]', 'Work continues while arrangements recover.')
  await moteClick(button('Retry arrangements'))
  expect(node('[aria-label="Next arrangements"]').textContent).not.toContain('Original arrangement observation unavailable.')
  expect(node('[data-upcoming-id="retained"]')).toBe(original)
  expect(question.value).toBe('Work continues while arrangements recover.')
  expect(vi.mocked(api.schedule.list).mock.calls.filter(([params]) => params.scope).map(([params]) => params)).toEqual(Array.from({ length: 3 }, () => ({ scope: { hostId: defaultAgent.hostId, workspacePath: defaultAgent.workspacePath } })))
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('keeps the original on-open recovery eligible while its companion home covers the retained conversation', async () => {
  const cleanup = beginMoteStartupRecovery()
  try {
    const reference = { hostId: customAgent.hostId, sessionId: customAgent.id, displayWorkspaceId: SCRATCH_WORKSPACE_ID,
      groupId: 'mote-group', tabId: customTab.id, regionId: 'custom-region' }
    const topics = moteTopics.map(topic => topic.id === customMoteId ? { ...topic,
      quickMode: { status: 'saved' as const, version: 'confirmed-original', defaults: { conversation: reference, recovery: 'on-open' as const } } } : topic)
    vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
    vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
    useAppStore.setState(state => ({ projectRailOpen: true, sessions: state.sessions.map(session => session.id === customAgent.id ? { ...customAgent, processState: 'exited' as const } : session),
      scratchTopicSnapshots: { ...state.scratchTopicSnapshots, [SCRATCH_WORKSPACE_ID]: { ...state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!, topics } } }))
    const recover = vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'reattachable', session: customAgent })
    const before = useAppStore.getState()
    await app.mount()
    expect(recover).not.toHaveBeenCalled()
    await moteClick(node<HTMLButtonElement>('[data-space-nav="topic:' + customMoteId + '"]'))
    expect(homeExpanded()).not.toBeNull()
    expect(recover).toHaveBeenCalledExactlyOnceWith(customAgent.control, customAgent.workspacePath, expect.any(String), { trigger: 'mote-open', timingOverride: 'on-open' })
    await moteClick(button('Continue discussion'))
    expect(homeExpanded()).toBeNull()
    expect(recover).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().sessions.find(session => session.id === customAgent.id)?.control).toEqual(customAgent.control)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
  } finally { cleanup() }
})

it('does not let a late original file opening collapse a subsequently reopened companion home', async () => {
  useAppStore.setState({ projectRailOpen: true })
  let finish!: () => void
  const read = vi.spyOn(api.files, 'read').mockImplementation((_workspace, path) => new Promise(resolve => {
    finish = () => resolve({ status: 'read', document: { path, content: '# Original file retained', revision } })
  }))
  await app.mount(); await openHome()
  await moteClick(button('Ideas')); await moteClick(node('.mote-details__ideas .mote-details__note'))
  await moteClick(button('Open file'))
  expect(read).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, rootPath + '/experiment.md')
  expect(finish).toBeTypeOf('function')
  await openHome()
  const reopened = homeExpanded(), drafts = useAppStore.getState().agentComposerDrafts
  await act(async () => finish()); await settleMoteApp()
  expect(homeExpanded()).toBe(reopened)
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it.each([false, true])('reveals a newly saved home arrangement after the existing Calendar refreshes, unless later input owns focus (%s)', async cancelReveal => {
  confirmOriginalHome()
  const previous = arrangement('previous', 20000), added = arrangement('newly-saved', 10000)
  let records = [previous], finish!: () => void, holdScope = false
  vi.mocked(api.schedule.list).mockImplementation(params => {
    if (!params.scope) return Promise.resolve({ schedules: records.filter(record => record.agentSessionId === params.target?.agentSessionId), executionScope: 'connected-host' })
    if (holdScope) return new Promise(resolve => { finish = () => resolve({ schedules: records, executionScope: 'connected-host' }) })
    return Promise.resolve({ schedules: records, executionScope: 'connected-host' })
  })
  await app.mount(); await moteClick(button('Calendar'))
  await moteClick(button('Upcoming'))
  expect(node('.mote-calendar [data-schedule-id="previous"]')).not.toBeNull()
  await moteClick(button('New arrangement'))
  expect(node<HTMLDetailsElement>('.mote-calendar .schedule-create').open).toBe(true)
  records = [added, previous]
  await moteClick(button('Profile'))
  expect(node('[data-upcoming-id="newly-saved"]')).not.toBeNull()
  holdScope = true
  await moteClick(node('[data-upcoming-id="newly-saved"]'))
  expect(finish).toBeTypeOf('function')
  expect(app.container.querySelector('.mote-calendar [data-schedule-id="newly-saved"]')).toBeNull()
  const input = node<HTMLTextAreaElement>('.mote-calendar [aria-label="Arranged message"]')
  if (cancelReveal) await act(async () => {
    input.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Keep this later arrangement thought.')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => finish()); await settleMoteApp()
  const row = node<HTMLDetailsElement>('.mote-calendar [data-schedule-id="newly-saved"] details')
  expect(row.open).toBe(!cancelReveal)
  expect(document.activeElement).toBe(cancelReveal ? input : row.querySelector('summary'))
  if (cancelReveal) expect(input.value).toBe('Keep this later arrangement thought.')
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})
