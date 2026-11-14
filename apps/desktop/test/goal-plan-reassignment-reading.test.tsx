// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { GoalDelegationWork } from '../src/renderer/src/components/GoalDelegationWork'
import { goalPlanProjection } from '../src/renderer/src/components/GoalPlanGraph'
import { goalDelegationRows } from '../src/renderer/src/lib/goal-delegation-presentation'
import { composerDOM } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'

const dom = composerDOM()
const attempt = { operationId: 'original-attempt', sourceMessageId: 'original-source', threadId: 'original-thread', hostId: 'local', ownerAgentSessionId: 'supervisor',
  ownerRunId: 'supervisor-run', workerAgentSessionId: 'worker-a', workerRunId: 'worker-a-run', text: 'Original task body', alignmentRevision: 1, criterionIds: ['criterion'],
  planNodeId: 'node', capturedCriteria: [{ id: 'criterion', text: 'Original criterion' }], preparedAt: 2, linkedAt: 3,
  report: { operationId: 'late-report', replyMessageId: 'late-reply', authorAgentSessionId: 'worker-a', submittedAt: 5,
    grounding: { alignmentRevision: 1, summary: 'A late original result stays readable', checks: [{ criterionId: 'criterion', outcome: 'met' as const, evidence: ['logs/original.log'], note: '' }] } } }
function goal(): DemandRecord {
  return { id: 'original-goal', title: 'Original Goal', description: '', status: 'in_progress', priority: 'normal', projectId: null, projectName: null, source: 'session',
    sessionIds: ['supervisor', 'worker-a', 'worker-b'], assigneeSessionIds: ['supervisor', 'worker-a', 'worker-b'], supervisorSessionId: 'supervisor', createdAt: 1, updatedAt: 6,
    plan: { revision: 2, alignmentRevision: 1, nodes: [{ id: 'node', title: 'Original node', outcome: 'Original result', check: 'check original', criterionIds: ['criterion'], dependsOn: [], executor: { hostId: 'local', agentSessionId: 'worker-b' } }], reviews: [],
      history: [1, 2].map(revision => ({ operationId: `revision-${revision}`, revision, revisedAt: revision, author: { kind: 'agent' as const, id: 'supervisor' } })) },
    planState: { revision: 2, done: 0, total: 1, next: ['node'], nodes: [{ id: 'node', state: 'ready', column: 0, attempts: 1, staleCriteria: [], unknown: [], attempt: null }] },
    delegations: [attempt] }
}
it('the mounted work reader marks a superseded report as a previous attempt using only the owner current-attempt identity', async () => {
  const record = goal()
  expect(goalPlanProjection(record)?.nodes[0]).toMatchObject({ state: 'ready', delegation: null })
  expect(goalDelegationRows(record)[0]).toMatchObject({ previousAttempt: true, report: { replyMessageId: 'late-reply' } })
  useAppStore.setState({ demands: { [record.id]: record } })
  await dom.render(<GoalDelegationWork demand={record} active={false} />)
  const row = dom.container.querySelector('[data-goal-attempt="previous"]')!
  expect(row).not.toBeNull(); expect(row.textContent).toContain('Previous attempt')
  expect(row.textContent).toContain('A late original result stays readable')
  const disclosure = row.querySelector<HTMLDetailsElement>('.goal-delegation__source')!
  await act(async () => disclosure.querySelector<HTMLElement>('summary')!.click())
  await vi.waitFor(() => expect(disclosure.querySelector('[data-option="execution"]')).not.toBeNull())
  await act(async () => disclosure.querySelector<HTMLButtonElement>('[data-option="execution"]')!.click())
  expect(disclosure.textContent).toContain('original-source'); expect(disclosure.textContent).toContain('original-thread')
  const { planState: _, ...unavailable } = record
  expect(goalDelegationRows(unavailable)[0]).not.toHaveProperty('previousAttempt')
})
