// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { goalPlanState, projectGoalPlan, type GoalPlan, type GoalPlanNodeInput } from '@agentmux/demand/goal-plan'
import type { DemandDelegation } from '@agentmux/demand/delegations'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const node = (id: string, dependsOn: string[] = []): GoalPlanNodeInput => ({
  id, title: id, outcome: id, criterionIds: ['check'], check: 'Verify result', dependsOn, executor: null
})
const nodes = [{ ...node('source'), executor: { hostId: 'local', agentSessionId: 'agent-1' } },
  { ...node('other'), claimOpen: true as const }, node('alpha', ['source']), node('beta', ['source']),
  node('leaf', ['alpha']), node('join', ['leaf', 'beta', 'other'])]
const plan: GoalPlan = { revision: 1, alignmentRevision: 1, nodes, reviews: [],
  history: [{ revision: 1, operationId: 'saved', author: { kind: 'agent', id: 'host' }, revisedAt: 1 }] }
const criteria = [{ id: 'check', text: 'Checked' }]
const record: DemandRecord = {
  id: 'reading', title: 'Read a branch', description: '', status: 'in_progress', priority: 'normal', projectId: null,
  projectName: null, source: 'session', sessionIds: [], createdAt: 1, updatedAt: 1, plan,
  alignment: { revision: 1, summary: 'Trace the dependencies', openQuestions: [], criteria, confirmedAt: 1 },
  planState: goalPlanState(projectGoalPlan(plan, [], criteria))
}
async function board(demand = record) {
  // happy-dom has no layout engine. Give each real dependency column a horizontal position.
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const column = this.closest<HTMLElement>('[data-goal-plan-column]')
    const x = column ? (Number(column.dataset.goalPlanColumn) + 1) * 160 : this.dataset.goalPlanBoundary === 'finish' ? 880 : 0
    const lowerBranch = ['other', 'beta'].includes(this.dataset.goalPlanNode ?? '')
    return new DOMRect(x, lowerBranch ? 112 : 20, this.classList.contains('goal-plan__canvas') ? 1000 : 100, 60)
  })
  useAppStore.setState({ demands: { [demand.id]: demand }, selectedDemandId: demand.id, mainSurface: 'board' })
  await dom.render(<GlobalBoardSurface />)
  const canvas = dom.container.querySelector<HTMLElement>('[aria-label="Execution graph"]')!
  const card = (id: string) => canvas.querySelector<HTMLElement>(`[data-goal-plan-node="${id}"]`)!
  const edge = (id: string) => canvas.querySelector<SVGPathElement>(`[data-goal-plan-edge="${id}"]`)!
  const head = (id: string) => card(id).querySelector<HTMLButtonElement>('button')!
  const reading = () => dom.container.querySelector<HTMLElement>('.goal-plan__reading h3')
  return { canvas, card, edge, head, reading, measure }
}

it('reads the original task handoff and reverses direction only for a report from its executor', async () => {
  const attempt: DemandDelegation = {
    operationId: 'source-attempt', sourceMessageId: 'dispatch', planNodeId: 'source', hostId: 'local',
    workerHostId: 'worker-host', ownerAgentSessionId: 'supervisor', workerAgentSessionId: 'agent-1',
    ownerRunId: 'manager-run', workerRunId: 'worker-run', threadId: 'execution-thread', text: 'Verify recovery',
    alignmentRevision: 1, criterionIds: ['check'], capturedCriteria: criteria, preparedAt: 2, linkedAt: 3,
    report: { operationId: 'delivery', replyMessageId: 'reply', authorAgentSessionId: 'agent-1', submittedAt: 4,
      grounding: { alignmentRevision: 1, summary: 'Original workspace recovered', checks: [] } }
  }
  const pending: DemandDelegation = { ...attempt, operationId: 'beta-attempt', planNodeId: 'beta',
    ownerAgentSessionId: 'previous-owner', workerAgentSessionId: 'agent-2' }
  delete pending.report
  delete pending.linkedAt
  const delegations = [attempt, pending]
  const crossHostPlan = { ...plan, nodes: [{ ...nodes[0]!, executor: { hostId: 'worker-host', agentSessionId: 'agent-1' } }, ...nodes.slice(1)] }
  const { head } = await board({ ...record, plan: crossHostPlan, supervisorSessionId: 'supervisor', delegations,
    planState: goalPlanState(projectGoalPlan(crossHostPlan, delegations, criteria)) })
  const handoff = () => dom.container.querySelector('[aria-label="Task handoff"]')
  const actors = () => [...handoff()!.querySelectorAll('.goal-plan-handoff__agent')].map(person => [
    person.querySelector('small')?.textContent, person.querySelector('strong')?.title.split('\n')[0]
  ])
  expect(handoff()?.getAttribute('data-goal-handoff')).toBe('source-attempt')
  expect(handoff()?.textContent).toContain('Delivery reported')
  expect(actors(), 'A report travels from the original executor to the recorded task owner.').toEqual([
    ['Executor', 'agent-1'], ['Supervisor', 'supervisor']
  ])
  expect(handoff()?.querySelector('strong')?.title).toContain('Host worker-host')
  await act(async () => head('beta').click())
  expect(handoff()?.getAttribute('data-goal-handoff')).toBe('beta-attempt')
  expect(handoff()?.textContent).toContain('Dispatch prepared')
  expect(actors()).toEqual([['Task owner', 'previous-owner'], ['Executor', 'agent-2']])
  await act(async () => head('other').click())
  expect(handoff()).toBeNull()
})

it('reads a collected and reviewed attempt while keeping the whole Goal finish pending', async () => {
  const attempt: DemandDelegation = {
    operationId: 'reviewed-attempt', sourceMessageId: 'dispatch', planNodeId: 'source', hostId: 'local',
    ownerAgentSessionId: 'supervisor', workerAgentSessionId: 'agent-1',
    ownerRunId: 'manager-run', workerRunId: 'worker-run', threadId: 'execution-thread', text: 'Verify recovery',
    alignmentRevision: 1, criterionIds: ['check'], capturedCriteria: criteria, preparedAt: 2, linkedAt: 3,
    report: { operationId: 'delivery', replyMessageId: 'reply', authorAgentSessionId: 'agent-1', submittedAt: 4,
      grounding: { alignmentRevision: 1, summary: 'Original workspace recovered', checks: [] } },
    collection: { operationId: 'collected', replyMessageId: 'reply', collector: { kind: 'user', id: 'collector' }, collectedAt: 5 }
  }
  const only = { ...plan, nodes: [nodes[0]!] }
  const ownerState = goalPlanState(projectGoalPlan(only, [attempt], criteria))
  const completed = { ...record, status: 'in_review' as const, plan: only, delegations: [attempt],
    planState: { ...ownerState, done: 1, nodes: ownerState.nodes.map(node => ({ ...node, state: 'done' as const })) } }
  const { head, canvas } = await board(completed)
  expect(dom.container.querySelector('[aria-label="Task handoff"]')).toBeNull()
  await act(async () => head('source').click())
  const handoff = dom.container.querySelector('[aria-label="Task handoff"]')
  expect(handoff?.textContent, 'A completed Ticket reports the verdict and the collected transfer separately.').toContain('Review passed')
  expect(handoff?.textContent).toContain('Delivery reported')
  const finish = () => canvas.querySelector('[data-goal-plan-boundary="finish"]')?.getAttribute('data-goal-finish-state')
  expect(finish()).toBe('Report needed')
  const grounding = { submissionId: 'original-results', alignmentRevision: 1, summary: 'One missing observation', acceptedAt: null,
    checks: [{ criterionId: 'check', outcome: 'unknown' as const, evidence: [], note: 'No original input observation' }] }
  await act(async () => useAppStore.setState({ demands: { [record.id]: { ...completed, grounding } } }))
  expect(finish(), 'A completed Ticket exposes the missing Goal evidence').toBe('Evidence needed')
  await act(async () => useAppStore.setState({ demands: { [record.id]: { ...completed, grounding: {
    ...grounding, checks: [{ criterionId: 'check', outcome: 'met', evidence: ['verified.log'], note: '' }]
  } } } }))
  expect(finish()).toBe('Awaiting acceptance')
  await act(async () => useAppStore.setState({ demands: { [record.id]: { ...completed, status: 'in_progress', grounding } } }))
  expect(finish(), 'The owner still has independent work to resolve').toBe('Pending')
  await act(async () => useAppStore.setState({ demands: { [record.id]: { ...completed, status: 'done', grounding: {
    ...grounding, acceptedAt: 9, unknownDecision: { by: { kind: 'user', id: 'person' },
      checks: [{ criterionId: 'check', reason: 'The original composer observation was never recorded.' }] },
  } } } }))
  expect(finish(), 'An explicit closure preserves the unknown result').toBe('Unverified')
  expect(dom.container.querySelector('[data-goal-meta-plan]')?.textContent).toBe('1 of 1 Tickets passed')
  const collection = dom.container.querySelector<HTMLButtonElement>('[data-goal-time-event="Report collected"]')!
  await act(async () => collection.click())
  const reading = dom.container.querySelector('.goal-execution-time__detail')!
  expect(reading.textContent).toContain('User collector')
  expect(reading.textContent).toContain('collected')
  const openOriginal = [...reading.querySelectorAll('button')].find(button => button.textContent === 'Open original record')!
  await act(async () => openOriginal.click())
  expect(document.activeElement?.closest('[data-goal-coordination]')?.getAttribute('data-goal-coordination')).toBe('collection:reviewed-attempt')
})

it('traces only actual ancestors and descendants of a hovered node in the mounted board', async () => {
  const { canvas, card, edge, head, reading, measure } = await board()
  const originalEdge = edge('alpha>leaf'), originalHead = head('alpha')
  expect(canvas.dataset.goalTrace).toBeUndefined()
  expect(originalEdge).not.toBeNull()
  measure.mockClear()
  originalHead.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  expect(canvas.dataset.goalTrace).toBe('alpha')
  expect(card('alpha').dataset.goalPath).toBe('current')
  expect(card('source').querySelector('.goal-plan-node__role')?.textContent).toContain('Assigned')
  expect(card('source').querySelector('.goal-plan-node__name')?.textContent).toBeTruthy()
  expect(card('other').querySelector('[data-claim-open]')?.textContent).toBe('Open to claim')
  expect(card('source').dataset.goalPath).toBe('upstream')
  expect(card('leaf').dataset.goalPath, 'The child must follow the hovered task downstream.').toBe('downstream')
  expect(card('join').dataset.goalPath).toBe('downstream')
  expect(card('beta').dataset.goalPath).toBeUndefined()
  expect(card('other').dataset.goalPath).toBeUndefined()
  expect(edge('source>alpha').dataset.goalPath).toBe('upstream')
  expect(edge('alpha>leaf').dataset.goalPath).toBe('downstream')
  expect(edge('leaf>join').dataset.goalPath).toBe('downstream')
  expect(edge('beta>join').dataset.goalPath).toBeUndefined()
  expect(edge('source>beta').dataset.goalPath).toBeUndefined()
  expect(canvas.querySelectorAll('[data-goal-boundary-edge="start"][data-goal-path="upstream"]')).toHaveLength(1)
  expect(canvas.querySelectorAll('[data-goal-boundary-edge="finish"][data-goal-path="downstream"]')).toHaveLength(1)
  expect(reading()).toBeNull()
  expect(head('alpha').getAttribute('aria-expanded')).toBe('false')
  originalHead.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
  expect(canvas.querySelectorAll('[data-goal-path]')).toHaveLength(0)
  expect(canvas.dataset.goalTrace).toBeUndefined()
  expect(edge('alpha>leaf')).toBe(originalEdge)
  expect(head('alpha')).toBe(originalHead)
  expect(measure).not.toHaveBeenCalled()
})

it('keeps the inspected task while keyboard focus or pointer previews a different branch', async () => {
  const { canvas, head, card, reading } = await board()
  await act(async () => head('alpha').click())
  expect(reading()?.textContent, 'The reading pane belongs to the selected task.').toBe('alpha')
  expect(canvas.dataset.goalTrace).toBe('alpha')
  const selectedHeading = reading()!
  head('beta').focus()
  expect(document.activeElement).toBe(head('beta'))
  expect(canvas.dataset.goalTrace).toBe('beta')
  expect(card('alpha').dataset.goalPath).toBeUndefined()
  expect(card('leaf').dataset.goalPath).toBeUndefined()
  head('other').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  expect(canvas.dataset.goalTrace).toBe('other')
  head('other').dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
  expect(canvas.dataset.goalTrace).toBe('beta')
  expect(reading()).toBe(selectedHeading)
  expect(head('alpha').getAttribute('aria-expanded')).toBe('true')
  selectedHeading.focus()
  expect(canvas.dataset.goalTrace).toBe('alpha')
  expect(card('leaf').dataset.goalPath).toBe('downstream')
  head('other').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch' }))
  expect(canvas.dataset.goalTrace).toBe('alpha')
})


it('draws distinct dependency ports on the original source and target cards', async () => {
  const { edge, card, canvas } = await board()
  const endpoints = (id: string) => {
    const coordinates = edge(id).getAttribute('d')!.match(/[-+]?(?:\d*\.)?\d+/g)!.map(Number)
    const first = coordinates.slice(0, 2), last = coordinates.slice(-2)
    return { start: { x: first[0]!, y: first[1]! }, end: { x: last[0]!, y: last[1]! } }
  }
  const outgoing = [endpoints('source>alpha').start, endpoints('source>beta').start]
  const incoming = [endpoints('leaf>join').end, endpoints('beta>join').end, endpoints('other>join').end]
  for (const ports of [outgoing, incoming]) {
    expect(new Set(ports.map(point => point.y)).size, 'Parallel dependencies need distinct ports on their shared task.').toBe(ports.length)
  }
  const origin = canvas.getBoundingClientRect()
  const source = card('source').getBoundingClientRect(), join = card('join').getBoundingClientRect()
  for (const port of outgoing) {
    expect(port.x).toBe(source.right - origin.left)
    expect(port.y).toBeGreaterThan(source.top - origin.top)
    expect(port.y).toBeLessThan(source.bottom - origin.top)
  }
  for (const port of incoming) {
    expect(port.x).toBe(join.left - origin.left)
    expect(port.y).toBeGreaterThan(join.top - origin.top)
    expect(port.y).toBeLessThan(join.bottom - origin.top)
  }
})


it('keeps an unverified original Goal distinct from a successful finish and opens it from the empty timeline', async () => {
  const { plan: _plan, planState: _planState, ...original } = record
  const goal: DemandRecord = { ...original, alignment: { ...original.alignment!, confirmedAt: null }, status: 'done', sessionIds: ['recorded-member'] }
  useAppStore.setState({ demands: { [goal.id]: goal }, selectedDemandId: goal.id, mainSurface: 'board' })
  await dom.render(<GlobalBoardSurface />)
  const graph = dom.container.querySelector('[aria-label="Goal plan"]')!
  const finish = graph.querySelector('[data-goal-finish-state="Unverified"]')!
  expect(finish.querySelector('svg')?.getAttribute('data-semantic-icon'), 'An unchecked result must use the unverified glyph.').toBe('status.unknown')
  const card = graph.querySelector('[data-goal-plan-origin]')!
  expect(card.querySelector('.goal-plan-node__who')?.textContent).toBe('Executor unconfirmed')
  const timeline = graph.querySelector('[aria-label="Execution timeline"]')!
  expect(timeline.querySelector('.goal-execution-time__axis')).toBeNull()
  expect(timeline.textContent).toContain('No times recorded')
  expect(timeline.querySelector('time, [role="img"]')).toBeNull()
  const jump = timeline.querySelector('button')!
  await act(async () => jump.click())
  expect(graph.querySelector('.goal-plan__reading h3')?.textContent).toBe(goal.title)
  expect(card.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
  await act(async () => graph.querySelector<HTMLButtonElement>('.goal-plan__reading-header button')!.click())
  expect(document.activeElement).toBe(jump)
})
