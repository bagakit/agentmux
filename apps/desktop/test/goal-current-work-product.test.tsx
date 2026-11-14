// @vitest-environment happy-dom
import './helpers/current-demand-product'
import { demands, client, hostGoals, root, container, session, writes } from './helpers/current-demand-product'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { GoalResponsibilitySummary } from '../src/renderer/src/components/GoalResponsibilitySummary'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { refreshGoalDelegations } from '../src/renderer/src/lib/goal-delegation-work'
import { goalNextStepFact } from '../src/renderer/src/lib/goal-presentation'

const actions = () => [...container.querySelectorAll<HTMLButtonElement>('.goals-detail button')]
const action = (text: string) => { const found = actions().find(button => button.textContent?.trim() === text); expect(found, text).toBeDefined(); return found! }
async function mount(id: string) {
  await useAppStore.getState().refreshDemand(id)
  await act(async () => { useAppStore.setState({ selectedDemandId: id, mainSurface: 'board' }); root.render(<GlobalBoardSurface />) })
}

it('original ended finite work dominates clarification in the actual Goal detail without changing its input or execution identity', async () => {
  const goalId = 'original-ended-work'
  await demands.create({ id: goalId, title: 'A long design goal with several independent requirements', description: 'Original human authorization\n  exact bytes  ', assigneeSessionIds: [session.agentSessionId], sessionIds: [session.agentSessionId] })
  await mount(goalId)
  const start = actions().find(button => button.textContent?.startsWith('Start with'))!
  expect(start).toBeDefined(); expect(start.disabled, 'Finite execution has no new alignment requirement').toBe(false)
  await act(async () => start.click())
  await vi.waitFor(async () => expect((await demands.get(goalId))?.dispatches?.[0]?.stage).toBe('confirmed'))
  await vi.waitFor(() => expect(useAppStore.getState().goalFiniteStartIntents[goalId], 'The original Start click finishes its confirmed receipt before observing the later Run exit').toBeUndefined())
  const original = (await demands.get(goalId))!.dispatches![0]!
  const input = await client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: original.agentSessionId, expectedRun: { runId: original.runId }, submissionId: original.operationId })
  expect(input?.admission?.acknowledged).toBe(true)
  const acceptedWrites = [...writes]
  vi.spyOn(hostGoals.runtime, 'observeOriginalRun').mockResolvedValue({ runId: original.runId, state: 'exited' })
  const observed = await api.demands.delegation('goal.delegations', { goalId })
  expect(observed.startObservations?.[0]?.originalRun).toEqual({ runId: original.runId, state: 'exited' })
  await act(async () => { await refreshGoalDelegations(goalId); useAppStore.setState({ agentComposerDrafts: { [session.agentSessionId]: 'Keep my original draft' } }) })
  const current = useAppStore.getState().demands[goalId]!
  expect(goalNextStepFact(current).source).toMatchObject({ kind: 'start', operationId: original.operationId, agentSessionId: original.agentSessionId, hostId: original.hostId, runId: original.runId })
  expect(container.querySelector('[data-goal-current-conclusion]')?.textContent, JSON.stringify(useAppStore.getState().demands[goalId]!.startObservations)).toContain('Agent ended')
  expect(container.querySelectorAll('[data-goal-work-area]')).toHaveLength(1)
  expect(container.querySelector('[data-goal-work-area]')!.querySelectorAll('.goal-responsibility__execution')).toHaveLength(0)
  expect(container.querySelectorAll(`[data-goal-work-kind="start"][data-goal-work-operation="${original.operationId}"]`)).toHaveLength(1)
  expect(container.querySelectorAll(`[data-goal-execution-responsibility="start:${original.operationId}"]`)).toHaveLength(1)
  expect(container.querySelector('[data-goal-grill]')?.classList.contains('primary-button')).toBe(false)
  expect(action('Open original Agent').classList.contains('primary-button')).toBe(true)
  expect(actions().filter(button => button.classList.contains('primary-button')).map(button => button.textContent?.trim())).toEqual(['Open original Agent'])
  const currentRecord = container.querySelector(`[data-goal-work-kind="start"][data-goal-work-operation="${original.operationId}"]`)!
  await act(async () => action('View current work').click())
  expect(document.activeElement).toBe(currentRecord)
  const responsibility = current.responsibility!.executions.find(row => row.execution.kind === 'start' && row.execution.operationId === original.operationId)!
  expect(responsibility).toBeDefined()
  expect(currentRecord.querySelector('.goal-work__responsibility details')?.textContent, 'Full original responsibility remains readable in its own source disclosure').toContain(responsibility.reason)
  expect(currentRecord.querySelector('.goal-work__responsibility > p')?.textContent, 'The visible state stays concise rather than repeating the technical reason').not.toContain(responsibility.reason)
  const origin = container.querySelector('[aria-label="Execution graph"] [data-goal-plan-origin]')!
  expect(origin).not.toBeNull()
  expect(Boolean(origin.compareDocumentPosition(currentRecord) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  await act(async () => origin.querySelector('button')!.click())
  const planReading = container.querySelector(`[data-goal-plan-detail="${goalId}"]`)!
  await act(async () => planReading.querySelector('button')!.click())
  expect(document.activeElement).toBe(currentRecord)
  expect(container.querySelector('.goal-finite-start')?.textContent).not.toContain('View original work')
  expect([...container.querySelectorAll('h2')].some(heading => heading.textContent === 'Task execution')).toBe(false)
  expect(writes).toEqual(acceptedWrites)
  expect(useAppStore.getState().agentComposerDrafts[session.agentSessionId]).toBe('Keep my original draft')
  expect((await demands.get(goalId))!.dispatches).toEqual([original])
  expect((await demands.get(goalId))!.plan).toBeUndefined()
})

it('a restored unknown Start keeps its exact operation and recipient through reassignment and actual inspection with no replay', async () => {
  const id = 'retained-original-task'
  await demands.create({ id, title: 'Original task without an outline', description: 'The original authorization remains unchanged', assigneeSessionIds: [session.agentSessionId], sessionIds: [session.agentSessionId] })
  const original = { goalId: id, operationId: 'retained-current-work', sessionId: session.agentSessionId, expectedUpdatedAt: (await demands.get(id))!.updatedAt, phase: 'may-have-dispatched' as const }
  await act(async () => useAppStore.setState({ goalFiniteStartIntents: { [id]: original } }))
  const before = [...writes], inspect = vi.spyOn(api.demands, 'inspectDispatch')
  await demands.update(id, { supervisorSessionId: null, sessionIds: [...(await demands.get(id))!.sessionIds, 'different-current-assignee'], assigneeSessionIds: ['different-current-assignee'] })
  await mount(id)
  await vi.waitFor(() => expect(container.querySelector('[data-goal-current-conclusion]')?.textContent).toBe('Original task input unconfirmed'))
  await vi.waitFor(() => expect(action('Inspect original Start').disabled).toBe(false))
  const originalReads = inspect.mock.calls.length
  await act(async () => action('View current work').click())
  expect(document.activeElement).toBe(container.querySelector(`[data-goal-retained-operation="${original.operationId}"]`))
  expect(inspect).toHaveBeenCalledTimes(originalReads)
  await act(async () => action('Inspect original Start').click())
  await vi.waitFor(() => expect(action('Inspect original Start').disabled).toBe(false))
  expect(inspect).toHaveBeenCalledWith({ goalId: id, operationId: original.operationId })
  expect(useAppStore.getState().goalFiniteStartIntents[id]).toEqual(original)
  expect(container.querySelector('[data-goal-work-area]')?.getAttribute('data-goal-work-context')).toBe('recorded')
  expect(await demands.inspectDispatch(id, original.operationId)).toBeNull()
  expect(actions().filter(button => button.classList.contains('primary-button')).map(button => button.textContent?.trim())).toEqual(['Inspect original Start'])
  expect(writes).toEqual(before)
  expect((await client.agentSession(session.agentSessionId)).run).toEqual(session.run)
})

it('a fresh Goal keeps the actual origin plan before its finite entry and never renders empty delegated reports', async () => {
  await demands.create({ id: 'fresh-origin', title: 'A real fresh goal', description: 'Original intent', assigneeSessionIds: [session.agentSessionId] })
  await mount('fresh-origin')
  const work = container.querySelector('[data-goal-work-area]')!
  expect(work.getAttribute('data-goal-work-context')).toBe('fresh')
  expect(container.querySelector('[data-goal-plan-origin]')).not.toBeNull()
  const plan = container.querySelector('[data-goal-plan-origin]')!, finite = work.querySelector('[data-goal-finite-start]')!
  expect(Boolean(plan.compareDocumentPosition(finite) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  expect(work.textContent).not.toContain('Refresh reports')
  expect(work.querySelector('[aria-label="Delegated work"]')).toBeNull()
  expect(actions().find(button => button.textContent?.startsWith('Start with'))?.disabled).toBe(false)
  expect((await demands.get('fresh-origin'))!.alignment).toBeUndefined()
})

it('responsibility navigation keeps its authoritative remote Host in the actual Main request and never selects the local namesake', async () => {
  const state = useAppStore.getState(), original = state.demands.goal!, before = [...writes]
  const reference = { kind: 'start' as const, operationId: 'retained-remote-execution', hostId: 'original-remote-host', agentSessionId: session.agentSessionId, runId: 'original-remote-run' }
  const record = { ...original, responsibility: { scope: 'original-remote-scope', observedAt: Date.now(),
    supervisor: { agentSessionId: session.agentSessionId, hostId: 'original-manager-host', state: 'unknown' as const, reason: 'Original remote observation unavailable' },
    executions: [{ execution: reference, binding: 'confirmed' as const, phase: 'unknown' as const, reason: 'Keep the original remote input', nextOwner: { kind: 'worker' as const, agentSessionId: session.agentSessionId, action: 'Inspect original remote work' }, alert: 'unknown' as const,
      basis: { stateEnteredAt: null, activityRevision: null, inputSubmissionId: null } }] } }
  const execute = vi.spyOn(state, 'executeControl')
  await act(async () => { useAppStore.setState({ demands: { ...state.demands, goal: record } }); root.render(<GoalResponsibilitySummary demand={record} />) })
  const target = container.querySelector<HTMLButtonElement>(`button[title="Session ${session.agentSessionId} · Host ${reference.hostId}"]`)
  expect(target).not.toBeNull()
  await act(async () => target!.click())
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ operation: 'focus', target: { kind: 'focus-agent', hostId: reference.hostId, agentSessionId: session.agentSessionId }, inputPolicy: 'preserve' }))
  execute.mockClear()
  const nextWorker = container.querySelector<HTMLButtonElement>('.goal-responsibility__next button')
  expect(nextWorker?.title, 'Worker and manager can share a Session ID on different Hosts; the typed next owner selects its own original Host').toBe(`Session ${session.agentSessionId} · Host ${reference.hostId}`)
  await act(async () => nextWorker!.click())
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ operation: 'focus', target: { kind: 'focus-agent', hostId: reference.hostId, agentSessionId: session.agentSessionId }, inputPolicy: 'preserve' }))
  expect(writes).toEqual(before)
  expect((await client.agentSession(session.agentSessionId)).run).toEqual(session.run)
})
