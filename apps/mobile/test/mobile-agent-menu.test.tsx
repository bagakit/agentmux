import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileAgentRow, MobileAgentMenuContext } from '../src/navigation/MobileAgentRow'
import { MobileAgentUsage } from '../src/conversation/MobileAgentUsage'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { getDeviceWorkface, emptyDeviceWorkface } from '../src/recovery/device-workface'
import { saveMobileHome } from '../src/navigation/home-preference'
import { MobileGoalSessions } from '../src/goals/MobileGoalSessions'
import { button, click, fixture, mount, mounted, session } from './conversation-fixture'

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { vi.useRealTimers(); for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })
const identity = { name: '原 Agent', project: '原项目', context: { spaceId: 'space-original', zoneId: 'zone-original', workspaceId: 'resource', displayWorkspaceId: 'display', groupId: 'group', tabId: 'tab', regionId: 'region' } }
async function pointer(target: Element, type: string, overrides = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { pointerType: 'touch', isPrimary: true, pointerId: 1, button: 0, clientX: 10, clientY: 10, ...overrides })
  await act(async () => target.dispatchEvent(event))
}
async function row() {
  const menu = vi.fn(), open = vi.fn()
  const view = await mount(<MobileAgentMenuContext.Provider value={menu}><MobileAgentRow agentSessionId="sid-original" identity={identity} onOpen={open}>原 Agent</MobileAgentRow></MobileAgentMenuContext.Provider>)
  return { ...view, menu, open, main: view.element.querySelector('.mobile-agent-row__open')! }
}
describe('original Agent row gestures', () => {
  it('short tap opens only the original conversation and visible More opens its original occurrence', async () => {
    const f = await row(); await pointer(f.main, 'pointerdown'); await pointer(f.main, 'pointerup'); await click(f.main as HTMLButtonElement)
    expect(f.open).toHaveBeenCalledTimes(1); expect(f.menu).not.toHaveBeenCalled()
    await click(button(f.element, '原 Agent · 更多操作')); expect(f.menu).toHaveBeenCalledExactlyOnceWith({ agentSessionId: 'sid-original', identity })
  })
  it('long press opens its original menu and swallows the release click', async () => {
    vi.useFakeTimers(); const f = await row(); await pointer(f.main, 'pointerdown')
    await act(async () => vi.advanceTimersByTime(500)); await pointer(f.main, 'pointerup'); await act(async () => f.main.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })))
    expect(f.menu).toHaveBeenCalledExactlyOnceWith({ agentSessionId: 'sid-original', identity }); expect(f.open).not.toHaveBeenCalled()
  })
  it.each(['move', 'scroll', 'cancel', 'second-finger', 'release', 'blur'])('cancels a pending long press on %s', async kind => {
    vi.useFakeTimers(); const f = await row(); await pointer(f.main, 'pointerdown')
    if (kind === 'move') await pointer(f.main, 'pointermove', { clientY: 35 })
    if (kind === 'scroll' || kind === 'blur') await act(async () => window.dispatchEvent(new Event(kind)))
    if (kind === 'cancel') await pointer(f.main, 'pointercancel')
    if (kind === 'second-finger') await pointer(f.main, 'pointerdown', { pointerId: 2, isPrimary: false })
    if (kind === 'release') await pointer(f.main, 'pointerup')
    await act(async () => vi.advanceTimersByTime(600)); expect(f.menu).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled()
  })
  it('cancels a pending menu when its original SID unmounts', async () => {
    vi.useFakeTimers(); const f = await row(); await pointer(f.main, 'pointerdown')
    await f.render(null); await act(async () => vi.advanceTimersByTime(600)); expect(f.menu).not.toHaveBeenCalled()
  })
  it('offers keyboard and native context-menu access without conversation navigation', async () => {
    const f = await row()
    await act(async () => f.main.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })))
    await act(async () => f.main.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true })))
    expect(f.menu).toHaveBeenCalledTimes(2); expect(f.open).not.toHaveBeenCalled()
    await click(f.main); expect(f.open).toHaveBeenCalledTimes(1)
  })
})
const usage = { scope: 'response' as const, inputTokens: 12, outputTokens: 4, totalTokens: 16, observedAt: 1000,
  cumulative: { scope: 'native-session' as const, inputTokens: 100, outputTokens: 30, totalTokens: 130 }, context: { usedTokens: 50, capacityTokens: 200 } }
it('connects the actual App row menu to copy and exact-SID usage without selecting, resuming or sending', async () => {
  const f = fixture(), copy = vi.fn().mockResolvedValue(true), ensure = vi.fn()
  f.client.agentSessions = () => []
  f.client.ensureAgentContinuity = ensure
  f.client.forwardRpc = vi.fn().mockImplementation(async (method, params) => {
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], locations: [], bindings: [], agentPresentation: [{ agentSessionId: 'peer', name: '另一个原 Agent', project: '原项目', state: 'done', group: 'results' }] } }
    if (method === 'agent.inspect') { expect(params.target).toEqual({ kind: 'agent-session', agentSessionId: 'peer' }); return { session: { ...session('peer'), turnUsage: usage } } }
    throw Error('Unexpected method ' + method)
  })
  saveMobileHome('focus'); await getDeviceWorkface().updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'sessions' })
  const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '已连接' }} platform={{ ...createBrowserPlatform(), copyText: copy }} />)
  await click(button(view.element, '另一个原 Agent · 更多操作'))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('另一个原 Agent')
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
  await click(button(document.body, '复制 Agent 身份链接')); expect(copy.mock.calls[0]![0]).toBe('amux://agent/peer')
  await click(button(document.body, '查看消耗'))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('50 / 200 tokens')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('原生 Session 累计')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('130')
  await click(button(document.body, '关闭面板'))
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original'); expect(f.submit).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled()
})
it('does not turn missing native observations or an old unscoped sample into zero or cumulative usage', async () => {
  const f = fixture(); f.client.forwardRpc = vi.fn().mockResolvedValue({ session: { ...session(), turnUsage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, observedAt: 1000 } } })
  const view = await mount(<MobileAgentUsage client={f.client} agentSessionId="session-original" connected />)
  expect(f.client.forwardRpc).not.toHaveBeenCalled(); await click(button(view.element, '查看消耗'))
  expect(view.element.textContent).toContain('累计用量尚未上报'); expect(view.element.textContent).toContain('范围未确认'); expect(view.element.textContent).toContain('已用量与容量尚未上报')
})
it.each(['sid', 'client'])('does not adopt a late native usage reading across a %s change', async change => {
  const a = fixture(), b = fixture(); let resolve!: (value: unknown) => void
  a.client.forwardRpc = vi.fn().mockReturnValue(new Promise(done => { resolve = done }))
  b.client.forwardRpc = vi.fn().mockResolvedValue({ session: session() })
  const view = await mount(<MobileAgentUsage client={a.client} agentSessionId="session-original" connected />); await click(button(view.element, '查看消耗'))
  await view.render(<MobileAgentUsage client={change === 'client' ? b.client : a.client} agentSessionId={change === 'sid' ? 'peer' : 'session-original'} connected />)
  await act(async () => resolve({ session: { ...session(), turnUsage: usage } }))
  expect(view.element.textContent).not.toContain('50 / 200 tokens')
})
it('rejects another SID reading and can refresh the original target', async () => {
  const f = fixture(); f.client.forwardRpc = vi.fn().mockResolvedValueOnce({ session: { ...session('peer'), turnUsage: usage } }).mockResolvedValueOnce({ session: { ...session(), turnUsage: usage } })
  const view = await mount(<MobileAgentUsage client={f.client} agentSessionId="session-original" connected />); await click(button(view.element, '查看消耗'))
  expect(view.element.textContent).toContain('另一 Agent'); expect(view.element.textContent).not.toContain('50 / 200 tokens')
  await click(button(view.element, '刷新消耗')); expect(view.element.textContent).toContain('50 / 200 tokens')
})
it('preserves the original Goal Host check for More and long press as well as short tap', async () => {
  const f = fixture(), menu = vi.fn(), open = vi.fn()
  f.client.forwardRpc = vi.fn()
  const view = await mount(<MobileAgentMenuContext.Provider value={menu}><MobileGoalSessions client={f.client} sessionIds={['session-original']} visible openSession={open}
    goal={{ id: 'goal-original', sessionIds: ['session-original'] } as never}
    factScope={{ origin: 'http://127.0.0.1', runtimeId: 'other-runtime', deviceHostId: null }} /></MobileAgentMenuContext.Provider>)
  await click(button(view.element, 'Agent 名称未确认 · 更多操作'))
  vi.useFakeTimers(); const main = view.element.querySelector('.mobile-agent-row__open')!
  await pointer(main, 'pointerdown'); await act(async () => vi.advanceTimersByTime(500)); await pointer(main, 'pointerup')
  expect(menu).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(f.client.forwardRpc).not.toHaveBeenCalled()
  expect(view.element.textContent).toContain('原目标与当前 Host 尚未匹配')
})
it('rechecks the source of an open menu when the same client changes Runtime', async () => {
  const f = fixture(), ensure = vi.fn(), copy = vi.fn().mockResolvedValue(true)
  let runtimeId = 'original-runtime'
  f.client.runtimeOwnerIdentity = () => ({ runtimeId } as never); f.client.ensureAgentContinuity = ensure; f.client.agentSessions = () => []
  f.client.forwardRpc = vi.fn().mockResolvedValue({ catalog: { spaces: [], zones: [], tabs: [], regions: [], locations: [], bindings: [], agentPresentation: [{ agentSessionId: 'peer', name: '原关联 Agent', project: '原项目', state: 'done', group: 'results' }] } })
  saveMobileHome('focus'); await getDeviceWorkface().updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'sessions' })
  const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '已连接' }} platform={{ ...createBrowserPlatform(), copyText: copy }} />)
  await click(button(view.element, '原关联 Agent · 更多操作')); const reads = vi.mocked(f.client.forwardRpc).mock.calls.length
  runtimeId = 'replacement-runtime'
  await click(button(document.body, '查看消耗')); await click(button(document.body, '恢复原 Agent')); await click(button(document.body, '打开原对话'))
  expect(vi.mocked(f.client.forwardRpc).mock.calls).toHaveLength(reads); expect(ensure).not.toHaveBeenCalled(); expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('原菜单的 Host 或工作面来源已变化')
  await click(button(document.body, '复制 Agent 身份链接')); expect(copy.mock.calls[0]![0]).toBe('amux://agent/peer')
})
