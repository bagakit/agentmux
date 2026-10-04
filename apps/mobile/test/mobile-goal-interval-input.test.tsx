import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileGoalWork } from '../src/navigation/MobileGoalWork'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { fixture, mount, mounted } from './conversation-fixture'
import type { AgentMuxRpcGoal } from '@agentmux/core'

beforeEach(() => { localStorage.clear(); getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() } })
it('sends the native numeric interval to the original Goal/Session operation and retains its exact unknown intent', async () => {
  const f = fixture(), goal = { id: 'goal-original', title: '原目标', description: '原意', status: 'todo', priority: 'normal', projectId: null, projectName: null, sessionIds: ['session-original'], createdAt: 1, updatedAt: 2, source: 'session', alignment: { summary: '原范围', criteria: [], openQuestions: [], revision: 2, confirmedAt: 1 } } as AgentMuxRpcGoal
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', availability: 'connected' })
  f.client.forwardRpc = vi.fn(async (method: string) => {
    if (method === 'goal.ls') return { goals: [goal] }
    if (method === 'goal.inspect') return { goal, goalContinuations: [] }
    if (method === 'goal.start') throw Error('original start reply lost')
    throw Error('Unexpected ' + method)
  }) as typeof f.client.forwardRpc
  const view = await mount(<MobileGoalWork client={f.client} agentSessionId="session-original" connected visible />)
  await act(async () => view.element.querySelector<HTMLButtonElement>('[aria-label="查看目标 原目标"]')!.click())
  const field = view.element.querySelector<HTMLInputElement>('[aria-label="目标检查间隔（分钟）"]')!
  expect(field.type).toBe('number'); expect(field.min).toBe('1')
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '7'); field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(field.value).toBe('7'); await act(async () => field.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(f.client.forwardRpc).toHaveBeenCalledWith('goal.start', { goalId: goal.id, sessionId: 'session-original', continuation: { intervalMs: 420000, alignmentRevision: 2 }, operationId: expect.any(String) })
  const intent = getDeviceWorkface().snapshot().record.goalWork?.pending[0]
  expect(intent).toMatchObject({ kind: 'start', runtimeId: 'original-runtime', sessionId: 'session-original', goalId: goal.id, intervalMs: 420000 })
  expect(view.element.textContent).toContain('original start reply lost'); expect(view.element.textContent).toContain('不会自动重发')
  expect(vi.mocked(f.client.forwardRpc!).mock.calls.filter(call => call[0] === 'goal.start')).toHaveLength(1)
})
