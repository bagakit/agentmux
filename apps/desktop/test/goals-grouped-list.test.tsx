// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DemandAlignment, DemandGrounding } from '@agentmux/demand/goals'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { goalNextStepFact } from '../src/renderer/src/lib/goal-presentation'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'

/**
 * People open Goals to learn what waits on them. The first screen groups Goals by whose turn it is,
 * counts each group in the header and marks each row, all from the one next-step branch.
 */
const dom = composerDOM()
const criteria = [{ id: 'a', text: 'First outcome' }]
const agreed = (patch: Partial<DemandAlignment> = {}): DemandAlignment => ({ summary: 'Agreed direction', criteria, openQuestions: [], revision: 1, confirmedAt: 10, ...patch })
const report = (patch: Partial<DemandGrounding> = {}): DemandGrounding => ({ alignmentRevision: 1, summary: 'Agent report', submissionId: 'report', acceptedAt: null,
  checks: [{ criterionId: 'a', outcome: 'met', evidence: ['result.md:1'], note: '' }], ...patch })
let order = 0
function goal(id: string, patch: Partial<DemandRecord>): DemandRecord {
  order++
  return { id, title: `Goal ${id}`, description: '', status: 'in_progress', priority: 'normal', projectId: null, projectName: null, source: 'session',
    sessionIds: [], createdAt: order, updatedAt: order, ...patch }
}
const goals = [
  goal('confirm', { alignment: agreed({ confirmedAt: null }) }),
  goal('review', { alignment: agreed(), grounding: report() }),
  goal('outline', {}),
  goal('agent', { alignment: agreed() }),
  goal('stale', { alignment: agreed({ revision: 2 }), grounding: report() }),
  goal('accepted', { status: 'done', alignment: agreed(), grounding: report({ acceptedAt: 20 }) })
]
const seed = (records = goals) => useAppStore.setState({ demands: Object.fromEntries(records.map(record => [record.id, record])), selectedDemandId: null, mainSurface: 'board' })
const groups = () => [...dom.container.querySelectorAll<HTMLElement>('[data-goal-group]')]
const rowIds = (group: HTMLElement) => [...group.querySelectorAll<HTMLElement>('[data-demand-id]')].map(row => row.dataset.demandId)

describe('Goals list grouped by whose turn it is', () => {
  it('orders groups you → attention → define → agents and keeps finished history out by default', async () => {
    seed(); await dom.render(<GlobalBoardSurface />)
    expect(groups().map(group => group.dataset.goalGroup)).toEqual(['you', 'attention', 'define', 'agents'])
    expect(rowIds(groups()[0]!).sort()).toEqual(['confirm', 'review'])
    expect(rowIds(groups()[1]!)).toEqual(['stale'])
    expect(rowIds(groups()[2]!)).toEqual(['outline'])
    expect(rowIds(groups()[3]!)).toEqual(['agent'])
    expect(dom.container.querySelector('[data-demand-id="accepted"]')).toBeNull()
  })

  it('derives each group and mark from goalNextStepFact, not from the sentence', async () => {
    seed(); await dom.render(<GlobalBoardSurface />)
    for (const record of goals.filter(record => record.id !== 'accepted')) {
      const row = dom.container.querySelector<HTMLElement>(`[data-demand-id="${record.id}"]`)!
      const fact = goalNextStepFact(record)
      expect(row.closest<HTMLElement>('[data-goal-group]')!.dataset.goalGroup).toBe(fact.stage)
      expect(row.querySelector<HTMLElement>('[data-goal-stage]')!.dataset.goalStage).toBe(fact.stage)
      expect(row.querySelector('.goals-row__next')!.textContent).toBe(fact.text)
    }
  })

  it('summarizes the same counts in the page header and offers one primary action there', async () => {
    seed(); await dom.render(<GlobalBoardSurface />)
    const header = dom.container.querySelector<HTMLElement>('.goals-page-header')!
    expect(header.querySelector('h1')!.textContent).toBe('Goals')
    const summary = [...header.querySelectorAll<HTMLElement>('[data-goal-summary-stage]')].map(item => [item.dataset.goalSummaryStage, item.textContent])
    expect(summary).toEqual([['you', '2 need you'], ['attention', '1 needs attention'], ['define', '1 to define'], ['agents', '1 with agents']])
    expect(header.querySelectorAll('.primary-button')).toHaveLength(1)
    expect(header.querySelector('.primary-button')!.getAttribute('aria-label')).toBe('New Goal')
  })

  it('names a calm state when nothing waits on the person', async () => {
    seed([goals[3]!]); await dom.render(<GlobalBoardSurface />)
    expect(groups().map(group => group.dataset.goalGroup)).toEqual(['agents'])
    expect(dom.container.querySelector('.goals-page-header [data-goal-summary-clear]')!.textContent).toBe('Nothing waits on you')
  })

  it('reads each group heading as a labelled region with its count', async () => {
    seed(); await dom.render(<GlobalBoardSurface />)
    const first = groups()[0]!
    expect(first.getAttribute('aria-labelledby')).toBeTruthy()
    expect(dom.container.querySelector(`#${first.getAttribute('aria-labelledby')}`)!.textContent).toBe('Needs you2')
  })

  it('does not repeat the absent-execution placeholder on every row', async () => {
    seed(); await dom.render(<GlobalBoardSurface />)
    expect(dom.container.querySelector('.goals-list')!.textContent).not.toContain('尚无确认执行绑定')
  })

  it('keeps the regrouped list when the person picks one work status', async () => {
    seed(); await dom.render(<GlobalBoardSurface />)
    await act(async () => { useAppStore.setState({ demands: { ...useAppStore.getState().demands, review: { ...goals[1]!, status: 'in_review', updatedAt: 99 } } }) })
    expect(groups()[0]!.querySelector('[data-demand-id="review"]')).not.toBeNull()
  })

  it('opens a Goal on the same stage and next step its row showed', async () => {
    seed(); useAppStore.setState({ selectedDemandId: 'confirm' }); await dom.render(<GlobalBoardSurface />)
    const stage = dom.container.querySelector<HTMLElement>('.goals-detail [data-goal-detail-stage]')!
    expect(stage.querySelector<HTMLElement>('[data-goal-stage]')!.dataset.goalStage).toBe('you')
    expect(stage.textContent).toBe('Needs you · Goal ready for confirmation')
  })

  it('does no grouping render work for unrelated Session output', async () => {
    seed()
    const commits = vi.fn()
    await dom.render(<Profiler id="goals" onRender={commits}><GlobalBoardSurface /></Profiler>)
    const count = commits.mock.calls.length
    expect(count).toBeGreaterThan(0)
    const [session] = useAppStore.getState().sessions
    await act(async () => { useAppStore.setState({ sessions: [{ ...session!, latestOutputBytes: 900000, updatedAt: 99 }] }) })
    expect(commits.mock.calls.length).toBe(count)
  })
})

describe('Goal stage marks', () => {
  it('give every stage its own glyph, so the mark reads without color', async () => {
    const { GOAL_STAGE_ICON_NAMES } = await import('../src/renderer/src/lib/goal-groups')
    const names = Object.values(GOAL_STAGE_ICON_NAMES)
    expect(names.length).toBe(6)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('Goal detail reading', () => {
  it('does not repeat an empty responsibility block above Collaboration', async () => {
    seed(); useAppStore.setState({ selectedDemandId: 'agent' }); await dom.render(<GlobalBoardSurface />)
    const detail = dom.container.querySelector('.goals-detail')!
    expect(detail.querySelector('.goal-collaboration')).not.toBeNull()
    expect(detail.textContent).not.toContain('尚无确认执行绑定')
    expect(detail.querySelector('.goal-responsibility__heading')).toBeNull()
  })
})

describe('One solid primary per surface', () => {
  it('lets the open Goal own the solid primary, keeping New Goal reachable as a secondary', async () => {
    seed(); useAppStore.setState({ selectedDemandId: 'review' }); await dom.render(<GlobalBoardSurface />)
    const create = dom.container.querySelector<HTMLButtonElement>('[data-new-goal]')!
    expect(create.getAttribute('aria-label')).toBe('New Goal')
    expect(create.classList.contains('primary-button')).toBe(false)
    expect(dom.container.querySelectorAll('.goals-surface .primary-button, .goals-surface .goals-button--primary').length).toBe(1)
    expect(dom.container.querySelector('.goals-detail .goals-button--primary')).not.toBeNull()
  })
})

describe('Goals brand start', () => {
  it('shows the Goals companions beside the title when Goals exist, decorative and size-bounded', async () => {
    seed(); await dom.render(<GlobalBoardSurface />)
    const art = dom.container.querySelector<HTMLImageElement>('.goals-page-header__art')!
    expect(art.getAttribute('alt')).toBe('')
    expect(art.getAttribute('aria-hidden')).toBe('true')
    expect(art.src).toContain('goals-companions-header')
    expect(Number(art.getAttribute('width'))).toBeLessThanOrEqual(278)
  })

  it('keeps the header compact without art while a Goal is open', async () => {
    seed(); useAppStore.setState({ selectedDemandId: 'review' }); await dom.render(<GlobalBoardSurface />)
    expect(dom.container.querySelector('.goals-page-header__art')).toBeNull()
  })
})
