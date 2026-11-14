// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DemandAlignment, DemandGrounding } from '@agentmux/demand/goals'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { goalNextStepFact } from '../src/renderer/src/lib/goal-presentation'
import { GOAL_GROUP_LABELS } from '../src/renderer/src/lib/goal-groups'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

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
    expect(dom.container.querySelector('.goals-list')!.textContent).not.toContain('No confirmed execution binding')
  })

  it('keeps the regrouped list when the person picks one work status', async () => {
    seed(); await dom.render(<GlobalBoardSurface />)
    await act(async () => { useAppStore.setState({ demands: { ...useAppStore.getState().demands, review: { ...goals[1]!, status: 'in_review', updatedAt: 99 } } }) })
    expect(groups()[0]!.querySelector('[data-demand-id="review"]')).not.toBeNull()
  })

  it('opens a Goal on the same stage and next step its row showed', async () => {
    seed(); useAppStore.setState({ selectedDemandId: 'confirm' }); await dom.render(<GlobalBoardSurface />)
    const stage = dom.container.querySelector<HTMLElement>('.goals-detail [data-goal-detail-stage]')!
    const fact = goalNextStepFact(goals[0]!)
    expect(stage.querySelector<HTMLElement>('[data-goal-stage]')!.dataset.goalStage).toBe(fact.stage)
    expect(stage.querySelector('small')?.textContent).toBe(GOAL_GROUP_LABELS[fact.stage])
    expect(stage.querySelector('strong')?.textContent).toBe(fact.text)
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
    expect(detail.textContent).not.toContain('No confirmed execution binding')
    expect(detail.querySelector('.goal-responsibility__heading')).toBeNull()
  })
})

describe('One solid primary per surface', () => {
  it('lets the open Goal own the solid primary, keeping New Goal reachable as a secondary', async () => {
    seed(); useAppStore.setState({ selectedDemandId: 'review' }); await dom.render(<GlobalBoardSurface />)
    const create = dom.container.querySelector<HTMLButtonElement>('[data-new-goal]')!
    expect(create.getAttribute('aria-label')).toBe('New Goal')
    expect(create.classList.contains('primary-button')).toBe(false)
    expect(dom.container.querySelectorAll('.goals-surface .primary-button').length).toBe(1)
    expect(dom.container.querySelector('.goals-detail .primary-button')).not.toBeNull()
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

describe('Goal detail reading', () => {
  it('marks a related Session that failed from its Core state, not from its label', async () => {
    const failed = { ...composerSession('failed-agent'), status: { state: 'error' as const, source: 'run-process' as const, observedAt: 1 } }, healthy = composerSession('healthy-agent')
    useAppStore.setState({ sessions: [failed, healthy], agentNames: { [failed.id]: 'A healthy-looking label', [healthy.id]: 'Failed is only this name' } })
    seed([goal('linked', { alignment: agreed(), sessionIds: [failed.id, healthy.id], participations: [failed, healthy].map(session => ({
      id: 'original-discussion-' + session.id, operationId: 'original-discussion-' + session.id, kind: 'discussion',
      hostId: session.control.hostId, agentSessionId: session.control.agentSessionId, entryPoint: 'goal.discuss', recordedAt: 1
    })) })]); useAppStore.setState({ selectedDemandId: 'linked' })
    await dom.render(<GlobalBoardSurface />)
    const member = dom.container.querySelector<HTMLButtonElement>('.goal-team button.focus-context[data-session-id="failed-agent"]')
    const neighbour = dom.container.querySelector<HTMLButtonElement>('.goal-team button.focus-context[data-session-id="healthy-agent"]')
    expect(member).not.toBeNull(); expect(neighbour).not.toBeNull()
    expect(member?.dataset.state).toBe(failed.status.state)
    expect(member?.querySelector('.focus-context__identity strong')?.textContent).toBe('A healthy-looking label')
    expect(member?.querySelector('.focus-context__state small')?.textContent).toBe('Failed')
    expect(member?.querySelector('[data-focus-state-icon]')?.getAttribute('data-focus-state-icon')).toBe('error')
    expect(neighbour?.dataset.state).toBe(healthy.status.state)
    expect(neighbour?.querySelector('.focus-context__identity strong')?.textContent).toBe('Failed is only this name')
    expect(neighbour?.querySelector('[data-focus-state-icon]')?.getAttribute('data-focus-state-icon')).toBe('unknown')
    expect(neighbour?.querySelector('.focus-context__state small')?.textContent).not.toBe('Failed')
    expect(member?.disabled).toBe(false); expect(neighbour?.disabled).toBe(false)
  })

  it('keeps the clarify request on the same line as the stage primary', async () => {
    seed(); useAppStore.setState({ selectedDemandId: 'confirm' }); await dom.render(<GlobalBoardSurface />)
    const actions = dom.container.querySelector('.goals-alignment .goals-inline-actions')!
    expect(actions.querySelector('[data-goal-confirm]')).not.toBeNull()
    expect(actions.querySelector('[data-goal-grill]')).not.toBeNull()
    expect(actions.querySelector('[data-goal-grill]')!.parentElement).toBe(actions)
  })
})

describe('Goals header with no Goals', () => {
  it('leaves the empty fact to the empty state instead of saying it twice', async () => {
    seed([]); await dom.render(<GlobalBoardSurface />)
    expect(dom.container.querySelector('.goals-page-header__summary')).toBeNull()
    expect(dom.container.querySelector('.goals-empty')!.textContent).toContain('No goals yet')
  })
})

describe('Goal definition heading', () => {
  it('reads the same with or without a proposal: the Goal glyph and a section rule above', async () => {
    seed(); useAppStore.setState({ selectedDemandId: 'outline' }); await dom.render(<GlobalBoardSurface />)
    const undefinedHeading = dom.container.querySelector('.goals-intent-body h2')!
    expect(undefinedHeading.textContent?.trim()).toBe('Goal definition')
    expect(undefinedHeading.querySelector('[data-semantic-icon="object.goal"]')).not.toBeNull()
    await act(async () => { useAppStore.setState({ selectedDemandId: 'confirm' }) })
    const proposalHeading = dom.container.querySelector('.goals-alignment h2')!
    expect(proposalHeading.querySelector('[data-semantic-icon="object.goal"]')).not.toBeNull()
  })
})

describe('Normal-path copy reads as guidance, not disclaimers', () => {
  it('says what Accept and finish does in one clause and drops the reassurance chain', async () => {
    seed(); useAppStore.setState({ selectedDemandId: 'review' }); await dom.render(<GlobalBoardSurface />)
    const results = dom.container.querySelector('.goals-grounding')!
    expect(results.textContent).toContain('Accept and finish also closes the goal.')
    expect(results.textContent).not.toContain('Original Agents keep running')
    expect(results.textContent).not.toContain('ends its scheduled follow-up')
  })

  it('names the next move for an agreed goal without a report in one sentence', async () => {
    seed(); useAppStore.setState({ selectedDemandId: 'agent' }); await dom.render(<GlobalBoardSurface />)
    const missing = dom.container.querySelector('.goals-no-results')!
    expect(missing.querySelector('.goals-muted')!.textContent).toBe('Agents work on this goal next. Ask for a result check when the work is ready.')
  })

  it('does not caption Collaboration with what selection does not do', async () => {
    seed(); useAppStore.setState({ selectedDemandId: 'agent' }); await dom.render(<GlobalBoardSurface />)
    expect(dom.container.querySelector('.goal-collaboration')!.textContent).not.toContain('Selection does not start execution')
  })
})
