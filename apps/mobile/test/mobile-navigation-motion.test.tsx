import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { MobileHeaderMenuContext } from '../src/navigation/MobileHeaderMenu'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted, waitForElement } from './conversation-fixture'

// Only native canvas paint is outside this DOM test; navigation and every callback owner stay real.
vi.mock('../src/terminal/MobileTerminalViewer', () => ({ MobileTerminalViewer: ({ agentSessionId }: { agentSessionId: string }) => <div data-terminal-session={agentSessionId} /> }))
const connected = { state: 'connected' as const, message: '已连接' }
beforeEach(async () => { localStorage.clear(); window.history.replaceState(null, ''); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })
function appFixture() {
  const f = fixture()
  f.client.subscribeRpc = vi.fn().mockResolvedValue({ subscriptionId: 'appearance', dispose: async () => {} })
  f.client.readAgentInputMailbox = vi.fn().mockResolvedValue({ hostId: 'local', agentSessionId: 'session-original', items: [], nextCursor: null })
  f.client.forwardRpc = vi.fn().mockImplementation(async (method, params) => {
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [
      { agentSessionId: 'session-original', name: '产品修复', project: '项目', group: 'working', state: 'working', stateMark: 'working', lastActivityAt: Date.now(), providerId: 'codex', detail: '' }
    ] } }
    if (method === 'goal.ls') return { goals: [] }
    if (method === 'app.snapshot') return { agents: [] }
    if (method === 'agent.inspect') return { session: f.client.agentSession(params.agentSessionId), displayName: { override: null, availability: 'observed' } }
    throw new Error('Unconfigured read-only observation: ' + method)
  })
  return f
}
it('pushes through the actual conversation Goal and mailbox Terminal callbacks and alternates consecutive push phases', async () => {
  await import('../src/navigation/MobileGoalWork')
  const f = appFixture(), view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
  const main = view.element.querySelector<HTMLElement>('.mobile-main')!
  await click(button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Focus'))
  await click(await waitForElement(view.element, '.mobile-agent-row__open'))
  const original = editor(view.element)
  expect(main.dataset.motion).toBe('push')
  const conversationPhase = main.dataset.motionPhase
  expect(conversationPhase).toMatch(/^[01]$/)
  await click(button(view.element.querySelector<HTMLElement>('.mobile-conversation__floating-tools')!, '目标与结果'))
  expect(view.element.querySelector('.mobile-goal-panel')?.hasAttribute('hidden')).toBe(false)
  expect(main.dataset.motion).toBe('push')
  expect(main.dataset.motionPhase).not.toBe(conversationPhase)
  expect(main.dataset.motionKey).toBeUndefined()
  await click(button(view.element.querySelector<HTMLElement>('.mobile-header')!, '返回对话'))
  await vi.waitFor(() => expect(main.dataset.motion).toBe('pop'))
  // The mailbox owns this route; the header toggle is a different callback.
  await click(view.element.querySelector('.mobile-message-tools__trigger')!)
  await click(button(document.body, '查看 Terminal'))
  expect(view.element.querySelector('.mobile-terminal-panel')?.hasAttribute('hidden')).toBe(false)
  expect(main.dataset.motion).toBe('push')
  expect(view.element.querySelector('[data-terminal-session]')?.getAttribute('data-terminal-session')).toBe('session-original')
  expect(editor(view.element)).toBe(original)
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
})
it('retains the actual header menu while a Space tree branch is expanded', async () => {
  const f = fixture(), open = vi.fn(), menu = vi.fn()
  f.client.forwardRpc = vi.fn().mockResolvedValue({ catalog: { spaces: [
    { spaceId: 'folder-original', name: '产品项目', kind: 'folder', hostId: 'local', directoryPath: '/fixture/product', projectId: 'project-original' },
    { spaceId: 'folder-child', name: '子目录', kind: 'folder', hostId: 'local', directoryPath: '/fixture/product/child', projectId: 'project-child' }
  ], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [] } })
  const view = await mount(<MobileHeaderMenuContext.Provider value={<button type="button" aria-label="手机设置与连接" onClick={menu}>菜单</button>}>
    <MobileSpatialNavigation home="space" client={f.client} connected sessions={[]} openSession={open} />
  </MobileHeaderMenuContext.Provider>)
  await click(await waitForElement(view.element, '[data-space-id="folder-original"] > button'))
  expect(view.element.querySelector('[data-space-id="folder-child"]')).not.toBeNull()
  await click(button(view.element.querySelector<HTMLElement>('.mobile-page-header')!, '手机设置与连接'))
  expect(menu).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})
