import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileGoalsSurface } from '../src/goals/MobileGoalsSurface'
import { DeviceWorkfaceStore, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { fixture, mount, mounted } from './conversation-fixture'
import type { AgentMuxRpcGoal } from '@agentmux/core'

afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; vi.restoreAllMocks() })
it('keeps the original Goal composition candidate through a parent render, then retains the committed draft after an unknown save', async () => {
  localStorage.clear()
  const owner = getDeviceWorkface(), host = { origin: location.origin, hostId: 'goal-device-host' }
  await owner.replaceBackup(emptyDeviceWorkface()); await owner.confirmHost(host)
  const recordId = owner.recordIdentity(), commits = vi.spyOn(owner, 'editGoalDraft')
  const f = fixture(), goal = { id: 'original-goal', title: '原目标', description: '原意', status: 'todo', priority: 'normal', projectId: null, projectName: null, sessionIds: [], createdAt: 1, updatedAt: 2, source: 'session', activityLog: [] } as AgentMuxRpcGoal
  const runtime = { runtimeId: 'goal-runtime-original', ownerInstanceId: 'goal-process-original', availability: 'connected' as const }
  f.client.runtimeOwnerIdentity = () => runtime
  f.client.forwardRpc = vi.fn(async (method: string) => {
    if (method === 'goal.ls') return { goals: [goal] }
    if (method === 'goal.inspect') return { goal }
    if (method === 'goal.decisions') return { decisions: [] }
    if (method === 'app.snapshot') return { projects: [], executors: [], unavailable: [] }
    if (method === 'goal.update') throw Error('original save reply lost')
    throw Error('Unexpected ' + method)
  }) as typeof f.client.forwardRpc
  const surface = (connected: boolean) => <MobileGoalsSurface client={f.client} connected={connected} visible />
  const writes = () => vi.mocked(f.client.forwardRpc!).mock.calls.filter(call => call[0] === 'goal.update')
  const acknowledged = async (phase?: 'unknown') => {
    let index = -1
    await vi.waitFor(() => {
      index = commits.mock.calls.findIndex(([, next]) => next.description === '组字候选'
        && (phase ? next.operations[0]?.phase === phase : next.operations.length === 0))
      expect(index).toBeGreaterThanOrEqual(0)
    })
    const result = await commits.mock.results[index]!.value
    expect(result).toMatchObject({ recordId, applied: true, conflict: null })
    expect(result.draft).toEqual(commits.mock.calls[index]![1])
    return result.draft!
  }
  const view = await mount(surface(true)), click = async (text: string) => {
    const button = [...view.element.querySelectorAll('button')].find(value => value.textContent === text && !value.closest('[hidden]'))
    expect(button).toBeDefined(); await act(async () => button!.click())
  }
  await click('原目标未分配项目 · 待开始原意'); await click('编辑目标正文')
  const body = view.element.querySelector<HTMLTextAreaElement>('article textarea')!; body.focus()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(body, '组字候选'); body.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
  await view.render(surface(false)); expect(body.value).toBe('组字候选'); expect(document.activeElement).toBe(body)
  await act(async () => body.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '组字候选' })))
  const originalDraft = await acknowledged()
  expect(originalDraft).toMatchObject({ goalId: goal.id, scope: { origin: host.origin, deviceHostId: host.hostId, runtimeId: runtime.runtimeId },
    description: '组字候选', baseline: { description: '原意', updatedAt: 2 }, operations: [] })
  await act(async () => body.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(writes()).toHaveLength(0); expect(body.value).toBe('组字候选')
  expect(view.element.textContent).toContain('保存未发送')
  await view.render(surface(true))
  expect(view.element.querySelector('article textarea')).toBe(body); expect(body.value).toBe('组字候选')
  expect(writes()).toHaveLength(0)
  await act(async () => body.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  const unknownDraft = await acknowledged('unknown'), request = writes()[0]![1]
  expect(request).toEqual({ goalId: goal.id, patch: { description: '组字候选' }, operationId: expect.any(String), expectedUpdatedAt: 2 })
  expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.patch)).toBe(true)
  expect(unknownDraft.operations).toEqual([{ request, ownerInstanceId: runtime.ownerInstanceId, phase: 'unknown', issue: 'original save reply lost' }])
  expect(unknownDraft.scope).toEqual(originalDraft.scope)
  expect(owner.recordIdentity()).toBe(recordId)
  expect(new DeviceWorkfaceStore(() => localStorage).snapshot().record.goalDrafts).toEqual([unknownDraft])
  expect(body.value).toBe('组字候选'); expect(view.element.textContent).toContain('保存回执未确认')
  expect(writes()).toHaveLength(1)
})
