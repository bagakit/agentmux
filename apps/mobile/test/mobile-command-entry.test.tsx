import { act } from 'react'
import { ClientUiProvider } from '@agentmux/client-ui'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { MobileMessageTools } from '../src/conversation/MobileMessageTools'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

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
