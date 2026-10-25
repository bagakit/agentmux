import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const observed = vi.hoisted(() => {
  let releaseTerminal!: () => void
  const terminalPermit = new Promise<void>(resolve => { releaseTerminal = resolve })
  let releaseGoals!: () => void
  const goalsPermit = new Promise<void>(resolve => { releaseGoals = resolve })
  return { counts: { terminal: 0, goals: 0, topics: 0, spatial: 0, survey: 0, profile: 0 }, terminalPermit, releaseTerminal, goalsPermit, releaseGoals,
    terminalReady: false, goalsReady: false }
})
vi.mock('../src/terminal/MobileTerminalViewer', async original => {
  observed.counts.terminal += 1
  await observed.terminalPermit
  const value = await original(); observed.terminalReady = true; return value
})
vi.mock('../src/goals/MobileGoalsSurface', async original => {
  observed.counts.goals += 1
  await observed.goalsPermit
  const value = await original(); observed.goalsReady = true; return value
})
vi.mock('../src/topics/MobileTopicsSurface', async original => { observed.counts.topics += 1; return original() })
vi.mock('../src/navigation/MobileSpatialNavigation', async original => { observed.counts.spatial += 1; return original() })
vi.mock('../src/survey/MobileSurveySurface', async original => { observed.counts.survey += 1; return original() })
vi.mock('../src/navigation/MobileMoteProfile', async original => { observed.counts.profile += 1; return original() })
afterEach(async () => {
  observed.releaseTerminal(); observed.releaseGoals()
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks(); localStorage.clear()
})

it('loads only the first requested panel and retains real Goal and Composer instances without replaying an unknown input', async () => {
  window.history.replaceState(null, ''); localStorage.clear()
  const owner = getDeviceWorkface(); await owner.replaceBackup(emptyDeviceWorkface())
  await owner.updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
  const f = fixture()
  f.client.subscribeRpc = vi.fn().mockResolvedValue({ subscriptionId: 'appearance-observation', dispose: async () => {} })
  f.client.forwardRpc = vi.fn().mockImplementation(async method => {
    if (method === 'goal.ls') return { goals: [] }
    if (method === 'agent.inspect') return { session: f.client.agentSession('session-original'), displayName: { override: null, availability: 'observed' } }
    throw new Error('No unrelated read configured: ' + method)
  })
  const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '已连接' }} platform={createBrowserPlatform()} />)
  const originalEditor = editor(view.element)
  expect(observed.counts).toEqual({ terminal: 0, goals: 0, topics: 0, spatial: 0, survey: 0, profile: 0 })
  await paste(view.element, '原草稿仍在当前聊天')
  f.submit.mockRejectedValueOnce(new Error('Original receipt is unavailable after dispatch'))
  await click(button(view.element, 'Send'))
  const originalOperation = f.submit.mock.calls[0]![0].operationId
  expect(view.element.querySelector('[data-phase="unknown"]')).not.toBeNull()

  await click(button(view.element, '查看终端'))
  expect(observed.counts.terminal).toBe(1)
  expect(view.element.querySelector('.mobile-terminal-panel')?.textContent).toContain('正在加载终端')
  await click(button(view.element, '查看对话'))
  expect(editor(view.element)).toBe(originalEditor)
  expect(originalEditor.textContent).toBe('原草稿仍在当前聊天')
  await act(async () => { observed.releaseTerminal(); await vi.waitFor(() => expect(observed.terminalReady).toBe(true), { timeout: 10000 }) })
  expect(view.element.querySelector('.mobile-terminal')).not.toBeNull()
  expect(observed.counts.terminal).toBe(1)

  await click(button(view.element.querySelector<HTMLElement>('[aria-label="手机导航"]')!, 'Goals'))
  expect(observed.counts.goals).toBe(1)
  await click(button(view.element.querySelector<HTMLElement>('[aria-label="手机导航"]')!, 'Topics'))
  await act(async () => { observed.releaseGoals(); await vi.waitFor(() => expect(observed.goalsReady).toBe(true), { timeout: 10000 }) })
  expect(vi.mocked(f.client.forwardRpc!).mock.calls.filter(([method]) => method === 'goal.ls')).toHaveLength(0)
  const originalGoals = view.element.querySelector('.mobile-goals')!
  await click(button(view.element.querySelector<HTMLElement>('[aria-label="手机导航"]')!, 'Goals'))
  const search = originalGoals.querySelector<HTMLInputElement>('[aria-label="搜索目标"]')!
  expect(search).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '保留的目标筛选'); search.dispatchEvent(new Event('input', { bubbles: true })) })
  await click(button(view.element.querySelector<HTMLElement>('[aria-label="手机导航"]')!, 'Topics'))
  expect(editor(view.element)).toBe(originalEditor)
  expect(view.element.querySelector('.mobile-goals')).toBe(originalGoals)
  await click(button(view.element.querySelector<HTMLElement>('[aria-label="手机导航"]')!, 'Goals'))
  expect(view.element.querySelector('.mobile-goals')).toBe(originalGoals)
  expect(originalGoals.querySelector('[aria-label="搜索目标"]')).toBe(search)
  expect(search.value).toBe('保留的目标筛选')
  expect(observed.counts.goals).toBe(1)
  expect(editor(view.element)).toBe(originalEditor)
  expect(owner.snapshot().record.conversation.attempts[0]![1].operationId).toBe(originalOperation)
  expect(f.submit).toHaveBeenCalledOnce()
  expect(f.signalAgent).not.toHaveBeenCalled()
}, 20000)
