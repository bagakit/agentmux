import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

// Native canvas painting is covered by the real Renderer probe; the App routing and owners stay real.
vi.mock('../src/terminal/MobileTerminalViewer', () => ({ MobileTerminalViewer: ({ agentSessionId }: { agentSessionId: string }) => <div data-terminal-session={agentSessionId} /> }))
const connected = { state: 'connected' as const, message: '原 Host 已连接' }
beforeEach(async () => { localStorage.clear(); window.history.replaceState(null, ''); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})
async function setup(mote: boolean) {
  const f = fixture(), identity = { name: '原 Agent', project: '原项目', ...(mote ? { mote: { spaceId: 'original-mote', name: '原搭档' } } : {}) }
  await getDeviceWorkface().updatePresentation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' },
    { primary: mote ? 'mote' : 'focus', showSession: true, showGoalWork: false, identity, profile: null })
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', availability: 'connected' } as ReturnType<typeof f.client.runtimeOwnerIdentity>)
  f.client.subscribeRpc = vi.fn().mockResolvedValue({ subscriptionId: 'appearance', dispose: async () => {} })
  f.client.forwardRpc = vi.fn().mockImplementation(async (method, params) => {
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [] } }
    if (method === 'goal.ls') return { goals: [] }
    if (method === 'agent.inspect') return { session: f.client.agentSession(params.agentSessionId), displayName: { override: null, availability: 'observed' } }
    if (method === 'app.snapshot') return { agents: [] }
    throw new Error('Unconfigured original observation: ' + method)
  })
  f.client.readAgentInputMailbox = vi.fn().mockResolvedValue({ hostId: 'local', agentSessionId: 'session-original', items: [], nextCursor: null })
  const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
  return { f, view }
}
describe('phone direct conversation controls', () => {
  it.each([false, true])('switches the original panel from the %s Mote header and retains the mounted draft', async mote => {
    const { f, view } = await setup(mote), original = editor(view.element)
    await paste(view.element, '切换后保留这份草稿')
    const header = view.element.querySelector<HTMLElement>('.mobile-header')!
    expect(header.querySelectorAll('.mobile-session-view-toggle')).toHaveLength(1)
    await click(button(header, '查看终端'))
    expect(view.element.querySelector('.mobile-terminal-panel')?.hasAttribute('hidden')).toBe(false)
    expect(view.element.querySelector('[data-terminal-session]')?.getAttribute('data-terminal-session')).toBe('session-original')
    await click(button(header, '查看对话'))
    expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
    expect(editor(view.element)).toBe(original); expect(original.textContent).toBe('切换后保留这份草稿')
    await click(button(header, '当前对话操作'))
    const sheet = document.querySelector('[role="dialog"]')!
    expect(sheet.textContent).not.toContain('查看终端'); expect(sheet.textContent).not.toContain('目标与结果')
    expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
  })
  it.each([false, true])('uses the single floating History and original Goal owner with safe return focus for Mote=%s', async mote => {
    const { f, view } = await setup(mote), original = editor(view.element)
    await paste(view.element, '目标与历史保留原编辑器')
    const tools = view.element.querySelector<HTMLElement>('.mobile-conversation__floating-tools')!
    const history = tools.querySelector<HTMLButtonElement>('.mobile-message-tools__trigger')!
    expect(history).not.toBeNull(); expect(view.element.querySelectorAll('.mobile-message-tools__trigger')).toHaveLength(1)
    expect(history.closest('.composer')).toBeNull()
    await click(history)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('输入历史与通信记录')
    await click(button(document.body, '关闭通信记录'))
    await vi.waitFor(() => expect(document.activeElement).toBe(history))
    const goal = button(tools, '目标与结果')
    await click(goal)
    expect(view.element.querySelector('.mobile-goal-panel')?.hasAttribute('hidden')).toBe(false)
    expect(f.client.forwardRpc).toHaveBeenCalledWith('goal.ls', { agentSessionId: 'session-original' })
    await click(button(view.element.querySelector<HTMLElement>('.mobile-header')!, '返回对话'))
    await vi.waitFor(() => expect(document.activeElement).toBe(goal))
    expect(editor(view.element)).toBe(original); expect(original.textContent).toBe('目标与历史保留原编辑器')
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
    expect(vi.mocked(f.client.forwardRpc).mock.calls.every(([method]) => !['agent.open','agent.resume','goal.start'].includes(method))).toBe(true)
  })
})
