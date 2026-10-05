import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { parseConnectionOffer } from '@agentmux/relay/offer'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const STORAGE = 'agentmux-mobile-workface-v1'
const unavailable = { state: 'unavailable' as const, message: '设备未授权；原 Host 与 Run 状态未知。' }
const connected = { state: 'connected' as const, message: '已连接原 Host' }
function clientFixture() {
  const f = fixture()
  f.client.forwardRpc = vi.fn().mockImplementation(async method => {
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [],
      agentPresentation: [{ agentSessionId: 'session-original', name: '原 Agent', project: '原项目', group: 'working', state: 'working', detail: '执行中', providerId: 'codex' }] } }
    if (method === 'app.snapshot') return { agents: [] }
    if (method === 'agent.inspect') return { session: f.client.agentSession('session-original'), displayName: { override: null, availability: 'observed' } }
    throw new Error('Observation unavailable: ' + method)
  })
  return f
}
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})
describe('actual Relay mobile shell and shared conversation caller', () => {
  it('opens the client-owned connection dialog without claiming authentication or replacing original connection records', async () => {
    const overlay = document.createElement('div'); document.body.append(overlay)
    const original = localStorage.getItem(STORAGE)
    const view = await mount(<MobileApp client={null} connection={unavailable} platform={createBrowserPlatform({ overlayContainer: () => overlay })} />)
    expect(view.element.querySelector('.mobile-connect-page')).not.toBeNull()
    expect(view.element.querySelector('.mobile-session-list')).toBeNull()
    expect(view.element.textContent).toContain(unavailable.message)
    await click(button(view.element, '连接详情'))
    expect(overlay.querySelector('[role="dialog"]')).not.toBeNull()
    expect(overlay.textContent).toContain('Agent 与会话由 Mac 管理')
    expect(overlay.querySelector('#mobile-host-address')).toBeNull()
    expect(view.element.querySelector('[data-connection="connected"]')).toBeNull()
    expect(localStorage.getItem(STORAGE)).toBe(original)
    await click(button(overlay, '关闭面板')); expect(overlay.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps the actual composer through five-entry navigation and restores the original saved Session while offline', async () => {
    getDeviceWorkface().updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
    const f = clientFixture(), platform = createBrowserPlatform()
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={platform} />)
    expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
    const originalEditor = editor(view.element)
    await paste(view.element, '切换页面仍保留的草稿')
    await click(button(view.element.querySelector('nav.mobile-navigation')!, 'Space'))
    expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(true)
    expect(editor(view.element)).toBe(originalEditor)
    await click(button(view.element.querySelector('nav.mobile-navigation')!, 'Focus'))
    await click(view.element.querySelector('.mobile-session-list button')!)
    expect(editor(view.element)).toBe(originalEditor); expect(originalEditor.textContent).toBe('切换页面仍保留的草稿')
    await view.render(<MobileApp client={null} connection={unavailable} platform={platform} />)
    expect(originalEditor.textContent).toBe('切换页面仍保留的草稿')
    expect(view.element.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id')).toBe('session-original')
    expect(f.submit).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(STORAGE)!).selectedSessionId).toBe('session-original')
    const second = await mount(<MobileApp client={null} connection={unavailable} platform={platform} />)
    expect(second.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
    expect(second.element.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id')).toBe('session-original')
    expect(editor(second.element).textContent).toBe('切换页面仍保留的草稿')
    expect(second.element.querySelector('.mobile-connect-page')).toBeNull()
  })

  it('retains unreadable original bytes through healthy navigation and replaces them only by the explicit restore action', async () => {
    localStorage.setItem(STORAGE, '{cannot-read-original-reference')
    const view = await mount(<MobileApp client={clientFixture().client} connection={connected} platform={createBrowserPlatform()} />)
    expect(view.element.textContent).toContain('原记录尚未覆盖')
    await click(button(view.element.querySelector('nav.mobile-navigation')!, 'Space'))
    expect(localStorage.getItem(STORAGE)).toBe('{cannot-read-original-reference')
    await click(button(view.element, '用当前工作面替换原记录'))
    expect(JSON.parse(localStorage.getItem(STORAGE)!)).toMatchObject({ ...emptyDeviceWorkface(), selectedSessionId: null, hostUrl: '', panel: 'conversation' })
    expect(view.element.textContent).toContain('已用当前工作面替换')
    expect(view.element.textContent).toContain('Mac 上的原会话保持不变')
  })

  it('uses the current public offer boundary: LAN plaintext is supported, remote plaintext and credential/path/token destinations are rejected', () => {
    const offer = { v: 2 as const, serverId: 'original-host', daemonPublicKeyB64: 'A'.repeat(43) + '=', relay: { endpoint: '192.168.1.20:43123', useTls: false } }
    expect(parseConnectionOffer(offer)).toEqual(offer)
    for (const endpoint of ['public.example:43123', 'user:secret@192.168.1.20', '192.168.1.20/token', '192.168.1.20/?code=secret', '192.168.1.20/#token']) {
      expect(() => parseConnectionOffer({ ...offer, relay: { endpoint, useTls: false } })).toThrow()
    }
  })

  it('preserves malformed original records through a temporarily usable connection and primary navigation', async () => {
    const original = JSON.stringify({ version: 1, selectedSessionId: 42, hostUrl: false, panel: 'lost' })
    localStorage.setItem(STORAGE, original)
    const f = clientFixture(), platform = createBrowserPlatform()
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={platform} />)
    expect(view.element.textContent).toContain('原记录尚未覆盖')
    await click(button(view.element.querySelector('nav.mobile-navigation')!, 'Focus'))
    await click(view.element.querySelector('.mobile-session-list button')!)
    await view.render(<MobileApp client={null} connection={unavailable} platform={platform} />)
    expect(localStorage.getItem(STORAGE)).toBe(original)
    expect(view.element.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id')).toBe('session-original')
    expect(view.element.textContent).toContain('仅临时采用')
  })

  it('never claims durable navigation when device storage writes fail', async () => {
    const original = localStorage.getItem(STORAGE), f = clientFixture()
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('device storage unavailable') })
    await click(view.element.querySelector('.mobile-session-list button')!)
    expect(write).toHaveBeenCalledWith(STORAGE, expect.stringContaining('session-original'))
    expect(view.element.textContent).toContain('仅临时采用')
    expect(localStorage.getItem(STORAGE)).toBe(original)
    expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
  })
})
