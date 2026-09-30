// @vitest-environment happy-dom
import { act, createElement, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { workspaceProjectId } from '../src/renderer/src/lib/workspace-projects'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { useAppStore } from '../src/renderer/src/store'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDemandStore } from '@agentmux/demand'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { directGoalRequest, retryDirectGoal } from '../src/renderer/src/lib/goals-direct-pmo'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { agentCreationFixture } from './helpers/agent-creation-fixture'

const baseline = useAppStore.getState()
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], workspaces: [{ id: 'repo', name: 'Repo', path: '/repo', hostId: 'local', kind: 'folder' }, { id: SCRATCH_WORKSPACE_ID, name: 'Topics', path: '/topics', hostId: 'local', kind: 'folder' }], executors: { configured: { label: 'Configured Agent', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } }, appearance: { terminalTheme: 'graphite' } } as AppConfig
function goal(id = 'goal:one', status = 'backlog' as const) { return { id, title: 'A readable outcome', description: 'Make the original work recoverable.', status, priority: 'normal' as const, projectId: null, projectName: null, sessionIds: [], createdAt: 1, updatedAt: 2, source: 'default-topic' as const } }
function session(id: string, workspacePath = '/repo'): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', providerId: 'codex', executorId: 'configured', hostId: 'local', workspacePath, label: 'Configured Agent', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1,
    processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } } }
}
const originalTab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', regionId: 'original-region', workspaceId: 'repo', sessionId: 'healthy' })
const topic = { id: PMO_TEAMS_TOPIC_ID, title: 'Mote', summary: '', directoryPath: 'teams', topicPath: 'teams/topic.md', collaborators: [], soul: { path: 'SOUL.md', content: '# SOUL', version: 'v1' } }
let root: Root, container: HTMLDivElement, temporaryRoot: string, owner: ReturnType<typeof openDemandStore>
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  temporaryRoot = await mkdtemp(join(tmpdir(), 'amux-direct-goal-')); owner = openDemandStore({ root: temporaryRoot })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  useAppStore.setState({ ...baseline, config: structuredClone(config), sessions: [session('healthy')], demands: {}, selectedDemandId: null, mainSurface: 'board', activeWorkspaceId: null,
    tabs: { [originalTab.id]: originalTab }, layouts: { repo: createWorkspaceLayout('original-group', [originalTab.id]), [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('scratch-group') },
    agentComposerDrafts: { healthy: 'Original unsent draft' }, demandPmoTabIds: {}, pendingAgentLaunches: {}, error: null, errorNoticeContext: null })
  vi.spyOn(api.demands, 'create').mockImplementation(input => owner.create(input))
  vi.spyOn(api.demands, 'list').mockImplementation(() => owner.list())
  vi.spyOn(api.demands, 'update').mockImplementation((id, patch) => owner.update(id, patch))
  vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue(topic)
  vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic)
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => {
    const value = session(input.agentSessionId!, '/topics/teams')
    return { created: agentCreationFixture(value), session: value, projectionFailures: [], timeline: { agentSessionId: value.id, revision: 0, items: [] } }
  })
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
})
afterEach(async () => {
  const retained = directGoalRequest()
  if (retained) {
    expect(retained.pending, 'the test settles its finite operation').toBe(false)
    if (!await owner.get(retained.id)) await owner.create({ id: retained.id, title: 'Cleanup existing caller identity' })
    vi.mocked(api.demands.list).mockImplementation(() => owner.list())
    useAppStore.setState({ requestDemandPmoTask: vi.fn().mockResolvedValue('cleanup-tab') })
    await act(async () => retryDirectGoal())
  }
  await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks(); await rm(temporaryRoot, { recursive: true, force: true })
  expect(directGoalRequest()).toBeNull()
})
async function eventually(assertion: () => unknown | Promise<unknown>) { await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); await assertion() }) }
async function mount() { await act(async () => root.render(createElement(GlobalBoardSurface))) }
function button(text: string) { const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text || node.getAttribute('aria-label') === text); expect(result, text).toBeDefined(); return result! }
async function click(text: string) { await act(async () => button(text).click()) }
async function edit(label: string, text: string) { const node = container.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[aria-label="${label}"]`)!; expect(node).toBeTruthy(); await act(async () => { Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, text); node.dispatchEvent(new Event('input', { bubbles: true })) }); return node }

describe('Goals direct PMO creation and reading surface', () => {
  it('one actual click saves a caller-owned undefined Goal and launches its dedicated PMO through the original owner', async () => {
    const originalLayout = useAppStore.getState().layouts.repo, originalFocus = useAppStore.getState().agentFocus
    await mount(); await click('New Goal')
    await eventually(() => expect(directGoalRequest()).toBeNull())
    const goals = await owner.list(); expect(goals).toHaveLength(1)
    const saved = goals[0]!
    expect(saved).toMatchObject({ title: 'Untitled goal', description: '', status: 'backlog', projectId: null, projectName: null, sessionIds: [] })
    expect(saved.id).toMatch(/^demand_/); expect(saved.alignment).toBeUndefined(); expect(saved.grounding).toBeUndefined()
    expect(api.demands.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: saved.id, title: 'Untitled goal', description: '', status: 'backlog' }))
    expect(container.querySelector('.goals-intake, [aria-label="Goal intent"]')).toBeNull()
    expect(container.querySelector(`[data-demand-id="${saved.id}"]`)?.classList.contains('goals-row--undefined')).toBe(true)
    const state = useAppStore.getState(), tabId = state.demandPmoTabIds[saved.id]!, tab = state.tabs[tabId]!
    expect(state.selectedDemandId).toBe(saved.id); expect(tab.topicId).toBe(PMO_TEAMS_TOPIC_ID)
    expect(api.sessions.launchAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ scratchTopicId: PMO_TEAMS_TOPIC_ID, prompt: expect.stringContaining(`existing Goal ${saved.id}`) }))
    expect(vi.mocked(api.sessions.launchAgent).mock.calls[0]![0].prompt).toContain('existing undefined Goal draft')
    expect(readPmoTeamsTopicFloatingState()?.targetTabId).toBe(tab.id)
    expect(state.tabs[originalTab.id]).toBe(originalTab); expect(state.layouts.repo).toBe(originalLayout)
    expect(state.agentComposerDrafts.healthy).toBe('Original unsent draft'); expect(state.agentFocus.execution).toEqual(originalFocus.execution)
    expect(state.sessions.find(value => value.id === 'healthy')).toEqual(session('healthy')); expect(api.sessions.stop).not.toHaveBeenCalled()
    await click('Board view'); expect(container.querySelector(`[data-demand-id="${saved.id}"]`)?.classList.contains('goals-row--undefined')).toBe(true)
    await act(async () => useAppStore.getState().updateDemand(saved.id, { alignment: { summary: 'A real discussed goal', criteria: [{ id: 'observable', text: 'An observable result' }], openQuestions: [] } }))
    expect(container.querySelector(`[data-demand-id="${saved.id}"]`)?.classList.contains('goals-row--undefined')).toBe(false)
    expect((await owner.list()).map(value => value.id)).toEqual([saved.id]); expect(api.demands.create).toHaveBeenCalledTimes(1)
  })

  it('owns one click across duplicate activation and a mounted board unload/return before the save receipt', async () => {
    let finish!: (receipt: Awaited<ReturnType<typeof owner.create>>) => void
    let saved!: Awaited<ReturnType<typeof owner.create>>
    vi.mocked(api.demands.create).mockImplementationOnce(async input => { saved = await owner.create(input); return await new Promise(resolve => { finish = resolve }) })
    await mount(); const newGoal = button('New Goal')
    await act(async () => { newGoal.click(); newGoal.click() })
    await eventually(() => expect(finish).toBeTypeOf('function'))
    expect(api.demands.create).toHaveBeenCalledTimes(1); expect(api.sessions.launchAgent).not.toHaveBeenCalled(); expect(useAppStore.getState().demands).toEqual({})
    await act(async () => root.render(null)); await mount(); expect(button('New Goal').disabled).toBe(true)
    await act(async () => finish(saved)); await eventually(() => expect(directGoalRequest()).toBeNull())
    expect((await owner.list()).map(value => value.id)).toEqual([saved.demand.id]); expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1)
  })

  it('recovers an actually saved but lost creation receipt only by reading the exact frozen ID', async () => {
    vi.mocked(api.demands.create).mockImplementationOnce(async input => { await owner.create(input); throw new Error('Saved IPC receipt missing') })
    vi.mocked(api.demands.list).mockRejectedValueOnce(new Error('Owner read unavailable'))
    await mount(); await click('New Goal'); await eventually(() => expect(directGoalRequest()?.pending).toBe(false))
    const id = directGoalRequest()!.id
    expect((await owner.list()).map(value => value.id)).toEqual([id]); expect(useAppStore.getState().demands).toEqual({})
    expect(container.querySelector('.goals-creation')?.textContent).toContain('目标保存结果尚未确认'); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
    await act(async () => root.render(null)); await mount(); await click('重新读取目标')
    await eventually(() => expect(directGoalRequest()).toBeNull())
    expect(api.demands.create).toHaveBeenCalledTimes(1); expect(api.demands.list).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().selectedDemandId).toBe(id); expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.sessions.launchAgent).mock.calls[0]![0].prompt).toContain(`existing Goal ${id}`)
  })

  it('saves again only after a complete owner read proves absence, using the same caller ID', async () => {
    vi.mocked(api.demands.create).mockRejectedValueOnce(new Error('Disk unavailable'))
    await mount(); await click('New Goal'); await eventually(() => expect(directGoalRequest()?.pending).toBe(false))
    const id = directGoalRequest()!.id
    expect(await owner.list()).toEqual([]); expect(useAppStore.getState().demands).toEqual({}); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
    expect(directGoalRequest()?.notSaved).toBe(true)
    expect(container.querySelector('.goals-creation')?.textContent).toContain('已确认目标尚未保存')
    expect(container.querySelector('button[data-new-goal]')?.hasAttribute('disabled')).toBe(true)
    await act(async () => root.render(null)); await mount(); await click('保存这个目标')
    await eventually(() => expect(directGoalRequest()).toBeNull())
    expect(vi.mocked(api.demands.create).mock.calls.map(([input]) => input.id)).toEqual([id, id])
    expect((await owner.list()).map(value => value.id)).toEqual([id]); expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.sessions.launchAgent).mock.calls[0]![0].prompt).toContain(`existing Goal ${id}`)
  })

  it('keeps an unknown save read-only across repeated failed reads and never saves a new identity', async () => {
    vi.mocked(api.demands.create).mockRejectedValueOnce(new Error('Receipt missing'))
    vi.mocked(api.demands.list).mockRejectedValue(new Error('Complete owner read unavailable'))
    await mount(); await click('New Goal'); await eventually(() => expect(directGoalRequest()?.pending).toBe(false))
    const id = directGoalRequest()!.id
    expect(directGoalRequest()?.notSaved).toBe(false)
    await click('重新读取目标'); await eventually(() => expect(directGoalRequest()?.pending).toBe(false))
    expect(directGoalRequest()?.id).toBe(id); expect(api.demands.create).toHaveBeenCalledTimes(1)
    expect(api.demands.list).toHaveBeenCalledTimes(2); expect(await owner.list()).toEqual([])
    expect(useAppStore.getState().demands).toEqual({}); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
    expect(container.querySelector('.goals-creation')?.textContent).toContain('不会重复创建')
    expect([...container.querySelectorAll('button')].filter(node => node.textContent === '保存这个目标')).toEqual([])
  })

  it('retains the real Goal and failed mapped launcher, then retries the same Goal and Tab', async () => {
    vi.mocked(api.sessions.launchAgent).mockRejectedValueOnce(new Error('PMO launch receipt unavailable'))
    await mount(); await click('New Goal'); await eventually(() => expect(directGoalRequest()?.pending).toBe(false))
    const id = directGoalRequest()!.id, tabId = useAppStore.getState().demandPmoTabIds[id]!, tab = useAppStore.getState().tabs[tabId]!, regionId = tab.layout.activeRegionId
    expect((await owner.list()).map(value => value.id)).toEqual([id]); expect(tab.regions[regionId]?.kind).toBe('launcher')
    expect(useAppStore.getState().agentComposerDrafts[regionId]).toContain(`existing Goal ${id}`)
    expect(useAppStore.getState().errorNoticeContext?.lifecycle).toMatchObject({ regionId, tabId, step: 'launch' })
    expect(readPmoTeamsTopicFloatingState()?.targetTabId).toBe(tabId)
    await act(async () => root.render(null)); await mount(); await click('重试专属讨论'); await eventually(() => expect(directGoalRequest()).toBeNull())
    expect(useAppStore.getState().demandPmoTabIds[id]).toBe(tabId); expect(useAppStore.getState().tabs[tabId]!.regions[regionId]?.kind).toBe('agent')
    expect(api.demands.create).toHaveBeenCalledTimes(1); expect(api.sessions.launchAgent).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.sessions.launchAgent).mock.calls.map(([input]) => input.prompt?.includes(`existing Goal ${id}`))).toEqual([true, true])
  })

  it('keeps the saved Goal with no fictional Tab when no PMO Executor is configured', async () => {
    useAppStore.setState({ config: { ...config, executors: {} } })
    await mount(); await click('New Goal'); await eventually(() => expect(directGoalRequest()?.pending).toBe(false))
    const id = directGoalRequest()!.id
    expect((await owner.list()).map(value => value.id)).toEqual([id]); expect(useAppStore.getState().demandPmoTabIds).toEqual({})
    expect(Object.keys(useAppStore.getState().tabs)).toEqual([originalTab.id]); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
    expect(container.querySelector('.goals-creation')?.textContent).toContain('目标已保存'); expect(container.querySelector('.goals-creation')?.textContent).not.toContain('same Tab')
  })

  it('preserves explicit Project and matching conditions while making the new shell visible', async () => {
    await mount(); await click('Goal filters')
    async function choose(label: string, value: string) { await act(async () => { const node = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })) }) }
    const projectId = workspaceProjectId(config.workspaces[0]!)
    await choose('Filter project', projectId); await choose('Filter work status', 'backlog'); await choose('Filter routing', 'unassigned')
    await edit('Search goals', 'untitled'); await click('New Goal'); await eventually(() => expect(directGoalRequest()).toBeNull())
    const saved = (await owner.list())[0]!
    expect(saved).toMatchObject({ projectId, projectName: 'Repo' })
    expect((container.querySelector('[aria-label="Search goals"]') as HTMLInputElement).value).toBe('untitled')
    expect((container.querySelector('[aria-label="Filter project"]') as HTMLSelectElement).value).toBe(projectId)
    expect((container.querySelector('[aria-label="Filter work status"]') as HTMLSelectElement).value).toBe('backlog')
    expect((container.querySelector('[aria-label="Filter routing"]') as HTMLSelectElement).value).toBe('unassigned')
    expect([...container.querySelectorAll('[data-demand-id]')].map(node => node.getAttribute('data-demand-id'))).toEqual([saved.id])
  })

  it('clears only conditions that would hide the newly created Goal', async () => {
    await mount(); await click('Goal filters')
    await act(async () => { for (const [label, value] of [['Filter work status', 'done'], ['Filter routing', 'assigned'], ['Filter executor', 'configured']]) { const node = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; node.value = value!; node.dispatchEvent(new Event('change', { bubbles: true })) } })
    await edit('Search goals', 'a different outcome'); await click('New Goal'); await eventually(() => expect(directGoalRequest()).toBeNull())
    const saved = (await owner.list())[0]!
    expect((container.querySelector('[aria-label="Search goals"]') as HTMLInputElement).value).toBe('')
    expect([...container.querySelectorAll<HTMLSelectElement>('.goals-filters select')].map(node => node.value)).toEqual(['all', 'all', 'all', 'all'])
    expect([...container.querySelectorAll('[data-demand-id]')].map(node => node.getAttribute('data-demand-id'))).toEqual([saved.id])
  })

  it('attaches the created PMO without stealing a newer Goal selection, PMO focus or floating target', async () => {
    let finish!: () => void
    const launch = vi.mocked(api.sessions.launchAgent).getMockImplementation()!
    vi.mocked(api.sessions.launchAgent).mockImplementationOnce(async input => { await new Promise<void>(resolve => { finish = resolve }); return launch(input) })
    await mount(); await click('New Goal'); await eventually(() => expect(finish).toBeTypeOf('function'))
    const saved = (await owner.list())[0]!, mapped = useAppStore.getState().demandPmoTabIds[saved.id]!
    await act(async () => { useAppStore.setState(state => ({ selectedDemandId: 'later-goal', agentFocus: { ...state.agentFocus, pmo: { ...state.agentFocus.pmo, sessionId: 'later-pmo' } } })); requestPmoTeamsTopicFloatingOpen({ targetTabId: originalTab.id }) })
    const laterPmo = useAppStore.getState().agentFocus.pmo, laterFloating = readPmoTeamsTopicFloatingState()
    await act(async () => finish()); await eventually(() => expect(directGoalRequest()).toBeNull())
    expect(useAppStore.getState().selectedDemandId).toBe('later-goal'); expect(useAppStore.getState().agentFocus.pmo).toBe(laterPmo)
    expect(readPmoTeamsTopicFloatingState()).toBe(laterFloating)
    expect(useAppStore.getState().tabs[mapped]!.regions[useAppStore.getState().tabs[mapped]!.layout.activeRegionId]?.kind).toBe('agent')
    expect(api.demands.create).toHaveBeenCalledTimes(1); expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1); expect(api.sessions.stop).not.toHaveBeenCalled()
  })

  it('publishes the real saved Goal without stealing a later selection or navigation', async () => {
    let finish!: (receipt: Awaited<ReturnType<typeof owner.create>>) => void
    let saved!: Awaited<ReturnType<typeof owner.create>>
    vi.mocked(api.demands.create).mockImplementationOnce(async input => { saved = await owner.create(input); return await new Promise(resolve => { finish = resolve }) })
    await mount(); await click('New Goal'); await eventually(() => expect(finish).toBeTypeOf('function'))
    await act(async () => useAppStore.setState({ selectedDemandId: 'later-goal', mainSurface: 'workbench', activeWorkspaceId: 'repo' }))
    await act(async () => finish(saved)); await eventually(() => expect(directGoalRequest()?.pending).toBe(false))
    expect(useAppStore.getState().demands[saved.demand.id]?.id).toBe(saved.demand.id)
    expect(useAppStore.getState().selectedDemandId).toBe('later-goal'); expect(useAppStore.getState().mainSurface).toBe('workbench'); expect(useAppStore.getState().activeWorkspaceId).toBe('repo')
    expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  })

  it('retries a failed Mote open as an open action without silently starting Grill', async () => {
    const original = goal(); const open = vi.fn().mockRejectedValueOnce(new Error('Mote view unavailable')).mockResolvedValueOnce('mote-tab'); const request = vi.fn()
    useAppStore.setState({ demands: { [original.id]: original }, selectedDemandId: original.id, openDemandPmo: open, requestDemandPmoTask: request })
    await mount(); await click(`Open discussion for ${original.title}`)
    expect(container.querySelector('[role="status"]')?.textContent).toContain('discussion could not be opened')
    expect(request).not.toHaveBeenCalled(); await click('Retry opening discussion')
    expect(open.mock.calls).toEqual([[original.id], [original.id]]); expect(request).not.toHaveBeenCalled()
  })

  it('defaults to a nonempty list, filters honestly and keeps the same identity in the horizontal board', async () => {
    useAppStore.setState({ demands: { 'goal:one': goal(), 'goal:done': { ...goal('goal:done'), title: 'Previously done', status: 'done' } } })
    await mount(); expect([...container.querySelectorAll('[data-demand-id]')].map((node) => node.getAttribute('data-demand-id'))).toEqual(['goal:one'])
    expect(container.querySelector('.goals-list')).toBeTruthy(); expect(container.querySelector('.goals-filters')).toBeNull()
    await act(async () => (container.querySelector('[data-demand-id]') as HTMLElement).click()); expect(useAppStore.getState().selectedDemandId).toBe('goal:one')
    await click('Board view'); expect(container.querySelector('.goals-board')).toBeTruthy(); expect(container.querySelector('[data-demand-id="goal:one"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(useAppStore.getState().selectedDemandId).toBe('goal:one')
    await click('Show finished'); expect([...container.querySelectorAll('[data-demand-id]')].map((node) => node.getAttribute('data-demand-id'))).toEqual(['goal:one', 'goal:done'])
    await edit('Search goals', 'previously'); expect([...container.querySelectorAll('[data-demand-id]')].map((node) => node.getAttribute('data-demand-id'))).toEqual(['goal:done'])
    expect(useAppStore.getState().selectedDemandId).toBe('goal:one')
    await click('Clear search'); await click('List view'); expect(container.querySelectorAll('[data-demand-id]')).toHaveLength(2)
  })

  it('keeps durable selection during an empty startup projection and recovers its same detail', async () => {
    useAppStore.setState({ selectedDemandId: 'goal:restored', demands: {} }); await mount()
    expect(useAppStore.getState().selectedDemandId).toBe('goal:restored'); expect(container.querySelector('.goals-detail')?.textContent).toContain('identity is kept')
    await act(async () => useAppStore.setState({ demands: { 'goal:restored': goal('goal:restored') } }))
    expect(container.querySelector('[aria-label="Goal workspace for A readable outcome"]')).toBeTruthy()
    expect(useAppStore.getState().selectedDemandId).toBe('goal:restored')
  })

  it('retains an unsaved title when the owner rejects a save and retries through the public caller', async () => {
    const original = goal(); const update = vi.fn().mockRejectedValueOnce(new Error('Save unconfirmed')).mockResolvedValueOnce(undefined)
    useAppStore.setState({ demands: { [original.id]: original }, selectedDemandId: original.id, updateDemand: update })
    await mount(); const title = await edit('Goal title', 'My clearer outcome')
    await act(async () => title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(update).toHaveBeenCalledWith(original.id, { title: 'My clearer outcome' })
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Goal title"]')?.value).toBe('My clearer outcome')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('draft is kept')
    await click('Retry save'); expect(update).toHaveBeenCalledTimes(2)
  })

  it('keeps a newer title draft while the earlier save is in flight', async () => {
    const original = goal(); let resolve!: () => void
    const update = vi.fn(() => new Promise<void>((r) => { resolve = r }))
    useAppStore.setState({ demands: { [original.id]: original }, selectedDemandId: original.id, updateDemand: update })
    await mount(); const title = await edit('Goal title', 'First revision')
    await act(async () => title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await edit('Goal title', 'A newer unsent revision')
    await act(async () => { useAppStore.setState({ demands: { [original.id]: { ...original, title: 'First revision' } } }); resolve() })
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Goal title"]')?.value).toBe('A newer unsent revision')
    expect(update).toHaveBeenCalledExactlyOnceWith(original.id, { title: 'First revision' })
  })

  it('retains a failed detail draft when reading another Goal and returning', async () => {
    const original = goal(), second = { ...goal('goal:two'), title: 'Another goal' }
    const update = vi.fn().mockRejectedValue(new Error('Save unavailable'))
    useAppStore.setState({ demands: { [original.id]: original, [second.id]: second }, selectedDemandId: original.id, updateDemand: update })
    await mount(); const title = await edit('Goal title', 'An unsaved but valuable title')
    await act(async () => title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(container.querySelector('[role="status"]')?.textContent).toContain('draft is kept')
    await act(async () => (container.querySelector('[data-demand-id="goal:two"]') as HTMLElement).click())
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Goal title"]')?.value).toBe('Another goal')
    await act(async () => (container.querySelector('[data-demand-id="goal:one"]') as HTMLElement).click())
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Goal title"]')?.value).toBe('An unsaved but valuable title')
    expect(Object.keys(useAppStore.getState().demands)).toEqual(['goal:one', 'goal:two'])
  })

  it('retries the actual failed property patch rather than pretending an empty save succeeded', async () => {
    const original = goal(); const update = vi.fn().mockRejectedValueOnce(new Error('Priority save unavailable')).mockResolvedValueOnce(undefined)
    useAppStore.setState({ demands: { [original.id]: original }, selectedDemandId: original.id, updateDemand: update })
    await mount(); const priority = container.querySelector<HTMLSelectElement>('[aria-label="Goal priority"]')!
    await act(async () => { priority.value = 'high'; priority.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(update).toHaveBeenCalledExactlyOnceWith(original.id, { priority: 'high' })
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Priority save unavailable')
    await click('Retry save'); expect(update.mock.calls).toEqual([[original.id, { priority: 'high' }], [original.id, { priority: 'high' }]])
  })

  it('does no default Goal render work for unrelated Session output and tab facts', async () => {
    const related = { id: 'linked', label: 'Linked Agent', status: { state: 'working' }, workspacePath: '/repo' } as SessionSnapshot
    const unrelated = { ...related, id: 'unrelated' }
    useAppStore.setState({ demands: { 'goal:one': { ...goal(), sessionIds: ['linked'] } }, sessions: [related, unrelated], selectedDemandId: 'goal:one' })
    const commits = vi.fn(); await act(async () => root.render(createElement(Profiler, { id: 'goals', onRender: commits }, createElement(GlobalBoardSurface))))
    expect(container.querySelector('[data-demand-id]')?.textContent).toContain('1 linked · working')
    expect(container.querySelector('.goals-execution__link')).toBeNull(); expect(container.querySelector('.agent-topology-summary')).toBeNull()
    const count = commits.mock.calls.length; expect(count).toBeGreaterThan(0)
    await act(async () => useAppStore.setState({ sessions: [related, { ...unrelated, latestOutputBytes: 900000, updatedAt: 12 }], tabs: {} }))
    expect(commits.mock.calls.length).toBe(count)
  })
})
