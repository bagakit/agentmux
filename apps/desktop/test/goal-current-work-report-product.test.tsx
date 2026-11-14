// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { expect, it, vi } from 'vitest'
import { fixture, mount, container } from './helpers/goal-responsibility-product'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

it('the actual Goal work area collects the exact Core report through its Host owner while human acceptance remains separate', async () => {
  const f = await fixture()
  await f.delegate('worker-a')
  await f.action('worker-a', 'report', { goalId: 'goal', operationId: 'delegate-worker-a', report: {
    operationId: 'original-work-report', authorAgentSessionId: 'worker-a', replyMessageId: 'original-work-reply', grounding: { alignmentRevision: 1, summary: 'Original worker result',
      checks: [{ criterionId: 'AC', outcome: 'met', evidence: ['artifacts/original-work.log:7'], note: 'Original evidence' }] } } })
  await f.publish()
  await act(async () => useAppStore.setState({ selectedDemandId: 'goal', mainSurface: 'board', agentComposerDrafts: { 'worker-a': 'Keep the human draft' } }))
  await mount(createElement(GlobalBoardSurface))
  const work = container.querySelector('[data-goal-work-area="goal"]')
  expect(work).not.toBeNull()
  const record = work!.querySelector('[data-goal-work-operation="delegate-worker-a"]')
  expect(record).not.toBeNull()
  const collect = [...record!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Collect report')
  expect(collect).toBeDefined(); expect(collect!.classList.contains('primary-button')).toBe(true)
  const before = [...f.nativeInputs]
  await act(async () => collect!.click())
  const calls = vi.mocked(api.demands.delegation)
  const collectionIndex = calls.mock.calls.findLastIndex(([method]) => method === 'goal.collect')
  expect(collectionIndex).toBeGreaterThanOrEqual(0)
  await act(async () => { await calls.mock.results[collectionIndex]!.value })
  await vi.waitFor(async () => expect((await f.demands.get('goal'))!.delegations![0]!.collection).toBeDefined())
  const saved = (await f.demands.get('goal'))!
  expect(saved.delegations![0]!.collection).toMatchObject({ operationId: 'goal-collect:goal:delegate-worker-a:original-work-reply', replyMessageId: 'original-work-reply' })
  expect(saved.delegations![0]!.report!.grounding.summary).toBe('Original worker result')
  expect(saved.grounding?.summary).toBe('source-worker-a: Original worker result')
  expect(saved.grounding?.acceptedAt ?? null).toBeNull()
  expect(saved.status).not.toBe('done')
  expect(vi.mocked(api.goals.execute).mock.calls.some(([request]) => request.operation === 'demand.accept' || request.operation === 'demand.confirm')).toBe(false)
  expect(f.nativeInputs).toEqual(before)
  expect(useAppStore.getState().agentComposerDrafts['worker-a']).toBe('Keep the human draft')
})

it('the screenshot combination keeps ended original work and its frozen missing inspection ahead of the actual origin with one check action', async () => {
  const f = await fixture({ patrol: true, alignment: false })
  await f.finite()
  f.runStates.set('finite-worker-run', 'exited')
  f.patrolState.routeUnavailable = true
  await f.demands.update('goal', { title: '一个包含多个设计要求的原始目标', supervisorSessionId: 'finite-worker' })
  await f.publish()
  await act(async () => useAppStore.setState({ selectedDemandId: 'goal', mainSurface: 'board', agentComposerDrafts: { 'finite-worker': 'Original unsent draft' } }))
  await mount(createElement(GlobalBoardSurface))
  const request = [...container.querySelectorAll<HTMLButtonElement>('.goals-detail button')].find(button => button.textContent?.startsWith('Request inspection from') || button.textContent === 'Request owner inspection')
  expect(request).toBeDefined()
  await act(async () => request!.click())
  await vi.waitFor(async () => expect((await f.demands.get('goal'))!.patrols?.length).toBe(1))
  await f.publish()
  const work = container.querySelector('[data-goal-work-area]')!
  const check = [...work.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check original inspection')
  expect(check).toBeDefined(); expect(check!.classList.contains('primary-button')).toBe(false)
  const choose = [...work.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Choose Supervisor')
  expect(choose).toBeDefined(); expect(choose!.classList.contains('primary-button')).toBe(true)
  const record = work.querySelector('[data-goal-work-operation="finite-start"][data-goal-work-kind="start"]'), origin = work.querySelector('[data-goal-plan-origin]')
  expect(record).not.toBeNull(); expect(origin).not.toBeNull()
  expect(Boolean(record!.compareDocumentPosition(origin!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  expect(work.querySelectorAll('[data-goal-work-operation="finite-start"]')).toHaveLength(1)
  const manager = useAppStore.getState().demands.goal!.responsibility!.supervisor
  expect(work.querySelector('.goal-patrol__source')?.textContent, 'The original Supervisor reason remains readable without an extra warning paragraph').toContain(manager.reason)
  expect(container.querySelector('[data-goal-grill]')?.classList.contains('primary-button')).toBe(false)
  const original = (await f.demands.get('goal'))!.patrols![0]!
  const before = [...f.nativeInputs], inputAttempts = [...f.attempts]
  const prepareCalls = vi.mocked(api.demands.delegation).mock.calls.filter(([method]) => method === 'goal.patrol').length
  await act(async () => choose!.click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(f.nativeInputs).toEqual(before); expect(f.attempts).toEqual(inputAttempts)
  expect((await f.demands.get('goal'))!.patrols![0]!.supervisorAgentSessionId).toBe('finite-worker')
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === 'Cancel')!.click())
  await act(async () => check!.click()); await f.publish()
  expect((await f.demands.get('goal'))!.patrols![0]!.operationId).toBe(original.operationId)
  expect((await f.demands.get('goal'))!.patrols![0]!.supervisorAgentSessionId).toBe('finite-worker')
  expect(f.nativeInputs).toEqual(before); expect(f.attempts).toEqual(inputAttempts)
  expect(vi.mocked(api.demands.delegation).mock.calls.filter(([method]) => method === 'goal.patrol')).toHaveLength(prepareCalls)
  expect(useAppStore.getState().agentComposerDrafts['finite-worker']).toBe('Original unsent draft')
  expect(f.stop).not.toHaveBeenCalled()
})
