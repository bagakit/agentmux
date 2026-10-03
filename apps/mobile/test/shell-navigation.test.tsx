import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileApp, validatedHostAddress } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const STORAGE = 'agentmux-mobile-workface-v1'
const unavailable = { state: 'unavailable' as const, message: '设备未授权；原 Host 与 Run 状态未知。' }
beforeEach(() => { localStorage.clear(); getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren()
  vi.restoreAllMocks()
})
describe('actual mobile shell and shared conversation caller', () => {
  it('opens its actual client-owned dialog and persists an HTTPS address without claiming authentication or creating Sessions', async () => {
    const overlay = document.createElement('div'); document.body.append(overlay)
    const view = await mount(<MobileApp client={null} connection={unavailable} platform={createBrowserPlatform({ overlayContainer: () => overlay })} />)
    expect(view.element.querySelector('.mobile-welcome')).not.toBeNull()
    expect(view.element.querySelector('.mobile-session-list')).toBeNull()
    expect(view.element.textContent).toContain(unavailable.message)
    expect(view.element.querySelector('.mobile-welcome')?.textContent).toContain('Agent 与会话由 Mac 管理')
    expect(view.element.querySelector('.mobile-welcome')?.textContent).not.toContain('仍在原处工作')
    await click(button(view.element, '查看连接状态'))
    expect(overlay.querySelector('[role="dialog"]')).not.toBeNull()
    const input = overlay.querySelector<HTMLInputElement>('#mobile-host-address')!
    expect(input).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://private-host.local:43123')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(button(overlay, '保存地址'))
    expect(JSON.parse(localStorage.getItem(STORAGE)!)).toEqual({ ...emptyDeviceWorkface(), selectedSessionId: null,
      hostUrl: 'https://private-host.local:43123', panel: 'conversation' })
    expect(view.element.textContent).toContain('连接与设备授权尚未确认')
    expect(view.element.querySelector('[data-connection="connected"]')).toBeNull()
    await click(button(overlay, '关闭面板')); expect(overlay.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps the actual composer mounted across navigation and restores the saved original Session reference while offline', async () => {
    localStorage.setItem(STORAGE, JSON.stringify({ ...emptyDeviceWorkface(), selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' }))
    const f = fixture(), platform = createBrowserPlatform()
    const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '已连接原 Host' }} platform={platform} />)
    const originalEditor = editor(view.element)
    await paste(view.element, '切换页面仍保留的草稿')
    await click(button(view.element.querySelector('nav.mobile-navigation')!, '会话'))
    expect(view.element.querySelector('.mobile-session-panel')?.hasAttribute('hidden')).toBe(false)
    expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(true)
    expect(editor(view.element)).toBe(originalEditor)
    await click(button(view.element.querySelector('nav.mobile-navigation')!, '对话'))
    expect(editor(view.element)).toBe(originalEditor); expect(originalEditor.textContent).toBe('切换页面仍保留的草稿')
    await view.render(<MobileApp client={null} connection={unavailable} platform={platform} />)
    expect(originalEditor.textContent).toBe('切换页面仍保留的草稿')
    expect(view.element.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id')).toBe('session-original')
    expect(button(view.element, 'Send').disabled).toBe(true); expect(f.submit).not.toHaveBeenCalled()
    await act(async () => view.render(<MobileApp client={null} connection={unavailable} platform={platform} />))
    expect(JSON.parse(localStorage.getItem(STORAGE)!).selectedSessionId).toBe('session-original')
    const second = await mount(<MobileApp client={null} connection={unavailable} platform={platform} />)
    expect(second.element.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id')).toBe('session-original')
    expect(second.element.querySelector('.mobile-welcome')).toBeNull()
  })

  it('retains unreadable navigation through actual navigation and replaces it only by the explicit restoration action', async () => {
    localStorage.setItem(STORAGE, '{cannot-read-original-reference')
    const view = await mount(<MobileApp client={null} connection={unavailable} platform={createBrowserPlatform()} />)
    expect(view.element.textContent).toContain('原记录尚未覆盖')
    expect(view.element.textContent).not.toContain('地址保存在这台设备')
    expect(localStorage.getItem(STORAGE)).toBe('{cannot-read-original-reference')
    expect(view.element.querySelector('.mobile-session-list')).toBeNull()
    await click(button(view.element.querySelector('nav.mobile-navigation')!, '会话'))
    expect(view.element.querySelector('.mobile-session-panel')?.hasAttribute('hidden')).toBe(false)
    expect(localStorage.getItem(STORAGE)).toBe('{cannot-read-original-reference')
    await click(button(view.element, '用当前工作面替换原记录'))
    expect(JSON.parse(localStorage.getItem(STORAGE)!)).toEqual({ ...emptyDeviceWorkface(), selectedSessionId: null, hostUrl: '', panel: 'sessions' })
    expect(view.element.textContent).toContain('已用当前工作面替换')
    expect(view.element.textContent).toContain('Mac 上的原会话保持不变')
  })

  it('rejects plaintext, credential-bearing, path or authorization-bearing destinations', () => {
    expect(validatedHostAddress(' https://private-host.local:1234/ ')).toBe('https://private-host.local:1234')
    for (const value of ['http://private-host.local', 'https://user:secret@private-host.local',
      'https://private-host.local/token', 'https://private-host.local/?code=secret', 'https://private-host.local/#token']) {
      expect(() => validatedHostAddress(value)).toThrow('HTTPS 地址')
    }
  })

  it('preserves all original malformed-v1 bytes through navigation and an address adopted only temporarily', async () => {
    const original = JSON.stringify({ version: 1, selectedSessionId: 42, hostUrl: false, panel: 'lost' })
    localStorage.setItem(STORAGE, original)
    const overlay = document.createElement('div'); document.body.append(overlay)
    const view = await mount(<MobileApp client={null} connection={unavailable} platform={createBrowserPlatform({ overlayContainer: () => overlay })} />)
    expect(view.element.textContent).toContain('原记录尚未覆盖')
    await click(button(view.element.querySelector('nav.mobile-navigation')!, '会话'))
    expect(localStorage.getItem(STORAGE)).toBe(original)
    await click(button(view.element.querySelector('nav.mobile-navigation')!, '连接'))
    const input = overlay.querySelector<HTMLInputElement>('#mobile-host-address')!
    expect(input).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://192.168.1.20:43123')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(button(overlay, '临时采用地址'))
    expect(input.value).toBe('https://192.168.1.20:43123')
    expect(localStorage.getItem(STORAGE)).toBe(original)
    expect(view.element.textContent).toContain('地址与导航仅临时采用')
    expect(view.element.textContent).not.toContain('地址已保存在')
  })

  it('never reports a saved address when the actual device storage write fails', async () => {
    const overlay = document.createElement('div'); document.body.append(overlay)
    const view = await mount(<MobileApp client={null} connection={unavailable} platform={createBrowserPlatform({ overlayContainer: () => overlay })} />)
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('device storage unavailable') })
    await click(button(view.element, '查看连接状态'))
    const input = overlay.querySelector<HTMLInputElement>('#mobile-host-address')!
    expect(input).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://192.168.1.20:43123')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(button(overlay, '保存地址'))
    expect(write).toHaveBeenCalledExactlyOnceWith(STORAGE, JSON.stringify({ ...emptyDeviceWorkface(),
      selectedSessionId: null, hostUrl: 'https://192.168.1.20:43123', panel: 'conversation' }))
    expect(input.value).toBe('https://192.168.1.20:43123')
    expect(view.element.textContent).toContain('仅临时采用')
    expect(view.element.textContent).not.toContain('地址已保存在')
    expect(localStorage.getItem(STORAGE)).toBe(JSON.stringify(emptyDeviceWorkface()))
  })
})
