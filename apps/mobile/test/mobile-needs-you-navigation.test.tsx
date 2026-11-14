import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { mobileNeedsYou, mobileNeedsYouElsewhere, mobileNeedsYouReason } from '../src/navigation/needs-you'
import type { MobileAgentPresentation } from '../src/navigation/mobile-agent-status'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { click, fixture, mount, mounted } from './conversation-fixture'
import { openPrimary } from './mobile-root-navigation'

const connected = { state: 'connected' as const, message: '原 Host' }
const now = Date.now()
const row = (id: string, values: Partial<MobileAgentPresentation>): MobileAgentPresentation => ({ agentSessionId: id, name: id, project: '原项目', detail: '', group: 'idle', state: 'done', providerId: 'codex', recap: null, ...values })
const rows = [
  row('session-working', { name: '重构登录', group: 'working', state: 'working', stateMark: 'working', stateLabel: '执行中', lastActivityAt: now - 60_000,
    projectGroup: { key: 'project-a', projectId: 'a', hostId: 'local', name: '登录服务', spaceId: null }, recap: { text: '正在拆分会话层', source: 'native-hook' } }),
  // The display label deliberately disagrees with the typed facts: membership must not read it.
  row('session-waiting', { name: '资料整理', group: 'attention', state: 'waiting', stateMark: 'attention', stateLabel: '执行中',
    projectGroup: { key: 'project-a', projectId: 'a', hostId: 'local', name: '登录服务', spaceId: null } }),
  row('session-error', { name: '迁移脚本', group: 'attention', state: 'error', stateMark: 'error', stateLabel: '已完成',
    projectGroup: { key: 'project-b', projectId: 'b', hostId: 'local', name: '数据平台', spaceId: null } }),
  row('session-idle', { name: '旧实验', group: 'idle', state: 'done', stateMark: 'idle', stateLabel: '需要你回应', lastActivityAt: now + 86_400_000 })
]
function catalog() {
  return { spaces: [], zones: [], tabs: [], regions: [], locations: [], bindings: [], agentPresentation: structuredClone(rows) }
}
beforeEach(async () => { window.history.replaceState(null, ''); localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})

describe('typed needs-you facts', () => {
  it('reads only typed group, state and stateMark, never the display label', () => {
    expect(mobileNeedsYouReason(rows[0])).toBeNull()
    expect(mobileNeedsYouReason(rows[1])).toBe('waiting')
    expect(mobileNeedsYouReason(rows[2])).toBe('error')
    expect(mobileNeedsYouReason(rows[3])).toBeNull()
    expect(mobileNeedsYouReason(row('blocked', { group: 'idle', state: 'blocked' }))).toBe('waiting')
    expect(mobileNeedsYou(rows).map(item => item.agentSessionId)).toEqual(['session-waiting', 'session-error'])
    expect(mobileNeedsYouElsewhere(mobileNeedsYou(rows), 'session-waiting')).toBe(1)
    expect(mobileNeedsYouElsewhere(mobileNeedsYou(rows), null)).toBe(2)
  })
})

describe('the needs-you Focus home', () => {
  it('leads with a strip of waiting Agents that opens the exact Session, then 64px rows without technical identity', async () => {
    const f = fixture(), open = vi.fn()
    f.client.forwardRpc = vi.fn().mockResolvedValue({ catalog: catalog() })
    const needsYou = mobileNeedsYou(rows)
    const view = await mount(<MobileSpatialNavigation client={f.client} connected home="focus" sessions={[]} openSession={open} needsYou={needsYou} />)
    const strip = view.element.querySelector<HTMLElement>('.mobile-needs-you')!
    expect(strip).not.toBeNull()
    expect(strip.compareDocumentPosition(view.element.querySelector('.mobile-focus-project')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const tickets = [...strip.querySelectorAll<HTMLButtonElement>('.mobile-needs-you-ticket')]
    expect(tickets.map(value => value.dataset.reason)).toEqual(['waiting', 'error'])
    expect(tickets.map(value => value.querySelector('strong')?.textContent)).toEqual(['资料整理', '迁移脚本'])
    await click(tickets[1]!)
    expect(open).toHaveBeenLastCalledWith('session-error', expect.objectContaining({ name: '迁移脚本' }))
    // Rows: typed attention marks, readable time, and no raw provider id or display tuple in the visible copy.
    const byName = (name: string) => [...view.element.querySelectorAll<HTMLElement>('.mobile-agent-row')].find(value => value.querySelector('.mobile-row-title strong')?.textContent === name)!
    expect(byName('资料整理').dataset.needsYou).toBe('waiting')
    expect(byName('迁移脚本').dataset.needsYou).toBe('error')
    expect(byName('重构登录').dataset.needsYou).toBeUndefined()
    expect(byName('旧实验').dataset.needsYou).toBeUndefined()
    expect(byName('资料整理').querySelector('.mobile-row-dot')?.getAttribute('data-mark')).toBe('attention')
    expect(byName('重构登录').querySelector('.mobile-row-dot')?.getAttribute('data-mark')).toBe('working')
    expect(byName('重构登录').querySelector('time')?.textContent).toMatch(/^\d{2}:\d{2}$/)
    expect(byName('旧实验').querySelector('time')).toBeNull()
    for (const value of view.element.querySelectorAll<HTMLElement>('.mobile-agent-row__open')) {
      const visible = [...value.querySelectorAll<HTMLElement>('*')].filter(node => !node.closest('.mobile-visually-hidden')).map(node => node.childNodes).flatMap(nodes => [...nodes]).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(' ')
      expect(visible).not.toMatch(/\bcodex\b/)
    }
    await click(byName('重构登录').querySelector<HTMLButtonElement>('.mobile-agent-row__open')!)
    expect(open).toHaveBeenLastCalledWith('session-working', expect.objectContaining({ name: '重构登录' }))
  })

  it('omits the strip when nothing needs the person and while a search is active', async () => {
    const f = fixture()
    f.client.forwardRpc = vi.fn().mockResolvedValue({ catalog: catalog() })
    const view = await mount(<MobileSpatialNavigation client={f.client} connected home="focus" sessions={[]} openSession={vi.fn()} needsYou={[]} />)
    expect(view.element.querySelector('.mobile-needs-you')).toBeNull()
    await view.render(<MobileSpatialNavigation client={f.client} connected home="focus" sessions={[]} openSession={vi.fn()} needsYou={mobileNeedsYou(rows)} />)
    expect(view.element.querySelector('.mobile-needs-you')).not.toBeNull()
  })
})

describe('the five-tab shell with typed counts', () => {
  it('carries the count on back inside a conversation, and on the root shows five tabs with a typed Focus badge', async () => {
    const f = fixture()
    f.client.forwardRpc = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'goal.ls') return { goals: [], unavailable: [] }
      if (method === 'topic.category.ls') return { categories: [], unavailable: [] }
      if (method === 'topic.ls') return { topics: [], unavailable: [] }
      if (method === 'app.snapshot') return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
      return { catalog: catalog() }
    })
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    // The restored conversation is a drilled page: the bar yields and back counts the Agents that need the person.
    const restoredBack = await vi.waitFor(() => { const value = view.element.querySelector<HTMLElement>('.mobile-session-origin .mobile-back-badge'); expect(value).not.toBeNull(); return value! })
    expect(view.element.querySelector('.mobile-navigation')).toBeNull()
    expect(restoredBack.getAttribute('data-count')).toBe('2')
    await openPrimary(view.element, 'Focus')
    await vi.waitFor(() => expect(view.element.querySelector('.mobile-navigation .mobile-tab-badge')).not.toBeNull())
    const tabs = [...view.element.querySelectorAll<HTMLButtonElement>('.mobile-navigation button')]
    expect(tabs.map(value => value.getAttribute('aria-label'))).toEqual(['Goals', 'Topics', 'Mote', 'Focus', 'Space'])
    expect(view.element.querySelector('.mobile-navigation-bar [aria-label="手机设置与连接"]')).toBeNull()
    const focus = tabs[3]!
    expect(focus.querySelector('.mobile-tab-badge')?.getAttribute('data-count')).toBe('2')
    expect(focus.getAttribute('aria-description')).toBe('2 个需要你')
    expect(tabs.filter(value => value !== focus).every(value => !value.querySelector('.mobile-tab-badge'))).toBe(true)
    const ticket = await vi.waitFor(() => { const value = view.element.querySelector<HTMLButtonElement>('.mobile-needs-you-ticket[data-reason="waiting"]'); expect(value).not.toBeNull(); return value! })
    await click(ticket)
    const back = await vi.waitFor(() => { const value = view.element.querySelector<HTMLElement>('.mobile-session-origin'); expect(value).not.toBeNull(); return value! })
    expect(view.element.querySelector('.mobile-navigation')).toBeNull()
    expect(back.querySelector('.mobile-back-badge')?.getAttribute('data-count')).toBe('1')
    expect(back.getAttribute('aria-description')).toBe('另有 1 个需要你')
    expect(f.submit).not.toHaveBeenCalled()
  })
})

describe('gestures in the real shell', () => {
  function touch(type: string, x: number, y: number, t: number) {
    const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { touches: unknown[]; changedTouches: unknown[] }
    const point = { clientX: x, clientY: y }
    Object.defineProperty(event, 'timeStamp', { value: t })
    event.touches = type === 'touchend' ? [] : [point]; event.changedTouches = [point]
    return event
  }
  it('a left-edge swipe leaves the open conversation the same way the back button does, and does nothing at the top level', async () => {
    const f = fixture()
    f.sessions.set('session-waiting', { ...f.sessions.get('peer')!, agentSessionId: 'session-waiting' })
    f.client.forwardRpc = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'topic.category.ls') return { categories: [], unavailable: [] }
      if (method === 'goal.ls') return { goals: [] }
      if (method === 'app.snapshot') return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
      return { catalog: catalog() }
    })
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    await openPrimary(view.element, 'Focus')
    const main = view.element.querySelector<HTMLElement>('.mobile-main')!
    const swipe = async () => act(async () => {
      main.dispatchEvent(touch('touchstart', 6, 400, 0)); main.dispatchEvent(touch('touchmove', 60, 402, 60))
      main.dispatchEvent(touch('touchmove', 150, 404, 160)); main.dispatchEvent(touch('touchend', 150, 404, 200))
    })
    // At the top level there is nothing behind, so the gesture is off: it neither changes the page
    // nor takes the touch from a horizontal scroller that starts at the edge.
    const edgePan = touch('touchmove', 60, 402, 60)
    await act(async () => { main.dispatchEvent(touch('touchstart', 6, 400, 0)); main.dispatchEvent(edgePan); main.dispatchEvent(touch('touchend', 60, 402, 90)) })
    expect(edgePan.defaultPrevented).toBe(false)
    expect(main.dataset.edgeBack).toBeUndefined()
    await swipe()
    expect(view.element.querySelector('[data-workface="focus"]')?.getAttribute('aria-current')).toBe('page')
    const ticket = await vi.waitFor(() => { const value = view.element.querySelector<HTMLButtonElement>('.mobile-needs-you-ticket[data-reason="waiting"]'); expect(value).not.toBeNull(); return value! })
    await click(ticket)
    await vi.waitFor(() => expect(view.element.querySelector('.mobile-session-origin')).not.toBeNull())
    expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-waiting')
    await swipe()
    await vi.waitFor(() => expect(view.element.querySelector('.mobile-session-origin')).toBeNull())
    expect(view.element.querySelector('[data-workface="focus"]')?.getAttribute('aria-current')).toBe('page')
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  })
})

describe('the phone row state words', () => {
  it('come from the typed mark and state, never from the shared display label', async () => {
    const { mobileAgentStateLabel } = await import('../src/navigation/mobile-agent-status')
    const base = row('a', { stateLabel: 'Activity not confirmed' })
    expect(mobileAgentStateLabel({ ...base, stateMark: 'working', state: 'working' })).toBe('执行中')
    expect(mobileAgentStateLabel({ ...base, stateMark: 'unknown', state: 'running' })).toBe('状态未确认')
    expect(mobileAgentStateLabel({ ...base, stateMark: 'results', state: 'done' })).toBe('有新结果')
    expect(mobileAgentStateLabel({ ...base, stateMark: 'idle', state: 'done' })).toBe('已完成')
    expect(mobileAgentStateLabel({ ...base, stateMark: 'attention', state: 'waiting' })).toBe('等待输入')
    expect(mobileAgentStateLabel({ ...base, stateMark: 'error', state: 'error' })).toBe('出错')
    expect(mobileAgentStateLabel({ ...base, stateMark: 'interrupted', state: 'exited' })).toBe('已中断')
    expect(mobileAgentStateLabel(undefined)).toBe('状态未确认')
  })
})
