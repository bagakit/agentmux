// @vitest-environment happy-dom
import { bridge, demands, directory, client, root, container, session, writes, manager } from './helpers/current-demand-product'
import { act, createElement } from 'react'
import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { openDemandStore } from '@agentmux/demand'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import type { DemandGroundingProposal } from '@agentmux/demand/goals'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'

function report(outcome: 'met' | 'gap' | 'unknown' = 'met'): DemandGroundingProposal {
  return { alignmentRevision: 1, summary: 'The original output was checked.', checks: [{ criterionId: 'real', outcome,
    evidence: ['original-result.log'], note: outcome === 'gap' ? 'A reviewed limitation remains.' : '' }] }
}
async function publish() {
  await act(async () => { await useAppStore.getState().refreshDemand('goal'); useAppStore.setState({ selectedDemandId: 'goal' }) })
}
async function mount() { await act(async () => root.render(createElement(GlobalBoardSurface))) }
function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)
  expect(found, label).toBeDefined(); return found!
}
async function click(label: string) { await act(async () => button(label).click()) }
async function settled(assertion: () => unknown | Promise<unknown>) {
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); await assertion() })
}
function row() { return container.querySelector('[data-demand-id="goal"]') }
function noLifecycleChange() {
  return [vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'restart'), vi.spyOn(api.sessions, 'interrupt')]
}

it('mounted original acceptance leaves work open, then explicit Finish goal uses preload and Main with the same reviewed result', async () => {
  await demands.proposeGrounding('goal', report()); await publish(); await mount()
  const expected = (await demands.get('goal'))!, originalRun = structuredClone(session.run), lifecycle = noLifecycleChange()
  const originalInput = [...writes], originalSessions = useAppStore.getState().sessions
  expect(button('Accept and finish').classList.contains('goals-button--primary')).toBe(true)
  expect(button('Accept results').classList.contains('goals-button--primary')).toBe(false)
  await click('Accept results')
  await settled(async () => expect((await demands.get('goal'))!.grounding!.acceptedAt).toBeGreaterThan(0))
  const accepted = (await demands.get('goal'))!
  expect(accepted.status).toBe('todo')
  expect(bridge.invoke).toHaveBeenCalledWith('demands:acceptGrounding', 'goal', 1, expected.grounding!.submissionId, false, undefined)
  expect(row()?.querySelector('.goals-row__next')?.textContent).toBe('Accepted')
  await click('Finish goal')
  await settled(async () => expect((await demands.get('goal'))!.status).toBe('done'))
  expect(bridge.invoke).toHaveBeenCalledWith('demands:acceptGrounding', 'goal', 1, expected.grounding!.submissionId, false, true)
  const restored = (await openDemandStore({ root: join(directory, 'goals') }).get('goal'))!
  expect(restored.grounding).toEqual(accepted.grounding)
  expect(restored.sessionIds).toEqual(expected.sessionIds)
  expect(row()).toBeNull()
  expect(container.querySelector('.goals-detail')).not.toBeNull()
  expect(useAppStore.getState().selectedDemandId).toBe('goal')
  expect(useAppStore.getState().sessions).toEqual(originalSessions)
  expect((await client.agentSession(session.agentSessionId)).run).toEqual(originalRun)
  expect(writes).toEqual(originalInput); expect(manager.list()).toEqual([])
  for (const call of lifecycle) expect(call).not.toHaveBeenCalled()
  await click('Show finished'); expect(row()).not.toBeNull()
})

it('the primary gap completion action preserves the reviewed gap through actual IPC and durable storage', async () => {
  await demands.proposeGrounding('goal', report('gap')); await publish(); await mount()
  const submission = (await demands.get('goal'))!.grounding!.submissionId
  const primary = container.querySelector<HTMLButtonElement>('.goals-grounding .goals-button--primary')!
  expect(primary?.textContent).toMatch(/Accept/iu); expect(primary?.textContent).toMatch(/finish/iu); expect(primary?.textContent).toMatch(/gap/iu)
  await act(async () => primary.click())
  await settled(async () => expect((await demands.get('goal'))!.status).toBe('done'))
  expect(bridge.invoke).toHaveBeenCalledWith('demands:acceptGrounding', 'goal', 1, submission, true, true)
  expect((await demands.get('goal'))!.grounding).toMatchObject({ submissionId: submission, acceptedAt: expect.any(Number), checks: report('gap').checks })
})

it('Done without current acceptance stays in the default list, including when an earlier accepted goal is revised', async () => {
  await demands.update('goal', { status: 'done' }); await publish(); await mount()
  expect(row()).not.toBeNull(); expect(row()?.textContent).toContain('Results not verified')
  expect(container.querySelector('[data-goal-accept], [data-goal-finish]')).toBeNull()
  const grounded = await demands.proposeGrounding('goal', report())
  await demands.acceptGrounding('goal', 1, grounded.demand.grounding!.submissionId)
  await publish(); expect(row()).toBeNull()
  await demands.proposeAlignment('goal', { summary: 'A revised outcome needs review.', criteria: [{ id: 'real', text: 'Revised expected output' }], openQuestions: [] })
  await publish(); expect(row()).not.toBeNull()
  expect(container.textContent).toContain('A revised outcome needs review.')
})

it('a currently accepted report stays the list conclusion while original finite execution facts remain readable', async () => {
  await demands.prepareDispatch('goal', { operationId: 'historical-start', agentSessionId: session.agentSessionId, hostId: 'local', runId: session.run.runId,
    execution: 'finite', prompt: 'The original finite task.' })
  const submitted = await demands.proposeGrounding('goal', report())
  await demands.acceptGrounding('goal', 1, submitted.demand.grounding!.submissionId)
  await publish(); await mount()
  expect(row()?.querySelector('.goals-row__next')?.textContent).toBe('Accepted')
  expect(useAppStore.getState().demands.goal!.dispatches).toEqual((await demands.get('goal'))!.dispatches)
  expect(container.querySelector('.goals-detail')?.textContent).toMatch(/Start|Original input/iu)
  expect(button('Finish goal')).toBeTruthy()
})

it('a stale primary finish cannot close or accept a replacement report, and reload never retries the acknowledgement', async () => {
  await demands.proposeGrounding('goal', report()); await publish(); await mount()
  const old = (await demands.get('goal'))!
  await openDemandStore({ root: join(directory, 'goals') }).proposeGrounding('goal', { ...report(), summary: 'New report requiring review.' })
  const accept = vi.spyOn(api.demands, 'acceptGrounding')
  await click('Accept and finish')
  await settled(() => expect(container.querySelector('[data-goal-acknowledgement-failure]')).not.toBeNull())
  const current = (await demands.get('goal'))!
  expect(current.status).toBe('todo'); expect(current.grounding!.acceptedAt).toBeNull()
  expect(accept).toHaveBeenCalledExactlyOnceWith('goal', 1, old.grounding!.submissionId, false, true)
  expect([...container.querySelectorAll('.goals-detail .goals-button--primary')].map(node => node.textContent?.trim())).toEqual(['Reload current proposal'])
  await click('Reload current proposal')
  await settled(() => expect(container.textContent).toContain('New report requiring review.'))
  expect(accept).toHaveBeenCalledTimes(1); expect((await demands.get('goal'))!.status).toBe('todo')
})

it('lost finish receipt reloads the original committed result without a duplicate acceptance or input', async () => {
  await demands.proposeGrounding('goal', report()); await publish(); await mount()
  const real = bridge.invoke.getMockImplementation()!, originalInput = [...writes]
  let lost = false
  bridge.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const response = await real(channel, ...args)
    if (channel === 'demands:acceptGrounding' && !lost) { lost = true; throw new Error('Original finish receipt unavailable') }
    return response
  })
  const accept = vi.spyOn(api.demands, 'acceptGrounding')
  await click('Accept and finish')
  await settled(() => expect(container.querySelector('[data-goal-acknowledgement-failure]')).not.toBeNull())
  const committed = (await openDemandStore({ root: join(directory, 'goals') }).get('goal'))!
  expect(committed.status).toBe('done'); expect(committed.grounding!.acceptedAt).toBeGreaterThan(0)
  await click('Reload current proposal')
  await settled(() => expect(container.querySelector('[data-goal-acknowledgement-failure]')).toBeNull())
  expect(accept).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().demands.goal!.grounding).toEqual(committed.grounding)
  expect((await demands.get('goal'))!.activities).toEqual(committed.activities)
  expect(writes).toEqual(originalInput)
})


it('explicit finish stops the Goal follow-up while retaining the original Run and avoiding further input', async () => {
  await act(async () => root.render(null))
  const rpc = new AgentMuxRpcService({ execute: (...args) => bridge.controlOptions.execute(...args), coreClients: () => [{ hostId: 'local', client }] })
  const originalRun = structuredClone(session.run)
  await rpc.call('goal.start', { goalId: 'goal', sessionId: session.agentSessionId, operationId: 'original-follow-up', continuation: { intervalMs: 60_000, alignmentRevision: 1 } }, { principal: { kind: 'user', id: 'fixture-human' } })
  expect(manager.list()).toEqual([expect.objectContaining({ status: 'active', agentSessionId: session.agentSessionId })])
  const before = [...writes], lifecycle = noLifecycleChange()
  await demands.proposeGrounding('goal', report()); await publish(); await mount()
  await click('Accept and finish')
  await settled(() => expect(manager.list()[0]!.status).toBe('stopped'))
  expect((await demands.get('goal'))!.status).toBe('done')
  expect((await client.agentSession(session.agentSessionId)).run).toEqual(originalRun)
  expect(writes).toEqual(before)
  for (const call of lifecycle) expect(call).not.toHaveBeenCalled()
})
