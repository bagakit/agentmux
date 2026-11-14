// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { expect, it, vi } from 'vitest'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { api } from '../src/renderer/src/lib/api'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { GoalRow } from '../src/renderer/src/components/GoalsCollection'

const dom = composerDOM()
const originalIssue = 'Invalid Goal responsibility observation. Original Run is unconfirmed; keep the original work and read its receipt.'
const goal = (id: string, patch: Partial<DemandRecord> = {}): DemandRecord => ({ id, title: `Original ${id}`, description: 'Original brief', status: 'backlog', priority: 'normal', projectId: null, projectName: null, source: 'session', sessionIds: [], createdAt: 1, updatedAt: 1, ...patch })
async function mount(view: 'board' | 'list' = 'board') {
  const records = [goal('unknown', { delegationObservationIssue: originalIssue, responsibility: { scope: 'original-scope', observedAt: 1,
    supervisor: { agentSessionId: null, state: 'unknown', reason: 'Original manager observation unavailable' }, executions: [{
      execution: { kind: 'start', operationId: 'original-dispatch', hostId: 'local', agentSessionId: 'agent-1', runId: 'run-agent-1' },
      binding: 'confirmed', phase: 'unknown', reason: originalIssue, nextOwner: { kind: 'manager', agentSessionId: null, action: 'Read the original receipt.' },
      alert: 'unknown', basis: { stateEnteredAt: null, activityRevision: null, inputSubmissionId: null }
    }] } }), goal('working', { status: 'in_progress', responsibility: { scope: 'original-scope', observedAt: 1, supervisor: { agentSessionId: null, state: 'unknown', reason: 'Original manager observation unavailable' }, executions: [] } })]
  useAppStore.setState({ config: { ...composerConfig, goals: { defaultView: view } }, demands: Object.fromEntries(records.map(record => [record.id, record])), selectedDemandId: null, mainSurface: 'board' })
  await dom.render(<GlobalBoardSurface />)
}

it('the original Board spends its lanes on occupied statuses and keeps zero statuses visible as a quiet summary', async () => {
  await mount()
  const lanes = [...dom.container.querySelectorAll<HTMLElement>('.goals-board-column')]
  expect(lanes.map(lane => lane.dataset.status)).toEqual(['backlog', 'in_progress'])
  expect(lanes.map(lane => lane.querySelectorAll('[data-demand-id]').length)).toEqual([1, 1])
  expect([...dom.container.querySelectorAll<HTMLElement>('[data-empty-status]')].map(node => node.dataset.emptyStatus)).toEqual(['todo', 'in_review', 'blocked', 'done', 'cancelled'])
  expect(dom.container.querySelectorAll('[aria-label="Empty work statuses"]')).toHaveLength(1)
  expect(useAppStore.getState().selectedDemandId).toBeNull()
})

it('expanding uncertainty reads the retained error and original recovery controls without selecting or sending', async () => {
  await mount()
  const dispatch = vi.spyOn(api.demands, 'delegation')
  const row = dom.container.querySelector<HTMLElement>('[data-demand-id="unknown"]')!
  const preview = row.querySelector<HTMLDetailsElement>('[data-goal-responsibility-preview]')!
  const summary = preview.querySelector<HTMLElement>('summary')!
  const originalBody = preview.querySelector('[aria-label="Execution responsibility"]')!
  expect(preview.tagName).toBe('DETAILS'); expect(preview.open).toBe(false)
  expect(summary.textContent).toContain('Observation unconfirmed')
  expect(summary.textContent).toContain('Details & recovery')
  expect(summary.querySelector('[data-attention="true"]')).not.toBeNull()
  expect(summary.textContent).not.toContain(originalIssue)
  await act(async () => summary.click())
  expect(preview.open).toBe(true)
  expect(preview.textContent).toContain(originalIssue)
  expect(preview.querySelector('[aria-label="Request owner inspection"]')).not.toBeNull()
  expect([...preview.querySelectorAll('button')].some(button => button.textContent === 'Choose Supervisor')).toBe(true)
  expect(useAppStore.getState().selectedDemandId).toBeNull(); expect(dispatch).not.toHaveBeenCalled()
  await act(async () => preview.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(preview.open).toBe(false); expect(document.activeElement).toBe(summary)
  expect(preview.querySelector('[aria-label="Execution responsibility"]')).toBe(originalBody)
  expect(useAppStore.getState().demands.unknown?.delegationObservationIssue).toBe(originalIssue)
  expect(useAppStore.getState().agentComposerDrafts['agent-1']).toBe('Keep my draft')
  expect(dispatch).not.toHaveBeenCalled()
  await act(async () => row.click())
  expect(useAppStore.getState().selectedDemandId).toBe('unknown')
  expect(dom.container.querySelector('[aria-label="Goal title"]')).not.toBeNull()
})

it('List keeps unknown visible and maintains its original grouped reading rather than changing the chosen view', async () => {
  await mount('list')
  expect(dom.container.querySelector('.goals-list')).not.toBeNull()
  expect(dom.container.querySelector('.goals-board')).toBeNull()
  const summary = dom.container.querySelector('[data-goal-responsibility-preview="working"] > summary')!
  expect(summary.textContent).toContain('Supervisor unconfirmed')
  expect(summary.querySelector('[data-attention="true"]')).not.toBeNull()
  const list = dom.container.querySelector('.goals-list')!
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, latestOutputBytes: 6000 })) })))
  expect(dom.container.querySelector('.goals-list')).toBe(list)
  expect(dom.container.querySelector('[data-goal-responsibility-preview="working"] > summary')).toBe(summary)
})

it('related Agent status never becomes Goal progress and unrelated output does not redraw the row', async () => {
  const record = goal('attribution', { sessionIds: ['related-agent'], delegationObservationIssue: originalIssue })
  const related = composerSession('related-agent')
  useAppStore.setState({ demands: { [record.id]: record }, sessions: [related,
    ...Array.from({ length: 1000 }, (_, i) => composerSession(`unrelated-${i}`))] })
  let commits = 0
  await dom.render(<Profiler id="actual-goal-row" onRender={() => { commits++ }}><GoalRow demand={{ ...record, sessions: [], workspacePath: null }}
    selected={false} selectedSessionId={null} acknowledgementFailed={false} stageChanged={false} onSelect={() => {}} /></Profiler>)
  const facts = () => dom.container.querySelector('.goals-row__facts')!.textContent
  expect(facts()).toContain('1 related Agent')
  expect(facts()).not.toMatch(/working|error|running/iu)
  expect(dom.container.querySelector('[data-goal-responsibility-preview]')!.textContent).toContain(originalIssue)
  const before = commits
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === related.id
    ? { ...session, status: { state: 'error', source: 'run-process', observedAt: 2 } }
    : { ...session, latestOutputBytes: 20000 }) })))
  expect(facts()).toBe('1 related Agent')
  expect(commits).toBe(before)
})

it.each([1, 2])('canonical and presentation references count one confirmed Actor in the actual Goal row (%s aliases)', async aliases => {
  const session = { ...composerSession('presentation-alias'), control: { kind: 'agent' as const,
    hostId: 'local', agentSessionId: 'canonical-actor', run: { runId: 'original-run' } } }
  const record = goal('deduplicated', { sessionIds: ['canonical-actor', 'presentation-alias'] })
  useAppStore.setState({ demands: { [record.id]: record }, sessions: aliases === 1 ? [session] : [session, { ...session, id: 'second-alias' }] })
  await dom.render(<GoalRow demand={{ ...record, sessions: [], workspacePath: null }} selected={false} selectedSessionId={null}
    acknowledgementFailed={false} stageChanged={false} onSelect={() => {}} />)
  expect(dom.container.querySelector('.goals-row__facts')!.textContent).toBe('1 related Agent')
})
