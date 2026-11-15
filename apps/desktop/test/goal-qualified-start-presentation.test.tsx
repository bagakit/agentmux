import { goalNextStepFact } from '../src/renderer/src/lib/goal-presentation'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { DemandDispatch } from '@agentmux/demand'
import { demandAgentReferenceKey, type DemandSpaceMemberReference } from '@agentmux/demand/relations'
import { GoalStartWork } from '../src/renderer/src/components/GoalStartWork'
import { GoalExecution } from '../src/renderer/src/components/GoalExecution'
import { goalStartRows } from '../src/renderer/src/lib/goal-start-presentation'
import { currentDemandIndex, currentDemandKey, currentQualifiedDemandKey } from '../src/renderer/src/lib/goal-current-work'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const ref = (runtimeId: string): DemandSpaceMemberReference => ({ kind: 'space-member', source: { runtimeId: 'B', spaceId: 'original-Space', regionId: 'Region-' + runtimeId, admission: { kind: 'creation', operationId: 'C-' + runtimeId } }, execution: { runtimeId, agentSessionId: 'same-SID' } })
const start = (runtimeId: string): DemandDispatch => ({ operationId: 'Start-' + runtimeId, target: ref(runtimeId), runId: 'Run-' + runtimeId, execution: 'finite', prompt: 'Original body', agentMuxNote: 'Independent note', preparedAt: 1, stage: 'confirmed', receipt: { kind: 'core-input', inputKey: { kind: 'prompt', agentSessionId: 'same-SID', expectedRun: { runId: 'Run-' + runtimeId }, submissionId: 'Start-' + runtimeId }, outcome: 'admitted', observedAt: 2 } })
const goal = (): DemandProjection => ({ id: 'original-goal', title: 'Original Goal', description: '', status: 'todo', priority: 'normal', projectId: null, projectName: null, sessionIds: [], assigneeSessionIds: [], supervisorSessionId: null, createdAt: 1, updatedAt: 1, source: 'default-topic', sessions: [], workspacePath: null, dispatches: [start('D'), start('E')] })
beforeEach(() => {
  useAppStore.setState({ config: composerConfig, sessions: [composerSession('same-SID')], demands: { 'original-goal': goal() }, timelines: {}, agentNames: {}, goalAgentCreationDrafts: {}, goalAgentSelectionDrafts: {}, agentComposerDrafts: { 'same-SID': 'Original unsent local input' } })
  vi.spyOn(api.demands, 'onChanged').mockImplementation(() => () => {})
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(() => () => {})
})

it('the real Start record view keeps qualified receipts distinct and never opens a same-SID local Agent', async () => {
  const openAgent = vi.fn(), drafts = useAppStore.getState().agentComposerDrafts, original = goal()
  const { receipt: _receipt, ...pending } = original.dispatches![1]!
  original.dispatches![1] = { ...pending, stage: 'unknown' }
  await dom.render(<GoalStartWork rows={goalStartRows(original)} supervisorSessionId={null} active={false} openAgent={openAgent} review={async () => {}} />)
  expect(dom.container.querySelectorAll('[data-goal-work-operation]')).toHaveLength(2)
  expect(dom.container.querySelector('[data-goal-work-operation="Start-D"] > strong')?.textContent).toBe('Original input receipt retained · Current execution unconfirmed')
  expect(dom.container.querySelector('[data-goal-work-operation="Start-E"] > strong')?.textContent).toBe('Task start unconfirmed · Check original input')
  expect(dom.container.textContent).toContain('Runtime D'); expect(dom.container.textContent).toContain('Runtime E')
  expect(dom.container.textContent).not.toContain('[object Object]'); expect(dom.container.textContent).toContain('Start observation unknown')
  expect([...dom.container.querySelectorAll('button')].some(button => button.textContent === 'Open original Agent')).toBe(false)
  for (const runtime of ['D', 'E']) {
    const reader = dom.container.querySelector<HTMLElement>(`[data-goal-work-operation="Start-${runtime}"] .goal-request-reader`)!
    await act(async () => reader.querySelector<HTMLElement>('summary')!.click())
    await vi.waitFor(() => expect(reader.querySelector('[data-option="execution"]')).not.toBeNull())
    await act(async () => reader.querySelector<HTMLButtonElement>('[data-option="execution"]')!.click())
    const fields = Object.fromEntries([...reader.querySelectorAll('dt')].map(term => [term.textContent, term.nextElementSibling?.textContent]))
    expect(fields).toMatchObject({ 'Source Runtime': 'B', Space: 'original-Space', Region: 'Region-' + runtime,
      Admission: 'creation · C-' + runtime, 'Execution Runtime': runtime, Worker: 'same-SID', 'Original Run': 'Run-' + runtime })
  }
  expect(openAgent).not.toHaveBeenCalled(); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  const legacy: DemandDispatch = { operationId: 'legacy', hostId: 'original-remote', agentSessionId: 'same-SID', runId: 'legacy-Run', execution: 'finite', prompt: 'Legacy body', preparedAt: 1, stage: 'prepared' }
  await dom.render(<GoalStartWork rows={goalStartRows({ dispatches: [legacy] })} supervisorSessionId={null} active={false} openAgent={openAgent} review={async () => {}} />)
  await act(async () => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Open original Agent')!.click())
  expect(openAgent).toHaveBeenCalledExactlyOnceWith('same-SID', 'original-remote')
})

it('the current-work projection preserves each exact Source target without publishing it as a local Host/SID fact', () => {
  const original = goal(), index = currentDemandIndex({ [original.id]: original })
  expect(index.get(currentQualifiedDemandKey(ref('D')))?.goals[0]?.operationIds).toEqual(['Start-D'])
  expect(index.get(currentQualifiedDemandKey(ref('E')))?.goals[0]?.operationIds).toEqual(['Start-E'])
  expect(index.get(currentDemandKey('local', 'same-SID'))).toBeUndefined()
  const next = goalNextStepFact(original)
  expect(next.source).toMatchObject({ kind: 'start', operationId: 'Start-D', agentReference: ref('D'), runId: 'Run-D' })
  expect(next.source).not.toHaveProperty('agentSessionId'); expect(next.source).not.toHaveProperty('hostId')
})

it('the real Team retains original qualified execution references even after their current role selection changes', async () => {
  const lookup = vi.spyOn(api.sessions, 'historySource')
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active: false, retainedRegionId: null }}><GoalExecution demand={goal()} onUpdate={async () => false} /></WorkbenchPresentationContext.Provider>)
  expect([...dom.container.querySelectorAll('[data-goal-team-reference]')].map(value => value.getAttribute('data-goal-team-reference'))).toEqual([demandAgentReferenceKey(ref('D')), demandAgentReferenceKey(ref('E'))])
  expect(dom.container.querySelector('[data-goal-team-actor]')).toBeNull(); expect(lookup).not.toHaveBeenCalled()
})

it('the real responsibility surface consumes the Core qualified row without creating a raw navigation target', async () => {
  const { openDemandStore, demandExecutionReferences } = await import('@agentmux/demand')
  const { observeGoalExecution } = await import('@agentmux/core/goal-responsibility')
  const { GoalResponsibilitySummary } = await import('../src/renderer/src/components/GoalResponsibilitySummary')
  const { mkdtemp, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'goal-qualified-view-'))
  try {
    const store = openDemandStore({ root: directory })
    await store.create({ id: 'original-goal', title: 'Original Goal', assigneeSessionIds: [ref('D')] })
    const original = (await store.prepareDispatch('original-goal', { operationId: 'Start-D', target: ref('D'), runId: 'Run-D', execution: 'finite', prompt: 'Original body' })).demand
    const execution = demandExecutionReferences(original)[0]!
    const row = observeGoalExecution(original, { execution, inputConfirmed: true, unknown: 'Current Source observation unavailable' }, 3)
    const projected = { ...goal(), responsibility: { scope: 'original-source-scope', observedAt: 3, supervisor: { agentSessionId: null, state: 'missing' as const, reason: 'No Supervisor' }, executions: [row] } }
    await dom.render(<GoalResponsibilitySummary demand={projected} active={false} />)
    expect(dom.container.querySelector('.goal-responsibility__line')?.textContent).toContain('same-SID @ D')
    expect(dom.container.textContent).toContain('Current Source observation unavailable')
    expect(dom.container.querySelector('.goal-responsibility__agent')).toBeNull()
    expect(dom.container.textContent).not.toContain('[object Object]')
    expect(row.execution).toEqual(execution); expect(row).not.toHaveProperty('observation')
  } finally { await rm(directory, { recursive: true, force: true }) }
})


it('the real Mobile input history displays qualified dispatches without reading or opening a namesake Session', async () => {
  const { MobileGoalSessions } = await import('../../mobile/src/goals/MobileGoalSessions')
  const forwardRpc = vi.fn(), openSession = vi.fn()
  const client = { forwardRpc } as unknown as import('@agentmux/core/hosted').AgentMuxHostedClient
  const original: import('@agentmux/core').AgentMuxRpcGoal = { ...goal(), assigneeSessionIds: [], supervisorSessionId: null, participations: [] }
  await dom.render(<MobileGoalSessions client={client} sessionIds={[]} goal={original} visible openSession={openSession} />)
  expect(dom.container.textContent).toContain('same-SID @ D'); expect(dom.container.textContent).toContain('same-SID @ E')
  expect(dom.container.textContent).not.toContain('[object Object]')
  expect([...dom.container.querySelectorAll('pre')].map(value => JSON.parse(value.textContent!)).filter(value => value.target).map(value => value.target)).toEqual([ref('D'), ref('E')])
  expect(forwardRpc).not.toHaveBeenCalled(); expect(openSession).not.toHaveBeenCalled()
})
