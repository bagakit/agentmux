// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'
import type { RuntimeEvent, SessionHistorySourceObservation, SessionHistorySourceReference } from '../src/shared/contracts'
import { GoalExecution } from '../src/renderer/src/components/GoalExecution'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM(), sid = 'original-retained-worker', hostId = 'worker-owner'
const reference = { hostId, agentSessionId: sid }, key = JSON.stringify([hostId, sid])
const source: AgentSessionHistoryDescriptor = { ...reference, state: 'retired', retiredAt: 8,
  history: { executorId: 'original-configuration', providerId: 'claude', workspacePath: '/original/work', createdAt: 1 } }
const goal = (): DemandProjection => ({ id: 'retained-goal', title: 'Keep this exact original work', description: 'Original intent', status: 'in_progress', priority: 'normal',
  projectId: null, projectName: null, workspacePath: null, sessions: [], source: 'default-topic', sessionIds: [sid, 'bare-without-host', 'healthy'], assigneeSessionIds: [sid], supervisorSessionId: null,
  participations: [{ id: 'original-discussion', operationId: 'original-discussion', kind: 'discussion', agentSessionId: sid, hostId, entryPoint: 'goal.discuss', recordedAt: 1 }], createdAt: 1, updatedAt: 1 })
const row = () => [...dom.container.querySelectorAll<HTMLElement>('[data-goal-team-identity]')].find(node => node.dataset.goalTeamIdentity === key)!
let listeners: Set<(event: RuntimeEvent) => void>
const event = (type: 'run-removed' | 'agent-session-record-deleted', agentSessionId = sid, route = hostId): RuntimeEvent => ({ type: 'core', hostId: route,
  event: type === 'run-removed' ? { type, agentSessionId, run: { runId: 'original-run' } } : { type, agentSessionId, retiredAt: 8,
    recordDeletion: { operationId: 'original-delete', retirementRevision: 'a'.repeat(64), deletedAt: 9, phase: 'complete' } } } as RuntimeEvent)
async function publish(value: RuntimeEvent) { await act(async () => { for (const listener of listeners) listener(value) }) }
beforeEach(() => {
  listeners = new Set()
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
  vi.spyOn(useAppStore.getState(), 'executeControl').mockResolvedValue({ operation: 'demand.show', goalContinuations: [] } as never)
  useAppStore.setState({ config: composerConfig, sessions: [composerSession('healthy')], timelines: {}, agentNames: {},
    goalAgentCreationDrafts: {}, goalAgentSelectionDrafts: {}, agentComposerDrafts: { [sid]: 'Original unsent draft' } })
})
async function mount(record = goal()) { await dom.render(<GoalExecution demand={record} onUpdate={async () => false} />) }

it('the actual Team uses the shared worker Host instead of its delegation owner or same-shaped bare assignment', async () => {
  const record = { ...goal(), participations: [], delegations: [{ operationId: 'original-delegation', sourceMessageId: 'original-message', hostId: 'owner-host', workerHostId: hostId,
    ownerAgentSessionId: 'original-owner', workerAgentSessionId: sid, ownerRunId: 'owner-run', workerRunId: 'worker-run', threadId: 'original-thread', text: 'Original work', alignmentRevision: 1,
    criterionIds: ['original-criterion'], capturedCriteria: [{ id: 'original-criterion', text: 'Original criterion' }], preparedAt: 1 }] }
  const read = vi.spyOn(api.sessions, 'historySource').mockImplementation(async reference => ({ reference,
    source: { ...source, hostId: 'hostId' in reference ? reference.hostId : '', agentSessionId: reference.agentSessionId }, issue: null }))
  await mount(record)
  expect(row()?.textContent).toContain('delegation-worker')
  expect(read.mock.calls.map(([reference]) => reference)).toEqual([
    { hostId: 'owner-host', agentSessionId: 'original-owner' }, { hostId, agentSessionId: sid }
  ])
  expect(dom.container.querySelector('[data-goal-team-unconfirmed="original-retained-worker"]')).not.toBeNull()
})

it('the Team shares only original Supervisor witnesses with the Host and does not promote an old discussion', async () => {
  const read = vi.spyOn(api.sessions, 'historySource').mockResolvedValue({ reference, source, issue: null })
  const original = { ...goal(), supervisorSessionId: sid }
  await mount(original)
  expect(row()?.textContent).toContain('discussion'); expect(row()?.textContent).not.toContain('supervisor')
  await mount({ ...original, creationOrigin: { operationId: 'original-goal-create', requesterAsSupervisor: true,
    requesterParticipationId: original.participations![0]!.id, supervisorDefaultPending: false } })
  expect(row()?.textContent).toContain('supervisor')
  expect(read).toHaveBeenCalledExactlyOnceWith(reference)
})

it('the mounted Team reads only its exact retained source without assigning a Host to bare roles or granting Run controls', async () => {
  const read = vi.spyOn(api.sessions, 'historySource').mockResolvedValue({ reference, source, issue: null })
  const forbidden = ['historySources', 'historyPage', 'readHistory', 'recover', 'resume', 'launchAgent', 'stop', 'submitPrompt'].map(name => vi.spyOn(api.sessions, name as 'historyPage'))
  const before = useAppStore.getState().agentComposerDrafts
  await mount()
  expect(read).toHaveBeenCalledExactlyOnceWith(reference)
  expect(row()?.textContent).toContain('Retired original Session'); expect(row()?.textContent).toContain('original-configuration')
  expect(row()?.textContent).toContain('Current Run is not observed')
  expect(row()?.querySelector('.focus-context')).toBeNull(); expect(row()?.querySelector('[data-session-id]')).toBeNull()
  expect(dom.container.querySelector('[data-goal-team-unconfirmed="bare-without-host"]')).not.toBeNull()
  expect(dom.container.querySelectorAll('button.focus-context')).toHaveLength(1)
  for (const control of forbidden) expect(control).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts).toBe(before)
})

it('a failed precise refresh preserves confirmed metadata and the same original relationship for retry', async () => {
  const read = vi.spyOn(api.sessions, 'historySource').mockResolvedValueOnce({ reference, source, issue: null })
    .mockRejectedValueOnce(new Error('Original metadata read unavailable')).mockResolvedValue({ reference, source, issue: null })
  await mount(); expect(row()?.textContent).toContain('Retired original Session')
  await publish(event('run-removed'))
  expect(read).toHaveBeenCalledTimes(2); expect(row()?.textContent).toContain('Original metadata read unavailable')
  expect(row()?.textContent).toContain('original-configuration')
  await act(async () => row()!.querySelector<HTMLButtonElement>('button')!.click())
  expect(read.mock.calls).toEqual([[reference], [reference], [reference]])
  expect(row()?.textContent).not.toContain('unavailable'); expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Original unsent draft')
})

it('an exact record-deleted fact fences a late active metadata response without querying a foreign namesake', async () => {
  let finish!: (value: SessionHistorySourceObservation) => void
  const read = vi.spyOn(api.sessions, 'historySource').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await mount(); expect(read).toHaveBeenCalledExactlyOnceWith(reference)
  await publish(event('agent-session-record-deleted', sid, 'other-host'))
  expect(row()?.textContent).not.toContain('Original record deleted')
  await publish(event('agent-session-record-deleted'))
  expect(row()?.textContent).toContain('Original record deleted')
  await act(async () => finish({ reference, source: { ...source, state: 'active' }, issue: null }))
  expect(row()?.textContent).toContain('Original record deleted'); expect(row()?.textContent).not.toContain('Retained original Session')
  expect(read).toHaveBeenCalledTimes(1)
})

it('a changed Goal cannot accept the previous original identity response', async () => {
  const finishes: Array<(value: SessionHistorySourceObservation) => void> = []
  const read = vi.spyOn(api.sessions, 'historySource').mockImplementation(() => new Promise(resolve => finishes.push(resolve)))
  await mount(); await mount({ ...goal(), id: 'next-goal' })
  await act(async () => finishes[0]!({ reference, source, issue: null }))
  expect(row()?.textContent).not.toContain('Retired original Session')
  expect(read).toHaveBeenCalledTimes(2)
  await act(async () => finishes[1]!({ reference, source: { ...source, state: 'active' }, issue: null }))
  expect(row()?.textContent).toContain('Retained original Session')
})

it.each([1, 1000])('the mounted exact Team reader with %i Sessions ignores unrelated output and identity lifecycle events', async count => {
  const raw = [composerSession('healthy'), ...Array.from({ length: count - 1 }, (_, index) => composerSession('unrelated-' + index))], costs = { inventory: 0, commits: 0 }
  const sessions = new Proxy(raw, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/u.test(key)) costs.inventory++; return Reflect.get(target, key, receiver) } })
  useAppStore.setState({ sessions })
  const read = vi.spyOn(api.sessions, 'historySource').mockResolvedValue({ reference, source, issue: null })
  await dom.render(<Profiler id="exact-Team" onRender={() => costs.commits++}><GoalExecution demand={goal()} onUpdate={async () => false} /></Profiler>)
  expect(read).toHaveBeenCalledExactlyOnceWith(reference); costs.inventory = costs.commits = 0
  for (let revision = 1; revision <= 4; revision++) {
    await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision, items: [] } } })))
    await publish(event('run-removed', 'unrelated-' + revision))
  }
  expect(costs).toEqual({ inventory: 0, commits: 0 }); expect(read).toHaveBeenCalledTimes(1)
})
