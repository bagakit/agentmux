import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const network = vi.hoisted(() => ({ attempts: 0, finish: null as (() => Promise<void>) | null, loaded: false }))
// Only the module transport is controlled. MobileApp and its actual deferred
// panel/error boundary remain the production consumers of each read result.
vi.mock('../src/navigation/defer-mobile-surface', async original => {
  const actual = await original<typeof import('../src/navigation/defer-mobile-surface')>()
  return { deferMobileSurface(label: string, load: () => Promise<{ default: React.ComponentType<object> }>) {
    return actual.deferMobileSurface(label, label !== '终端' ? load : () => {
      network.attempts += 1
      if (network.attempts === 1) return Promise.reject(new Error('Module response unavailable'))
      return new Promise((resolve, reject) => {
        network.finish = async () => { try { resolve(await load()); network.loaded = true } catch (error) { reject(error) } }
      })
    })
  } }
})
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks(); localStorage.clear()
})

it('confines a module failure to its panel and retries code only after explicit action while retaining the original input', async () => {
  window.history.replaceState(null, ''); localStorage.clear()
  const owner = getDeviceWorkface(); await owner.replaceBackup(emptyDeviceWorkface())
  await owner.updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
  const f = fixture()
  f.client.subscribeRpc = vi.fn().mockResolvedValue({ subscriptionId: 'appearance-observation', dispose: async () => {} })
  f.client.forwardRpc = vi.fn().mockImplementation(async method => {
    if (method === 'agent.inspect') return { session: f.client.agentSession('session-original'), displayName: { override: null, availability: 'observed' } }
    throw new Error('No unrelated read configured: ' + method)
  })
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '已连接' }} platform={createBrowserPlatform()} />)
  const originalEditor = editor(view.element)
  await paste(view.element, '未确认消息的原草稿')
  f.submit.mockRejectedValueOnce(new Error('Original input receipt unavailable'))
  await click(button(view.element, 'Send'))
  const operationId = f.submit.mock.calls[0]![0].operationId

  await click(button(view.element, '查看终端'))
  expect(view.element.querySelector('.mobile-terminal-panel')?.textContent).toContain('终端暂时无法打开')
  expect(network.attempts).toBe(1)
  expect(errors).toHaveBeenCalled()
  await click(button(view.element.querySelector<HTMLElement>('.mobile-terminal-panel')!, '返回'))
  expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
  expect(editor(view.element)).toBe(originalEditor)
  expect(originalEditor.textContent).toBe('未确认消息的原草稿')
  await click(button(view.element, '查看终端'))
  expect(network.attempts).toBe(1)
  await click(button(view.element.querySelector<HTMLElement>('.mobile-terminal-panel')!, '重新加载此面板'))
  expect(network.attempts).toBe(2)
  expect(view.element.querySelector('.mobile-terminal-panel')?.textContent).toContain('正在加载终端')
  await click(button(view.element, '查看对话'))
  await act(async () => { await network.finish!(); await vi.waitFor(() => expect(network.loaded).toBe(true)) })
  expect(view.element.querySelector('.mobile-terminal')).not.toBeNull()
  expect(editor(view.element)).toBe(originalEditor)
  expect(view.element.querySelector('[data-phase="unknown"]')).not.toBeNull()
  expect(owner.snapshot().record.conversation.attempts[0]![1].operationId).toBe(operationId)
  expect(f.submit).toHaveBeenCalledOnce()
  expect(f.signalAgent).not.toHaveBeenCalled()
})
