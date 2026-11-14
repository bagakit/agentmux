// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryDescriptor, ContinuousProgressLoop } from '@agentmux/core'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { GoalExecution } from '../src/renderer/src/components/GoalExecution'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { agentCardConversationFixture } from './helpers/agent-card-conversation-fixture'

const dom = composerDOM(), sid = 'original-worker', hostId = 'local', workspace = composerConfig.workspaces[0]!.path
const source = (host = hostId, id = sid): AgentSessionHistoryDescriptor => ({ hostId: host, agentSessionId: id, state: 'retired', retiredAt: 2,
  history: { executorId: 'codex', providerId: 'codex', workspacePath: workspace, createdAt: 1, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native' } } })
const goal = (): DemandProjection => ({ id: 'reference-goal', title: 'Original work', description: 'Keep the original request', status: 'in_progress', priority: 'normal',
  projectId: null, projectName: null, workspacePath: null, source: 'default-topic', sessions: [], sessionIds: [sid], assigneeSessionIds: [sid], supervisorSessionId: sid,
  participations: [{ id: 'original-discussion', operationId: 'original-discussion', kind: 'discussion', hostId, agentSessionId: sid, entryPoint: 'goal.discuss', recordedAt: 1 }], createdAt: 1, updatedAt: 1 })
const team = () => dom.container.querySelector<HTMLElement>('.goal-team')!
const unit = (host = hostId, id = sid) => [...team().querySelectorAll<HTMLElement>('[data-goal-team-identity]')].find(item => item.dataset.goalTeamIdentity === JSON.stringify([host, id]))
async function mount(record = goal(), active = true) { await dom.render(<WorkbenchPresentationContext.Provider value={{ active, retainedRegionId: null }}><GoalExecution demand={record} onUpdate={async () => false} /></WorkbenchPresentationContext.Provider>) }
async function button(text: string, root: ParentNode = team()) {
  const matches = [...root.querySelectorAll<HTMLButtonElement>('button')].filter(item => item.textContent === text)
  expect(matches).toHaveLength(1); await act(async () => matches[0]!.click())
}
beforeEach(() => {
  useAppStore.setState({ config: composerConfig, sessions: [], timelines: {}, agentNames: {}, goalAgentCreationDrafts: {}, goalAgentSelectionDrafts: {},
    agentComposerDrafts: { [sid]: 'Original unsent input' } })
  vi.spyOn(api.sessions, 'historySource').mockImplementation(async reference => ({ reference, source: source('hostId' in reference ? reference.hostId : '', reference.agentSessionId), issue: null }))
  vi.spyOn(api.conversation, 'readAgentConversation')
  vi.spyOn(useAppStore.getState(), 'executeControl').mockResolvedValue({ operation: 'demand.show', goalContinuations: [] } as never)
})

it('exact historical sources share one readable reference unit without promoting any bare current role', async () => {
  await mount()
  expect(team().querySelectorAll('[data-goal-team-reference]')).toHaveLength(1)
  expect(unit()?.querySelector('.focus-context__copy')).not.toBeNull()
  expect(unit()?.textContent).toContain('Retired Session'); expect(unit()?.textContent).toContain('Current Run is unconfirmed')
  expect(unit()?.querySelector('button.focus-context')).toBeNull(); expect(unit()?.querySelector('[data-session-id]')).toBeNull()
  expect(team().querySelectorAll('[data-role-host="unconfirmed"]')).toHaveLength(3)
  expect(unit()?.querySelectorAll('.goals-service')).toHaveLength(0)
  expect(unit()?.querySelector<HTMLElement>('.goal-team__source')?.title).toBe(hostId + ' · ' + workspace)
  expect(unit()?.querySelector('dl')?.textContent).toContain('Original workspace' + workspace)
  expect(api.conversation.readAgentConversation).not.toHaveBeenCalled()
})

it('a Supervisor witness qualifies only that role and leaves same-SID Executor and Related Hosts unconfirmed', async () => {
  await mount({ ...goal(), creationOrigin: { operationId: 'original-create', requesterAsSupervisor: true, requesterParticipationId: 'original-discussion', supervisorDefaultPending: false } })
  expect(unit()?.querySelectorAll('[data-goal-team-role]')).toHaveLength(1)
  expect(unit()?.querySelector('[data-goal-team-role="supervisor"]')).not.toBeNull()
  expect(team().querySelector('[data-goal-team-role="assignees"]')?.getAttribute('data-role-host')).toBe('unconfirmed')
  expect(team().querySelector('[data-goal-team-role="related"]')?.getAttribute('data-role-host')).toBe('unconfirmed')
})

it('same-SID historical Hosts remain exact separate sources while a bare role cannot choose either Host', async () => {
  const record = goal(); record.participations = [...record.participations!, { ...record.participations![0]!, id: 'foreign-source', hostId: 'other-host' }]
  await mount(record)
  expect(api.sessions.historySource).toHaveBeenCalledTimes(2)
  expect(unit()).toBeDefined(); expect(unit('other-host')).toBeDefined()
  expect(team().querySelectorAll('[data-goal-team-reference]')).toHaveLength(1)
  expect(team().querySelectorAll('[data-role-host="unconfirmed"]')).toHaveLength(3)
  expect(team().querySelector('.focus-context')).toBeNull()
})

it('one live namesake does not invent a Host for an unqualified original role', async () => {
  const other = { ...composerSession(sid), hostId: 'other-host', control: { ...composerSession(sid).control, hostId: 'other-host' } }
  useAppStore.setState({ sessions: [other] })
  await mount({ ...goal(), participations: [] })
  expect(api.sessions.historySource).not.toHaveBeenCalled()
  expect(team().querySelector('.focus-context')).toBeNull()
  expect(team().querySelector('[data-goal-team-unconfirmed]')?.textContent).toContain('Host is not confirmed')
  expect(team().querySelector('[aria-label="Choose Goal Supervisor"]')).not.toBeNull()
})

it('a deleted original record remains readable as a relationship without a fake Run or conversation action', async () => {
  vi.mocked(api.sessions.historySource).mockImplementation(async reference => ({ reference, source: { ...source(), state: 'deleted' }, issue: null }))
  await mount()
  expect(unit()?.textContent).toContain('Record deleted')
  expect(unit()?.textContent).toContain('original relationship is retained')
  expect(unit()?.querySelector('button')).toBeNull()
  expect(team().querySelector('.focus-context')).toBeNull()
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Original unsent input')
})

it('the exact retained conversation opens the shared public Reader without starting or selecting a replacement Agent', async () => {
  const original = composerSession(sid), captured = 'Original captured request retained before the Run ended'
  useAppStore.setState({ sessions: [original], timelines: { [sid]: { agentSessionId: sid, revision: 1, items: [
    { id: 'original-input', agentSessionId: sid, kind: 'user_message', title: 'Prompt', content: captured, source: 'native-hook', status: 'complete', createdAt: 1, updatedAt: 1 }
  ] } } })
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: sid, source: { providerId: 'codex', nativeSessionId: 'original-native' }, items: [], nextCursor: null })
  const conversation = await agentCardConversationFixture(() => ({ providerId: 'codex', nativeSessionId: 'original-native' }))
  const store = conversation.storeFor(hostId), stored = await store.readMetadata(sid)
  expect(stored).not.toBeNull()
  const retirement = { reservationId: 'original-retirement', ownerId: 'private-owner', ownerPid: process.pid, kind: 'stop' as const,
    agentSessionId: sid, operationId: 'original-retirement', expiresAt: Date.now() + 60_000, expectedRun: stored!.run,
    stopOperation: { daemonInstance: 'private-daemon', operationKey: 'original-retirement', runId: stored!.run.runId } }
  await store.reserveLifecycle(retirement); await store.commitLifecycle(retirement, null)
  const retained = await store.readHistorySource(sid)
  expect(retained?.state).toBe('retired')
  vi.mocked(api.sessions.historySource).mockResolvedValue({ reference: { hostId, agentSessionId: sid }, source: retained, issue: null })
  useAppStore.setState({ sessions: [], timelines: {} })
  const select = vi.spyOn(useAppStore.getState(), 'selectSession'), launch = vi.spyOn(api.sessions, 'launchAgent'), submit = vi.spyOn(api.sessions, 'submitPrompt')
  await mount(); expect(api.conversation.readAgentConversation).not.toHaveBeenCalled()
  await button('Read original conversation', unit()!)
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    const text = document.querySelector('.agent-session-action-surface')?.textContent
    expect(text, text ?? 'Original reading surface missing').toContain(captured)
  }, { timeout: 10_000, interval: 20 })
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls[0]?.[0]).toMatchObject({ hostId, agentSessionId: sid })
  expect(select).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Original unsent input')
})

it('relationship editing and a new Loop use native disclosures while an existing original Loop stays visible and exact', async () => {
  await mount()
  expect(team().querySelector<HTMLDetailsElement>('.goal-team__edit')?.open).toBe(false)
  expect(team().querySelector<HTMLDetailsElement>('.goals-continuation__configure')?.open).toBe(false)
  const loop = { loopId: 'original-loop', creationOperationId: 'original-start', revision: 3, hostId: 'original-loop-host', agentSessionId: 'original-loop-agent',
    status: 'active', intervalMs: 120000, taskSource: { kind: 'goal', goalId: goal().id, alignmentRevision: 5 }, nextCheckAt: 100,
    initialDelivery: { state: 'unconfirmed', operationId: 'original-start' } } as ContinuousProgressLoop
  const execute = vi.mocked(useAppStore.getState().executeControl).mockImplementation(async request => {
    if (request.operation === 'demand.show') return { operation: 'demand.show', goalContinuations: [loop] } as never
    throw Error('Original receipt remains unknown')
  })
  await button('Check')
  expect(team().querySelector('.goals-continuation__configure')).toBeNull()
  expect(team().querySelector('.goals-continuation__saved')?.closest('details')).toBeNull()
  await button('Inspect and retry original start')
  expect(execute.mock.calls.filter(([request]) => request.operation === 'demand.start').map(([request]) => request)).toEqual([
    { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'original-start', operation: 'demand.start', demandId: goal().id, sessionId: 'original-loop-agent', continuation: { intervalMs: 120000, alignmentRevision: 5 } }
  ])
})

it('a covered Goal does not start its metadata or continuation reads', async () => {
  await mount(goal(), false)
  expect(api.sessions.historySource).not.toHaveBeenCalled()
  expect(useAppStore.getState().executeControl).not.toHaveBeenCalled()
})
