import { act } from 'react'
import { ClientUiProvider } from '@agentmux/client-ui'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { MobileMessageTools } from '../src/conversation/MobileMessageTools'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, editor, fixture, mount, mounted, paste } from './conversation-fixture'

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
})

it('opens original Provider Commands directly from the collapsed composer and inserts without submitting', async () => {
  const f = fixture()
  const view = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original"
    connection={{ state: 'connected', message: '原 Host' }} platform={createBrowserPlatform()} />)
  await paste(view.element, '原草稿与依据 ')
  const originalEditor = editor(view.element)
  expect(view.element.querySelector('.composer-tools')?.getAttribute('data-mode')).toBe('collapsed')
  await click(button(view.element, 'Choose a command'))
  const input = document.querySelector<HTMLInputElement>('input[aria-label="查找命令"]')!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'compact')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const choices = [...document.querySelectorAll<HTMLButtonElement>('.mobile-command-menu [role="menuitem"]')]
  expect(choices.length).toBeGreaterThan(0)
  const originalCommand = choices[0]!.querySelector('strong')!.textContent!
  await click(choices[0]!)
  expect(editor(view.element)).toBe(originalEditor)
  expect(originalEditor.textContent).toContain('原草稿与依据')
  expect(originalEditor.textContent).toContain(originalCommand)
  expect(document.querySelector('.mobile-command-menu')).toBeNull()
  expect(f.submit).not.toHaveBeenCalled()
})

it('keeps the direct entry when discovery has no declared commands, with a closable explanation', async () => {
  const select = vi.fn(), refresh = vi.fn()
  const view = await mount(<ClientUiProvider platform={createBrowserPlatform()}><MobileMessageTools commands={[]} onCommand={select} refresh={refresh} /></ClientUiProvider>)
  const trigger = button(view.element, 'Choose a command')
  await click(trigger)
  expect(document.querySelector('.mobile-command-menu')?.textContent).toContain('当前会话尚未列出命令')
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('.mobile-command-menu')).toBeNull()
  expect(select).not.toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
})

const prompts = [
  { id: 'shared', value: { keyword: 'compact', label: '整理依据', body: '原提示词正文\n保留 $TOKEN 与引用。' } },
  { id: 'codex', value: { keyword: 'review', label: '原 Provider 专用', body: '检查原修改', providerId: 'codex' } },
  { id: 'claude', value: { keyword: 'private', label: '另一 Provider 专用', body: '不能串入', providerId: 'claude' } }
]
const promptPage = (items = prompts) => ({ operation: 'settings.resource.list' as const, resource: 'prompts' as const, partial: true as const, items })
const menu = () => document.querySelector<HTMLElement>('.mobile-command-menu')!
async function customView() {
  const f = fixture(), rpc = vi.fn().mockResolvedValue(promptPage())
  Object.assign(f.client, { forwardRpc: rpc })
  const props = { client: f.client, agentSessionId: 'session-original', connection: { state: 'connected' as const, message: '原 Host' }, platform: createBrowserPlatform() }
  const view = await mount(<MobileConversationSurface {...props} />)
  return { ...f, rpc, props, ...view }
}
it('reads original custom Prompts on demand, distinguishes native collisions and inserts the semantic body without sending', async () => {
  const view = await customView()
  expect(view.rpc).not.toHaveBeenCalled()
  await paste(view.element, '原草稿 ')
  const original = editor(view.element)
  await click(button(view.element, 'Choose a command'))
  expect(view.rpc).toHaveBeenCalledWith('settings.prompts.ls', {}, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  expect(menu().textContent).toContain('Shortcuts'); expect(menu().querySelector('[role=group][aria-label="Agent commands"]')).not.toBeNull()
  expect(menu().textContent).toContain('原 Provider 专用'); expect(menu().textContent).not.toContain('另一 Provider 专用')
  expect([...menu().querySelectorAll('[role=menuitem]')].filter(node => node.textContent?.includes('compact')).length).toBeGreaterThanOrEqual(2)
  await click([...menu().querySelectorAll<HTMLButtonElement>('button[role=menuitem]')].find(node => node.textContent?.includes('整理依据'))!)
  expect(editor(view.element)).toBe(original)
  expect(original.textContent).toContain('原草稿')
  expect(original.querySelector('[data-tool-reference]')?.getAttribute('title')).toBe('Expand prompt: 原提示词正文\n保留 $TOKEN 与引用。')
  expect(view.submit).not.toHaveBeenCalled()
})
it('retains native commands, the original editor and previous same-scope prompts on read failure; retry can discover an empty original library', async () => {
  const view = await customView()
  await paste(view.element, '保留这份草稿')
  await click(button(view.element, 'Choose a command'))
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  view.rpc.mockRejectedValueOnce(new Error('原配置读取失败'))
  await click(button(view.element, 'Choose a command'))
  expect(menu().textContent).toContain('原配置读取失败')
  expect(menu().textContent).toContain('整理依据')
  expect(menu().querySelector('[role=group][aria-label="Agent commands"]')).not.toBeNull()
  view.rpc.mockResolvedValueOnce(promptPage([]))
  await click(button(menu(), '重试读取 Commands'))
  expect(menu().textContent).not.toContain('整理依据')
  expect(menu().textContent).not.toContain('原配置读取失败')
  expect(editor(view.element).textContent).toContain('保留这份草稿')
  expect(view.submit).not.toHaveBeenCalled()
})
it('does not let a late original connection read populate another Session or client', async () => {
  const view = await customView(), late = deferred<ReturnType<typeof promptPage>>()
  view.rpc.mockReturnValueOnce(late.promise)
  await click(button(view.element, 'Choose a command'))
  const next = fixture(), fresh = vi.fn().mockResolvedValue(promptPage([{ id: 'fresh', value: { keyword: 'fresh', label: '新连接快捷', body: '新连接正文' } }]))
  Object.assign(next.client, { forwardRpc: fresh })
  await view.render(<MobileConversationSurface {...view.props} client={next.client} agentSessionId="other" />)
  await click(button(view.element, 'Choose a command'))
  expect(menu().textContent).toContain('新连接快捷')
  await act(async () => late.resolve(promptPage()))
  expect(menu().textContent).toContain('新连接快捷')
  expect(menu().textContent).not.toContain('整理依据')
  expect(menu().querySelector('[role=group][aria-label="Agent commands"]')).not.toBeNull()
  expect(next.submit).not.toHaveBeenCalled(); expect(view.submit).not.toHaveBeenCalled()
})

it('reads prompt keywords for a real focused editor and selects a bare word with the same semantic body', async () => {
  const view = await customView(), original = editor(view.element)
  await act(async () => original.focus())
  expect(view.rpc).toHaveBeenCalledTimes(1)
  await paste(view.element, 'review')
  const option = [...document.querySelectorAll<HTMLButtonElement>('.composer-completion-popover [role=option]')]
    .find(item => item.textContent?.includes('review'))
  expect(option, 'Actual bare-word candidate from the original Settings read').toBeDefined()
  await click(option!)
  expect(editor(view.element)).toBe(original)
  expect(original.querySelector('[data-tool-reference]')?.getAttribute('title')).toBe('Expand prompt: 检查原修改')
  expect(view.submit).not.toHaveBeenCalled()
})
