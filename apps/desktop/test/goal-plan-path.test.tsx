// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { goalPlanState, projectGoalPlan, type GoalPlan, type GoalPlanNodeInput } from '@agentmux/demand/goal-plan'
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
async function board() {
  // happy-dom has no layout engine. Give each real dependency column a horizontal position.
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const column = this.closest<HTMLElement>('[data-goal-plan-column]')
    const x = column ? (Number(column.dataset.goalPlanColumn) + 1) * 160 : this.dataset.goalPlanBoundary === 'finish' ? 880 : 0
    const lowerBranch = ['other', 'beta'].includes(this.dataset.goalPlanNode ?? '')
    return new DOMRect(x, lowerBranch ? 112 : 20, this.classList.contains('goal-plan__canvas') ? 1000 : 100, 60)
  })
  useAppStore.setState({ demands: { [record.id]: record }, selectedDemandId: record.id, mainSurface: 'board' })
  await dom.render(<GlobalBoardSurface />)
  const canvas = dom.container.querySelector<HTMLElement>('[aria-label="Execution graph"]')!
  const card = (id: string) => canvas.querySelector<HTMLElement>(`[data-goal-plan-node="${id}"]`)!
  const edge = (id: string) => canvas.querySelector<SVGPathElement>(`[data-goal-plan-edge="${id}"]`)!
  const head = (id: string) => card(id).querySelector<HTMLButtonElement>('button')!
  const reading = () => dom.container.querySelector<HTMLElement>('.goal-plan__reading h3')
  return { canvas, card, edge, head, reading, measure }
}

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
