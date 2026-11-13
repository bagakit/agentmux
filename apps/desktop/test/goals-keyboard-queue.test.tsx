// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import type { DemandAlignment, DemandGrounding } from '@agentmux/demand/goals'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const criteria = [{ id: 'a', text: 'First outcome' }]
const agreed = (patch: Partial<DemandAlignment> = {}): DemandAlignment => ({ summary: 'Agreed', criteria, openQuestions: [], revision: 1, confirmedAt: 10, ...patch })
const report = (): DemandGrounding => ({ alignmentRevision: 1, summary: 'Report', submissionId: 'r', acceptedAt: null, checks: [{ criterionId: 'a', outcome: 'met', evidence: ['x:1'], note: '' }] })
let order = 0
const goal = (id: string, patch: Partial<DemandRecord>): DemandRecord => ({ id, title: `Goal ${id}`, description: '', status: 'in_progress', priority: 'normal', projectId: null, projectName: null, source: 'session', sessionIds: [], createdAt: ++order, updatedAt: order, ...patch })
const seed = (records: DemandRecord[], selected: string | null = null) => useAppStore.setState({ demands: Object.fromEntries(records.map(r => [r.id, r])), selectedDemandId: selected, mainSurface: 'board' })
const key = (target: Element, key: string) => act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
const rows = () => [...dom.container.querySelectorAll<HTMLElement>('[data-demand-id]')].map(row => row.dataset.demandId)

describe('Goals keyboard movement', () => {
  it('moves focus through rows in the grouped reading order with j/k and ArrowDown/ArrowUp', async () => {
    seed([goal('confirm', { alignment: agreed({ confirmedAt: null }) }), goal('outline', {}), goal('review', { alignment: agreed(), grounding: report() })])
    await dom.render(<GlobalBoardSurface />)
    expect(rows()).toEqual(['review', 'confirm', 'outline'])
    const first = dom.container.querySelector<HTMLElement>('[data-demand-id="review"]')!
    first.focus()
    await key(first, 'j'); expect((document.activeElement as HTMLElement).dataset.demandId).toBe('confirm')
    await key(document.activeElement!, 'ArrowDown'); expect((document.activeElement as HTMLElement).dataset.demandId).toBe('outline')
    await key(document.activeElement!, 'k'); expect((document.activeElement as HTMLElement).dataset.demandId).toBe('confirm')
    await key(document.activeElement!, 'ArrowUp'); expect((document.activeElement as HTMLElement).dataset.demandId).toBe('review')
  })

  it('leaves typing alone inside the search field', async () => {
    seed([goal('confirm', { alignment: agreed({ confirmedAt: null }) }), goal('outline', {})])
    await dom.render(<GlobalBoardSurface />)
    const search = dom.container.querySelector<HTMLInputElement>('input[aria-label="Search goals"]')!
    search.focus(); await key(search, 'j')
    expect(document.activeElement).toBe(search)
  })
})

describe('Goal detail queue', () => {
  it('shows the place in its group and opens the next Goal waiting in that group', async () => {
    seed([goal('one', { alignment: agreed({ confirmedAt: null }) }), goal('two', { alignment: agreed(), grounding: report() }), goal('outline', {})], 'two')
    await dom.render(<GlobalBoardSurface />)
    const queue = dom.container.querySelector<HTMLElement>('.goals-detail [data-goal-queue]')!
    expect(queue.textContent).toContain('1 of 2')
    const next = queue.querySelector<HTMLButtonElement>('[data-goal-queue-next]')!
    expect(next.getAttribute('aria-label')).toBe('Next goal that needs you')
    await act(async () => next.click())
    expect(useAppStore.getState().selectedDemandId).toBe('one')
    expect(dom.container.querySelector('.goals-detail [data-goal-queue-next]')).toBeNull()
  })
})

describe('Stage change cue', () => {
  it('marks only a shown Goal whose facts moved it to another group', async () => {
    const pending = goal('pending', { alignment: agreed({ confirmedAt: null }) })
    seed([pending, goal('steady', {})])
    await dom.render(<GlobalBoardSurface />)
    expect(dom.container.querySelector('[data-goal-stage-changed]')).toBeNull()
    await act(async () => { useAppStore.setState({ demands: { ...useAppStore.getState().demands, pending: { ...pending, alignment: agreed(), updatedAt: 99 } } }) })
    const moved = dom.container.querySelector<HTMLElement>('[data-demand-id="pending"]')!
    expect(moved.hasAttribute('data-goal-stage-changed')).toBe(true)
    expect(dom.container.querySelector<HTMLElement>('[data-demand-id="steady"]')!.hasAttribute('data-goal-stage-changed')).toBe(false)
  })
})
