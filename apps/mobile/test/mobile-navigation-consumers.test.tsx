import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { saveMobileHome } from '../src/navigation/home-preference'
import { button, click, evidence, fixture, mount, mounted, session } from './conversation-fixture'

const connection = { state: 'connected' as const, message: '已连接' }
beforeEach(async () => { window.history.replaceState(null, ''); localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })

/** Actual App consumers; counters measure SDK method calls, not physical-phone latency. */
async function app(presentation: boolean | 'missing-provider' = true) {
  const f = fixture(), owner = getDeviceWorkface(), copy = vi.fn().mockResolvedValue(true)
  const fullDirectory = vi.spyOn(f.client, 'agentSessions'), pointRead = vi.spyOn(f.client, 'agentSession')
  const ensure = vi.fn(); f.client.ensureAgentContinuity = ensure
  f.sessions.set('peer', { ...session('peer'), providerId: 'claude' })
  let catalogFails = false
  const catalog = { spaces: [], zones: [], tabs: [], regions: [], locations: [], bindings: [],
    ...(presentation ? { agentPresentation: [{ agentSessionId: 'peer', ...(presentation === 'missing-provider' ? {} : { providerId: 'claude' }), name: '原目录 Agent', project: '原项目', state: 'done', group: 'results' }] } : {}) }
  f.client.forwardRpc = vi.fn().mockImplementation(async (method, params) => {
    if (method === 'space.ls') { if (catalogFails) throw new Error('original catalog unavailable'); return { catalog } }
    if (method === 'agent.inspect') return { session: f.sessions.get(params.target.agentSessionId) }
    if (method === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (method === 'goal.ls') return { goals: [] }
    throw new Error('Unexpected consumer RPC: ' + method)
  })
  saveMobileHome('focus')
  await owner.updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'sessions' })
  await owner.updateConversation({ version: 1, drafts: [['session-original', 'Original retained draft']], attempts: [], responses: [] })
  const original = owner.snapshot().record.conversation
  const view = await mount(<MobileApp client={f.client} connection={connection} platform={{ ...createBrowserPlatform(), copyText: copy }} />)
  await click(button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Focus'))
  expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(true)
  return { ...f, ...view, fullDirectory, pointRead, copy, ensure, original, failCatalog: () => { catalogFails = true } }
}

it('switches the five actual primary workfaces and menu without rereading the unrelated full SDK directory', async () => {
  const f = await app(), originalSlot = f.element.querySelector('.mobile-conversation-slot')!
  const initialReads = f.fullDirectory.mock.calls.length
  for (const name of ['Goals', 'Topics', 'Mote', 'Space', 'Focus']) {
    await click(button(f.element.querySelector<HTMLElement>('[aria-label="手机导航"]')!, name))
    expect(f.element.querySelector(`[data-workface="${name.toLowerCase()}"]`)?.getAttribute('aria-current')).toBe('page')
    expect(f.fullDirectory).toHaveBeenCalledTimes(initialReads)
    expect(f.element.querySelector('.mobile-conversation-slot')).toBe(originalSlot)
    expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
    expect(getDeviceWorkface().snapshot().record.conversation).toEqual(f.original)
  }
  const row = button(f.element, '原目录 Agent · 更多操作')
  await click(row); expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await click(button(document.body, '复制 Agent 身份链接')); expect(f.copy.mock.calls[0]![0]).toBe('amux://agent/peer')
  await click(button(document.body, '关闭面板'))
  expect(button(f.element, '原目录 Agent · 更多操作')).toBe(row)
  expect(f.fullDirectory).toHaveBeenCalledTimes(initialReads)
  expect(f.ensure).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})

it('ignores unrelated Session and Run events while refreshing the exact selected Session and connection facts', async () => {
  const f = await app(); f.pointRead.mockClear(); f.fullDirectory.mockClear()
  await act(async () => f.emit({ type: 'agent-session', session: { ...session('peer'), updatedAt: 2 } }))
  await act(async () => f.emit({ type: 'run-removed', agentSessionId: 'peer', run: { runId: 'run-peer' }, evidence }))
  expect(f.pointRead).not.toHaveBeenCalled(); expect(f.fullDirectory).not.toHaveBeenCalled()
  await act(async () => f.emit({ type: 'agent-session', session: { ...session(), updatedAt: 3 } }))
  expect(f.pointRead.mock.calls).toEqual([['session-original']])
  f.pointRead.mockClear()
  await act(async () => f.emit({ type: 'run-removed', run: { runId: 'run-original' }, evidence }))
  expect(f.pointRead.mock.calls).toEqual([['session-original']])
  f.pointRead.mockClear()
  await act(async () => f.emit({ type: 'connection-state', state: 'lost', evidence }))
  expect(f.pointRead.mock.calls).toEqual([['session-original']])
  f.pointRead.mockClear()
  await act(async () => f.emit({ type: 'connection-state', state: 'restored', evidence }))
  expect(f.pointRead.mock.calls).toEqual([['session-original']])
  expect(f.fullDirectory).not.toHaveBeenCalled()
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
  expect(getDeviceWorkface().snapshot().record.conversation).toEqual(f.original)
})

it('retains the actual SDK-only fallback row and original DOM across menu suspension and failed directory refreshes', async () => {
  const f = await app(false)
  const list = [...f.element.querySelectorAll<HTMLElement>('details')].find(item => item.querySelector('summary')?.textContent === '其他已有会话')!
  expect(list).toBeDefined()
  const row = [...list.querySelectorAll<HTMLLIElement>('li')].find(item => item.querySelector('.mobile-session-state small')?.textContent === 'claude')!
  expect(row).toBeDefined()
  const more = button(row, '名称未确认 · 更多操作'), open = row.querySelector<HTMLButtonElement>('.mobile-agent-row__open')!
  const beforeMenu = f.fullDirectory.mock.calls.length
  await click(more)
  expect(f.fullDirectory).toHaveBeenCalledTimes(beforeMenu)
  expect(row.isConnected).toBe(true); expect(list.contains(row)).toBe(true)
  f.fullDirectory.mockImplementation(() => { throw new Error('SDK inventory temporarily unavailable') })
  f.failCatalog()
  await click(button(document.body, '关闭面板'))
  await click(button(f.element, '刷新空间目录'))
  expect(list.contains(row)).toBe(true); expect(row.querySelector('.mobile-agent-row__open')).toBe(open)
  expect(f.element.textContent).toContain('原会话元信息目录暂不可读')
  expect(f.element.textContent).toContain('original catalog unavailable')
  await click(open)
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('peer')
  expect(getDeviceWorkface().snapshot().record.conversation.drafts).toContainEqual(['session-original', 'Original retained draft'])
  expect(f.ensure).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})

it('fills a missing public Provider from the original SDK and reuses that directory across menus and all primary workfaces', async () => {
  const f = await app('missing-provider'), row = button(f.element, '原目录 Agent · 更多操作').closest('li')!
  expect(row.querySelector('.mobile-session-state small')?.textContent).toBe('claude')
  const initialReads = f.fullDirectory.mock.calls.length
  expect(initialReads).toBeGreaterThan(0)
  await click(button(row, '原目录 Agent · 更多操作'))
  expect(f.fullDirectory).toHaveBeenCalledTimes(initialReads)
  await click(button(document.body, '关闭面板'))
  expect(button(f.element, '原目录 Agent · 更多操作').closest('li')).toBe(row)
  for (const name of ['Goals', 'Topics', 'Mote', 'Space', 'Focus']) {
    await click(button(f.element.querySelector<HTMLElement>('[aria-label="手机导航"]')!, name))
    expect(f.fullDirectory).toHaveBeenCalledTimes(initialReads)
  }
  expect(button(f.element, '原目录 Agent · 更多操作').closest('li')?.querySelector('.mobile-session-state small')?.textContent).toBe('claude')
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
  expect(getDeviceWorkface().snapshot().record.conversation).toEqual(f.original)
  expect(f.ensure).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})

it('retains hidden metadata without reading it and refreshes on return only after a relevant original SDK event', async () => {
  const f = await app('missing-provider'), row = button(f.element, '原目录 Agent · 更多操作').closest('li')!
  const navigate = async (name: string) => click(button(f.element.querySelector<HTMLElement>('[aria-label="手机导航"]')!, name))
  const initialReads = f.fullDirectory.mock.calls.length
  await navigate('Goals')
  await act(async () => f.emit({ type: 'agent-session', session: { ...session('other'), providerId: 'gemini', updatedAt: 2 } }))
  expect(f.fullDirectory).toHaveBeenCalledTimes(initialReads)
  await navigate('Focus')
  expect(f.fullDirectory).toHaveBeenCalledTimes(initialReads)
  expect(row.querySelector('.mobile-session-state small')?.textContent).toBe('claude')
  await navigate('Goals')
  await act(async () => f.emit({ type: 'agent-session', session: { ...session('peer'), providerId: 'gemini', updatedAt: 3 } }))
  expect(f.fullDirectory).toHaveBeenCalledTimes(initialReads)
  expect(row.querySelector('.mobile-session-state small')?.textContent).toBe('claude')
  await navigate('Focus')
  expect(f.fullDirectory).toHaveBeenCalledTimes(initialReads + 1)
  expect(button(f.element, '原目录 Agent · 更多操作').closest('li')).toBe(row)
  expect(row.querySelector('.mobile-session-state small')?.textContent).toBe('gemini')
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
  expect(getDeviceWorkface().snapshot().record.conversation).toEqual(f.original)
})
