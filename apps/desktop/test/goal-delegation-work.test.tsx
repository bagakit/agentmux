import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DemandDelegation } from '@agentmux/demand'
import { openDemandStore } from '@agentmux/demand'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import type { GoalDelegationObservation, GoalDelegationResult } from '@agentmux/core/goal-delegation'
import type { RuntimeEvent } from '../src/shared/contracts'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { goalDelegationRows } from '../src/renderer/src/lib/goal-delegation-presentation'
import { goalNextStep } from '../src/renderer/src/lib/goal-presentation'
import { createGoalDelegationEvents } from '../src/renderer/src/lib/goal-delegation-events'
import { applyGoalDelegationResult, beginGoalDelegationRead } from '../src/renderer/src/lib/goal-delegation-work'
import { GoalDelegationWork } from '../src/renderer/src/components/GoalDelegationWork'
import { GoalExecution } from '../src/renderer/src/components/GoalExecution'
import { MoteCurrentWork } from '../src/renderer/src/components/MoteCurrentWork'
import { moteGoalContext } from '../src/renderer/src/lib/mote-goals'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { moteTopics, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'

function delegation(): DemandDelegation {
  return { operationId: 'original-operation', sourceMessageId: 'original-message', hostId: 'original-host',
    ownerAgentSessionId: 'original-owner', workerAgentSessionId: 'original-worker', ownerRunId: 'owner-run', workerRunId: 'original-run',
    threadId: 'original-thread', text: 'Preserve original work', alignmentRevision: 1, criterionIds: ['AC'],
    preparedAt: _reshape_fixtureEpoch(0, 0, 10), linkedAt: _reshape_fixtureEpoch(0, 0, 11), capturedCriteria: [{ id: 'AC', text: 'Original success criterion' }] }
}
function report(): NonNullable<DemandDelegation['report']> {
  return { operationId: 'original-report', replyMessageId: 'original-reply', authorAgentSessionId: 'original-worker', submittedAt: _reshape_fixtureEpoch(0, 0, 20),
    grounding: { alignmentRevision: 1, summary: 'Original worker result', checks: [{ criterionId: 'AC', outcome: 'met', evidence: ['original-result.md:12'], note: 'Original evidence' }] } }
}
function goal(d = delegation()): DemandRecord {
  return { id: 'original-goal', title: 'Original Goal', description: 'Original user request', status: 'in_progress', priority: 'normal',
    projectId: null, projectName: null, source: 'session', sessionIds: [], assigneeSessionIds: ['original-owner', 'original-worker'], supervisorSessionId: 'original-owner',
    createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1), delegations: [d] }
}
function observation(state: 'running' | 'exited' | 'interrupted' = 'running'): GoalDelegationObservation {
  const original = delegation()
  return { operationId: original.operationId, workerRun: { runId: original.workerRunId, state }, communication: {
    hostId: original.hostId, dispatch: { sourceMessageId: original.sourceMessageId, ownerAgentSessionId: original.ownerAgentSessionId,
      workerAgentSessionId: original.workerAgentSessionId, threadId: original.threadId, openedAt: _reshape_fixtureEpoch(0, 0, 11), originAwaits: false, events: [] },
    source: {} as never, replies: [], identityDiagnostics: [] } }
}
function result(record: DemandRecord): GoalDelegationResult {
  return { goalId: record.id, goalUpdatedAt: record.updatedAt, diskDurability: 'confirmed', delegations: record.delegations!, observations: record.delegationObservations ?? [observation()],
    ...(record.grounding ? { grounding: record.grounding } : {}) }
}

describe('original delegation reading facts', () => {
  it('requires the original observed Run and never interprets Goal status or another Run as completion', () => {
    const record = goal()
    expect(goalNextStep(record)).toBe('Delegation observation unknown')
    expect(goalNextStep({ ...record, status: 'done' })).toBe('Delegation observation unknown')
    expect(goalDelegationRows({ ...record, delegationObservations: [{ ...observation('exited'), workerRun: { runId: 'replacement-run', state: 'exited' } }] })[0]!.state).toBe('unknown')
    expect(goalNextStep({ ...record, delegationObservations: [observation('exited')] })).toBe('No report · Continue the original Agent')
    const { communication: _communication, ...exitOnly } = observation('exited')
    expect(goalNextStep({ ...record, delegationObservations: [exitOnly] })).toBe('Agent ended · Check report or continue')
    expect(goalNextStep({ ...record, delegationObservations: [{ ...observation('exited'), unknown: 'Communication observation unavailable' }] })).toBe('Agent ended · Check report or continue')
    const { linkedAt: _linkedAt, ...unlinked } = delegation()
    expect(goalNextStep({ ...goal(unlinked), delegationObservations: [observation('exited')] })).toBe('Delegation observation unknown')
    expect(goalNextStep({ ...record, delegationObservations: [observation('interrupted')] })).toBe('Interrupted · Continue the original Agent')
  })
  it('does not turn worker_done communication into a business result', () => {
    const observed = { ...observation(), communication: { dispatch: { ...delegation(), openedAt: _reshape_fixtureEpoch(0, 0, 1), originAwaits: false,
      events: [{ kind: 'worker_done', replyMessageId: 'communication-reply', at: _reshape_fixtureEpoch(0, 0, 2) }] }, source: {}, replies: [], identityDiagnostics: [] } } as unknown as GoalDelegationObservation
    expect(goalDelegationRows({ ...goal(), delegationObservations: [observed] })[0]).toMatchObject({ state: 'working', next: 'Working · No result report' })
  })
  it('shows exact protocol question/escalation responsibility and reply identity', () => {
    for (const kind of ['question', 'escalation'] as const) {
      const observed = { ...observation(), communication: { dispatch: { ...delegation(), openedAt: _reshape_fixtureEpoch(0, 0, 1), originAwaits: true,
        events: [{ kind, replyMessageId: 'original-question', at: _reshape_fixtureEpoch(0, 0, 2) }] }, source: {}, replies: [], identityDiagnostics: [] } } as unknown as GoalDelegationObservation
      expect(goalDelegationRows({ ...goal(), delegationObservations: [observed] })[0]).toMatchObject({ state: 'question', replyMessageId: 'original-question' })
    }
  })
  it('separates reported, collected and exact human-accepted results while keeping observation failures visible', () => {
    const d = { ...delegation(), report: report() }, record = { ...goal(d), delegationObservationIssue: 'Original observation unavailable' }
    expect(goalDelegationRows(record)[0]).toMatchObject({ state: 'report', issue: 'Original observation unavailable', next: 'Report ready to collect' })
    const collection = { operationId: 'original-collection', replyMessageId: 'original-reply', collector: { kind: 'user' as const, id: 'original-user' }, collectedAt: _reshape_fixtureEpoch(0, 0, 30), groundingSubmissionId: 'original-submission' }
    const collected = goal({ ...d, collection })
    expect(goalNextStep(collected)).toBe('Collected · Awaiting your review')
    const grounding = { ...report().grounding, submissionId: 'original-submission', submittedAt: _reshape_fixtureEpoch(0, 0, 30), acceptedAt: _reshape_fixtureEpoch(0, 0, 40) }
    expect(goalDelegationRows({ ...collected, grounding })[0]!.state).toBe('accepted')
    expect(goalDelegationRows({ ...collected, grounding: { ...grounding, submissionId: 'another-result' } })[0]!.state).toBe('collected')
  })
})

it('indexes one event bridge by exact source/Host/Run and changed Goal, ignoring terminal and unrelated traffic', () => {
  let session!: (event: RuntimeEvent) => void, domain!: (goalIds: string[]) => void
  const stopSessions = vi.fn(), stopDomain = vi.fn()
  const sessions = vi.fn(listener => { session = listener; return stopSessions }), demands = vi.fn(listener => { domain = listener; return stopDomain })
  const observe = createGoalDelegationEvents({ sessions, demands }), first = vi.fn(), second = vi.fn()
  const releaseFirst = observe('first', [delegation(), { ...delegation(), operationId: 'second-source', sourceMessageId: 'second-message' }], first)
  const releaseSecond = observe('second', [{ ...delegation(), hostId: 'another-host', sourceMessageId: 'another-message', workerRunId: 'another-run' }], second)
  expect(sessions).toHaveBeenCalledTimes(1); expect(demands).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 100; i++) {
    session({ hostId: 'original-host', event: { type: 'terminal-output', run: { runId: 'original-run' }, data: 'output' } } as RuntimeEvent)
    session({ hostId: 'original-host', event: { type: 'process-state', run: { runId: 'unrelated-' + i }, state: 'exited' } } as RuntimeEvent)
    domain(['unrelated-goal-' + i])
  }
  session({ hostId: 'wrong-host', event: { type: 'process-state', run: { runId: 'original-run' }, state: 'exited' } } as RuntimeEvent)
  expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled()
  session({ hostId: 'original-host', event: { type: 'dispatch-changed', sourceMessageId: 'original-message' } } as RuntimeEvent)
  session({ hostId: 'original-host', event: { type: 'process-state', run: { runId: 'original-run' }, state: 'exited' } } as RuntimeEvent)
  domain(['first', 'first']); session({ hostId: 'original-host', event: { type: 'connection-state', state: 'restored' } } as RuntimeEvent)
  expect(first).toHaveBeenCalledTimes(4); expect(second).not.toHaveBeenCalled()
  releaseFirst(); domain(['first']); expect(first).toHaveBeenCalledTimes(4)
  expect(stopSessions).not.toHaveBeenCalled()
  releaseSecond(); expect(stopSessions).toHaveBeenCalledTimes(1); expect(stopDomain).toHaveBeenCalledTimes(1)
})

const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement
let notifyDomain: (goalIds: string[]) => void
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  vi.spyOn(api.demands, 'onChanged').mockImplementation(listener => { notifyDomain = listener; return () => {} })
  vi.spyOn(api.sessions, 'onEvent').mockReturnValue(() => {})
  vi.spyOn(api.ui, 'openObjectLink').mockResolvedValue(undefined)
  useAppStore.setState({ demands: {}, sessions: [] })
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true)
})
async function settle() { await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }) }
async function mount(record: DemandRecord, component: ReactNode = createElement(GoalDelegationWork, { demand: record })) {
  useAppStore.setState({ demands: { [record.id]: record } })
  await act(async () => root.render(component)); await settle()
}
function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)
  expect(found, label).toBeDefined(); return found!
}
async function click(label: string) { await act(async () => button(label).click()); await settle() }

describe('mounted original Goal delegation consumer', () => {
  it('the actual full Goal list adapter preserves a newer original owner cut against a delayed older filesystem snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'amux-goal-read-cut-'))
    try {
      const owner = openDemandStore({ root: directory })
      const old = (await owner.create({ id: 'original-goal', title: 'Original Goal', status: 'backlog' })).demand
      const latest = (await owner.update(old.id, { status: 'in_progress' })).demand
      const record = { ...goal(), updatedAt: latest.updatedAt }
      useAppStore.setState({ demands: { [record.id]: record } })
      applyGoalDelegationResult({ goalId: latest.id, goalUpdatedAt: latest.updatedAt, diskDurability: 'confirmed', delegations: [], observations: [] })
      const retained = useAppStore.getState().demands[record.id]!
      vi.spyOn(api.demands, 'list').mockResolvedValue([old])
      await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: 'original-list-request', operation: 'demand.list' })
      expect(useAppStore.getState().demands[record.id]).toBe(retained)
      expect(useAppStore.getState().demands[record.id]!.status).toBe('in_progress')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('rejects late older Goal versions and earlier reads without guessing a merge of report responsibility', () => {
    const original = goal(), reportReady = { ...original, updatedAt: _reshape_fixtureEpoch(0, 0, 2), delegations: [{ ...delegation(), report: report() }] }
    useAppStore.setState({ demands: { [original.id]: original } })
    const earlier = beginGoalDelegationRead(), later = beginGoalDelegationRead()
    applyGoalDelegationResult(result({ ...reportReady, delegationObservations: [observation('exited')] }), later)
    const acceptedCut = useAppStore.getState().demands[original.id]!
    applyGoalDelegationResult(result(original), beginGoalDelegationRead())
    expect(useAppStore.getState().demands[original.id]).toBe(acceptedCut)
    applyGoalDelegationResult(result({ ...reportReady, delegationObservations: [observation('running')] }), earlier)
    expect(useAppStore.getState().demands[original.id]).toBe(acceptedCut)
    const fullGoal = { ...acceptedCut, updatedAt: _reshape_fixtureEpoch(0, 0, 3) }
    useAppStore.setState({ demands: { [original.id]: fullGoal } })
    applyGoalDelegationResult(result(reportReady), beginGoalDelegationRead())
    expect(useAppStore.getState().demands[original.id]).toBe(fullGoal)
  })
  it('keeps an original Supervisor reminder receipt separate from Goal completion and never resends it', async () => {
    const record = { ...goal({ ...delegation(), attention: { operationId: 'original-reminder-operation', intentId: 'original-reminder-intent',
      hostId: 'original-host', supervisorAgentSessionId: 'original-supervisor', supervisorRunId: 'original-supervisor-run',
      occurrenceAt: _reshape_fixtureEpoch(0, 0, 30), agentMuxNote: 'Original platform reminder', preparedAt: _reshape_fixtureEpoch(0, 0, 31), attemptedAt: _reshape_fixtureEpoch(0, 0, 32) } }),
      delegationObservations: [{ ...observation('exited'), attention: { state: 'unknown' as const, reason: 'Original reminder receipt is unavailable' } }] }
    const calls = vi.spyOn(api.demands, 'delegation').mockResolvedValue(result(record))
    const submit = vi.spyOn(api.sessions, 'submitPrompt')
    await mount(record)
    expect(container.textContent).toContain('Supervisor reminder unknown')
    expect(container.textContent).toContain('Original reminder receipt is unavailable')
    await click('Open original Supervisor')
    expect(api.ui.openObjectLink).toHaveBeenCalledWith('amux://agent/original-supervisor')
    await click('Refresh reports')
    expect(calls.mock.calls.map(([method]) => method)).toEqual(['goal.delegations', 'goal.delegations'])
    expect(submit).not.toHaveBeenCalled()
    expect(useAppStore.getState().demands[record.id]!.status).toBe('in_progress')
  })
  it('collects an owner-verified recoverable original report after the worker exits without asking it to resend', async () => {
    let record = { ...goal(), delegationObservations: [{ ...observation('exited'), recoverableReport: report() }] }
    const calls = vi.spyOn(api.demands, 'delegation').mockImplementation(async (method, input) => {
      if (method === 'goal.collect') {
        const request = input as Parameters<typeof api.demands.delegation<'goal.collect'>>[1]
        record = { ...record, updatedAt: record.updatedAt + 1, delegations: [{ ...delegation(), report: report(), collection: { ...request.collection,
          collector: { kind: 'user', id: 'trusted-user' }, collectedAt: _reshape_fixtureEpoch(0, 0, 30) } }] }
      }
      return result(record)
    })
    const send = vi.spyOn(api.sessions, 'submitMessage')
    await mount(record)
    expect(container.textContent).toContain('Report ready to collect')
    await click('Collect report')
    expect(calls.mock.calls.find(([method]) => method === 'goal.collect')).toEqual(['goal.collect', {
      goalId: 'original-goal', operationId: 'original-operation', collection: {
        operationId: 'goal-collect:original-goal:original-operation:original-reply', replyMessageId: 'original-reply' } }])
    expect(container.textContent).toContain('Collected · Awaiting your review')
    expect(send).not.toHaveBeenCalled()
  })
  it('collects the exact original report, updates the same Goal and leaves human acceptance to review', async () => {
    let record = goal({ ...delegation(), report: report() })
    const collect = vi.spyOn(api.demands, 'delegation').mockImplementation(async (method, input) => {
      if (method === 'goal.collect') {
        const request = input as Parameters<typeof api.demands.delegation<'goal.collect'>>[1]
        record = { ...record, updatedAt: record.updatedAt + 1, delegations: [{ ...record.delegations![0]!, collection: { ...request.collection,
          collectedAt: _reshape_fixtureEpoch(0, 0, 30), collector: { kind: 'user', id: 'trusted-user' } } }] }
      }
      return result(record)
    })
    const accept = vi.spyOn(api.demands, 'acceptGrounding')
    await mount(record); await click('Collect report')
    expect(collect.mock.calls.find(([method]) => method === 'goal.collect')).toEqual(['goal.collect', {
      goalId: 'original-goal', operationId: 'original-operation', collection: {
        operationId: 'goal-collect:original-goal:original-operation:original-reply', replyMessageId: 'original-reply' } }])
    expect(container.textContent).toContain('Collected · Awaiting your review')
    expect(button('Review results').disabled).toBe(false); expect(accept).not.toHaveBeenCalled()
    expect(useAppStore.getState().demands['original-goal']!.status).toBe('in_progress')
  })
  it('keeps known report collection and original Agent navigation available through observation failure', async () => {
    const record = goal({ ...delegation(), report: report() })
    vi.spyOn(api.demands, 'delegation').mockRejectedValue(new Error('Original observer disconnected'))
    await mount(record)
    expect(container.textContent).toContain('Original observer disconnected')
    expect(button('Collect report').disabled).toBe(false)
    expect(button('Open original Agent').disabled).toBe(false)
    await click('Open original Agent')
    expect(api.ui.openObjectLink).toHaveBeenCalledWith('amux://agent/original-worker')
    expect(useAppStore.getState().demands['original-goal']!.delegations).toEqual(record.delegations)
  })
  it('explicit retries keep the collection ID and body while unknown reads never resubmit it', async () => {
    const record = goal({ ...delegation(), report: report() })
    const calls = vi.spyOn(api.demands, 'delegation').mockImplementation(async method => {
      if (method === 'goal.collect') throw new Error('Original collection receipt unavailable')
      throw new Error('Original observation unavailable')
    })
    await mount(record); await click('Collect report')
    expect(calls.mock.calls.filter(([method]) => method === 'goal.collect')).toHaveLength(1)
    await click('Refresh reports')
    expect(calls.mock.calls.filter(([method]) => method === 'goal.collect')).toHaveLength(1)
    await click('Collect report')
    const collections = calls.mock.calls.filter(([method]) => method === 'goal.collect')
    expect(collections).toHaveLength(2); expect(collections[1]).toEqual(collections[0])
  })
  it('changes actual GoalExecution UI from original Run exit to reported work after the original Domain notification', async () => {
    let record = { ...goal(), delegationObservations: [observation('exited')] }
    const read = vi.spyOn(api.demands, 'delegation').mockImplementation(async () => result(record))
    await mount(record, createElement(GoalExecution, { demand: { ...record, sessions: [], workspacePath: null }, onUpdate: async () => true }))
    expect(container.textContent).toContain('No report · Continue the original Agent')
    record = { ...record, updatedAt: record.updatedAt + 1, delegations: [{ ...delegation(), report: report() }] }
    await act(async () => notifyDomain(['original-goal'])); await settle()
    expect(button('Collect report').disabled).toBe(false)
    const before = read.mock.calls.length
    await act(async () => notifyDomain(['another-goal'])); await settle()
    expect(read.mock.calls).toHaveLength(before)
  })
  it('updates the collapsed original Mote short hint, and drops its event observer when hidden', async () => {
    seedMoteWorkface()
    const scope = { workspace: scratchWorkspace, topic: moteTopics.find(item => item.id === PMO_TEAMS_TOPIC_ID)!, rootPath: scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID) }
    const context = moteGoalContext(useAppStore.getState(), scope)
    expect(context.contentRef).not.toBeNull()
    let record = { ...goal(), contentRefs: [context.contentRef!], delegationObservations: [observation('exited')] }
    vi.spyOn(api.demands, 'delegation').mockImplementation(async () => result(record))
    useAppStore.setState({ executeControl: vi.fn(async () => ({ operation: 'demand.list', demands: [] })) as never })
    await mount(record, createElement(MoteCurrentWork, { scope }))
    expect(container.querySelector('.mote-current-work__copy')?.textContent).toContain('No report · Continue the original Agent')
    record = { ...record, updatedAt: record.updatedAt + 1, delegations: [{ ...delegation(), report: report() }] }
    await act(async () => notifyDomain(['original-goal'])); await settle()
    expect(container.querySelector('.mote-current-work__copy')?.textContent).toContain('Report ready to collect')
    const calls = vi.mocked(api.demands.delegation).mock.calls.length
    await act(async () => root.render(createElement(MoteCurrentWork, { scope, active: false })))
    await act(async () => notifyDomain(['original-goal'])); await settle()
    expect(api.demands.delegation).toHaveBeenCalledTimes(calls)
  })
})
