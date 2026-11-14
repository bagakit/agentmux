// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { GoalPlanRequest } from '../src/renderer/src/components/GoalPlanRequest'
import { GoalPatrolControl } from '../src/renderer/src/components/GoalPatrolControl'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingClose } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM(), sid = 'original-supervisor'
const goal = (): DemandProjection => ({ id: 'exact-request', title: 'Original request target', description: '', status: 'in_progress', priority: 'normal',
  projectId: null, projectName: null, source: 'default-topic', workspacePath: null, sessions: [], sessionIds: [sid], assigneeSessionIds: [sid], supervisorSessionId: sid, createdAt: 1, updatedAt: 1 })
function presentation(hostId: string, runId = 'current-run') {
  return { ...composerSession(hostId + '-view'), hostId, label: hostId === 'original-host' ? 'Exact Supervisor' : 'Foreign namesake',
    control: { kind: 'agent' as const, hostId, agentSessionId: sid, run: { runId } } }
}
function patrol(purpose?: 'plan', attempt = false) {
  return { operationId: 'original-request', expectedScope: 'original-scope', supervisorAgentSessionId: sid, context: '{}', executions: [],
    requestedBy: { kind: 'user' as const, id: 'original-person' }, requestedAt: 1, ...(purpose ? { purpose, planRevision: 0 } : {}),
    attempts: attempt ? [{ operationId: 'original-input', actionOperationId: 'original-request', intentId: 'original-input', preparedAt: 1, agentMuxNote: 'Original request',
      target: { hostId: 'original-host', agentSessionId: sid, runId: 'original-run', providerId: 'codex', workspacePath: '/original' } }] : [] }
}
function witness(record: DemandProjection): DemandProjection {
  return { ...record, creationOrigin: { operationId: 'original-create', requesterAsSupervisor: true, requesterParticipationId: 'requester', supervisorDefaultPending: false },
    participations: [{ id: 'requester', operationId: 'original-create', kind: 'create', agentSessionId: sid, hostId: 'original-host', entryPoint: 'goal.create', recordedAt: 1 }] }
}
function seed(record: DemandProjection, sessions = [presentation('foreign-host')]) {
  useAppStore.setState({ demands: { [record.id]: record }, sessions, goalDiscussionRequests: {}, agentNames: {}, timelines: {}, agentComposerDrafts: { original: 'Keep this draft' } })
}
const buttons = () => [...dom.container.querySelectorAll<HTMLButtonElement>('button')]
function button(label: string) { const found = buttons().find(item => item.textContent?.trim() === label); expect(found, label).toBeDefined(); return found! }
async function plan(record: DemandProjection, onRequest = vi.fn()) { seed(record); await dom.render(<GoalPlanRequest demand={record} onRequest={onRequest} pending={false} busy={false} />); return onRequest }
beforeEach(() => {
  requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
  vi.spyOn(api.demands, 'onChanged').mockReturnValue(() => {})
  vi.spyOn(api.demands, 'delegation').mockImplementation(async (_method, input) => ({ goalId: input.goalId, goalUpdatedAt: 1, delegations: [], diskDurability: 'confirmed' }))
})

it('bare planning Supervisor keeps its actual Open destination unknown and its original request enabled despite a unique foreign namesake', async () => {
  const request = await plan(goal())
  expect(dom.container.textContent).not.toContain('Foreign namesake')
  expect(button('Ask Supervisor to split work').disabled).toBe(false)
  await act(async () => button('Open Supervisor conversation').click())
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true, agentTarget: { agentSessionId: null }, targetTabId: null })
  expect(readPmoTeamsTopicFloatingState()?.targetAgent).toBeUndefined()
  await act(async () => button('Ask Supervisor to split work').click())
  expect(request).toHaveBeenCalledOnce()
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Keep this draft')
})

it('one saved Supervisor Host opens that exact object while conflicting witnesses keep the same Open unknown', async () => {
  const record = witness(goal())
  seed(record, [presentation('original-host'), presentation('foreign-host')])
  await dom.render(<GoalPlanRequest demand={record} onRequest={() => {}} pending={false} busy={false} />)
  await act(async () => button('Open Exact Supervisor conversation').click())
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ agentTarget: { agentSessionId: sid, hostId: 'original-host' } })
  const conflict = { ...record, delegations: [{ operationId: 'saved-delegation', sourceMessageId: 'saved-source', ownerAgentSessionId: sid, ownerRunId: 'owner-run', hostId: 'foreign-host',
    workerAgentSessionId: 'worker', workerRunId: 'worker-run', threadId: 'original-thread', text: 'Original task', alignmentRevision: 1, criterionIds: [], capturedCriteria: [], preparedAt: 1 }] }
  seed(conflict, [presentation('original-host'), presentation('foreign-host')])
  await dom.render(<GoalPlanRequest demand={conflict} onRequest={() => {}} pending={false} busy={false} />)
  expect(dom.container.textContent).not.toContain('Exact Supervisor')
  expect(dom.container.textContent).not.toContain('Foreign namesake')
  await act(async () => button('Open Supervisor conversation').click())
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ agentTarget: { agentSessionId: null }, targetTabId: null })
})

it('a retained planning request gets no continuation Run from bare foreign inventory but keeps its exact attempted Host eligible', async () => {
  const unknown = inspection({ ...goal(), patrols: [patrol('plan')] }, 'foreign-host', 'foreign-run')
  unknown.responsibility!.supervisor.state = 'available'
  await plan(unknown)
  expect(buttons().some(item => item.textContent === 'Continue original planning request')).toBe(false)
  await act(async () => button('Open Supervisor conversation').click())
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ agentTarget: { agentSessionId: null }, targetTabId: null })
  const exact = { ...goal(), patrols: [patrol('plan', true)] }
  seed(exact, [presentation('original-host', 'current-original-run'), presentation('foreign-host', 'foreign-run')])
  await dom.render(<GoalPlanRequest demand={exact} onRequest={() => {}} pending={false} busy={false} />)
  await act(async () => button('Continue original planning request').click())
  expect(api.demands.delegation).toHaveBeenCalledWith('goal.patrol.continue', expect.objectContaining({ goalId: exact.id, patrolOperationId: 'original-request', expectedRunId: 'current-original-run' }))
})

it('planning Open and continuation read the complete frozen attempt tuple instead of mixing an old Supervisor reference with its Host', async () => {
  const record = { ...goal(), supervisorSessionId: 'retained-role-reference', patrols: [{ ...patrol('plan', true), supervisorAgentSessionId: 'retained-role-reference' }] }
  const reference = { ...presentation('original-host', 'reference-run'), id: 'role-reference-view', control: { kind: 'agent' as const, hostId: 'original-host', agentSessionId: 'retained-role-reference', run: { runId: 'reference-run' } } }
  seed(record, [presentation('original-host', 'current-attempt-run'), reference])
  await dom.render(<GoalPlanRequest demand={record} onRequest={() => {}} pending={false} busy={false} />)
  await act(async () => button('Open Exact Supervisor conversation').click())
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ agentTarget: { agentSessionId: sid, hostId: 'original-host' } })
  await act(async () => button('Continue original planning request').click())
  expect(api.demands.delegation).toHaveBeenCalledWith('goal.patrol.continue', expect.objectContaining({ patrolOperationId: 'original-request', expectedRunId: 'current-attempt-run' }))
})

function inspection(record: DemandProjection, hostId?: string, runId = 'original-run'): DemandProjection {
  return { ...record, responsibility: { scope: 'original-scope', observedAt: 1,
    supervisor: { agentSessionId: sid, state: 'ended', reason: 'Original management observation', runId, ...(hostId ? { hostId } : {}) },
    executions: [{ execution: { kind: 'start', operationId: 'execution', hostId: 'execution-host', agentSessionId: 'worker', runId: 'worker-run' }, phase: 'unknown', binding: 'unconfirmed',
      reason: 'The original input remains unconfirmed', alert: 'unknown', nextOwner: { kind: 'manager', agentSessionId: sid, action: 'Inspect the original work' }, basis: { stateEnteredAt: null, activityRevision: null, inputSubmissionId: null } }] } }
}
function inspectionOwner(record: DemandProjection) {
  let saved = patrol()
  vi.mocked(api.demands.delegation).mockImplementation(async (method, input) => {
    if (method === 'goal.patrol' && 'operationId' in input) saved = { ...patrol(), operationId: input.operationId }
    return { goalId: record.id, goalUpdatedAt: 1, delegations: [], diskDurability: 'confirmed', patrols: [saved] }
  })
}
async function inspect(label: string, recovery: ReturnType<typeof vi.spyOn>) {
  await act(async () => button(label).click())
  const calls = vi.mocked(api.demands.delegation)
  await vi.waitFor(() => expect(calls.mock.calls.some(([method]) => method === 'goal.patrol')).toBe(true))
  const index = calls.mock.calls.findLastIndex(([method]) => method === 'goal.patrol')
  await act(async () => { await calls.mock.results[index]!.value })
  expect(recovery).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(button(label).getAttribute('aria-busy')).toBe('false'))
}

it('a bare inspection target opens a placeholder and still calls the original Goal owner without recovering the foreign namesake', async () => {
  const record = inspection(goal()), recovery = vi.spyOn(useAppStore.getState(), 'recoverSession')
  seed(record)
  inspectionOwner(record)
  await dom.render(<GoalPatrolControl demand={record} />)
  expect(dom.container.textContent).not.toContain('Foreign namesake')
  await act(async () => button('Open owner conversation').click())
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ agentTarget: { agentSessionId: null }, targetTabId: null })
  await inspect('Request owner inspection', recovery)
  expect(api.demands.delegation).toHaveBeenCalledWith('goal.patrol', expect.objectContaining({ goalId: record.id, operationId: expect.any(String) }))
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ agentTarget: { agentSessionId: null }, targetTabId: null })
  expect(recovery).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Keep this draft')
})

it('inspection recovery does not replace a newer healthy Run with an ended observation on the same exact Host', async () => {
  const record = inspection(witness(goal()), 'original-host'), recovery = vi.spyOn(useAppStore.getState(), 'recoverSession')
  seed(record, [presentation('original-host', 'newer-healthy-run')])
  inspectionOwner(record)
  await dom.render(<GoalPatrolControl demand={record} />)
  await inspect('Request inspection from Exact Supervisor', recovery)
  expect(recovery).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions[0]?.control.run.runId).toBe('newer-healthy-run')
})

it('an original inspection attempt keeps its Host when a namesake manager on another Host offers a continuation Run', async () => {
  const record = inspection({ ...goal(), patrols: [patrol(undefined, true)] }, 'foreign-host', 'foreign-run')
  record.responsibility!.supervisor.state = 'available'
  seed(record, [presentation('original-host', 'current-original-run'), presentation('foreign-host', 'foreign-run')])
  await dom.render(<GoalPatrolControl demand={record} />)
  expect(buttons().some(item => item.textContent === 'Continue original inspection')).toBe(false)
  await act(async () => button('Open Exact Supervisor conversation').click())
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ agentTarget: { agentSessionId: sid, hostId: 'original-host' } })
})

it('a zero-attempt original inspection never borrows the current same-SID manager Host or Run', async () => {
  const record = inspection({ ...goal(), patrols: [patrol()] }, 'foreign-host', 'foreign-run')
  record.responsibility!.supervisor.state = 'available'
  seed(record)
  await dom.render(<GoalPatrolControl demand={record} />)
  expect(dom.container.textContent).not.toContain('Foreign namesake')
  expect(buttons().some(item => item.textContent === 'Continue original inspection')).toBe(false)
  await act(async () => button('Open owner conversation').click())
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ agentTarget: { agentSessionId: null }, targetTabId: null })
})
