// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DemandAlignment } from '@agentmux/demand/goals'
import type { DemandDelegation } from '@agentmux/demand/delegations'
import type { GoalPlan, GoalPlanNodeInput } from '@agentmux/demand/goal-plan'
import { projectGoalPlan } from '@agentmux/demand/goal-plan'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { goalPlanColumns, goalPlanEdgePath, goalPlanHighlight } from '../src/renderer/src/components/GoalPlanGraph'
import { api } from '../src/renderer/src/lib/api'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'

/**
 * A person sees the whole plan at a glance: dependency columns left to right, each node's
 * derived state, one highlighted next step, and the node's thread, report and review on demand.
 * The view reads the shared plan projection only.
 */
const dom = composerDOM()
const criteria = [{ id: 'api', text: 'API' }, { id: 'ui', text: 'UI' }]
const alignment: DemandAlignment = { summary: 'Plan inside the Goal', criteria, openQuestions: [], revision: 1, confirmedAt: 10 }
const node = (id: string, dependsOn: string[] = [], patch: Partial<GoalPlanNodeInput> = {}): GoalPlanNodeInput =>
  ({ id, title: `Node ${id}`, outcome: `Deliver ${id}`, dependsOn, criterionIds: ['api'], check: `pnpm test ${id}`, executor: null, ...patch })
const attempt = (nodeId: string, patch: Partial<DemandDelegation> = {}): DemandDelegation => ({
  operationId: `d-${nodeId}`, sourceMessageId: `s-${nodeId}`, hostId: 'local', ownerAgentSessionId: 'mote', workerAgentSessionId: `worker-${nodeId}`, ownerRunId: 'mr',
  workerRunId: `wr-${nodeId}`, threadId: `thread-${nodeId}`, text: 'task', alignmentRevision: 1, criterionIds: [nodeId === 'ui' ? 'ui' : 'api'], planNodeId: nodeId, preparedAt: 1,
  capturedCriteria: [criteria[nodeId === 'ui' ? 1 : 0]!], linkedAt: 2, ...patch })
const reported = (nodeId: string) => attempt(nodeId, { report: { operationId: `r-${nodeId}`, replyMessageId: `reply-${nodeId}`, authorAgentSessionId: `worker-${nodeId}`, submittedAt: 3,
  grounding: { alignmentRevision: 1, summary: `Delivered ${nodeId}`, checks: [{ criterionId: nodeId === 'ui' ? 'ui' : 'api', outcome: 'met', evidence: ['log:1'], note: '' }] } } })
const pass = (nodeId: string) => ({ operationId: `rv-${nodeId}`, nodeId, delegationOperationId: `d-${nodeId}`, verdict: 'pass' as const,
  check: { command: `pnpm test ${nodeId}`, result: '12 passed', evidence: ['ci:1'] }, note: '', reviewer: { kind: 'agent' as const, id: 'reviewer' }, reviewedAt: 4 })
const plan = (nodes: GoalPlanNodeInput[], reviews: GoalPlan['reviews'] = []): GoalPlan =>
  ({ revision: 2, alignmentRevision: 1, nodes, reviews, history: [1, 2].map(revision => ({ operationId: `p${revision}`, revision, author: { kind: 'agent' as const, id: 'mote' }, revisedAt: revision })) })
const goal = (patch: Partial<DemandRecord>): DemandRecord => ({ id: 'goal', title: 'Ship the plan', description: '', status: 'in_progress', priority: 'normal', projectId: null,
  projectName: null, source: 'session', sessionIds: [], createdAt: 1, updatedAt: 1, alignment, ...patch })
const seed = (record: DemandRecord) => useAppStore.setState({ demands: { [record.id]: record }, selectedDemandId: record.id, mainSurface: 'board' })
const graph = () => dom.container.querySelector<HTMLElement>('.goals-detail [aria-label="Goal plan"]')

// api → ui; docs runs in parallel; ui is waiting, api is reviewed, docs is ready.
const nodes = [node('api'), node('docs'), node('ui', ['api'], { criterionIds: ['ui'] }), node('release', ['ui', 'docs'])]

describe('Goal plan graph', () => {
  it('places each node in its dependency column and shows the derived state', async () => {
    seed(goal({ plan: plan(nodes), delegations: [reported('api')] }))
    await dom.render(<GlobalBoardSurface />)
    const columns = [...graph()!.querySelectorAll<HTMLElement>('[data-goal-plan-column]')]
      .map(column => [...column.querySelectorAll<HTMLElement>('[data-goal-plan-node]')].map(item => `${item.dataset.goalPlanNode}:${item.dataset.goalPlanState}`))
    expect(columns).toEqual([['api:review', 'docs:ready'], ['ui:waiting'], ['release:waiting']])
    expect(graph()!.querySelector('[data-goal-plan-progress]')!.textContent).toBe('0 of 4 done · revision 2')
    expect(graph()!.querySelector('[data-goal-plan-node="ui"]')!.textContent).toContain('Waiting on dependencies · Node api')
  })

  it('highlights exactly one next step: requested changes first, then the first ready node', async () => {
    seed(goal({ plan: plan(nodes, [pass('api')]), delegations: [reported('api')] }))
    await dom.render(<GlobalBoardSurface />)
    const highlighted = () => [...graph()!.querySelectorAll<HTMLElement>('.goal-plan-node--next')].map(item => item.dataset.goalPlanNode)
    // docs and ui are both ready; docs comes first in plan order.
    expect(highlighted()).toEqual(['docs'])
    expect(graph()!.querySelector('[data-goal-plan-progress]')!.textContent).toBe('1 of 4 done · revision 2')
    // ui is reworked after review; docs is still ready and earlier in order, yet the rework wins.
    const changes = { ...pass('ui'), verdict: 'changes' as const, note: 'The graph misses cancelled nodes' }
    await act(async () => useAppStore.setState(state => ({ demands: { goal: { ...state.demands.goal!, delegations: [reported('api'), reported('ui')], plan: plan(nodes, [pass('api'), changes]) } } })))
    expect(graph()!.querySelector<HTMLElement>('[data-goal-plan-node="docs"]')!.dataset.goalPlanState).toBe('ready')
    expect(graph()!.querySelector<HTMLElement>('[data-goal-plan-node="ui"]')!.dataset.goalPlanState).toBe('changes')
    expect(highlighted()).toEqual(['ui'])
  })

  it('opens a node in place with its check, thread, report and review evidence', async () => {
    seed(goal({ plan: plan(nodes, [pass('api')]), delegations: [reported('api')] }))
    await dom.render(<GlobalBoardSurface />)
    const head = graph()!.querySelector<HTMLButtonElement>('[data-goal-plan-node="api"] .goal-plan-node__head')!
    expect(head.getAttribute('aria-expanded')).toBe('false')
    await act(async () => head.click())
    const detail = graph()!.querySelector<HTMLElement>('[data-goal-plan-detail="api"]')!
    expect(detail.textContent).toContain('Deliver api')
    expect(detail.textContent).toContain('pnpm test api')
    expect(detail.textContent).toContain('thread-api')
    expect(detail.textContent).toContain('Delivered api')
    expect(detail.textContent).toContain('Passed by reviewer')
    expect(detail.textContent).toContain('12 passed')
    expect(detail.textContent).toContain('ci:1')
    await act(async () => head.click())
    expect(graph()!.querySelector('[data-goal-plan-detail="api"]')).toBeNull()
  })

  it('names an unknown delivery honestly and keeps cancelled nodes out of progress', async () => {
    const { linkedAt: _linked, ...prepared } = attempt('docs')
    seed(goal({ plan: plan([node('api'), node('docs'), node('gone', [], { cancelled: true })]), delegations: [prepared as DemandDelegation] }))
    await dom.render(<GlobalBoardSurface />)
    expect(graph()!.querySelector<HTMLElement>('[data-goal-plan-node="docs"]')!.textContent).toContain('Delivery unconfirmed')
    expect(graph()!.querySelector('[data-goal-plan-progress]')!.textContent).toBe('0 of 2 done · revision 2')
    expect(graph()!.querySelector<HTMLElement>('[data-goal-plan-node="gone"]')!.dataset.goalPlanState).toBe('cancelled')
  })

  it('keeps an unplanned Goal to one discussion entry without an empty graph', async () => {
    seed(goal({}))
    await dom.render(<GlobalBoardSurface />)
    expect(dom.container.querySelector('.goals-detail')).not.toBeNull()
    expect(graph()!.querySelector('[data-goal-plan-node]')).toBeNull()
    expect(graph()!.querySelectorAll('button')).toHaveLength(1)
    expect(graph()!.textContent).toContain('Plan in goal discussion')
  })
})

describe('plan graph projection helpers', () => {
  it('derive columns and the highlight from the shared projection only', () => {
    const projection = projectGoalPlan(plan(nodes), [], criteria)
    expect(goalPlanColumns(projection).map(column => column.map(item => item.node.id))).toEqual([['api', 'docs'], ['ui'], ['release']])
    expect(goalPlanHighlight(projection)).toBe('api')
  })
})

describe('plan graph navigation and list progress', () => {
  it('reads the exact original thread on demand and preserves it when a later read fails', async () => {
    const original = attempt('api')
    const envelope = { messageId: original.sourceMessageId, threadId: original.threadId, senderSessionId: original.ownerAgentSessionId,
      recipientSessionId: original.workerAgentSessionId, senderRunId: original.ownerRunId, recipientRunId: original.workerRunId,
      body: 'Original plan assignment', operationId: original.operationId, replyTo: null }
    const record = { hostId: original.hostId, dispatch: { sourceMessageId: original.sourceMessageId, threadId: original.threadId,
      ownerAgentSessionId: original.ownerAgentSessionId, workerAgentSessionId: original.workerAgentSessionId },
      source: { envelope, delivery: { state: 'delivered' } }, replies: [], identityDiagnostics: [] } as unknown as Awaited<ReturnType<typeof api.sessions.dispatch>>
    const read = vi.spyOn(api.sessions, 'dispatch').mockResolvedValue(record)
    try {
      seed(goal({ plan: plan(nodes), delegations: [original] }))
      await dom.render(<GlobalBoardSurface />)
      await act(async () => graph()!.querySelector<HTMLButtonElement>('[data-goal-plan-node="api"] .goal-plan-node__head')!.click())
      expect(read).not.toHaveBeenCalled()
      const button = graph()!.querySelector<HTMLButtonElement>('[data-goal-plan-thread="s-api"]')!
      await act(async () => button.click())
      expect(read).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: 'mote' }, 's-api')
      expect(graph()!.querySelector('[aria-label="Original plan thread"] [data-message-id="s-api"]')).not.toBeNull()
      await act(async () => button.click())
      read.mockRejectedValueOnce(new Error('Original journal temporarily unavailable.'))
      await act(async () => button.click())
      expect(graph()!.querySelector('[aria-label="Original plan thread"]')!.textContent).toContain('Original journal temporarily unavailable.')
      expect(graph()!.querySelector('[data-message-id="s-api"]')).not.toBeNull()
      read.mockResolvedValueOnce({ ...record, source: { ...record.source, envelope: { ...record.source.envelope, threadId: 'different-thread' } } })
      await act(async () => [...graph()!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Read again')!.click())
      expect(graph()!.querySelector('[aria-label="Original plan thread"]')!.textContent).toContain('did not match this plan attempt')
      expect(graph()!.querySelector('[data-message-id="s-api"]')).not.toBeNull()
    } finally { read.mockRestore() }
  })

  it('opens the exact executor and owner Agents of a node attempt, and names a failed open in place', async () => {
    seed(goal({ plan: plan(nodes), delegations: [{ ...reported('api'), hostId: 'owner-host', workerHostId: 'remote-host' }] }))
    await dom.render(<GlobalBoardSurface />)
    const open = vi.spyOn(useAppStore.getState(), 'executeControl').mockResolvedValue({ operation: 'focus', navigation: { state: 'applied' }, issues: [] } as never)
    await act(async () => graph()!.querySelector<HTMLButtonElement>('[data-goal-plan-node="api"] .goal-plan-node__head')!.click())
    await act(async () => graph()!.querySelector<HTMLButtonElement>('[data-goal-plan-open="executor"]')!.click())
    await act(async () => graph()!.querySelector<HTMLButtonElement>('[data-goal-plan-open="owner"]')!.click())
    expect(open.mock.calls.map(call => call[0])).toEqual([
      expect.objectContaining({ operation: 'focus', target: { kind: 'focus-agent', hostId: 'remote-host', agentSessionId: 'worker-api' }, inputPolicy: 'preserve' }),
      expect.objectContaining({ operation: 'focus', target: { kind: 'focus-agent', hostId: 'owner-host', agentSessionId: 'mote' }, inputPolicy: 'preserve' })
    ])
    open.mockRejectedValueOnce(new Error('The original Agent is not open on this Mac.'))
    await act(async () => graph()!.querySelector<HTMLButtonElement>('[data-goal-plan-open="executor"]')!.click())
    expect(graph()!.querySelector('[role="status"]')!.textContent).toBe('The original Agent is not open on this Mac.')
    // A node without an attempt offers no Agent to open.
    await act(async () => graph()!.querySelector<HTMLButtonElement>('[data-goal-plan-node="docs"] .goal-plan-node__head')!.click())
    expect(graph()!.querySelector('[data-goal-plan-detail="docs"] [data-goal-plan-open]')).toBeNull()
    open.mockRestore()
  })

  it('names remote tools from the exact Host-qualified Session snapshot', async () => {
    const original = useAppStore.getState().sessions.find(session => session.kind === 'agent')!
    if (original.kind !== 'agent') throw new Error('An actual preview Agent snapshot is required')
    seed(goal({ plan: plan(nodes), delegations: [{ ...reported('api'), hostId: 'owner-host', workerHostId: 'worker-host' }] }))
    useAppStore.setState({ sessions: [
      { ...original, id: 'local-presentation', hostId: 'worker-host', control: { ...original.control, hostId: 'worker-host', agentSessionId: 'worker-api' },
        toolExecution: { bindingId: 'remote-tools', resourceHostId: 'tool-host', workspacePath: '/project/work' } },
      { ...original, id: 'other-presentation', hostId: 'another-host', control: { ...original.control, hostId: 'another-host', agentSessionId: 'worker-api' } }
    ], agentNames: { 'local-presentation': 'Exact execution lead', 'other-presentation': 'Another Agent' } })
    await dom.render(<GlobalBoardSurface />)
    const who = graph()!.querySelector('[data-goal-plan-node="api"] .goal-plan-node__who')!
    expect(who.textContent).toContain('Exact execution lead')
    expect(who.textContent).toContain('Tools · tool-host')
    expect(who.textContent).not.toContain('Another Agent')
    expect(who.getAttribute('title')).toContain('/project/work')
  })

  it('shows done over live nodes as a ring in the Goal row', async () => {
    useAppStore.setState({ demands: { goal: goal({ plan: plan([...nodes, node('gone', [], { cancelled: true })], [pass('api')]), delegations: [reported('api')] }) }, selectedDemandId: null, mainSurface: 'board' })
    await dom.render(<GlobalBoardSurface />)
    const ring = dom.container.querySelector<HTMLElement>('[data-demand-id="goal"] [data-goal-plan-ring]')!
    expect(ring.dataset.goalPlanRing).toBe('1/4')
    expect(ring.getAttribute('aria-label')).toBe('Plan 1 of 4 done')
  })

  it('draws a dependency as a smooth left-to-right curve between its anchors', () => {
    expect(goalPlanEdgePath({ x: 10, y: 20 }, { x: 110, y: 60 })).toBe('M 10 20 C 60 20, 60 60, 110 60')
    expect(goalPlanEdgePath({ x: 0, y: 0 }, { x: 20, y: 0 })).toBe('M 0 0 C 24 0, -4 0, 20 0')
  })
})
