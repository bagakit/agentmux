import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const sid = 'session-original', connected = { state: 'connected' as const, message: '原 Host' }
const catalog = { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [
  { agentSessionId: sid, name: '原会话', project: '原项目', group: 'working', state: 'working', providerId: 'codex', detail: '原工作', recap: null },
  { agentSessionId: 'other', name: '另一个原 Agent', project: '原项目', group: 'working', state: 'working', providerId: 'codex', detail: '原工作', recap: null }
] }
const platform = createBrowserPlatform()
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })

async function setup(focusComposer: () => boolean) {
  const f = fixture(), owner = getDeviceWorkface()
  await owner.updatePresentation({ selectedSessionId: sid, hostUrl: '', panel: 'conversation' }, { primary: 'focus', showSession: true, showGoalWork: false, identity: { name: '原会话', project: '原项目' }, profile: null })
  f.client.forwardRpc = vi.fn(async (method: string) => {
    if (method === 'goal.ls') return { goals: [], unavailable: [] }
    if (method === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (method === 'topic.ls') return { topics: [], unavailable: [] }
    if (method === 'app.snapshot') return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
    return { catalog }
  }) as any
  const surface = (client = f.client) => <MobileApp client={client} connection={connected} platform={platform} native focusComposer={focusComposer} />
  const view = await mount(surface()), originalEditor = editor(view.element)
  await paste(view.element, '原始未发送草稿')
  await click(button(view.element, '当前对话操作'))
  expect(document.querySelector('[role="dialog"] [aria-label="撰写消息"]')).not.toBeNull()
  return { f, owner, surface, view, originalEditor }
}

it.each([true, false])('menu compose closes the original dialog and preserves draft and Session when focus returns %s', async succeeds => {
  const focus = vi.fn(() => { expect(document.querySelector('[role="dialog"] [aria-label="撰写消息"]')).toBeNull(); if (succeeds) document.querySelector<HTMLElement>('.mobile-conversation [contenteditable="true"]')!.focus(); return succeeds })
  const { f, owner, view, originalEditor } = await setup(focus)
  await click(document.querySelector('[role="dialog"] [aria-label="撰写消息"]')!)
  await vi.waitFor(() => expect(focus).toHaveBeenCalledTimes(1))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(editor(view.element)).toBe(originalEditor); expect(originalEditor.textContent).toContain('原始未发送草稿')
  if (succeeds) expect(document.activeElement).toBe(originalEditor)
  expect(owner.snapshot().record.selectedSessionId).toBe(sid); expect(f.client.agentSession(sid).run.runId).toBe('run-original')
  if (!succeeds) expect(view.element.textContent).toContain('输入区暂时未准备好。原草稿保留。')
  expect(f.submit).not.toHaveBeenCalled()
})

it('does not focus a different client when the original dialog closes during a batched owner change', async () => {
  const focus = vi.fn(() => true), { f, surface, view, originalEditor } = await setup(focus), second = fixture()
  const action = document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="撰写消息"]')!
  await act(async () => { action.click(); await view.render(surface(second.client)) })
  expect(focus).not.toHaveBeenCalled()
  expect(view.element.textContent).toContain('已切换工作面，原聚焦操作未执行；草稿保留。')
  expect(editor(view.element)).toBe(originalEditor); expect(originalEditor.textContent).toContain('原始未发送草稿')
  expect(f.submit).not.toHaveBeenCalled(); expect(second.submit).not.toHaveBeenCalled()
})

it('does not focus a hidden conversation when its workface changes as the original dialog closes', async () => {
  const focus = vi.fn(() => true), { f, view, originalEditor } = await setup(focus)
  const action = document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="撰写消息"]')!
  const nav = button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Focus')
  await act(async () => { action.click(); nav.click() })
  expect(focus).not.toHaveBeenCalled()
  expect(view.element.textContent).toContain('已切换工作面，原聚焦操作未执行；草稿保留。')
  expect(originalEditor.textContent).toContain('原始未发送草稿'); expect(f.submit).not.toHaveBeenCalled()
})

it('does not focus a different Session when the original dialog closes in the same batch as a Session change', async () => {
  const focus = vi.fn(() => true), { f, owner, view } = await setup(focus)
  await click(document.querySelector('[role="dialog"] [aria-label="关闭面板"]')!)
  await click(button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Focus'))
  await vi.waitFor(() => expect(view.element.textContent).toContain('另一个原 Agent'))
  const originalRow = [...view.element.querySelectorAll<HTMLButtonElement>('.mobile-spatial-panel button')].find(value => value.textContent?.includes('原会话'))!
  expect(originalRow).toBeDefined(); await click(originalRow)
  await click(button(view.element, '当前对话操作'))
  const action = document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="撰写消息"]')!
  const other = [...view.element.querySelectorAll<HTMLButtonElement>('.mobile-spatial-panel button')].find(value => value.textContent?.includes('另一个原 Agent'))!
  expect(other).toBeDefined()
  await act(async () => { action.click(); other.click() })
  expect(focus).not.toHaveBeenCalled()
  expect(view.element.textContent).toContain('已切换工作面，原聚焦操作未执行；草稿保留。')
  expect(owner.snapshot().record.selectedSessionId).toBe('other')
  await click(button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Focus'))
  await click(originalRow)
  await vi.waitFor(() => expect(editor(view.element).textContent).toContain('原始未发送草稿'))
  expect(owner.snapshot().record.selectedSessionId).toBe(sid); expect(f.submit).not.toHaveBeenCalled()
})
