// @vitest-environment happy-dom
import './helpers/goal-responsibility-product'
import { fixture, semantic, mount, container, settle, evidence } from './helpers/goal-responsibility-product'
import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { refreshGoalDelegations } from '../src/renderer/src/lib/goal-delegation-work'
import { useAppStore } from '../src/renderer/src/store'

const goal = () => useAppStore.getState().demands.goal!
const summary = () => container.querySelector<HTMLElement>('.goals-row [data-goal-responsibility="goal"]')!
const primary = () => summary().querySelector<HTMLButtonElement>('.goal-patrol__actions > button[aria-busy]')!
async function updated(action: () => unknown, assertion: () => void) {
  await act(async () => { await action(); await vi.waitFor(assertion) }); await settle()
}
async function board() {
  const f = await fixture({ patrol: true }); await f.finite(); await f.publish()
  useAppStore.setState({ selectedDemandId: null })
  await mount(createElement(GlobalBoardSurface)); expect(summary()).not.toBeNull()
  return f
}

describe('compact Goal summary through the production Board and original owners', () => {
  it('keeps exact execution, next responsibility and attention reason readable through a live state change', async () => {
    const f = await board()
    const row = () => goal().responsibility!.executions[0]!
    expect(summary().querySelector('.goal-responsibility__line')!.textContent).toContain(row().execution.agentSessionId)
    expect(summary().querySelector('.goal-responsibility__next-action')?.textContent).toBe(row().nextOwner.action)
    expect(summary().querySelector('.goal-responsibility__reason')?.textContent).toBe(row().reason)
    f.statuses.set('finite-worker', semantic(f.metadata.get('finite-worker')!, 'working'))
    await updated(() => f.emit('finite-worker'), () => expect(goal().responsibility!.executions[0]!.phase).toBe('executing'))
    expect(summary().querySelector('.goal-responsibility__next-action')?.textContent).toBe(row().nextOwner.action)
    expect(summary().querySelector('.goal-responsibility__phase')!.textContent).toBe('执行中')
    expect(summary().querySelector('.goal-patrol')).toBeNull()
  }, 30_000)

  it('discloses secondary patrol controls without sending and checks a saved unknown input without resubmission', async () => {
    const f = await board(); f.patrolState.loseBeforeSubmit = true
    const drafts = { original: 'Keep the original unsent input' }; useAppStore.setState({ agentComposerDrafts: drafts })
    await updated(() => primary().click(), () => expect(goal().patrolObservations?.[0]?.state).toBe('unknown'))
    const saved = (await f.demands.get('goal'))!.patrols![0]!
    const before = await f.proof(), requestCount = before.exchanges.filter(call => call.method === 'goal.patrol').length
    const disclosure = summary().querySelector<HTMLDetailsElement>('.goal-patrol__source')!
    expect(disclosure).not.toBeNull(); expect(disclosure.open).toBe(false)
    expect(summary().querySelectorAll('.goal-patrol__actions > button')).toHaveLength(1)
    await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')) })
    expect((await f.proof()).exchanges.filter(call => call.method === 'goal.patrol')).toHaveLength(requestCount)
    expect(disclosure.textContent).toContain(saved.operationId)
    expect(summary().querySelector('.goal-patrol__feedback')!.textContent).toContain(goal().patrolObservations![0]!.reason)
    expect(summary().querySelector('.goal-patrol__feedback')!.closest('details')).toBeNull()
    await updated(() => primary().click(), () => expect(primary().getAttribute('aria-busy')).toBe('false'))
    expect((await f.proof()).exchanges.filter(call => call.method === 'goal.patrol')).toHaveLength(requestCount)
    expect((await f.demands.get('goal'))!.patrols).toEqual([saved]); expect(f.attempts).toHaveLength(1)
    expect(f.nativeWrites).toEqual([]); expect(f.stop).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  }, 30_000)

  it('keeps an actual patrol report with unresolved gaps readable on the compact main surface', async () => {
    const f = await board()
    const recordJourney = process.env.AGENTMUX_GOAL_PATROL_RECEIPT_DIR !== undefined
    if (recordJourney) {
      f.statuses.set('finite-worker', semantic(f.metadata.get('finite-worker')!, 'working'))
      await updated(() => f.emit('finite-worker'), () => expect(goal().responsibility!.executions[0]!.phase).toBe('executing'))
      await f.capture('working')
      f.statuses.set('finite-worker', semantic(f.metadata.get('finite-worker')!, 'done'))
      await updated(() => f.emit('finite-worker'), () => expect(goal().responsibility!.executions[0]!.phase).toBe('stalled'))
      await f.capture('initial')
    }
    await updated(() => primary().click(), () => { expect(goal().patrols).toHaveLength(1); expect(primary().getAttribute('aria-busy')).toBe('false') })
    await f.flushPatrol(); await refreshGoalDelegations('goal')
    const attemptsBeforeReport = f.attempts.length
    if (recordJourney) await f.capture('delivered')
    const patrol = (await f.demands.get('goal'))!.patrols![0]!
    const reportSummary = '仍有差距：缺少冷启动的真实恢复证据；保留原 Session，待原负责人补齐。'
    await f.action('owner', 'patrol report', { goalId: 'goal', patrolOperationId: patrol.operationId, report: {
      operationId: 'summary-gap-report', summary: reportSummary, status: 'blocked',
      grounding: { alignmentRevision: patrol.alignment!.revision, summary: 'The original result still has an evidence gap',
        checks: patrol.alignment!.criteria.map(criterion => ({ criterionId: criterion.id, outcome: 'gap',
          evidence: ['apps/desktop/test/goal-summary-product.test.tsx:1'], note: 'The original cold-start recovery evidence is still missing.' })) },
      progress: [], nextOwner: { kind: 'agent', agentSessionId: 'owner', action: '补齐同一 Session 的恢复证据并回报' }
    } })
    await updated(() => refreshGoalDelegations('goal'), () => expect(goal().patrolObservations?.[0]?.state).toBe('reported'))
    expect((await f.demands.get('goal'))!.patrols![0]!.report).toMatchObject({ applied: true, summary: reportSummary })
    const report = summary().querySelector('.goal-patrol__report-summary')
    expect(report?.textContent).toBe(reportSummary)
    expect(report?.closest('details')).toBeNull()
    const disclosure = summary().querySelector<HTMLDetailsElement>('.goal-patrol__source')!
    expect(disclosure.open).toBe(false); expect(disclosure.textContent).not.toContain(reportSummary)
    expect(summary().textContent).toContain('补齐同一 Session 的恢复证据并回报')
    expect(f.attempts).toHaveLength(attemptsBeforeReport); expect(f.stop).not.toHaveBeenCalled()
    if (recordJourney) {
      await f.capture('reported')
      const source = await evidence('compact-applied-blocked-report-main-surface', await f.proof(), 'patrol')
      if (source) await f.exportJourney(source, { initialSnapshotId: 'initial', deliveredSnapshotId: 'delivered', reportedSnapshotId: 'reported' })
    }
  }, 30_000)

  it('keeps missing management reason and original recovery actions outside disclosure', async () => {
    const f = await board(); f.patrolState.routeUnavailable = true
    await updated(() => primary().click(), () => expect(goal().patrolObservations?.[0]?.state).toBe('missing'))
    const actions = summary().querySelector('.goal-patrol__actions')!
    expect(actions.textContent).toContain('选择 Supervisor')
    expect(actions.textContent).toContain('对话')
    expect(actions.closest('details')).toBeNull()
    expect(summary().querySelector('.goal-patrol__feedback')!.textContent).toContain(goal().patrolObservations![0]!.reason)
    expect(f.attempts).toEqual([]); expect(f.nativeWrites).toEqual([])
  }, 30_000)
})
