import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const counter = vi.hoisted(() => ({ rows: 0 }))
vi.mock('../src/navigation/MobileAgentRow', async original => {
  const actual = await original<typeof import('../src/navigation/MobileAgentRow')>()
  return { ...actual, MobileAgentRow: (props: Parameters<typeof actual.MobileAgentRow>[0]) => { counter.rows += 1; return <actual.MobileAgentRow {...props} /> } }
})
const connected = { state: 'connected' as const, message: '原 Host' }
async function width(value: number) { await act(async () => { vi.stubGlobal('innerWidth', value); window.dispatchEvent(new Event('resize')); await new Promise(resolve => requestAnimationFrame(resolve)) }) }
async function ready(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 4000, interval: 10 }) }
function setup(size = 20, projectHost = 'host-original') {
  const f = fixture(), catalog = { spaces: [], zones: [], tabs: [], regions: [{ tabId: 'original-tab', regionId: 'original-region', kind: 'agent', agentSessionId: 'session-original', execution: { hostId: 'host-original', cwd: f.sessions.get('session-original')!.workspacePath } }], locations: [], bindings: [], agentPresentation: Array.from({ length: size }, (_, index) => ({
    agentSessionId: index === 0 ? 'session-original' : index === 1 ? 'other' : `peer-${index}`, providerId: 'codex', name: `Agent ${index}`, project: 'Original Project',
    projectGroup: { key: 'original-project', hostId: projectHost, name: 'Original Project' }, state: 'working', group: 'working' })) }
  f.client.forwardRpc = vi.fn().mockImplementation(async method => {
    if (method === 'space.ls') return { catalog }
    if (method === 'goal.ls') return { goals: [] }
    if (method === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (method === 'app.snapshot') return { agents: [], projects: [], workspaces: [], unavailable: [] }
    throw new Error('Unconfigured read: ' + method)
  })
  return f
}
async function open(f: ReturnType<typeof setup>) {
  await getDeviceWorkface().updatePresentation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' }, { primary: 'focus', showSession: true, showGoalWork: false, identity: { name: 'Agent 0', project: 'Original Project' }, profile: null })
  const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} restoreWorkface />)
  await ready(() => expect(view.element.textContent).toContain('原生回答'))
  return view
}
beforeEach(async () => { vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 844); localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }; vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('wide sidebar shows the original Focus beside the current Agent without selecting another subject', async () => {
  const f = setup(), view = await open(f), owner = getDeviceWorkface(), before = owner.snapshot().record
  await width(844)
  expect(view.element.querySelector('.mobile-focus-pane')?.hasAttribute('hidden'), 'wide Focus must be visible beside the Agent').toBe(false)
  await ready(() => expect(view.element.querySelectorAll('.mobile-focus-facet .mobile-agent-row__open')).toHaveLength(20))
  expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
  expect(view.element.querySelector('[aria-current="true"]')?.closest('.mobile-agent-row')?.textContent).toContain('Agent 0')
  expect(view.element.querySelector('[aria-current="true"]')?.closest('.mobile-agent-row')?.hasAttribute('data-current')).toBe(true)
  expect(owner.snapshot().record.selectedSessionId).toBe(before.selectedSessionId); expect(owner.snapshot().record.presentation).toEqual(before.presentation)
  await click(button(view.element, 'Agent 1 · 更多操作').closest('li')!.querySelector<HTMLButtonElement>('.mobile-agent-row__open')!)
  await ready(() => expect(owner.snapshot().record.selectedSessionId).toBe('other'))
  expect(owner.snapshot().record.presentation?.primary).toBe('focus')
  await width(390); await click(button(view.element, '返回 Focus'))
  expect(view.element.querySelector('.mobile-focus-pane')?.getAttribute('role')).toBe('main')
  expect(view.element.querySelector('main')?.getAttribute('aria-hidden')).toBe('true')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})

it('wide rotation retains the same editor, selection, draft, reading window and original device record', async () => {
  const f = setup(), owner = getDeviceWorkface(), retained = emptyDeviceWorkface()
  retained.conversation.attempts = [[JSON.stringify(['retained-other', 'original-input']), { operationId: 'original-unknown-input', runId: 'run-original', draft: '原输入未知，不能重播', phase: 'unknown' }]]
  retained.fileUploads = [{ runtimeId: 'original-runtime', phase: 'unknown', identity: { hostId: 'host-original', agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, operationId: 'original-upload', name: 'original.txt', mimeType: 'text/plain', byteLength: 1, revision: 'sha256:' + 'a'.repeat(64) } }]
  await owner.replaceBackup(retained)
  const view = await open(f)
  await paste(view.element, '原输入和光标保持不变')
  const original = editor(view.element), reading = view.element.querySelector<HTMLElement>('.mobile-conversation__reading')!, session = f.sessions.get('session-original')
  original.focus(); const range = document.createRange(); range.selectNodeContents(original); range.collapse(false); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  reading.scrollTop = 143
  await act(async () => {})
  const record = owner.exportBackup(), writes = vi.spyOn(owner, 'updatePresentation')
  for (const size of [844, 390, 768, 1024, 382, 669, 385, 951, 390]) {
    await width(size)
    expect(editor(view.element), 'width must retain the original editor node').toBe(original)
    expect(original.textContent).toBe('原输入和光标保持不变'); expect(view.element.querySelector('.mobile-conversation__reading')).toBe(reading); expect(reading.scrollTop).toBe(143)
    expect(window.getSelection()?.anchorNode?.parentElement?.closest('[contenteditable]')).toBe(original); expect(document.activeElement).toBe(original)
    expect(owner.exportBackup()).toBe(record)
  }
  expect(writes).not.toHaveBeenCalled(); expect(f.sessions.get('session-original')).toBe(session)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})

it.each([20, 480])('wide directory %i uses one catalog owner without stream-scaled reads or width writes', async size => {
  await width(844)
  const f = setup(size), view = await open(f), owner = getDeviceWorkface()
  const reads = () => vi.mocked(f.client.forwardRpc!).mock.calls.filter(([method]) => method === 'space.ls').length
  await width(844)
  await ready(() => expect(view.element.querySelectorAll('.mobile-focus-facet .mobile-agent-row__open')).toHaveLength(size))
  const first = reads()
  expect(first, 'wide directory must pause the duplicate attention catalog reader').toBe(1)
  const writes = vi.spyOn(owner, 'updatePresentation'), history = f.readHistory.mock.calls.length
  counter.rows = 0
  for (let index = 0; index < 8; index++) await act(async () => { f.emit({ type: 'agent-timeline', agentSessionId: 'unrelated-agent', revision: index }) })
  await width(1024); await width(768)
  expect(f.readHistory.mock.calls.length).toBe(history)
  expect(counter.rows, 'unrelated streams and widths in the same layout must not rebuild Focus rows').toBe(0)
  await click(button(view.element, '当前对话操作')); await click(button(document.body, '关闭面板'))
  expect(reads()).toBe(first + 1)
  expect(writes).not.toHaveBeenCalled()
  const sidebar = view.element.querySelector('.mobile-focus-facet')
  await click(button(view.element, '收起会话列表')); expect(view.element.querySelector('.mobile-focus-pane')?.hasAttribute('hidden')).toBe(true)
  await click(button(view.element, '展开会话列表')); expect(view.element.querySelector('.mobile-focus-facet')).toBe(sidebar)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})


it('wide directory retains its cause and exposes one working retry and one global notice entry', async () => {
  await width(844)
  const f = setup(), rpc = f.client.forwardRpc!, fail = { value: true }
  f.client.forwardRpc = vi.fn().mockImplementation((method, input) => { if (method === 'space.ls' && fail.value) throw new Error('original-catalog-transport-failure'); return rpc(method, input) })
  const view = await open(f), original = editor(view.element)
  await ready(() => expect(view.element.querySelector('.mobile-focus-pane .mobile-directory-notice')).not.toBeNull())
  expect(view.element.querySelector('.mobile-attention-notice')).toBeNull()
  expect(view.element.querySelectorAll('.mobile-avatar-notice-outlet')).toHaveLength(1)
  await click(view.element.querySelector<HTMLButtonElement>('.mobile-directory-notice')!)
  expect(document.body.textContent).toContain('original-catalog-transport-failure')
  fail.value = false
  await click(button(document.body, '重新读取目录'))
  await ready(() => expect(view.element.querySelectorAll('.mobile-focus-facet .mobile-agent-row__open')).toHaveLength(20))
  expect(document.body.querySelector('.mobile-directory-issues')).toBeNull()
  expect(editor(view.element)).toBe(original); expect(f.submit).not.toHaveBeenCalled()
})


it('wide current row follows execution Host A when its project lane is displayed on Host B', async () => {
  await width(844)
  const f = setup(20, 'display-host-B'), view = await open(f)
  await ready(() => expect(view.element.querySelectorAll('.mobile-focus-facet .mobile-agent-row__open')).toHaveLength(20))
  expect(view.element.querySelector('.mobile-focus-project h2')?.textContent).toContain('display-host-B')
  const row = button(view.element, 'Agent 0 · 更多操作').closest('li')!
  expect(row.querySelector('.mobile-agent-row__open')?.getAttribute('aria-current'), 'current Agent follows its execution Host, not the display project Host').toBe('true')
  expect(row.hasAttribute('data-current')).toBe(true)
  expect(f.sessions.get('session-original')?.hostId).toBe('host-original')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})
