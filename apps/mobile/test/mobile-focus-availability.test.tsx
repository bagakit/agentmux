import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { MobileApp } from '../src/MobileApp'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { createBrowserPlatform } from '../src/platform/browser'
import { saveMobileHome } from '../src/navigation/home-preference'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, fixture, mount, mounted, session } from './conversation-fixture'
import { openPrimary } from './mobile-root-navigation'

type Row = NonNullable<AgentMuxSpaceCatalog['agentPresentation']>[number]
const row = (name = '原目录 Agent'): Row => ({ agentSessionId: 'peer', name, project: '原项目', providerId: 'claude',
  state: 'done', group: 'results', recap: null, projectGroup: { key: 'original-project', projectId: 'project-original', hostId: 'host-original', name: '原项目', spaceId: null } })
const catalog = (rows?: Row[]): AgentMuxSpaceCatalog => ({ spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [],
  ...(rows === undefined ? {} : { agentPresentation: rows }) })
const unavailable = { code: 'ORIGINAL_PRESENTATION_UNAVAILABLE', message: 'Original presentation did not arrive.', recovery: 'Reread the original source.' }
function source(initial?: Row[]) {
  const f = fixture()
  f.sessions.set('peer', { ...session('peer'), providerId: 'claude' })
  let read: () => unknown = () => ({ catalog: catalog(initial), presentation: { region: null, tab: null, unavailable: [unavailable] } })
  const rpc = vi.fn(async (method: string) => {
    if (method === 'space.ls') return await read()
    if (method === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (method === 'goal.ls') return { goals: [] }
    return { agents: [], topics: [], categories: [], unavailable: [] }
  })
  f.client.forwardRpc = rpc as never
  const ensure = vi.fn(); f.client.ensureAgentContinuity = ensure
  return { ...f, rpc, ensure, setRead(next: () => unknown) { read = next } }
}
function exposed(node: HTMLElement | null) {
  if (!node || node.closest('[hidden], [inert]')) return false
  for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !parent.hasAttribute('open')) return false
  return true
}
const focus = (element: HTMLElement) => element.querySelector<HTMLElement>('.mobile-focus-facet')!
const opens = (element: HTMLElement) => [...focus(element).querySelectorAll<HTMLButtonElement>('.mobile-agent-row__open')]
async function settled(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 5000 }) }
beforeEach(async () => {
  window.history.replaceState(null, ''); localStorage.clear()
  await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  const loaded = (globalThis as any).__mobileFocusAvailabilityLoaded ?? []
  for (const owner of ['MobileSpatialNavigation.tsx', 'MobileDirectoryNotice.tsx', 'MobileApp.tsx']) expect(loaded.some((item: any) => item.file.endsWith(owner)), 'Actual product source evaluated: ' + owner).toBe(true)
  if (process.env.MOBILE_FOCUS_MUTATION) expect(loaded.some((item: any) => item.applied)).toBe(true)
})
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})

it('shows SDK conversations visibly in actual App when Focus is omitted, keeps attention unknown and opens the exact original conversation', async () => {
  const f = source(), owner = getDeviceWorkface()
  saveMobileHome('focus')
  await owner.updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'sessions' })
  await owner.updateConversation({ version: 1, drafts: [['session-original', 'Original retained draft']], attempts: [], responses: [] })
  const original = owner.snapshot().record.conversation
  const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '原 Host' }} platform={createBrowserPlatform()} />)
  await openPrimary(view.element, 'Focus')
  await settled(() => expect(opens(view.element)).toHaveLength(3))
  expect(opens(view.element).every(exposed), 'SDK conversations must be directly visible, not merely present in closed details').toBe(true)
  expect(focus(view.element).textContent).toContain('项目与工作排序尚未确认')
  expect(focus(view.element).textContent).not.toContain('暂无会话')
  expect(view.element.querySelector('[data-workface="focus"] [data-unconfirmed]')?.textContent).toBe('?')
  await click(button(focus(view.element), '目录信息 · 1 项待确认'))
  expect(document.querySelector('.mobile-directory-issues')?.textContent).toContain(unavailable.code)
  expect(document.querySelector('.mobile-directory-issues')?.textContent).toContain(unavailable.recovery)
  await click(button(document.body, '关闭目录信息'))
  const peer = opens(view.element).find(node => node.textContent?.includes('Claude'))!
  await click(peer)
  expect(owner.snapshot().record.selectedSessionId).toBe('peer')
  expect(owner.snapshot().record.conversation.drafts).toEqual(original.drafts)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.ensure).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})

it('treats a confirmed empty Focus array as empty without claiming SDK membership or unknown attention', async () => {
  const f = source([])
  f.setRead(() => ({ catalog: catalog([]) }))
  const publish = vi.fn()
  const view = await mount(<MobileSpatialNavigation home="focus" client={f.client} connected openSession={vi.fn()} onPresentation={publish} />)
  await settled(() => expect(focus(view.element).textContent).toContain('暂无会话'))
  expect(opens(view.element)).toHaveLength(0)
  expect(focus(view.element).querySelector('.mobile-focus-read-status')).toBeNull()
  expect(publish).toHaveBeenLastCalledWith(f.client, [], null)
})

it('retains same-client confirmed rows and DOM through omitted and failed reads, keeps SDK extras separate, then accepts a new empty array', async () => {
  const f = source([row()]), publish = vi.fn(), open = vi.fn()
  f.setRead(() => ({ catalog: catalog([row()]) }))
  const view = await mount(<MobileSpatialNavigation home="focus" client={f.client} connected openSession={open} onPresentation={publish} />)
  await settled(() => expect(opens(view.element)[0]?.textContent).toContain('原目录 Agent'))
  const original = opens(view.element)[0]!
  f.setRead(() => ({ catalog: catalog() }))
  await click(button(focus(view.element), '刷新空间目录'))
  await settled(() => expect(focus(view.element).textContent).toContain('以下是上次读取的内容'))
  expect(opens(view.element)[0]).toBe(original)
  expect(exposed(original)).toBe(true)
  expect(focus(view.element).querySelectorAll('.mobile-focus-available .mobile-agent-row__open')).toHaveLength(2)
  expect(publish).toHaveBeenLastCalledWith(f.client, undefined, expect.stringContaining('未返回'))
  f.setRead(() => { throw Error('Original failed read') })
  await click(button(focus(view.element), '重新读取 Focus'))
  await settled(() => expect(publish).toHaveBeenLastCalledWith(f.client, undefined, 'Original failed read'))
  expect(opens(view.element)[0]).toBe(original)
  await click(original); expect(open).toHaveBeenLastCalledWith('peer', expect.objectContaining({ name: '原目录 Agent' }))
  f.setRead(() => ({ catalog: catalog([]) }))
  await click(button(focus(view.element), '重新读取 Focus'))
  await settled(() => expect(focus(view.element).textContent).toContain('暂无会话'))
  expect(opens(view.element)).toHaveLength(0)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.ensure).not.toHaveBeenCalled()
})

it('retries the same original source locally and recovers confirmed Focus rows without Agent control', async () => {
  const f = source(), publish = vi.fn()
  const view = await mount(<MobileSpatialNavigation home="focus" client={f.client} connected openSession={vi.fn()} onPresentation={publish} />)
  await settled(() => expect(opens(view.element).every(exposed)).toBe(true))
  const before = f.rpc.mock.calls.filter(([method]) => method === 'space.ls').length
  f.setRead(() => ({ catalog: catalog([row('恢复的原 Agent')]) }))
  await click(button(focus(view.element), '重新读取 Focus'))
  await settled(() => expect(opens(view.element)[0]?.textContent).toContain('恢复的原 Agent'))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.ls')).toHaveLength(before + 1)
  expect(publish).toHaveBeenLastCalledWith(f.client, [row('恢复的原 Agent')], null)
  expect(focus(view.element).querySelector('.mobile-focus-read-status')).toBeNull()
  expect(f.submit).not.toHaveBeenCalled(); expect(f.ensure).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})

it('does not borrow the previous client list before a replacement connection can read', async () => {
  const a = source([row('前一来源')]), b = source(), open = vi.fn()
  b.sessions.clear(); b.sessions.set('replacement', session('replacement'))
  const view = await mount(<MobileSpatialNavigation home="focus" client={a.client} connected openSession={open} />)
  await settled(() => expect(opens(view.element)[0]?.textContent).toContain('前一来源'))
  await view.render(<MobileSpatialNavigation home="focus" client={b.client} connected={false} openSession={open} />)
  expect(focus(view.element).textContent).not.toContain('前一来源')
  expect(opens(view.element)).toHaveLength(1)
  await click(opens(view.element)[0]!)
  expect(open).toHaveBeenLastCalledWith('replacement', expect.anything())
  expect(b.rpc).not.toHaveBeenCalled()
})

it('ignores a disposed old-client late read while preserving the current client confirmed list', async () => {
  const a = source(), b = source([row('当前来源')]), open = vi.fn()
  let resolve!: (value: unknown) => void
  a.setRead(() => new Promise(done => { resolve = done }))
  const view = await mount(<MobileSpatialNavigation home="focus" client={a.client} connected openSession={open} />)
  await settled(() => expect(resolve).toBeTypeOf('function'))
  await view.render(<MobileSpatialNavigation home="focus" client={b.client} connected openSession={open} />)
  await settled(() => expect(opens(view.element)[0]?.textContent).toContain('当前来源'))
  await act(async () => resolve({ catalog: catalog([row('旧迟到来源')]) }))
  expect(opens(view.element)[0]?.textContent).toContain('当前来源')
  expect(focus(view.element).textContent).not.toContain('旧迟到来源')
})

it('does not report checking after the original pending read is disposed by disconnect or inactive navigation', async () => {
  const f = source(), open = vi.fn()
  f.setRead(() => new Promise(() => {}))
  const view = await mount(<MobileSpatialNavigation home="focus" client={f.client} connected openSession={open} />)
  await settled(() => expect(focus(view.element).querySelector('.mobile-focus-read-status')?.textContent).toContain('正在核对'))
  await view.render(<MobileSpatialNavigation home="focus" client={f.client} connected={false} openSession={open} />)
  expect(focus(view.element).querySelector('.mobile-focus-read-status')?.textContent).not.toContain('正在核对')
  expect(focus(view.element).textContent?.match(/连接暂不可用/g)).toHaveLength(1)
  await view.render(<MobileSpatialNavigation home="focus" client={f.client} connected visible={false} openSession={open} />)
  expect(focus(view.element).querySelector('.mobile-focus-read-status')?.textContent).not.toContain('正在核对')
})

it('keeps conversation availability unknown when neither SDK nor Focus has confirmed a conversation', async () => {
  const f = source(), publish = vi.fn()
  f.sessions.clear()
  const view = await mount(<MobileSpatialNavigation home="focus" client={f.client} connected openSession={vi.fn()} onPresentation={publish} />)
  await settled(() => expect(publish).toHaveBeenCalled())
  expect(opens(view.element)).toHaveLength(0)
  expect(focus(view.element).querySelector('.mobile-focus-read-status')?.textContent).not.toContain('已有会话仍可打开')
  expect(focus(view.element).textContent).not.toContain('暂无会话')
})
