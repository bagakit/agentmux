import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { saveMobileHome } from '../src/navigation/home-preference'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const counter = vi.hoisted(() => ({ renders: 0 }))
vi.mock('../src/navigation/MobileAgentRow', async importOriginal => {
  const original = await importOriginal<typeof import('../src/navigation/MobileAgentRow')>()
  return { ...original, MobileAgentRow: (props: Parameters<typeof original.MobileAgentRow>[0]) => {
    counter.renders += 1
    return <original.MobileAgentRow {...props} />
  } }
})
// Canvas painting has separate renderer coverage; routing and the original session stay real.
vi.mock('../src/terminal/MobileTerminalViewer', () => ({ MobileTerminalViewer: ({ agentSessionId }: { agentSessionId: string }) => <div data-terminal-session={agentSessionId} /> }))

const connected = { state: 'connected' as const, message: '原 Host' }
beforeEach(async () => { window.history.replaceState(null, ''); localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()); counter.renders = 0 })
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})

it.each([20, 480])('keeps %i hidden Focus rows stable across conversation actions and restores their original search and DOM', async size => {
  const f = fixture(), owner = getDeviceWorkface(), record = owner.recordIdentity()
  const catalog = { spaces: [], zones: [], tabs: [], regions: [], locations: [], bindings: [],
    agentPresentation: Array.from({ length: size }, (_, index) => ({ agentSessionId: index === 0 ? 'session-original' : `peer-${index}`,
      providerId: 'codex', name: `Agent ${index}`, project: 'Original Project', state: 'working', group: 'working' })) }
  f.client.forwardRpc = vi.fn().mockImplementation(async method => {
    if (method === 'space.ls') return { catalog }
    if (method === 'goal.ls') return { goals: [] }
    if (method === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (method === 'app.snapshot') return { agents: [] }
    throw new Error('Unconfigured observation: ' + method)
  })
  saveMobileHome('focus')
  await owner.updatePresentation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'sessions' },
    { primary: 'focus', showSession: false, showGoalWork: false, identity: null, profile: null })
  const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
  await click(button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Focus'))
  await vi.waitFor(() => expect(view.element.querySelectorAll('.mobile-focus-project .mobile-agent-row__open')).toHaveLength(size))
  const search = view.element.querySelector<HTMLInputElement>('[aria-label="查找"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Agent'); search.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(search.value).toBe('Agent')
  const row = button(view.element, 'Agent 0 · 更多操作').closest('li')!, open = row.querySelector<HTMLButtonElement>('.mobile-agent-row__open')!
  await click(open)
  expect(view.element.querySelector('.mobile-spatial-panel')?.closest('[hidden]')).not.toBeNull()
  const originalEditor = editor(view.element)
  await paste(view.element, '保留原草稿')
  const header = view.element.querySelector<HTMLElement>('.mobile-header')!
  counter.renders = 0
  await click(button(header, '当前对话操作'))
  await click(button(document.body, '关闭面板'))
  await click(button(header, '查看终端'))
  expect(view.element.querySelector('[data-terminal-session]')?.getAttribute('data-terminal-session')).toBe('session-original')
  await click(button(header, '查看对话'))
  expect(counter.renders, 'hidden directory rows should not be reconstructed for unrelated conversation actions').toBe(0)
  expect(editor(view.element)).toBe(originalEditor); expect(originalEditor.textContent).toBe('保留原草稿')
  expect(owner.recordIdentity()).toBe(record); expect(owner.snapshot().record.selectedSessionId).toBe('session-original')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
  await click(button(header, '返回 Focus'))
  expect(view.element.querySelector('[aria-label="查找"]')).toBe(search); expect(search.value).toBe('Agent')
  expect(button(view.element, 'Agent 0 · 更多操作').closest('li')).toBe(row)
  expect(row.querySelector('.mobile-agent-row__open')).toBe(open)
  expect(view.element.querySelectorAll('.mobile-focus-project .mobile-agent-row__open')).toHaveLength(size)
})
