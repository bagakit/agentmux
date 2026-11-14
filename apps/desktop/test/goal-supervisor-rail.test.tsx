// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DemandDelegation } from '@agentmux/demand/delegations'
import type { GoalPlanNodeInput } from '@agentmux/demand/goal-plan'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'
import { GoalSupervisorRail } from '../src/renderer/src/components/GoalSupervisorRail'

// The existing identity renderer and presentation context are leaves of this slice.
// The mounted rail must supply the exact original Host; whole-workbench integration owns their reads.
vi.mock('../src/renderer/src/components/GoalContinuationControl', () => ({
  GoalContinuationAgent: ({ agentSessionId, hostId }: { agentSessionId: unknown; hostId?: string }) =>
    <strong data-original-supervisor-host={hostId} data-original-supervisor-reference={JSON.stringify(agentSessionId)}>{hostId === 'source-host' ? 'Original Supervisor name' : 'Other Host name'}</strong>
}))
vi.mock('../src/renderer/src/lib/workbench-presentation', () => ({ useWorkbenchPresentationActive: () => true }))
vi.mock('../src/renderer/src/lib/goal-discussion-recipient', () => ({ useGoalAgentName: () => null }))

const node = (id: string): GoalPlanNodeInput => ({ id, title: `Task ${id}`, outcome: 'An observable result', dependsOn: [], criterionIds: ['criterion'], check: 'check result', executor: null })
const delegation = (operationId: string, planNodeId = 'task'): DemandDelegation => ({ operationId, planNodeId, sourceMessageId: `message-${operationId}`,
  hostId: 'source-host', workerHostId: 'worker-host', ownerAgentSessionId: 'supervisor', workerAgentSessionId: 'worker',
  ownerRunId: 'owner-run', workerRunId: 'worker-run', threadId: `thread-${operationId}`, text: 'Original assignment', alignmentRevision: 1,
  criterionIds: ['criterion'], capturedCriteria: [{ id: 'criterion', text: 'Observable result' }], preparedAt: 10, linkedAt: 11 })
const goal = (patch: Partial<DemandProjection> = {}): DemandProjection => ({ id: 'goal', title: 'Complete the work', description: '', status: 'in_progress', priority: 'normal',
  projectId: null, projectName: null, source: 'session', sessionIds: [], sessions: [], workspacePath: null, createdAt: 1, updatedAt: 1,
  supervisorSessionId: 'supervisor', plan: { revision: 1, alignmentRevision: 1, nodes: [node('task'), node('other')], reviews: [],
    history: [{ operationId: 'plan-operation', revision: 1, author: { kind: 'agent', id: 'plan-author', hostId: 'plan-host', runtimeId: 'plan-runtime' }, revisedAt: 5 }] },
  delegations: [delegation('old-attempt')], ...patch })
let container: HTMLDivElement, root: Root
const discussion = vi.fn(), reveal = vi.fn()
const render = async (demand: DemandProjection) => { await act(async () => root.render(<GoalSupervisorRail demand={demand} onOpenDiscussion={discussion} onRevealAttempt={reveal} />)) }
const click = async (selector: string) => { const button = container.querySelector<HTMLButtonElement>(selector)!; expect(button).not.toBeNull(); await act(async () => button.click()); return button }
const showAll = async () => { const button = [...container.querySelectorAll('button')].find(button => button.textContent?.startsWith('Show ')); if (button) await act(async () => button.click()) }

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); discussion.mockClear(); reveal.mockClear() })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

describe('Goal Supervisor reading rail', () => {
  it('passes only a uniquely witnessed original Host to the existing name/avatar renderer', async () => {
    const demand = goal()
    await render(demand)
    expect(container.querySelector('[data-original-supervisor-host]')?.getAttribute('data-original-supervisor-host')).toBe('source-host')
    expect(container.textContent).toContain('Original Supervisor name')
    expect(container.textContent).not.toContain('Other Host name')
    const conflicting = { ...demand, plan: { ...demand.plan!, history: [{ ...demand.plan!.history[0]!, author: { kind: 'agent' as const, id: 'supervisor', hostId: 'other-host' } }] } }
    await render(conflicting)
    expect(container.querySelector('[data-original-supervisor-host]')).toBeNull()
    expect(container.textContent).toContain('Supervisor Host is conflicting')
    await render(goal({ delegations: [], supervisorSessionId: null }))
    expect(container.textContent).toContain('No Supervisor assigned')
    await click('.goal-supervisor-rail__discussion')
    expect(discussion).toHaveBeenCalledTimes(1)
  })

  it('shows one original coordination responsibility and keeps discussion available when observations are unknown', async () => {
    const execution = { kind: 'delegation' as const, operationId: 'old-attempt', hostId: 'source-host', agentSessionId: 'worker', runId: 'worker-run' }
    const common = { execution, binding: 'confirmed' as const, reason: 'Original owner reason', basis: { stateEnteredAt: null, activityRevision: null, inputSubmissionId: null } }
    await render(goal({ responsibility: { scope: 'scope', observedAt: 20, supervisor: { agentSessionId: 'supervisor', state: 'unknown', reason: 'Observation unavailable' }, executions: [
      { ...common, phase: 'executing', alert: null, nextOwner: { kind: 'worker', agentSessionId: 'worker', action: 'Keep the original work' } },
      { ...common, phase: 'report-review', alert: 'manager-review', nextOwner: { kind: 'manager', agentSessionId: 'supervisor', action: 'Collect the original report' } }
    ] }, delegationObservationIssue: 'The original observation is unavailable.' }))
    expect(container.querySelectorAll('[data-goal-supervisor-next]')).toHaveLength(1)
    expect(container.querySelector('[data-goal-supervisor-next]')?.textContent).toBe('Supervisor’s next stepCollect the original report')
    expect(container.textContent).not.toContain('Keep the original work')
    expect([...container.querySelectorAll('[role="status"]')].map(element => element.textContent)).toEqual(['Supervisor observation unconfirmed', 'The original observation is unavailable.'])
    const source = container.querySelector<HTMLDetailsElement>('[data-goal-supervisor-source]')!
    expect(source.open).toBe(false)
    expect(source.textContent).toContain('Observation unavailable')
    await click('.goal-supervisor-rail__discussion')
    expect(discussion).toHaveBeenCalledTimes(1)
    expect(reveal).not.toHaveBeenCalled()
  })

  it('keeps original authors and exactly linked old attempts; unrelated and missing attempts cannot navigate', async () => {
    const old = delegation('old-attempt'), current = delegation('current-attempt')
    current.report = { operationId: 'report-operation', replyMessageId: 'reply', authorAgentSessionId: 'worker', submittedAt: 30,
      grounding: { alignmentRevision: 1, summary: 'Full delivery stays in the original task reader', checks: [] } }
    current.collection = { operationId: 'collection-operation', replyMessageId: 'reply', collector: { kind: 'device', id: 'collecting-device' }, collectedAt: 31 }
    const demand = goal({ delegations: [old, current], decisions: [{ id: 'decision-record', createdAt: 50, actorId: 'decision-writer', question: 'Which option?', decision: 'Use the original option', rationale: 'The recorded reason' }],
      patrols: [{ operationId: 'patrol-operation', expectedScope: 'scope', executions: [], supervisorAgentSessionId: 'supervisor', context: 'Original context', requestedBy: { kind: 'device', id: 'requesting-device' }, requestedAt: 40, attempts: [],
        report: { operationId: 'patrol-report-operation', summary: 'Original inspection findings', authorAgentSessionId: 'reporting-agent', reportingRunId: 'reporting-run', reportedAt: 41, applied: false, reason: 'Current scope changed', progress: [], nextOwner: { kind: 'unassigned', agentSessionId: null, action: 'Read the original scope' } } }] })
    demand.plan!.reviews = [
      { operationId: 'review-operation', nodeId: 'task', delegationOperationId: old.operationId, verdict: 'changes', note: 'Recorded change', check: { command: '', result: '', evidence: [] }, reviewer: { kind: 'user', id: 'reviewing-user' }, reviewedAt: 35 },
      { operationId: 'wrong-node-review', nodeId: 'other', delegationOperationId: old.operationId, verdict: 'changes', note: 'Unconfirmed link', check: { command: '', result: '', evidence: [] }, reviewer: { kind: 'agent', id: 'external-reviewer', hostId: 'review-host' }, reviewedAt: 34 },
      { operationId: 'absent-attempt-review', nodeId: 'task', delegationOperationId: 'missing-attempt', verdict: 'changes', note: 'Missing link', check: { command: '', result: '', evidence: [] }, reviewer: { kind: 'device', id: 'review-device' }, reviewedAt: 33 }
    ]
    await render(demand); await showAll()
    expect(container.querySelector('[data-goal-coordination="review:wrong-node-review"] button')).toBeNull()
    expect(container.querySelector('[data-goal-coordination="review:absent-attempt-review"] button')).toBeNull()
    expect(container.querySelector('[data-goal-coordination="review:review-operation"]')?.textContent).toContain('User reviewing-user')
    expect(container.querySelector('[data-goal-coordination="report:current-attempt"]')?.textContent).toContain('Agent worker · Host worker-host')
    expect(container.textContent).toContain('Device requesting-device')
    expect(container.textContent).toContain('Device collecting-device')
    expect(container.querySelector('[data-goal-coordination="patrol-report:patrol-operation"]')?.textContent).toContain('Inspection reported · not applied')
    expect(container.querySelector('[data-goal-coordination="patrol-report:patrol-operation"] .goal-supervisor-rail__author')?.textContent).toBe('Agent reporting-agent')
    expect(container.textContent).toContain('Recorded actor decision-writer')
    expect(container.textContent).toContain('Agent plan-author · Host plan-host · Runtime plan-runtime')
    expect(container.textContent).not.toContain('Full delivery stays in the original task reader')
    const trigger = await click('[data-goal-coordination="review:review-operation"] button')
    expect(reveal).toHaveBeenCalledExactlyOnceWith('task', 'old-attempt', trigger)
    trigger.focus()
    await render({ ...demand, updatedAt: 2 })
    expect(container.querySelector('[data-goal-coordination="review:review-operation"] button')).toBe(trigger)
    expect(document.activeElement).toBe(trigger)
  })

  it('retains Source-qualified references without substituting a local same-Session name', async () => {
    const reference = { kind: 'space-member' as const, source: { runtimeId: 'source-runtime', spaceId: 'space', regionId: 'region', admission: { kind: 'creation' as const, operationId: 'creation' } }, execution: { runtimeId: 'other-runtime', agentSessionId: 'supervisor' } }
    await render(goal({ supervisorSessionId: reference }))
    const identity = container.querySelector('[data-original-supervisor-reference]')!
    expect(identity.getAttribute('data-original-supervisor-reference')).toBe(JSON.stringify(reference))
    expect(identity.hasAttribute('data-original-supervisor-host')).toBe(false)
    expect(container.textContent).not.toContain('Original Supervisor name')
  })
})
