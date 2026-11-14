const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, createElement, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { chooseField } from './helpers/selection-field'
import { demandAgentReferenceKey } from '@agentmux/demand/relations'
import { workspaceProjectId } from '../src/renderer/src/lib/workspace-projects'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { useAppStore, currentCoreSpatialGraph } from '../src/renderer/src/store'
import { readGoalDiscussionBinding } from '../../host/src/goal-discussion-bindings'
import { spatialAgentOpenRecord } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { directGoalRequest, retryDirectGoal } from '../src/renderer/src/lib/goals-direct-pmo'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { openHostGoalDiscussionFixture } from './helpers/host-goal-discussion-fixture'
import type { HostGoalTransport, GoalTransportGate } from './helpers/host-goal-transport'

const baseline = useAppStore.getState()
// This suite verifies unassigned creation/filtering; Supervisor defaulting is covered by the participation suite.
const config = { version: 9, goals: { requesterAsSupervisor: false }, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], workspaces: [{ id: 'repo', name: 'Repo', path: _hygiene_fixturePath("repo"), hostId: 'local', kind: 'folder' }, { id: SCRATCH_WORKSPACE_ID, name: 'Topics', path: _hygiene_fixturePath("topics"), hostId: 'local', kind: 'folder' }], executors: { configured: { label: 'Configured Agent', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } }, appearance: { terminalTheme: 'graphite' } } as AppConfig
function goal(id = 'goal:one', status = 'backlog' as const) { return { id, title: 'A readable outcome', description: 'Make the original work recoverable.', status, priority: 'normal' as const, projectId: null, projectName: null, sessionIds: [], createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 2), source: 'default-topic' as const } }
function session(id: string, workspacePath = _hygiene_fixturePath("repo")): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', providerId: 'codex', executorId: 'configured', hostId: 'local', workspacePath, label: 'Configured Agent', createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1), agentSessionUpdatedAt: _reshape_fixtureEpoch(0, 0, 1),
    processState: 'running', status: { state: 'running', source: 'run-process', observedAt: _reshape_fixtureEpoch(0, 0, 1) }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } } }
}
const originalTab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', regionId: 'original-region', workspaceId: 'repo', sessionId: 'healthy' })
const primaryTab = { ...createWorkbenchTab('primary-tab', { kind: 'agent', phase: 'attached', regionId: 'primary-region', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: 'primary' }), topicId: PMO_TEAMS_TOPIC_ID }
const topic = { id: PMO_TEAMS_TOPIC_ID, title: 'Mote', summary: '', directoryPath: 'teams', topicPath: 'teams/topic.md', collaborators: [], quickMode: { status: 'saved' as const, version: 'original-mote-preference', defaults: { executorId: 'configured' } }, soul: { path: 'SOUL.md', content: '# SOUL', version: 'v1' } }
let root: Root, container: HTMLDivElement, host: HostGoalTransport, owner: HostGoalTransport['demands']
let discussion: Awaited<ReturnType<typeof openHostGoalDiscussionFixture>>
let releaseHeldReceipt: (() => void) | undefined, releaseShowFailures: (() => void) | undefined, tearingDown = false
beforeEach(async () => {
  expect(directGoalRequest(), 'the previous finite operation and cleanup completed').toBeNull()
  releaseHeldReceipt = undefined; releaseShowFailures = undefined; tearingDown = false
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  useAppStore.setState({ ...baseline, config: structuredClone(config), sessions: [session('healthy'), session('primary', _hygiene_fixturePath("topics/topic--launcher--leader"))], demands: {}, selectedDemandId: null, mainSurface: 'board', activeWorkspaceId: null,
    agentFocus: { ...baseline.agentFocus, pmo: { sessionId: 'primary' } },
    tabs: { [originalTab.id]: originalTab, [primaryTab.id]: primaryTab }, layouts: { repo: createWorkspaceLayout('original-group', [originalTab.id]), [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('scratch-group', [primaryTab.id]) },
    scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(config.workspaces[1]!), revision: 1, topics: [topic], reading: false, error: null } },
    agentComposerDrafts: { healthy: 'Original unsent draft' }, demandPmoTabIds: {}, pendingAgentLaunches: {}, error: null, errorNoticeContext: null })
  discussion = await openHostGoalDiscussionFixture(useAppStore.getState().config!)
  host = discussion.host; owner = host.demands
  vi.spyOn(api.sessions, 'launchAgent')
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
})
afterEach(async () => {
  tearingDown = true
  // Release only this fixture's held real receipt, then await the existing finite flight.
  // If it never settles, the finite hook deadline fails before resetting its active owners.
  await act(async () => {
    releaseHeldReceipt?.()
    if (directGoalRequest()?.pending) await retryDirectGoal()
  })
  try {
    const retained = directGoalRequest()
    if (retained) {
      expect(retained.pending, 'the test settles its finite operation').toBe(false)
      if (!await owner.get(retained.id)) await owner.create({ id: retained.id, title: 'Cleanup existing caller identity' })
      releaseShowFailures?.()
      useAppStore.setState({ requestDemandPmoTask: vi.fn().mockResolvedValue('cleanup-tab') })
      await act(async () => retryDirectGoal())
    }
    expect(directGoalRequest()).toBeNull()
  } finally {
    try { await act(async () => root.unmount()) }
    finally { container.remove(); await discussion.dispose(); useAppStore.setState(baseline, true); vi.restoreAllMocks() }
  }
}, 5_000)
const creates = () => host.executed('demand.create')
const starts = () => discussion.core.start.mock.calls.length - 1 // The primary Mote predates every operation.
function binding(goalId: string) { const value = readGoalDiscussionBinding(currentCoreSpatialGraph()!, goalId); expect(value).not.toBeNull(); return value! }
async function discussionInput(goalId: string) {
  const target = binding(goalId); expect(target.recipient.kind).toBe('agent')
  if (target.recipient.kind !== 'agent') throw new Error('Expected the original dedicated Agent')
  const created = await discussion.core.core.inspectAgentCreation(target.recipient.agentSessionId)
  const key = created.creation!.initialInputKey!
  const input = await discussion.core.core.inspectAgentPromptSubmission(key)
  return input?.launch?.message ?? input?.admission?.intent?.message
}
// A held creation receipt: the original Host owner commits, the renderer's receipt waits for the test.
function holdCreateReceipt(): GoalTransportGate { const gate = host.once('demand.create', { kind: 'hold-receipt' }); releaseHeldReceipt = gate.release; if (tearingDown) gate.release(); return gate }
async function eventually(assertion: () => unknown | Promise<unknown>) { await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); await assertion() }, { timeout: 3_000 }) }
async function mount() { await act(async () => root.render(createElement(GlobalBoardSurface))) }
function button(text: string) { const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text || node.getAttribute('aria-label') === text); expect(result, text).toBeDefined(); return result! }
async function click(text: string) { await act(async () => button(text).click()) }
async function edit(label: string, text: string) { const node = container.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[aria-label="${label}"]`)!; expect(node).toBeTruthy(); await act(async () => { Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, text); node.dispatchEvent(new Event('input', { bubbles: true })) }); return node }

describe('Goals direct PMO creation and reading surface', () => {
  it('one actual click saves a caller-owned undefined Goal and launches its dedicated PMO through the original owner', async () => {
    const originalLayout = useAppStore.getState().layouts.repo, originalFocus = useAppStore.getState().agentFocus, originalWork = useAppStore.getState().tabs[originalTab.id]
    await mount(); await click('New Goal')
    await eventually(() => expect(directGoalRequest()).toBeNull())
    const goals = await owner.list(); expect(goals).toHaveLength(1)
    const saved = goals[0]!
    expect(saved).toMatchObject({ title: 'Untitled goal', description: '', status: 'backlog', projectId: null, projectName: null, sessionIds: [] })
    expect(saved.id.length).toBeGreaterThan(0); expect(saved.alignment).toBeUndefined(); expect(saved.grounding).toBeUndefined()
    expect(creates()).toHaveLength(1); expect(creates()[0]).toMatchObject({ demandId: saved.id, title: 'Untitled goal', description: '', status: 'backlog' })
    expect(container.querySelector('.goals-intake, [aria-label="Goal intent"]')).toBeNull()
    expect(container.querySelector(`[data-demand-id="${saved.id}"]`)?.classList.contains('goals-row--undefined')).toBe(true)
    const state = useAppStore.getState(), tabId = binding(saved.id).tabId, tab = state.tabs[tabId]!
    expect(state.selectedDemandId).toBe(saved.id); expect(tab.topicId).toBe(PMO_TEAMS_TOPIC_ID)
    expect(starts()).toBe(1); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
    expect((await discussionInput(saved.id))).toMatchObject({ userContent: 'Clarify this existing Goal.', systemContext: expect.stringContaining(`existing Goal ${saved.id}`) })
    expect((await discussionInput(saved.id))?.systemContext).toContain('existing undefined Goal draft')
    expect(readPmoTeamsTopicFloatingState()?.targetTabId).toBe(tab.id)
    expect(readPmoTeamsTopicFloatingState()?.reference?.regionId).toBe(binding(saved.id).regionId)
    expect(state.mainSurface).toBe('board')
    expect(state.tabs[originalTab.id]).toEqual({ ...originalWork, space: { spaceId: directoryIdentity('local', config.workspaces[0]!.path), zoneId: workspaceZoneId(directoryIdentity('local', config.workspaces[0]!.path), 'repo') } }); expect(state.layouts.repo).toEqual(originalLayout)
    expect(state.agentComposerDrafts.healthy).toBe('Original unsent draft'); expect(state.agentFocus.execution).toEqual(originalFocus.execution)
    expect(state.sessions.find(value => value.id === 'healthy')).toEqual(session('healthy')); expect(api.sessions.stop).not.toHaveBeenCalled()
    await click('Back to goals'); await click('Board view'); expect(container.querySelector(`[data-demand-id="${saved.id}"]`)?.classList.contains('goals-row--undefined')).toBe(true)
    await act(async () => useAppStore.getState().updateDemand(saved.id, { alignment: { summary: 'A real discussed goal', criteria: [{ id: 'observable', text: 'An observable result' }], openQuestions: [] } }))
    expect(container.querySelector(`[data-demand-id="${saved.id}"]`)?.classList.contains('goals-row--undefined')).toBe(false)
    expect((await owner.list()).map(value => value.id)).toEqual([saved.id]); expect(creates()).toHaveLength(1)
  })

  it('owns one click across duplicate activation and a mounted board unload/return before the save receipt', async () => {
    const original = useAppStore.getState(), originalWork = original.tabs[originalTab.id], originalLayout = original.layouts.repo
    const held = holdCreateReceipt()
    await mount(); const newGoal = button('New Goal')
    await act(async () => { newGoal.click(); newGoal.click() })
    const saved = await held.committed
    if (saved.operation !== 'demand.create') throw new Error('The held receipt belongs to another operation.')
    expect(creates()).toHaveLength(1); expect(api.sessions.launchAgent).not.toHaveBeenCalled(); expect(starts()).toBe(0)
    expect(directGoalRequest()).toMatchObject({ id: saved.demand.id, phase: 'save', pending: true })
    const projected = useAppStore.getState().demands
    // The actual goal.watch publication may independently read the owner's commit before the held ACK.
    expect(Object.keys(projected)).toEqual(projected[saved.demand.id] ? [saved.demand.id] : [])
    if (projected[saved.demand.id]) {
      expect(projected[saved.demand.id]).toMatchObject({ id: saved.demand.id, title: saved.demand.title, description: saved.demand.description,
        status: saved.demand.status, creationOrigin: saved.demand.creationOrigin })
      const reads = host.execute.mock.calls.flatMap(([request], index) => request.operation === 'demand.show' && request.demandId === saved.demand.id ? [host.execute.mock.results[index]!.value] : [])
      expect(reads.length).toBeGreaterThan(0)
      // Creation publishes before its decision append; compare the exact observed owner cut, not a later ACK.
      const originalReads = await Promise.all(reads)
      expect(originalReads.some(result => result.operation === 'demand.show' && result.demand?.id === saved.demand.id && result.demand.updatedAt === projected[saved.demand.id]!.updatedAt)).toBe(true)
    }
    await act(async () => root.render(null)); await mount(); expect(button('New Goal').disabled).toBe(true)
    await act(async () => held.release()); await eventually(() => expect(directGoalRequest()).toBeNull())
    expect((await owner.list()).map(value => value.id)).toEqual([saved.demand.id]); expect(starts()).toBe(1)
    expect(creates()).toHaveLength(1)
    const current = useAppStore.getState()
    expect(current.tabs[originalTab.id]).toEqual({ ...originalWork, space: { spaceId: directoryIdentity('local', config.workspaces[0]!.path), zoneId: workspaceZoneId(directoryIdentity('local', config.workspaces[0]!.path), 'repo') } })
    expect(current.layouts.repo).toEqual(originalLayout); expect(current.agentFocus.execution).toEqual(original.agentFocus.execution)
    expect(current.agentComposerDrafts.healthy).toBe('Original unsent draft'); expect(current.sessions.find(value => value.id === 'healthy')).toEqual(session('healthy'))
    expect(api.sessions.stop).not.toHaveBeenCalled()
  })

  it('recovers an actually saved but lost creation receipt only by reading the exact frozen ID', async () => {
    const lost = host.once('demand.create', { kind: 'lose-receipt', error: new Error('Saved IPC receipt missing') })
    // The exact frozen-ID read (demand.show) fails once before reaching the original owner.
    host.once('demand.show', { kind: 'reject', error: new Error('Owner read unavailable') })
    await mount(); await click('New Goal'); await eventually(() => expect(directGoalRequest()?.pending ?? false).toBe(false))
    const committed = await lost.committed
    if (committed.operation !== 'demand.create') throw new Error('Expected the original creation receipt')
    const id = committed.demand.id
    expect((await owner.list()).map(value => value.id)).toEqual([id])
    // An original owner publication may already have supplied the saved record.
    // Otherwise the unknown receipt still exposes only its exact readback action.
    if (directGoalRequest()) {
      expect(directGoalRequest()!.id).toBe(id)
      expect(container.querySelector('.goals-creation')?.textContent).toContain('Goal save is unconfirmed')
      expect(api.sessions.launchAgent).not.toHaveBeenCalled()
      await act(async () => root.render(null)); await mount(); await click('Read goal again')
    } else expect(useAppStore.getState().demands[id]).toMatchObject({ id, title: committed.demand.title })
    await eventually(() => expect(directGoalRequest()).toBeNull())
    expect(creates()).toHaveLength(1); expect(host.bodies('demand.show').filter(read => read.demandId === id).length).toBeGreaterThanOrEqual(2)
    expect(useAppStore.getState().selectedDemandId).toBe(id); expect(starts()).toBe(1)
    expect((await discussionInput(id))?.systemContext).toContain(`existing Goal ${id}`)
  })

  it('saves again only after a complete owner read proves absence, using the same caller ID', async () => {
    host.once('demand.create', { kind: 'reject', error: new Error('Disk unavailable') })
    await mount(); await click('New Goal'); await eventually(() => expect(directGoalRequest()?.pending).toBe(false))
    const id = directGoalRequest()!.id
    expect(await owner.list()).toEqual([]); expect(useAppStore.getState().demands).toEqual({}); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
    expect(directGoalRequest()?.notSaved).toBe(true)
    expect(container.querySelector('.goals-creation')?.textContent).toContain('The goal is not saved')
    expect(container.querySelector('button[data-new-goal]')?.hasAttribute('disabled')).toBe(true)
    expect(button('Save this goal').querySelector('[data-semantic-icon]')).toBeNull()
    await act(async () => root.render(null)); await mount(); await click('Save this goal')
    await eventually(() => expect(directGoalRequest()).toBeNull())
    expect(creates().map(request => request.demandId)).toEqual([id, id])
    expect((await owner.list()).map(value => value.id)).toEqual([id]); expect(starts()).toBe(1)
    expect((await discussionInput(id))?.systemContext).toContain(`existing Goal ${id}`)
  })

  it('keeps an unknown save read-only across repeated failed reads and never saves a new identity', async () => {
    host.once('demand.create', { kind: 'reject', error: new Error('Receipt missing') })
    releaseShowFailures = host.failAll('demand.show', new Error('Complete owner read unavailable'))
    await mount(); await click('New Goal'); await eventually(() => expect(directGoalRequest()?.pending).toBe(false))
    const id = directGoalRequest()!.id
    expect(directGoalRequest()?.notSaved).toBe(false)
    await click('Read goal again'); await eventually(() => expect(directGoalRequest()?.pending).toBe(false))
    expect(directGoalRequest()?.id).toBe(id); expect(creates()).toHaveLength(1)
    expect(host.bodies('demand.show').map(read => read.demandId)).toEqual([id, id]); expect(await owner.list()).toEqual([])
    expect(useAppStore.getState().demands).toEqual({}); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
    expect(container.querySelector('.goals-creation')?.textContent).toContain('Read this same goal before continuing')
    expect([...container.querySelectorAll('button')].filter(node => node.textContent === 'Save this goal')).toEqual([])
  })

  it('retains the same Goal, Tab and Agent after a lost dedicated discussion receipt and reconciles without another launch', async () => {
    const lost = host.once('demand.discuss', { kind: 'lose-receipt', error: new Error('Original discussion receipt missing') })
    await mount(); await click('New Goal'); await eventually(() => expect(directGoalRequest()?.pending).toBe(false))
    const committed = await lost.committed; expect(committed.operation).toBe('demand.discuss')
    const id = directGoalRequest()!.id, original = binding(id), tab = useAppStore.getState().tabs[original.tabId]!
    expect((await owner.list()).map(value => value.id)).toEqual([id]); expect(starts()).toBe(1)
    expect(directGoalRequest()?.error).toBe('Original discussion receipt missing')
    expect(tab.regions[original.regionId]?.kind).toBe('agent')
    expect(useAppStore.getState().agentComposerDrafts.healthy).toBe('Original unsent draft')
    await act(async () => root.render(null)); await mount(); await click('Retry goal discussion'); await eventually(() => expect(directGoalRequest()).toBeNull())
    expect(binding(id)).toEqual(original); expect(creates()).toHaveLength(1); expect(starts()).toBe(1)
    expect((await discussionInput(id))?.systemContext).toContain(`existing Goal ${id}`)
  })

  it('keeps the saved Goal and original input when the configured Agent is unavailable, then continues that same Goal after configuration recovers', async () => {
    const configured = useAppStore.getState().config!
    const held = holdCreateReceipt()
    await mount(); await click('New Goal'); await held.committed
    await act(async () => { useAppStore.setState({ config: { ...configured, executors: {} } }); held.release() })
    await eventually(() => expect(directGoalRequest()?.pending).toBe(false))
    const goals = await owner.list(); expect(goals).toHaveLength(1)
    const id = goals[0]!.id
    expect(directGoalRequest()).toMatchObject({ id, phase: 'pmo', pending: false })
    expect(directGoalRequest()?.error).toMatch(/configured|unavailable/i)
    expect(starts()).toBe(0); expect(readGoalDiscussionBinding(currentCoreSpatialGraph()!, id)).toBeNull()
    expect(useAppStore.getState().sessions.some(session => session.id === 'primary')).toBe(true)
    expect(useAppStore.getState().agentComposerDrafts.healthy).toBe('Original unsent draft')
    useAppStore.setState({ config: configured })
    await click('Retry goal discussion'); await eventually(() => expect(directGoalRequest()).toBeNull())
    expect((await owner.list()).map(goal => goal.id)).toEqual([id]); expect(creates()).toHaveLength(1); expect(starts()).toBe(1)
  })

  it('preserves explicit Project and matching conditions while making the new shell visible', async () => {
    await mount(); await click('Goal filters')
    async function choose(label: string, value: string) { await chooseField(container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!, value) }
    const projectId = workspaceProjectId(config.workspaces[0]!)
    await choose('Filter project', projectId); await choose('Filter work status', 'backlog'); await choose('Filter routing', 'unassigned')
    await edit('Search goals', 'untitled'); await click('New Goal')
    // Observe only the already pending finite flight; a failed/nonpending request is never retried here.
    if (directGoalRequest()?.pending) await act(async () => retryDirectGoal())
    expect(directGoalRequest(), JSON.stringify(directGoalRequest())).toBeNull()
    const saved = (await owner.list())[0]!
    expect(saved).toMatchObject({ projectId, projectName: 'Repo' })
    expect((container.querySelector('[aria-label="Search goals"]') as HTMLInputElement).value).toBe('untitled')
    expect(container.querySelector('[aria-label="Filter project"]')?.getAttribute('data-value')).toBe(projectId)
    expect(container.querySelector('[aria-label="Filter work status"]')?.getAttribute('data-value')).toBe('backlog')
    expect(container.querySelector('[aria-label="Filter routing"]')?.getAttribute('data-value')).toBe('unassigned')
    expect([...container.querySelectorAll('[data-demand-id]')].map(node => node.getAttribute('data-demand-id'))).toEqual([saved.id])
    expect(creates()).toHaveLength(1); expect(creates()[0]?.demandId).toBe(saved.id); expect(host.executed('demand.discuss')).toHaveLength(1)
    expect(starts()).toBe(1); expect(api.sessions.launchAgent).not.toHaveBeenCalled(); expect(api.sessions.stop).not.toHaveBeenCalled()
  })

  it('clears only conditions that would hide the newly created Goal', async () => {
    await mount(); await click('Goal filters')
    for (const [label, value] of [['Filter work status', 'done'], ['Filter routing', 'assigned'], ['Filter assignee', demandAgentReferenceKey('healthy')]]) await chooseField(container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!, value!)
    await edit('Search goals', 'a different outcome'); await click('New Goal'); await eventually(() => expect(directGoalRequest()).toBeNull())
    const saved = (await owner.list())[0]!
    expect((container.querySelector('[aria-label="Search goals"]') as HTMLInputElement).value).toBe('')
    expect([...container.querySelectorAll<HTMLElement>('.goals-filters .selection-field')].map(node => node.dataset.value)).toEqual(['all', 'all', 'all', 'all'])
    expect([...container.querySelectorAll('[data-demand-id]')].map(node => node.getAttribute('data-demand-id'))).toEqual([saved.id])
  })

  it('attaches the created PMO without stealing a newer Goal selection, PMO focus or floating target', async () => {
    let finish!: () => void
    const launch = discussion.core.core.createAgentWithDelivery.bind(discussion.core.core)
    vi.spyOn(discussion.core.core, 'createAgentWithDelivery').mockImplementationOnce(async input => { await new Promise<void>(resolve => { finish = resolve; releaseHeldReceipt = resolve; if (tearingDown) resolve() }); return launch(input) })
    await mount(); await click('New Goal'); await eventually(() => expect(finish).toBeTypeOf('function'))
    const saved = (await owner.list())[0]!, mapped = spatialAgentOpenRecord((await host.spatial.read())!.graph, saved.discussionOperationId!)!.address.tabId
    await act(async () => { useAppStore.setState(state => ({ selectedDemandId: 'later-goal', agentFocus: { ...state.agentFocus, pmo: { ...state.agentFocus.pmo, sessionId: 'later-pmo' } } })); requestPmoTeamsTopicFloatingOpen({ targetTabId: originalTab.id }) })
    const laterPmo = useAppStore.getState().agentFocus.pmo, laterFloating = readPmoTeamsTopicFloatingState()
    await act(async () => finish()); await eventually(() => expect(directGoalRequest()).toBeNull())
    expect(useAppStore.getState().selectedDemandId).toBe('later-goal'); expect(useAppStore.getState().agentFocus.pmo).toBe(laterPmo)
    expect(readPmoTeamsTopicFloatingState()).toBe(laterFloating)
    expect(useAppStore.getState().tabs[mapped]!.regions[useAppStore.getState().tabs[mapped]!.layout.activeRegionId]?.kind).toBe('agent')
    expect(creates()).toHaveLength(1); expect(starts()).toBe(1); expect(api.sessions.stop).not.toHaveBeenCalled()
  })

  it('publishes the real saved Goal without stealing a later selection or navigation', async () => {
    const held = holdCreateReceipt()
    await mount(); await click('New Goal')
    const saved = await held.committed
    if (saved.operation !== 'demand.create') throw new Error('The held receipt belongs to another operation.')
    await act(async () => useAppStore.setState({ selectedDemandId: 'later-goal', mainSurface: 'workbench', activeWorkspaceId: 'repo' }))
    await act(async () => held.release()); await eventually(() => expect(directGoalRequest()?.pending).toBe(false))
    expect(useAppStore.getState().demands[saved.demand.id]?.id).toBe(saved.demand.id)
    expect(useAppStore.getState().selectedDemandId).toBe('later-goal'); expect(useAppStore.getState().mainSurface).toBe('workbench'); expect(useAppStore.getState().activeWorkspaceId).toBe('repo')
    expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  })

  it('retries a failed Mote open as an open action without silently starting Grill', async () => {
    const original = goal(); const open = vi.fn().mockRejectedValueOnce(new Error('Mote view unavailable')).mockResolvedValueOnce('mote-tab'); const request = vi.fn()
    useAppStore.setState({ demands: { [original.id]: original }, selectedDemandId: original.id, openDemandPmo: open, requestDemandPmoTask: request })
    await mount(); await click(`Open discussion for ${original.title}`)
    expect(container.querySelector('.goals-detail [role="status"]')?.textContent).toContain('discussion could not be opened')
    expect(request).not.toHaveBeenCalled(); await click('Retry opening discussion')
    expect(open.mock.calls).toEqual([[original.id], [original.id]]); expect(request).not.toHaveBeenCalled()
  })

  it('defaults to a nonempty list, filters honestly and keeps the same identity in the horizontal board', async () => {
    // Finished history holds a Done Goal whose current result was accepted; Done without acceptance stays visible
    // and points at the missing verification (behavior SSOT goals-and-demand「状态、筛选与路由队列」).
    const criteria = [{ id: 'ac', text: 'Original result exists' }]
    useAppStore.setState({ demands: { 'goal:one': goal(), 'goal:done': { ...goal('goal:done'), title: 'Previously done', status: 'done',
      alignment: { summary: 'Original result', criteria, openQuestions: [], revision: 1, confirmedAt: _reshape_fixtureEpoch(0, 0, 3) },
      grounding: { alignmentRevision: 1, summary: 'Checked', submissionId: 'accepted-report', submittedAt: _reshape_fixtureEpoch(0, 0, 4), acceptedAt: _reshape_fixtureEpoch(0, 0, 5),
        checks: [{ criterionId: 'ac', outcome: 'met', evidence: ['result.log:1'], note: 'Observed.' }] } } } })
    await mount(); expect([...container.querySelectorAll('[data-demand-id]')].map((node) => node.getAttribute('data-demand-id'))).toEqual(['goal:one'])
    expect(container.querySelector('.goals-list')).toBeTruthy(); expect(container.querySelector('.goals-filters')).toBeNull()
    await act(async () => (container.querySelector('[data-demand-id]') as HTMLElement).click()); expect(useAppStore.getState().selectedDemandId).toBe('goal:one')
    await click('Back to goals'); await click('Board view'); expect(container.querySelector('.goals-board')).toBeTruthy()
    await act(async () => (container.querySelector('[data-demand-id="goal:one"]') as HTMLElement).click())
    expect(container.querySelector('[data-demand-id="goal:one"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('.goals-board')).toBeNull()
    expect(useAppStore.getState().selectedDemandId).toBe('goal:one')
    await click('Show finished'); expect([...container.querySelectorAll('[data-demand-id]')].map((node) => node.getAttribute('data-demand-id'))).toEqual(['goal:one', 'goal:done'])
    await edit('Search goals', 'previously'); expect([...container.querySelectorAll('[data-demand-id]')].map((node) => node.getAttribute('data-demand-id'))).toEqual(['goal:done'])
    expect(useAppStore.getState().selectedDemandId).toBe('goal:one')
    await click('Clear search'); await click('Back to goals'); await click('List view'); expect(container.querySelectorAll('[data-demand-id]')).toHaveLength(2)
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
    expect(update).toHaveBeenCalledWith(original.id, { title: 'My clearer outcome' }, undefined, undefined)
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Goal title"]')?.value).toBe('My clearer outcome')
    expect(container.querySelector('.goals-detail [role="status"]')?.textContent).toContain('draft is kept')
    await click('Retry save'); expect(update).toHaveBeenCalledTimes(2)
  })

  it('keeps a newer title draft while the earlier save is in flight', async () => {
    const original = goal(); let resolve!: () => void
    const update = vi.fn(() => new Promise<void>((r) => { resolve = r; releaseHeldReceipt = () => r(); if (tearingDown) releaseHeldReceipt() }))
    useAppStore.setState({ demands: { [original.id]: original }, selectedDemandId: original.id, updateDemand: update })
    await mount(); const title = await edit('Goal title', 'First revision')
    await act(async () => title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await edit('Goal title', 'A newer unsent revision')
    await act(async () => { useAppStore.setState({ demands: { [original.id]: { ...original, title: 'First revision' } } }); resolve() })
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Goal title"]')?.value).toBe('A newer unsent revision')
    expect(update).toHaveBeenCalledExactlyOnceWith(original.id, { title: 'First revision' }, undefined, undefined)
  })

  it('retains a failed detail draft when reading another Goal and returning', async () => {
    const original = goal(), second = { ...goal('goal:two'), title: 'Another goal' }
    const update = vi.fn().mockRejectedValue(new Error('Save unavailable'))
    useAppStore.setState({ demands: { [original.id]: original, [second.id]: second }, selectedDemandId: original.id, updateDemand: update })
    await mount(); const title = await edit('Goal title', 'An unsaved but valuable title')
    await act(async () => title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(container.querySelector('.goals-detail [role="status"]')?.textContent).toContain('draft is kept')
    await act(async () => (container.querySelector('[data-demand-id="goal:two"]') as HTMLElement).click())
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Goal title"]')?.value).toBe('Another goal')
    await act(async () => (container.querySelector('[data-demand-id="goal:one"]') as HTMLElement).click())
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Goal title"]')?.value).toBe('An unsaved but valuable title')
    expect(Object.keys(useAppStore.getState().demands)).toEqual(['goal:one', 'goal:two'])
  })

  it('retries the actual failed property patch rather than pretending an empty save succeeded', async () => {
    const original = goal(); const update = vi.fn().mockRejectedValueOnce(new Error('Priority save unavailable')).mockResolvedValueOnce(undefined)
    useAppStore.setState({ demands: { [original.id]: original }, selectedDemandId: original.id, updateDemand: update })
    await mount(); await chooseField(container.querySelector<HTMLElement>('[aria-label="Goal priority"]')!, 'high')
    expect(update).toHaveBeenCalledExactlyOnceWith(original.id, { priority: 'high' }, undefined, undefined)
    expect(container.querySelector('.goals-detail [role="status"]')?.textContent).toContain('Priority save unavailable')
    await click('Retry save'); expect(update.mock.calls).toEqual([[original.id, { priority: 'high' }, undefined, undefined], [original.id, { priority: 'high' }, undefined, undefined]])
  })

  it('does no default Goal render work for unrelated Session output and tab facts', async () => {
    const related = { ...session('linked'), label: 'Linked Agent', status: { state: 'working' } } as SessionSnapshot
    const unrelated = { ...session('unrelated'), label: 'Unrelated Agent', status: { state: 'working' } } as SessionSnapshot
    const primary = useAppStore.getState().sessions
    const tabs = useAppStore.getState().tabs
    useAppStore.setState({ demands: { 'goal:one': { ...goal(), sessionIds: ['linked'] } }, sessions: [...primary, related, unrelated], selectedDemandId: 'goal:one' })
    const commits = vi.fn(); await act(async () => root.render(createElement(Profiler, { id: 'goals', onRender: commits }, createElement(GlobalBoardSurface))))
    expect(container.querySelector('[data-demand-id]')?.textContent).toContain('1 linked · working')
    expect(container.querySelector('.agent-topology-summary')).toBeNull()
    await eventually(() => expect(container.textContent).not.toContain('Checking the original continuation'))
    const count = commits.mock.calls.length; expect(count).toBeGreaterThan(0)
    await act(async () => useAppStore.setState({ sessions: [...primary, related, { ...unrelated, latestOutputBytes: 900000, updatedAt: _reshape_fixtureEpoch(0, 0, 12) }], tabs: { ...tabs } }))
    expect(commits.mock.calls.length).toBe(count)
  })
})
