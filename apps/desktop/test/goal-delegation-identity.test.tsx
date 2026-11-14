// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()

it('the original delegation follow-up requires its own Supervisor Host witness instead of borrowing a live namesake', async () => {
  const sid = 'supervisor-reference', foreign = composerSession(sid)
  const record: DemandRecord = { id: 'delegated-goal', title: 'Keep the original delegated work', description: '', status: 'in_progress', priority: 'normal',
    projectId: null, projectName: null, source: 'session', sessionIds: [], supervisorSessionId: sid, createdAt: 1, updatedAt: 1,
    delegations: [{ operationId: 'original-task', sourceMessageId: 'original-message', hostId: 'owner-host', ownerAgentSessionId: 'original-owner',
      workerAgentSessionId: 'original-worker', ownerRunId: 'owner-run', workerRunId: 'worker-run', threadId: 'original-thread', text: 'The original authorization',
      alignmentRevision: 1, criterionIds: ['outcome'], capturedCriteria: [{ id: 'outcome', text: 'Original outcome' }], preparedAt: 1, linkedAt: 2 }] }
  vi.spyOn(api.demands, 'delegation').mockResolvedValue({ goalId: record.id, goalUpdatedAt: 1, delegations: record.delegations!, observations: [], diskDurability: 'confirmed' })
  useAppStore.setState({ demands: { [record.id]: record }, selectedDemandId: record.id, mainSurface: 'board',
    sessions: [{ ...foreign, hostId: 'foreign-host', control: { ...foreign.control, hostId: 'foreign-host' } }], agentNames: { [sid]: 'Foreign namesake' } })
  await dom.render(<GlobalBoardSurface />)
  const identity = () => dom.container.querySelector('.goal-delegation__identity')!
  expect(identity()).not.toBeNull()
  expect(identity().textContent).toContain('Supervisor reference · Host unconfirmed')
  expect(identity().textContent).not.toContain('Foreign namesake')
  const witnessed = { ...record, creationOrigin: { operationId: 'original-create', requesterAsSupervisor: true, requesterParticipationId: 'original-discussion', supervisorDefaultPending: false },
    participations: [{ id: 'original-discussion', operationId: 'original-discussion', kind: 'discussion' as const, hostId: 'foreign-host', agentSessionId: sid, entryPoint: 'goal.discuss', recordedAt: 1 }] }
  await act(async () => useAppStore.setState({ demands: { [record.id]: witnessed } }))
  expect(identity().textContent).toContain('Foreign namesake')
  expect(identity().textContent).not.toContain('Host unconfirmed')
  const conflicting = { ...witnessed, delegations: record.delegations!.map(row => ({ ...row, ownerAgentSessionId: sid })) }
  await act(async () => useAppStore.setState({ demands: { [record.id]: conflicting } }))
  expect(identity().textContent).toContain('Supervisor reference · Host unconfirmed')
  expect(identity().textContent).not.toContain('Foreign namesake')
  expect(useAppStore.getState().agentComposerDrafts['agent-1']).toBe('Keep my draft')
})
