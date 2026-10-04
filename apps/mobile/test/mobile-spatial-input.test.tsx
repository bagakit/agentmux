import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { fixture, mount, mounted } from './conversation-fixture'

afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() } })
it('filters Focus locally and keeps the exact draft and Session usable after a failed directory refresh', async () => {
  const f = fixture(); let fail = false
  const catalog = { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [
    { agentSessionId: 'session-original', name: '原讨论 Agent', project: '原项目', providerId: 'codex', group: 'working', state: 'working', detail: '执行中', recap: null },
    { agentSessionId: 'other', name: '参考 Agent', project: '参考项目', providerId: 'codex', group: 'idle', state: 'unknown', detail: '未知', recap: null } ] }
  f.client.forwardRpc = vi.fn(async () => { if (fail) throw Error('original directory unavailable'); return { catalog } }) as typeof f.client.forwardRpc
  const open = vi.fn(), view = await mount(<MobileSpatialNavigation home="focus" client={f.client} connected sessions={f.client.agentSessions()} openSession={open} />)
  const field = view.element.querySelector<HTMLInputElement>('[aria-label="查找"]')!
  expect(field.placeholder).toBe('查找 Agent 或工作空间')
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, ' 原讨论 '); field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(field.value).toBe(' 原讨论 '); expect(view.element.querySelector('.mobile-session-list')?.textContent).toContain('原讨论 Agent'); expect(view.element.textContent).not.toContain('参考 Agent')
  expect(f.client.forwardRpc).toHaveBeenCalledExactlyOnceWith('space.ls', { target: {}, presentation: true })
  fail = true; await act(async () => view.element.querySelector<HTMLButtonElement>('[aria-label="刷新空间目录"]')!.click())
  expect(view.element.textContent).toContain('original directory unavailable'); expect(field.value).toBe(' 原讨论 ')
  await act(async () => view.element.querySelector<HTMLButtonElement>('.mobile-session-list button')!.click())
  expect(open).toHaveBeenCalledExactlyOnceWith('session-original', expect.objectContaining({ name: '原讨论 Agent', project: '原项目' })); expect(f.submit).not.toHaveBeenCalled()
})
