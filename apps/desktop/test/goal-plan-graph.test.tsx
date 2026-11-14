// @vitest-environment happy-dom
import { act } from 'react'
import { formatGoalAddress } from '@agentmux/core/sharing'
import { editGoalDraft } from '../src/renderer/src/lib/goal-edit-drafts'
import { describe, expect, it, vi } from 'vitest'
import type { DemandAlignment } from '@agentmux/demand/goals'
import type { DemandDelegation } from '@agentmux/demand/delegations'
import type { GoalPlan, GoalPlanNodeInput } from '@agentmux/demand/goal-plan'
import { goalPlanState, projectGoalPlan } from '@agentmux/demand/goal-plan'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { GoalDetail } from '../src/renderer/src/components/GoalDetail'
import { goalExecutionRows } from '../src/renderer/src/components/GoalExecutionTimeline'
import { goalPlanColumns, goalPlanEdgePath, goalPlanHighlight, goalPlanProjection } from '../src/renderer/src/components/GoalPlanGraph'
import { api } from '../src/renderer/src/lib/api'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

/**
 * A person sees the whole plan at a glance: dependency columns left to right, each node's
 * derived state, one highlighted next step, and the node's thread, report and review on demand.
 * The view reads the Goal owner's derivation only.
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
/** A record as its Goal owner returns it: every plan carries the owner's derivation. */
const owned = (record: DemandRecord): DemandRecord => record.plan
  ? { ...record, planState: goalPlanState(projectGoalPlan(record.plan, record.delegations ?? [], record.alignment?.criteria ?? [])) } : record
const goal = (patch: Partial<DemandRecord>): DemandRecord => owned({ id: 'goal', title: 'Ship the plan', description: '', status: 'in_progress', priority: 'normal', projectId: null,
  projectName: null, source: 'session', sessionIds: [], createdAt: 1, updatedAt: 1, alignment, ...patch })
const seed = (record: DemandRecord) => useAppStore.setState({ demands: { [record.id]: record }, selectedDemandId: record.id, mainSurface: 'board' })
const graph = () => dom.container.querySelector<HTMLElement>('.goals-detail [aria-label="Goal plan"]')

// api → ui; docs runs in parallel; ui is waiting, api is reviewed, docs is ready.
const nodes = [node('api'), node('docs'), node('ui', ['api'], { criterionIds: ['ui'] }), node('release', ['ui', 'docs'])]

describe('Goal plan graph', () => {
  it('the mounted Goal detail keeps its brief and actual plan together with owner progress and the original editor', async () => {
    const record = goal({ plan: plan(nodes, [pass('api')]), delegations: [reported('api')], description: '# Original intent\n\nKeep the exact original work.' })
    seed(record)
    await dom.render(<GlobalBoardSurface />)
    const detail = dom.container.querySelector('.goals-detail')!
    const main = detail.querySelector('.goals-detail__main')!
    expect(main.firstElementChild?.contains(graph())).toBe(true)
    expect(detail.querySelector('[data-goal-meta-plan]')?.textContent).toBe('Plan 1 of 4 done')
    expect(detail.querySelector('.goals-detail__side .goal-collaboration')).not.toBeNull()
    const side = detail.querySelector('.goals-detail__side')!
    expect(side.firstElementChild).toBe(side.querySelector('.goal-supervisor-rail'))
    expect(side.lastElementChild).toBe(side.querySelector('[aria-label="Goal properties"]'))
    const head = detail.querySelector('.goals-detail__head')!
    expect(head.querySelector('[aria-label="Goal title"]')).not.toBeNull()
    expect(detail.querySelector('.goals-detail__reading-nav [aria-current]')?.textContent).toBe('Plan')
    expect(head.querySelector('[data-goal-detail-stage]')?.textContent).toBeTruthy()
    expect(detail.querySelector('[data-goal-reading-section="activity"]')).toBeNull()
    expect([...detail.querySelectorAll('.goals-detail__reading-nav button')].some(button => button.textContent === 'Activity')).toBe(false)
    expect(main.querySelector('.goal-collaboration')).toBeNull()
    const overview = main.querySelector('.goal-work-area__overview')!
    expect(overview.firstElementChild).toBe(main.querySelector('[aria-label="Goal brief"]'))
    expect(Boolean(graph()!.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    const intent = main.querySelector('.goals-detail__brief .goals-intent__reading')!
    expect(intent.textContent).toContain('Original intent')
    expect(intent.textContent).not.toContain('# Original intent')
    expect(main.querySelector('.goals-detail__brief textarea')).toBeNull()
    const edit = main.querySelector<HTMLButtonElement>('[aria-label="Edit goal description"]')!
    await act(async () => edit.click())
    expect(main.querySelector<HTMLTextAreaElement>('[aria-label="Goal description"]')?.value).toBe(record.description)
  })

  it('opens the same original attempt from coordination and the time chart', async () => {
    const first = reported('api')
    const current = { ...first, operationId: 'd-api-current', sourceMessageId: 'source-current', preparedAt: 5, linkedAt: 6,
      report: { ...first.report!, operationId: 'r-api-current', replyMessageId: 'reply-current', submittedAt: 7 } }
    seed(goal({ plan: plan(nodes, [{ ...pass('api'), verdict: 'changes', note: 'Correct the original work' }]), delegations: [first, current] }))
    await dom.render(<GlobalBoardSurface />)
    const old = dom.container.querySelector<HTMLButtonElement>('[data-goal-coordination-attempt="d-api"]')!
    expect(old).not.toBeNull()
    await act(async () => old.click())
    const reading = () => graph()!.querySelector('.goal-plan__reading')!
    expect(reading().querySelector('[data-goal-delivery="d-api"]')).not.toBeNull()
    expect(reading().querySelector('[aria-label="Independent node review"]')).toBeNull()
    expect(graph()!.querySelector('[data-goal-time-row="d-api"][data-selected]')).not.toBeNull()
    expect(graph()!.querySelector('[data-goal-observed-activity]')).toBeNull()
    expect(graph()!.querySelectorAll('[data-goal-time-event="Original dispatch linked"]')).toHaveLength(2)
    await act(async () => graph()!.querySelector<HTMLButtonElement>('[data-goal-time-row="d-api-current"] button')!.click())
    expect(reading().querySelector('[data-goal-delivery="d-api-current"]')).not.toBeNull()
    expect(reading().querySelector('[aria-label="Independent node review"]')).not.toBeNull()
  })

  it('takes the reader to the original Supervisor rail with keyboard focus and keeps one original discussion action', async () => {
    seed(goal({}))
    await dom.render(<GlobalBoardSurface />)
    const side = dom.container.querySelector<HTMLElement>('[aria-label="Goal team and properties"]')!
    expect(side).not.toBeNull()
    const scroll = vi.fn()
    side.scrollIntoView = scroll
    const detail = dom.container.querySelector<HTMLElement>('.goals-detail')!
    detail.scrollTop = 100
    dom.container.scrollTop = 18
    const team = dom.container.querySelector<HTMLButtonElement>('.goals-detail__team-link')!
    expect(team.textContent).toBe('Supervisor')
    await act(async () => team.click())
    expect(scroll).not.toHaveBeenCalled()
    expect(team.closest('nav')?.querySelector('[aria-current="location"]')).toBe(team)
    expect(detail.scrollTop).toBe(0)
    expect(dom.container.scrollTop).toBe(18)
    expect(document.activeElement).toBe(side)
    expect(dom.container.querySelectorAll('[aria-label="Open discussion for Ship the plan"]')).toHaveLength(1)
    expect(graph()!.textContent).not.toContain('Open goal discussion')
  })

  it('places each node in its dependency column and shows the derived state', async () => {
    seed(goal({ plan: plan(nodes), delegations: [reported('api')] }))
    await dom.render(<GlobalBoardSurface />)
    const columns = [...graph()!.querySelectorAll<HTMLElement>('[data-goal-plan-column]')]
      .map(column => [...column.querySelectorAll<HTMLElement>('[data-goal-plan-node]')].map(item => `${item.dataset.goalPlanNode}:${item.dataset.goalPlanState}`))
    expect(columns).toEqual([['api:review', 'docs:ready'], ['ui:waiting'], ['release:waiting']])
    expect(dom.container.querySelector('[data-goal-meta-plan]')?.textContent).toBe('Plan 0 of 4 done')
    expect(graph()!.querySelector('[data-goal-plan-node="ui"] .goal-plan-node__state')!.textContent).toBe('Waiting')
    expect(graph()!.querySelector('[data-goal-plan-node="ui"] .goal-plan-node__depends')!.textContent).toBe('Depends on · Node api')
    expect(graph()!.querySelector('[aria-label="Execution graph"]')?.getAttribute('tabindex')).toBe('0')
    const delivery = graph()!.querySelector('[data-goal-delivery="d-api"]')!
    expect(delivery, 'The first Plan paint shows the original current delivery').not.toBeNull()
    expect(delivery.closest('.goal-plan__stage')?.parentElement?.querySelector('[aria-label="Task assignments"] [aria-current] strong')?.textContent).toBe('Node api')
    expect(graph()!.querySelector('[data-goal-time-row="d-api"][data-selected]')).not.toBeNull()
    expect(document.activeElement).not.toBe(graph()!.querySelector('.goal-plan__reading h3'))
    const view = [...dom.container.querySelectorAll('button')].find(button => button.textContent === 'View delivery')!
    await act(async () => view.click())
    expect(document.activeElement).toBe(graph()!.querySelector('.goal-plan__reading h3'))
    expect(graph()!.querySelector('[data-goal-delivery="d-api"]')).toBe(delivery)
  })

  it('highlights exactly one next step: requested changes first, then the first ready node', async () => {
    seed(goal({ plan: plan(nodes, [pass('api')]), delegations: [reported('api')] }))
    await dom.render(<GlobalBoardSurface />)
    const highlighted = () => [...graph()!.querySelectorAll<HTMLElement>('.goal-plan-node--next')].map(item => item.dataset.goalPlanNode)
    // docs and ui are both ready; docs comes first in plan order.
    expect(highlighted()).toEqual(['docs'])
    expect(dom.container.querySelector('[data-goal-meta-plan]')?.textContent).toBe('Plan 1 of 4 done')
    // ui is reworked after review; docs is still ready and earlier in order, yet the rework wins.
    const changes = { ...pass('ui'), verdict: 'changes' as const, note: 'The graph misses cancelled nodes' }
    await act(async () => useAppStore.setState(state => ({ demands: { goal: owned({ ...state.demands.goal!, delegations: [reported('api'), reported('ui')], plan: plan(nodes, [pass('api'), changes]) }) } })))
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
    expect(dom.container.querySelector('[data-goal-meta-plan]')?.textContent).toBe('Plan 0 of 2 done')
    expect(graph()!.querySelector<HTMLElement>('[data-goal-plan-node="gone"]')!.dataset.goalPlanState).toBe('cancelled')
  })

  it('names every reconciliation reason, and a cancelled node reads as cancelled even when its criteria changed', async () => {
    const { linkedAt: _linked, ...prepared } = attempt('api', { capturedCriteria: [{ id: 'api', text: 'An earlier API' }] })
    seed(goal({ plan: plan([node('api'), node('empty', [], { criterionIds: [] }), node('gone', [], { criterionIds: ['removed'], cancelled: true })]), delegations: [prepared as DemandDelegation] }))
    await dom.render(<GlobalBoardSurface />)
    const state = (id: string) => {
      const label = graph()!.querySelector<HTMLElement>(`[data-goal-plan-node="${id}"] .goal-plan-node__state`)!
      return [label.textContent, label.dataset.goalPlanUnknown]
    }
    const detail = async (id: string) => {
      await act(async () => graph()!.querySelector<HTMLButtonElement>(`[data-goal-plan-node="${id}"] .goal-plan-node__head`)!.click())
      return graph()!.querySelector<HTMLElement>(`[data-goal-plan-detail="${id}"]`)!.textContent
    }
    expect([state('api'), state('empty'), state('gone')]).toEqual([['Criteria need review · Delivery unconfirmed', 'criteria dispatch-link'], ['Criteria need review', 'criteria'], ['Cancelled', undefined]])
    const api = await detail('api')
    expect(api).toContain('Changed or unavailable in the current goal: api')
    expect(api).toContain('The original delegation link is unconfirmed. Read its receipt before acting; it is never resent automatically.')
    expect(await detail('empty')).toContain('Covers no success criterion of the current goal. Revise the plan to name what this node delivers.')
    expect(await detail('gone')).not.toContain('Criteria')
  })

  it('shows the owner derivation as returned, even where this reader would derive another state', async () => {
    const record = goal({ plan: plan(nodes), delegations: [reported('api')] }), planState = record.planState!
    seed({ ...record, planState: { ...planState, done: 1, nodes: planState.nodes.map(item => item.id === 'api' ? { ...item, state: 'done' as const } : item) } })
    await dom.render(<GlobalBoardSurface />)
    expect(graph()!.querySelector<HTMLElement>('[data-goal-plan-node="api"]')!.dataset.goalPlanState).toBe('done')
    expect(graph()!.querySelector('[data-goal-plan-node="api"] .goal-plan-node__state')!.textContent).toBe('Done')
    expect(dom.container.querySelector('[data-goal-meta-plan]')?.textContent).toBe('Plan 1 of 4 done')
  })

  it('reads every node state as unavailable when the owner returned no derivation, and never guesses one', async () => {
    const { planState: _absent, ...older } = goal({ plan: plan(nodes, [pass('api')]), delegations: [reported('api')] })
    useAppStore.setState({ demands: { goal: older }, selectedDemandId: 'goal', mainSurface: 'board' })
    await dom.render(<GlobalBoardSurface />)
    const states = [...graph()!.querySelectorAll<HTMLElement>('[data-goal-plan-node]')].map(item =>
      [item.dataset.goalPlanNode, item.dataset.goalPlanState, item.querySelector('.goal-plan-node__state')!.textContent])
    expect(states).toEqual(['api', 'docs', 'ui', 'release'].map(id => [id, 'unavailable', 'State unavailable']))
    expect(graph()!.querySelectorAll('[data-goal-plan-column]')).toHaveLength(1)
    expect(graph()!.querySelector('.goal-plan-node--next')).toBeNull()
    expect(graph()!.querySelector('[data-goal-plan-progress]')!.textContent).toBe('Revision 2')
    expect(graph()!.querySelector('.goal-plan__progress')).toBeNull()
    expect(graph()!.classList.contains('goal-plan--unavailable')).toBe(true)
    expect(graph()!.querySelector('[data-goal-plan-node="release"] .goal-plan-node__depends')!.textContent).toBe('Depends on · Node ui, Node docs')
    const note = graph()!.querySelector('[data-goal-plan-states-unavailable]')!.textContent
    expect(note).toContain('The plan itself is unchanged')
    expect(note).toContain('Read this Goal again; update that Host')
    await act(async () => useAppStore.setState({ selectedDemandId: null }))
    expect(dom.container.querySelector('[data-demand-id="goal"]')).not.toBeNull()
    expect(dom.container.querySelector('[data-demand-id="goal"] [data-goal-plan-ring]')).toBeNull()
  })

  it('identifies the original unsplit Goal assignee and keeps direct execution unconfirmed', async () => {
    const record = goal({ assigneeSessionIds: ['original-member'] })
    seed(record)
    useAppStore.setState({ sessions: [composerSession('original-member')], agentNames: { 'original-member': 'Integration owner' } })
    await dom.render(<GlobalBoardSurface />)
    const card = graph()!.querySelector('[data-goal-plan-origin]')!
    expect(card.querySelector('.goal-plan-node__who')?.textContent).toContain('Integration owner')
    await act(async () => card.querySelector<HTMLButtonElement>('button')!.click())
    expect(graph()!.querySelector('[data-goal-plan-detail]')?.textContent).toContain('Executor unconfirmed')
    expect(graph()!.querySelector('[aria-label="Node assignment"]')).toBeNull()
  })

  it.each([alignment, undefined])('reads the whole Goal in the ordinary graph and assignments (alignment %s)', async (alignment) => {
    const record = goal({ description: '# The original outcome\n\nKeep the same goal and original words.' })
    if (!alignment) delete record.alignment
    seed(record)
    await dom.render(<GlobalBoardSurface />)
    expect(dom.container.querySelector('.goals-detail')).not.toBeNull()
    expect(graph()).not.toBeNull()
    expect(graph()!.querySelectorAll('[data-goal-plan-node]')).toHaveLength(1)
    const path = [...graph()!.querySelectorAll('.goal-plan__columns > li')].map(item => item.getAttribute('data-goal-plan-boundary') ?? 'work')
    expect(path, 'The original single work node keeps both workflow boundaries').toEqual(['start', 'work', 'finish'])
    expect(graph()!.querySelector('[data-goal-finish-state="Pending"]')).not.toBeNull()
    const timeline = graph()!.querySelector('[aria-label="Execution timeline"]')!
    expect(timeline, 'The original Goal keeps its timeline even without any time facts').not.toBeNull()
    expect(timeline.querySelector('.goal-execution-time__axis')?.textContent).toContain('No schedule or execution times')
    expect(timeline.querySelector('[data-goal-time-row="node:goal"] .goal-execution-time__track--empty')).not.toBeNull()
    expect(timeline.querySelector('time, [data-goal-observed-activity], [data-goal-planned-period]')).toBeNull()
    expect(dom.container.querySelector('.goals-detail__main')!.firstElementChild?.contains(graph())).toBe(true)
    const origin = graph()!.querySelector('[data-goal-plan-origin="goal"]')!
    expect(origin).not.toBeNull()
    expect(origin.closest('[aria-label="Execution graph"]')).not.toBeNull()
    expect(graph()!.querySelector('[aria-label="Task assignments"] button strong')?.textContent).toBe(record.title)
    expect(graph()!.querySelector('[data-goal-plan-edge]')).toBeNull()
    expect(graph()!.querySelector('[data-goal-plan-progress]')).toBeNull()
    expect(graph()!.querySelector('h2')!.textContent).toContain('Execution plan')
    expect(graph()!.querySelector('[data-goal-plan-request]')).not.toBeNull()
    const open = origin.querySelector<HTMLButtonElement>('button')!
    expect(open.textContent).toBe(record.title)
    await act(async () => open.click())
    const reading = graph()!.querySelector('[data-goal-plan-detail="goal"]')!
    expect(reading.textContent).toContain(alignment ? alignment.summary : 'Keep the same goal and original words.')
    expect(reading.querySelectorAll('li')).toHaveLength(alignment?.criteria.length ?? 0)
    expect(reading.querySelector('[aria-label="Independent node review"]')).toBeNull()
    expect(useAppStore.getState().demands.goal).not.toHaveProperty('plan')
    const back = [...graph()!.querySelectorAll('button')].find(button => button.textContent === 'Back to node')!
    await act(async () => back.click())
    expect(document.activeElement).toBe(open)
  })

  it('draws only original plan dates and derives Finish from the Goal close and acceptance', async () => {
    const report = { submissionId: 'original-report', alignmentRevision: 1, summary: 'Original checks', acceptedAt: 12,
      checks: [{ criterionId: 'api', outcome: 'gap' as const, note: 'A retained gap', evidence: ['checks/api.log'] }] }
    seed(goal({ status: 'done', plannedStartAt: 100, targetAt: 200, grounding: report }))
    await dom.render(<GlobalBoardSurface />)
    expect(graph()!.querySelector('[data-goal-finish-state="Closed with gaps"]')).not.toBeNull()
    expect(graph()!.querySelector('[data-goal-planned-period]')?.textContent).toBe('Planned')
    expect(graph()!.querySelector('[data-goal-observed-activity]')).toBeNull()
    await act(async () => seed(goal({ status: 'done', targetAt: 200, grounding: { ...report, acceptedAt: null } })))
    expect(graph()!.querySelector('[data-goal-finish-state="Unverified"]')).not.toBeNull()
    expect(graph()!.querySelector('[data-goal-planned-period]')).toBeNull()
    expect(graph()!.querySelector('[data-goal-time-event="Target date"]')).not.toBeNull()
  })

  it('uses the same canvas when the owner saves a split and keeps an old Done Goal unverified', async () => {
    const original = goal({ status: 'done' })
    seed(original)
    await dom.render(<GlobalBoardSurface />)
    const canvas = graph()!.querySelector('[aria-label="Execution graph"]')!
    expect(dom.container.querySelector('[data-goal-detail-stage]')?.textContent).toBe('Results not verified')
    expect(canvas.querySelector('[data-goal-plan-boundary="finish"]')?.textContent).toContain('Unverified')
    const root = canvas.querySelector<HTMLButtonElement>('[data-goal-plan-origin] button')!
    await act(async () => root.click())
    expect(graph()!.querySelector('[data-goal-plan-detail="goal"]')).not.toBeNull()
    await act(async () => seed(owned({ ...original, plan: plan([node('goal'), node('followup', ['goal'])]) })))
    expect(graph()!.querySelector('[aria-label="Execution graph"]')).toBe(canvas)
    expect(canvas.querySelector('[data-goal-plan-origin]')).toBeNull()
    expect(canvas.querySelectorAll('[data-goal-plan-node]')).toHaveLength(2)
    expect(canvas.querySelector('[data-goal-plan-depends="goal"]')).not.toBeNull()
    expect(graph()!.querySelector('[data-goal-plan-detail="goal"]')).toBeNull()
  })

  it('reads the actual report and its criteria before planning another execution', async () => {
    seed(goal({ grounding: { alignmentRevision: alignment.revision, submissionId: 'current-report', acceptedAt: null,
      summary: 'Review the original result.', checks: criteria.map(criterion => ({ criterionId: criterion.id, outcome: 'met', evidence: ['verification.log:1'], note: '' })) } }))
    await dom.render(<GlobalBoardSurface />)
    const finish = dom.container.querySelector('[data-goal-finish]')!
    const firstCheck = dom.container.querySelector('[data-goal-outcome]')!
    expect(finish).not.toBeNull()
    expect(Boolean(firstCheck.compareDocumentPosition(finish) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(Boolean(graph()!.compareDocumentPosition(finish) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(graph()!.querySelector('[aria-label="Execution graph"] [data-goal-plan-origin="goal"]')).not.toBeNull()
    expect(dom.container.querySelector('[data-goal-work-area]')!.textContent).not.toContain('Ready when you are')
  })

  it('places the original unconfirmed acknowledgement read before the retained proposal and graph', async () => {
    const demand = goal({ alignment: { ...alignment, confirmedAt: null } })
    seed(demand)
    await dom.render(<GoalDetail demand={{ ...demand, sessions: [], workspacePath: null }} onClose={vi.fn()} onOpenMote={vi.fn()} onGrill={vi.fn()} onGrounding={vi.fn()} onPlan={vi.fn()}
      acknowledgementFeedback={{ pending: false, failure: { attempt: { kind: 'confirm', revision: alignment.revision }, message: 'Original receipt unconfirmed' }, reloadError: null }}
      onAcknowledgementFeedbackChange={vi.fn()} moteError={null} onRetryMote={vi.fn()} />)
    const recovery = dom.container.querySelector('[data-goal-acknowledgement-failure]')!
    expect(Boolean(recovery.compareDocumentPosition(dom.container.querySelector('[data-goal-summary]')!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(Boolean(recovery.compareDocumentPosition(graph()!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect([...dom.container.querySelectorAll('.primary-button')].map(button => button.textContent?.trim())).toEqual(['Reload current proposal'])
  })
})

describe('plan graph projection helpers', () => {
  it('uses an exact current activity observation and leaves receipt-only attempts as events', () => {
    const delegation = attempt('api')
    const row = { execution: { kind: 'delegation' as const, operationId: delegation.operationId, hostId: 'local',
      agentSessionId: delegation.workerAgentSessionId, runId: delegation.workerRunId }, binding: 'confirmed' as const, phase: 'executing' as const,
      reason: 'Observed original work', alert: null, nextOwner: { kind: 'worker' as const, agentSessionId: delegation.workerAgentSessionId, action: 'Continue work' },
      basis: { stateEnteredAt: 3, activityRevision: null, inputSubmissionId: null }, stateSince: 3,
      observation: { process: 'running' as const, semantic: 'active' as const, source: 'native-hook' as const, readiness: 'ready' as const, observedAt: 6, stale: false } }
    const responsibility = { scope: 'goal', observedAt: 7, supervisor: { agentSessionId: null, state: 'missing' as const, reason: 'No Supervisor' }, executions: [row] }
    const demand = { plan: plan(nodes), delegations: [delegation], responsibility }
    expect(goalExecutionRows(demand)[0]?.active).toEqual({ from: 3, to: 6 })
    expect(goalExecutionRows({ ...demand, delegations: [reported('api')] })[0]?.active).toBeUndefined()
    expect(goalExecutionRows({ ...demand, responsibility: { ...responsibility, executions: [{ ...row, execution: { ...row.execution, runId: 'another-run' } }] } })[0]?.active).toBeUndefined()
  })

  it('derive columns and the highlight from the owner derivation only', () => {
    const projection = goalPlanProjection(goal({ plan: plan(nodes) }))!
    expect(goalPlanColumns(projection).map(column => column.map(item => item.node.id))).toEqual([['api', 'docs'], ['ui'], ['release']])
    expect(goalPlanHighlight(projection)).toBe('api')
  })
})

describe('plan graph navigation and list progress', () => {
  it('keeps dependencies in each dependent card when completed prerequisites make it ready', async () => {
    seed(goal({ plan: plan(nodes, [pass('api')]), delegations: [reported('api')] }))
    await dom.render(<GlobalBoardSurface />)
    expect(graph()!.querySelector('[data-goal-plan-node="ui"]')!.getAttribute('data-goal-plan-state')).toBe('ready')
    expect(graph()!.querySelector('[data-goal-plan-node="ui"] .goal-plan-node__depends')!.textContent).toBe('Depends on · Node api')
    expect(graph()!.querySelector('[data-goal-plan-node="release"] .goal-plan-node__depends')!.textContent).toBe('Depends on · Node ui, Node docs')
    // Each name is its own wrapping unit, so a line never splits a dependency's name.
    expect([...graph()!.querySelectorAll('[data-goal-plan-node="release"] .goal-plan-dependency')].map(name => name.textContent)).toEqual(['Node ui', 'Node docs'])
  })
  it('names the exact configured remote Host while retaining its machine route in the title', async () => {
    const prior = useAppStore.getState(), original = prior.sessions.find(session => session.kind === 'agent')!
    if (original.kind !== 'agent' || !prior.config) throw new Error('An actual preview configuration and Agent snapshot are required')
    const { toolExecution: _tools, ...source } = original
    try {
      seed(goal({ plan: plan(nodes), delegations: [{ ...reported('api'), hostId: 'owner-host', workerHostId: 'worker-host' }] }))
      useAppStore.setState({ config: { ...prior.config, hosts: [...prior.config.hosts, { id: 'worker-host', kind: 'ssh', label: 'Recovery worker', hostname: 'worker.invalid' }] },
        sessions: [{ ...source, id: 'remote-worker', hostId: 'worker-host', control: { ...source.control, hostId: 'worker-host', agentSessionId: 'worker-api' } }] })
      await dom.render(<GlobalBoardSurface />)
      const who = graph()!.querySelector('[data-goal-plan-detail="api"] .goal-delivery__byline .goal-plan-node__who')!
      expect(who.textContent).toContain('Remote · Recovery worker')
      expect(who.getAttribute('title')).toContain('worker-host')
    } finally { await act(async () => useAppStore.setState({ config: prior.config, sessions: prior.sessions })) }
  })
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

  it('reads the exact Host names in coordination and keeps the assignment index compact', async () => {
    const original = useAppStore.getState().sessions.find(session => session.kind === 'agent')!
    if (original.kind !== 'agent') throw new Error('An actual preview Agent snapshot is required')
    const review = { ...pass('api'), reviewer: { kind: 'agent' as const, id: 'worker-api', hostId: 'unobserved-host' } }
    seed(goal({ plan: plan(nodes, [review]), delegations: [{ ...reported('api'), hostId: 'owner-host', workerHostId: 'worker-host' }] }))
    useAppStore.setState({ sessions: [
      { ...original, id: 'local-presentation', hostId: 'worker-host', control: { ...original.control, hostId: 'worker-host', agentSessionId: 'worker-api' },
        workPlacement: { agentHostId: 'worker-host', resourceHostId: 'tool-host' },
        toolExecution: { bindingId: 'remote-tools', resourceHostId: 'tool-host', resourceRuntimeId: 'original-tool-runtime', workspacePath: '/project/work' } },
      { ...original, id: 'other-presentation', hostId: 'another-host', control: { ...original.control, hostId: 'another-host', agentSessionId: 'worker-api' } }
    ], agentNames: { 'local-presentation': 'Exact execution lead', 'other-presentation': 'Another Agent' } })
    await dom.render(<GlobalBoardSurface />)
    await act(async () => graph()!.querySelector<HTMLButtonElement>('[data-goal-plan-node="api"] .goal-plan-node__head')!.click())
    const who = graph()!.querySelector('[data-goal-plan-detail="api"] .goal-delivery__byline .goal-plan-node__who')!
    expect(who.textContent).toContain('Exact execution lead')
    expect(who.textContent).toContain('Tools · tool-host')
    expect(who.textContent).not.toContain('Another Agent')
    expect(who.getAttribute('title')).toContain('/project/work')
    const assignment = graph()!.querySelector('[aria-label="Task assignments"] button')!
    expect(assignment.textContent).toContain('Exact execution lead')
    expect(assignment.textContent).not.toContain('Tools')
    const author = (event: string) => dom.container.querySelector(`[data-goal-coordination="${event}"] .goal-supervisor-rail__author`)
    expect(author('report:d-api')?.textContent).toBe('Exact execution lead')
    expect(author('report:d-api')?.getAttribute('title')).toBe('Agent worker-api · Host worker-host')
    expect(author('review:rv-api')?.textContent).toBe('Agent worker-api · Host unobserved-host')
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


describe('Goal continuous reading', () => {
  const addressed = () => goal({ description: 'Original outcome with precise spacing.  ', address: formatGoalAddress('goal', 'original-runtime', 'original-namespace'),
    activities: [{ id: 'original-progress', kind: 'progress', message: 'Read the original outcome', createdAt: 1, actorId: 'worker' }] })
  const button = (text: string) => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!

  it('keeps the original Brief editor and draft mounted while moving between reading anchors', async () => {
    const record = addressed(); seed(record)
    await dom.render(<GlobalBoardSurface />)
    await act(async () => editGoalDraft(record.id, 'description', 'Keep this unsaved original Brief.  '))
    const editor = dom.container.querySelector('[aria-label="Goal description"]')!
    expect(editor).not.toBeNull()
    const detail = dom.container.querySelector<HTMLElement>('.goals-detail')!
    const planSection = dom.container.querySelector<HTMLElement>('[data-goal-reading-section="plan"]')!
    planSection.style.scrollMarginTop = '52px'
    vi.spyOn(planSection, 'getBoundingClientRect').mockReturnValue({ top: 780 } as DOMRect)
    vi.spyOn(detail, 'getBoundingClientRect').mockReturnValue({ top: 20 } as DOMRect)
    detail.scrollTop = 83; dom.container.scrollTop = 12
    await act(async () => button('Plan').click())
    expect(detail.scrollTop).toBe(791)
    expect(document.activeElement).toBe(planSection)
    await act(async () => button('Activity').click())
    await act(async () => button('Overview').click())
    expect(dom.container.querySelector('[aria-label="Goal description"]')).toBe(editor)
    expect(useAppStore.getState().goalEditDrafts.goal?.description?.value).toBe('Keep this unsaved original Brief.  ')
    expect(dom.container.scrollTop).toBe(12)
    expect(dom.container.querySelectorAll('[aria-label="Goal plan"]')).toHaveLength(1)
  })

  it('reveals an exact Plan entry once without moving input or replaying scroll after a later observation', async () => {
    const record = addressed(); seed(record)
    await dom.render(<GlobalBoardSurface />)
    const detail = dom.container.querySelector<HTMLElement>('.goals-detail')!
    const section = dom.container.querySelector<HTMLElement>('[data-goal-reading-section="plan"]')!
    const input = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal title"]')!
    section.style.scrollMarginTop = '52px'
    vi.spyOn(section, 'getBoundingClientRect').mockReturnValue({ top: 780 } as DOMRect)
    vi.spyOn(detail, 'getBoundingClientRect').mockReturnValue({ top: 20 } as DOMRect)
    detail.scrollTop = 83; input.focus()
    const entry = { goalId: record.id, runtimeId: record.address!.runtimeId, namespace: record.address!.namespace, section: 'plan' as const, phase: 'ready' as const, token: 'original-plan-entry' }
    await act(async () => useAppStore.setState({ goalReadingEntry: entry }))
    expect(detail.scrollTop).toBe(791)
    expect(document.activeElement).toBe(input)
    detail.scrollTop = 300
    await act(async () => useAppStore.setState({ demands: { goal: { ...record, updatedAt: record.updatedAt + 1 } } }))
    expect(detail.scrollTop).toBe(300)
    expect(dom.container.querySelector('[data-goal-reading-section="plan"]')).toBe(section)
    await act(async () => useAppStore.setState({ goalReadingEntry: { ...entry, namespace: 'different-original-store', token: 'foreign-plan-entry' } }))
    expect(detail.scrollTop).toBe(300)
    expect(document.activeElement).toBe(input)
  })

  it('copies the owner-provided Goal and Plan addresses through the shared clipboard and keeps failure visible', async () => {
    const record = addressed(); seed(record)
    const write = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    await dom.render(<GlobalBoardSurface />)
    await act(async () => button('Copy goal link').click())
    expect(write).toHaveBeenLastCalledWith(record.address!.goalUrl)
    expect(button('Goal link copied')).toBeDefined()
    await act(async () => button('Copy plan link').click())
    expect(write).toHaveBeenLastCalledWith(record.address!.planUrl)
    expect(button('Plan link copied')).toBeDefined()
    write.mockRejectedValueOnce(Error('The original clipboard write was not confirmed.'))
    await act(async () => button('Copy goal link').click())
    expect(dom.container.textContent).toContain('Link could not be copied. The original clipboard write was not confirmed.')
    expect(useAppStore.getState().selectedDemandId).toBe(record.id)
  })

  it('keeps a pending source read from scrolling and cancels it on a later explicit reading anchor', async () => {
    const record = addressed(); seed(record)
    await dom.render(<GlobalBoardSurface />)
    const detail = dom.container.querySelector<HTMLElement>('.goals-detail')!
    const section = dom.container.querySelector<HTMLElement>('[data-goal-reading-section="plan"]')!
    vi.spyOn(section, 'getBoundingClientRect').mockReturnValue({ top: 780 } as DOMRect)
    vi.spyOn(detail, 'getBoundingClientRect').mockReturnValue({ top: 20 } as DOMRect)
    detail.scrollTop = 83
    const entry = { goalId: record.id, runtimeId: record.address!.runtimeId, namespace: record.address!.namespace, section: 'plan' as const, phase: 'pending' as const, token: 'pending-original-source' }
    await act(async () => useAppStore.setState({ goalReadingEntry: entry }))
    expect(detail.scrollTop).toBe(83)
    await act(async () => button('Activity').click())
    expect(useAppStore.getState().goalReadingEntry).toBeNull()
    expect(dom.container.querySelector('[data-goal-reading-section="plan"]')).toBe(section)
    expect(document.activeElement).toBe(dom.container.querySelector('[data-goal-reading-section="activity"]'))
  })
})
