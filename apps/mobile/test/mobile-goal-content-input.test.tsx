import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileGoalsSurface } from '../src/goals/MobileGoalsSurface'
import { fixture, mount, mounted } from './conversation-fixture'
import type { AgentMuxRpcGoal } from '@agentmux/core'

afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() } })
it('keeps the original Goal composition candidate through a parent render, then retains the committed draft after an unknown save', async () => {
  const f = fixture(), goal = { id: 'original-goal', title: '原目标', description: '原意', status: 'todo', priority: 'normal', projectId: null, projectName: null, sessionIds: [], createdAt: 1, updatedAt: 2, source: 'session', activityLog: [] } as AgentMuxRpcGoal
  f.client.forwardRpc = vi.fn(async (method: string) => {
    if (method === 'goal.ls') return { goals: [goal] }
    if (method === 'goal.inspect') return { goal }
    if (method === 'goal.decisions') return { decisions: [] }
    if (method === 'app.snapshot') return { projects: [], executors: [], unavailable: [] }
    if (method === 'goal.update') throw Error('original save reply lost')
    throw Error('Unexpected ' + method)
  }) as typeof f.client.forwardRpc
  const surface = (connected: boolean) => <MobileGoalsSurface client={f.client} connected={connected} visible />
  const view = await mount(surface(true)), click = async (text: string) => {
    const button = [...view.element.querySelectorAll('button')].find(value => value.textContent === text && !value.closest('[hidden]'))
    expect(button).toBeDefined(); await act(async () => button!.click())
  }
  await click('原目标未分配项目 · 待开始原意'); await click('编辑目标正文')
  const body = view.element.querySelector<HTMLTextAreaElement>('article textarea')!; body.focus()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(body, '组字候选'); body.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
  await view.render(surface(false)); expect(body.value).toBe('组字候选'); expect(document.activeElement).toBe(body)
  await act(async () => body.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '组字候选' })))
  await act(async () => body.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(f.client.forwardRpc).toHaveBeenCalledWith('goal.update', { goalId: goal.id, patch: { description: '组字候选' }, operationId: expect.any(String) })
  expect(body.value).toBe('组字候选'); expect(view.element.textContent).toContain('保存回执未确认')
  expect(vi.mocked(f.client.forwardRpc!).mock.calls.filter(call => call[0] === 'goal.update')).toHaveLength(1)
})
