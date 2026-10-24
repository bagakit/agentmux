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
import { button, click, deferred, fixture, mount, mounted, session } from './conversation-fixture'

beforeEach(async () => { window.history.replaceState(null, ''); localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
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
const cachedUsage = { ...usage, observedAt: 900, context: { usedTokens: 5, capacityTokens: 20 } }
const connection = { state: 'connected' as const, message: '已连接' }
function usageSession(id = 'session-original', value = usage) { return { ...session(id), turnUsage: value } }
async function appMenu(inspect: (id: string) => Promise<unknown>, initial = cachedUsage) {
  const f = fixture(), copy = vi.fn().mockResolvedValue(true), ensure = vi.fn()
  f.sessions.set('peer', usageSession('peer', initial))
  f.client.ensureAgentContinuity = ensure
  f.client.forwardRpc = vi.fn().mockImplementation(async (method, params) => {
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], locations: [], bindings: [], agentPresentation: [{ agentSessionId: 'peer', name: '另一个原 Agent', project: '原项目', state: 'done', group: 'results' }] } }
    if (method === 'agent.inspect') return inspect(params.target.agentSessionId)
    throw Error('Unexpected method ' + method)
  })
  saveMobileHome('focus')
  const owner = getDeviceWorkface()
  await owner.updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'sessions' })
  await owner.updateConversation({ version: 1, drafts: [['session-original', 'Original unsent draft']], attempts: [], responses: [] })
  const original = owner.snapshot().record.conversation
  const app = () => <MobileApp client={f.client} connection={connection} platform={{ ...createBrowserPlatform(), copyText: copy }} />
  const view = await mount(app())
  return { ...f, ...view, copy, ensure, original, app }
}
it.each(['close', 'Escape', 'Back'])('opens the actual App menu before delayed inspect, allows Copy and preserves the original workface on %s', async dismissal => {
  const read = deferred<any>(), inspect = vi.fn(() => read.promise), f = await appMenu(inspect)
  await click(button(f.element, '另一个原 Agent · 更多操作'))
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog).not.toBeNull(); expect(dialog.textContent).toContain('另一个原 Agent')
  const usagePanel = dialog.querySelector('[aria-label="Agent 消耗"]')!
  expect(usagePanel).not.toBeNull()
  expect(usagePanel.compareDocumentPosition(button(dialog, '复制 Agent 身份链接')) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  expect(dialog.textContent).toContain('5 / 20 tokens')
  expect([...dialog.querySelectorAll('button')].some(value => value.textContent?.trim() === '查看消耗')).toBe(false)
  expect(inspect).toHaveBeenCalledExactlyOnceWith('peer')
  expect(button(dialog, '复制 Agent 身份链接').disabled).toBe(false)
  expect(button(dialog, '恢复原 Agent').disabled).toBe(false)
  await click(button(dialog, '复制 Agent 身份链接')); expect(f.copy.mock.calls[0]![0]).toBe('amux://agent/peer')
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
  expect(getDeviceWorkface().snapshot().record.conversation).toEqual(f.original)
  if (dismissal === 'close') await click(button(dialog, '关闭面板'))
  else if (dismissal === 'Escape') await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  else await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 20)) })
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  await act(async () => read.resolve({ session: usageSession('peer') }))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
  expect(getDeviceWorkface().snapshot().record.conversation).toEqual(f.original)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.ensure).not.toHaveBeenCalled()
})
it('shows cached SDK usage immediately and updates from the exact automatic native reading with an owner fence', async () => {
  const f = fixture(), read = deferred<any>()
  f.sessions.set('session-original', usageSession('session-original', cachedUsage))
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' } as never)
  f.client.forwardRpc = vi.fn().mockReturnValue(read.promise)
  const view = await mount(<MobileAgentUsage client={f.client} agentSessionId="session-original" connected />)
  expect(view.element.textContent).toContain('5 / 20 tokens')
  expect(f.client.forwardRpc).toHaveBeenCalledExactlyOnceWith('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'session-original' } }, {}, { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' })
  await act(async () => read.resolve({ session: usageSession() }))
  expect(view.element.textContent).toContain('50 / 200 tokens')
  expect(view.element.textContent).toContain('原生 Session 累计'); expect(view.element.textContent).toContain('130')
})
it('does not turn missing native observations or an old unscoped sample into zero or cumulative usage', async () => {
  const f = fixture(); f.client.forwardRpc = vi.fn().mockResolvedValue({ session: { ...session(), turnUsage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, observedAt: 1000 } } })
  const view = await mount(<MobileAgentUsage client={f.client} agentSessionId="session-original" connected />)
  expect(f.client.forwardRpc).toHaveBeenCalledTimes(1)
  expect(view.element.textContent).toContain('累计用量尚未上报'); expect(view.element.textContent).toContain('范围未确认'); expect(view.element.textContent).toContain('已用量与容量尚未上报')
})
it.each(['sid', 'client', 'runtime', 'owner-instance', 'record', 'device-host', 'disconnect', 'closed'])('does not adopt a late native usage reading after %s changes', async change => {
  const a = fixture(), b = fixture(), old = deferred<any>(), next = deferred<any>()
  let runtimeId = 'original-runtime', ownerInstanceId = 'original-owner'
  a.client.runtimeOwnerIdentity = () => ({ runtimeId, ownerInstanceId } as never)
  a.client.forwardRpc = vi.fn().mockReturnValueOnce(old.promise).mockReturnValue(next.promise)
  b.client.forwardRpc = vi.fn().mockReturnValue(next.promise)
  const view = await mount(<MobileAgentUsage client={a.client} agentSessionId="session-original" connected />)
  if (change === 'runtime') runtimeId = 'replacement-runtime'
  else if (change === 'owner-instance') ownerInstanceId = 'replacement-owner'
  else if (change === 'record') await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  else if (change === 'device-host') await getDeviceWorkface().confirmHost({ hostId: 'replacement-host', origin: 'https://replacement.test' })
  else await view.render(change === 'closed' ? null : <MobileAgentUsage client={change === 'client' ? b.client : a.client} agentSessionId={change === 'sid' ? 'peer' : 'session-original'} connected={change !== 'disconnect'} />)
  await act(async () => old.resolve({ session: usageSession() }))
  expect(view.element.textContent).not.toContain('50 / 200 tokens')
})
it.each(['Host', 'Run'])('does not adopt a late reading after the SDK target %s changes on the same client and SID', async change => {
  const f = fixture(), read = deferred<any>()
  f.client.forwardRpc = vi.fn().mockReturnValue(read.promise)
  const view = await mount(<MobileAgentUsage client={f.client} agentSessionId="session-original" connected />)
  f.sessions.set('session-original', { ...session(), ...(change === 'Host' ? { hostId: 'replacement-host' } : { run: { runId: 'replacement-run' } }) })
  await act(async () => read.resolve({ session: usageSession() }))
  expect(view.element.textContent).not.toContain('50 / 200 tokens')
})
it.each(['sid', 'Host'])('rejects a reading for another %s and refreshes only the original target', async wrong => {
  const f = fixture()
  f.client.forwardRpc = vi.fn().mockResolvedValueOnce({ session: { ...usageSession(wrong === 'sid' ? 'peer' : 'session-original'), run: session().run, hostId: wrong === 'Host' ? 'other-host' : 'host-original' } }).mockResolvedValueOnce({ session: usageSession() })
  const view = await mount(<MobileAgentUsage client={f.client} agentSessionId="session-original" connected />)
  expect(view.element.textContent).toContain('另一 Agent'); expect(view.element.textContent).not.toContain('50 / 200 tokens')
  await click(button(view.element, '刷新消耗')); expect(view.element.textContent).toContain('50 / 200 tokens')
  for (const [, params] of vi.mocked(f.client.forwardRpc).mock.calls) expect(params).toEqual({ target: { kind: 'agent-session', agentSessionId: 'session-original' } })
})
it('keeps the newer explicit refresh when an older automatic read completes later', async () => {
  const f = fixture(), old = deferred<any>(), refreshed = deferred<any>()
  f.client.forwardRpc = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(refreshed.promise)
  const view = await mount(<MobileAgentUsage client={f.client} agentSessionId="session-original" connected />)
  await click(button(view.element, '刷新消耗'))
  await act(async () => refreshed.resolve({ session: usageSession('session-original', { ...usage, context: { usedTokens: 80, capacityTokens: 300 } }) }))
  await act(async () => old.resolve({ session: usageSession() }))
  expect(view.element.textContent).toContain('80 / 300 tokens'); expect(view.element.textContent).not.toContain('50 / 200 tokens')
})
it('keeps the last native sample after a read failure and permits an exact-target refresh', async () => {
  const f = fixture(); f.sessions.set('session-original', usageSession('session-original', cachedUsage))
  f.client.forwardRpc = vi.fn().mockRejectedValueOnce(new Error('original read unavailable')).mockResolvedValueOnce({ session: usageSession() })
  const view = await mount(<MobileAgentUsage client={f.client} agentSessionId="session-original" connected />)
  expect(view.element.textContent).toContain('original read unavailable'); expect(view.element.textContent).toContain('5 / 20 tokens')
  await click(button(view.element, '刷新消耗')); expect(view.element.textContent).toContain('50 / 200 tokens')
})
it('refreshes the open actual App usage from an authoritative SDK Agent event without selecting or recovering', async () => {
  const f = await appMenu(async id => ({ session: usageSession(id) }))
  await click(button(f.element, '另一个原 Agent · 更多操作'))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('50 / 200 tokens')
  await act(async () => f.emit({ type: 'agent-session', session: usageSession('peer', { ...usage, observedAt: 2000, context: { usedTokens: 75, capacityTokens: 250 } }) }))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('75 / 250 tokens')
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
  expect(getDeviceWorkface().snapshot().record.conversation).toEqual(f.original)
  expect(f.ensure).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})
it('updates the mounted usage reader from its exact authoritative SDK event without another inspect', async () => {
  const f = fixture(); f.client.forwardRpc = vi.fn().mockResolvedValue({ session: usageSession() })
  const view = await mount(<MobileAgentUsage client={f.client} agentSessionId="session-original" connected />)
  expect(view.element.textContent).toContain('50 / 200 tokens')
  await act(async () => f.emit({ type: 'agent-session', session: usageSession('peer', { ...usage, observedAt: 2000, context: { usedTokens: 99, capacityTokens: 400 } }) }))
  expect(view.element.textContent).toContain('50 / 200 tokens'); expect(view.element.textContent).not.toContain('99 / 400 tokens')
  await act(async () => f.emit({ type: 'agent-session', session: usageSession('session-original', { ...usage, observedAt: 2000, context: { usedTokens: 75, capacityTokens: 250 } }) }))
  expect(view.element.textContent).toContain('75 / 250 tokens')
  expect(f.client.forwardRpc).toHaveBeenCalledTimes(1)
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
it('rechecks the open actual menu source when the same client changes Runtime while Copy remains usable', async () => {
  const f = await appMenu(async id => ({ session: session(id) }))
  let runtimeId = 'original-runtime'
  f.client.runtimeOwnerIdentity = () => ({ runtimeId } as never)
  await click(button(f.element, '另一个原 Agent · 更多操作')); const reads = vi.mocked(f.client.forwardRpc).mock.calls.length
  runtimeId = 'replacement-runtime'
  await click(button(document.body, '刷新消耗')); await click(button(document.body, '恢复原 Agent')); await click(button(document.body, '打开原对话'))
  expect(vi.mocked(f.client.forwardRpc).mock.calls).toHaveLength(reads); expect(f.ensure).not.toHaveBeenCalled(); expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('原菜单的 Host 或工作面来源已变化')
  await click(button(document.body, '复制 Agent 身份链接')); expect(f.copy.mock.calls[0]![0]).toBe('amux://agent/peer')
})
it('ends an in-flight reading when its actual App menu source is invalidated while retaining Copy and close', async () => {
  const read = deferred<any>(), inspect = vi.fn(() => read.promise), f = await appMenu(inspect)
  let ownerInstanceId = 'original-owner'
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId } as never)
  await click(button(f.element, '另一个原 Agent · 更多操作'))
  expect(document.querySelector('[aria-label="Agent 消耗"]')?.textContent).toContain('正在核对…')
  ownerInstanceId = 'replacement-owner'
  await f.render(f.app())
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog.textContent).toContain('原菜单的 Host 或工作面来源已变化')
  expect(dialog.querySelector('[aria-label="Agent 消耗"]')?.textContent).not.toContain('正在核对…')
  expect(inspect).toHaveBeenCalledTimes(1)
  await click(button(dialog, '复制 Agent 身份链接')); expect(f.copy.mock.calls[0]![0]).toBe('amux://agent/peer')
  await act(async () => read.resolve({ session: usageSession('peer') }))
  expect(dialog.textContent).not.toContain('50 / 200 tokens')
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
  expect(getDeviceWorkface().snapshot().record.conversation).toEqual(f.original)
  expect(f.ensure).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
  await click(button(dialog, '关闭面板')); expect(document.querySelector('[role="dialog"]')).toBeNull()
})
