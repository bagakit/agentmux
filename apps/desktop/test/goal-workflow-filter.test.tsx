// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it } from 'vitest'
import type { GoalResponsibilityRow } from '@agentmux/core/goal-responsibility'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { goalNextStepFact } from '../src/renderer/src/lib/goal-presentation'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { chooseField } from './helpers/selection-field'

const dom = composerDOM()
const goal = (id: string, title: string, patch: Partial<DemandRecord> = {}): DemandRecord => ({
  id, title, description: '', source: 'session', priority: 'normal', status: 'backlog',
  projectName: null, projectId: null, sessionIds: [], createdAt: 1, updatedAt: 1, ...patch
})
const records = [
  goal('api', 'Release API', { status: 'done', supervisorSessionId: 'lead', assigneeSessionIds: ['lead'], sessionIds: ['history-only'] }),
  goal('ui', 'Release UI'),
  goal('other', 'Other result', { status: 'done' }),
  goal('accepted', 'Release notes', { status: 'done',
    alignment: { summary: 'Publish notes', criteria: [{ id: 'publish', text: 'Published' }], openQuestions: [], revision: 1, confirmedAt: 3 },
    grounding: { alignmentRevision: 1, summary: 'Published notes', submissionId: 'receipt', acceptedAt: 5,
      checks: [{ criterionId: 'publish', outcome: 'met', evidence: ['notes.md'], note: '' }] } })
]
const stage = (value: string) => '[data-goal-flow-stage="' + value + '"]'
const row = (id: string) => dom.container.querySelector<HTMLElement>('[data-demand-id="' + id + '"]')!
const visible = () => [...dom.container.querySelectorAll<HTMLElement>('.goals-board-column [data-demand-id]')].map(item => item.dataset.demandId).sort()
const button = (selector: string) => dom.container.querySelector<HTMLButtonElement>(selector)!
async function mount() {
  useAppStore.setState({ config: { ...composerConfig, goals: { defaultView: 'board', showFinished: false } },
    mainSurface: 'board', demands: Object.fromEntries(records.map(item => [item.id, item])), selectedDemandId: null,
    sessions: [composerSession('lead'), composerSession('history-only')], agentNames: { lead: 'Release lead', 'history-only': 'Former participant' } })
  await dom.render(<GlobalBoardSurface />)
}
async function search(value: string) {
  const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Search goals"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('filters the actual board lanes by workflow and restores the exact default collection', async () => {
  await mount()
  expect(visible()).toEqual(['api', 'other', 'ui'])
  expect(button(stage('attention')).getAttribute('aria-label')).toMatch(/2 goals$/)
  expect(dom.container.querySelector('[data-goal-summary-stage]')).toBeNull()
  await dom.click(stage('attention'))
  expect(visible()).toEqual(['api', 'other'])
  expect(row('api').closest('[data-status]')?.getAttribute('data-status')).toBe('done')
  expect(row('api').querySelector('.goals-row__next')?.textContent).toBe(goalNextStepFact(records[0]!).text)
  expect(row('api').querySelector('[data-goal-board-role]')?.textContent).toBe('Supervisor / AssigneeRelease lead')
  expect(row('api').querySelector('.goal-agent-group')?.textContent).not.toContain('Former participant')
  await dom.click('[data-goal-flow-all]')
  expect(visible()).toEqual(['api', 'other', 'ui'])
  await dom.click(stage('attention'))
  await dom.click(stage('attention'))
  expect(visible()).toEqual(['api', 'other', 'ui'])
  expect(useAppStore.getState().selectedDemandId).toBeNull()
  expect(dom.draft()).toBe('Keep my draft')
})

it('exposes accepted history by explicit Finished selection and preserves other filters and the original history preference', async () => {
  await mount()
  expect(button(stage('finished')).getAttribute('aria-label')).toMatch(/1 goal$/)
  await dom.click(stage('finished'))
  expect(visible()).toEqual(['accepted'])
  expect(row('accepted').closest('[data-status]')?.getAttribute('data-status')).toBe('done')
  await dom.click('[data-goal-flow-all]')
  expect(visible()).not.toContain('accepted')
  await search('Other')
  expect(button(stage('finished')).getAttribute('aria-label')).toMatch(/0 goals$/)
  await dom.click(stage('finished'))
  expect(visible()).toEqual([])
  expect(dom.container.textContent).toContain('No goals match this view')
  await dom.click('[data-goal-flow-all]')
  expect(visible()).toEqual(['other'])
  await search('')
  await dom.click('[aria-label="Goal filters"]')
  await chooseField(button('[aria-label="Filter work status"]'), 'backlog')
  await dom.click(stage('finished'))
  expect(visible()).toEqual([])
  await dom.click('[data-goal-clear-all]')
  expect(visible()).toEqual(['api', 'other', 'ui'])
})

it('keeps the stage when switching to List and supports keyboard discovery without selecting a stage or goal', async () => {
  await mount()
  const attention = button(stage('attention'))
  attention.focus()
  await act(async () => attention.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(document.activeElement).toBe(button(stage('unknown')))
  expect(visible()).toEqual(['api', 'other', 'ui'])
  await dom.click(stage('attention'))
  await dom.click('[aria-label="List view"]')
  expect([...dom.container.querySelectorAll<HTMLElement>('.goals-list [data-demand-id]')].map(item => item.dataset.demandId).sort()).toEqual(['api', 'other'])
  await dom.click('[data-goal-clear-all]')
  expect(dom.container.querySelectorAll('.goals-list [data-demand-id]')).toHaveLength(3)
  expect(useAppStore.getState().selectedDemandId).toBeNull()
})

it('reads the next owner only from the original Run of the operation named in the card conclusion', async () => {
  const execution = { kind: 'start' as const, operationId: 'dispatch', agentSessionId: 'lead', hostId: 'local', runId: 'run-lead' }
  const confirmed: GoalResponsibilityRow = { execution, binding: 'confirmed', phase: 'executing', reason: 'Original input',
    nextOwner: { kind: 'worker', agentSessionId: 'lead', action: 'Finish the draft' },
    alert: null, basis: { stateEnteredAt: null, activityRevision: null, inputSubmissionId: null } }
  const otherRun = { ...confirmed, execution: { ...execution, runId: 'other-run' },
    nextOwner: { kind: 'external' as const, agentSessionId: null, action: 'Other operation' } }
  const task = goal('original', 'Write release notes', { status: 'in_progress', dispatches: [{
    operationId: 'dispatch', agentSessionId: 'lead', hostId: 'local', runId: 'run-lead', execution: 'finite',
    prompt: 'Write release notes', stage: 'confirmed', preparedAt: 1, submittedAt: 2,
    receipt: { kind: 'core-prompt', itemId: 'prompt:dispatch', createdAt: 3 }
  }], responsibility: { scope: 'original', observedAt: 4, supervisor: { agentSessionId: null, state: 'unknown', reason: 'Unavailable' },
    executions: [otherRun, confirmed] } })
  await mount()
  await act(async () => useAppStore.setState({ demands: { original: task } }))
  expect(row('original').querySelector('.goals-board__next-owner')?.textContent).toBe('Next Release lead')
  await act(async () => useAppStore.setState({ demands: { original: { ...task, responsibility: { ...task.responsibility!, executions: [otherRun] } } } }))
  expect(row('original').querySelector('.goals-board__next-owner')).toBeNull()
})
