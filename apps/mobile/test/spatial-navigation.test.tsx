import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted } from './conversation-fixture'
const connection = { state: 'connected' as const, message: '已连接 Mac' }
const catalog = { spaces: [{ spaceId: 'space', kind: 'folder', name: 'Actual Space', hostId: 'host-original', directoryPath: fixturePath("unrelated"), projectId: null }],
  zones: [], tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'workspace', name: 'Original Agent', regionIds: ['region'] }],
  regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: 'session-original', runId: 'run-original', execution: { hostId: 'host-original', cwd: fixturePath("workspace") } }],
  bindings: [{ spaceId: 'space', zoneId: 'zone' }], locations: [{ spaceId: 'space', zoneId: 'zone', workspaceId: 'workspace', displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' }] }
beforeEach(() => { localStorage.clear(); getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })
describe('mobile production workspace navigation', () => {
  it('opens the configured Space through actual bindings, keeps shared conversation mounted and removes history controls', async () => {
    localStorage.setItem('agentmux-mobile-home', 'space')
    const f = fixture(); f.client.forwardRpc = vi.fn().mockImplementation(async (method: string) => method === 'app.snapshot' ? { agents: [] } : method === 'agent.inspect' ? { session: f.client.agentSession('session-original'), displayName: { override: null, availability: 'observed' } } : { catalog })
    const view = await mount(<MobileApp client={f.client} connection={connection} platform={createBrowserPlatform()} />)
    expect(view.element.querySelector('h1')?.textContent).toBe('Space')
    expect(view.element.querySelector('.mobile-connect-page')).toBeNull()
    const space = [...view.element.querySelectorAll<HTMLButtonElement>('.mobile-session-list button')].find(item => item.textContent?.includes('Actual Space'))!
    await click(space)
    await click(view.element.querySelector<HTMLButtonElement>('.mobile-spatial-tab .mobile-session-list button')!)
    expect(view.element.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id')).toBe('session-original')
    expect(view.element.querySelector('.mobile-conversation__window')).toBeNull()
    expect(view.element.querySelector('.conversation-native-thread__source')).toBeNull()
    const input = editor(view.element)
    await view.render(<MobileApp client={null} connection={{ state: 'disconnected', message: 'Connection unavailable' }} platform={createBrowserPlatform()} />)
    expect(editor(view.element)).toBe(input)
    expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
    expect(view.element.querySelector('.mobile-connect-page')).toBeNull()
    await click(button(view.element.querySelector('.mobile-session-toolbar') as HTMLElement, 'Space'))
    expect(editor(view.element)).toBe(input)
    expect(f.disposeHistory).toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('shows authoritative project and Agent name separately from provider and opens the original Mote directly', async () => {
    localStorage.setItem('agentmux-mobile-home', 'focus')
    const f = fixture()
    Object.assign(f.client.agentSession('session-original'), { semanticStatus: { state: 'working' } })
    const originalCatalog = { ...catalog, spaces: [{ ...catalog.spaces[0], kind: 'mote', name: 'Original Mote' }],
      appearance: [{ spaceId: 'space', parts: { kind: 'face', shape: 'soft', palette: 'mint', eyes: 'round', brows: 'soft', mouth: 'smile', accessory: 'tuft' } }] }
    f.client.forwardRpc = vi.fn().mockImplementation(async (method: string, params: any) => method === 'app.snapshot'
      ? { agents: [{ agentSessionId: 'session-original', projectName: 'Original Project' }] }
      : method === 'agent.inspect' ? { session: f.client.agentSession(params.target.agentSessionId), displayName: { override: 'Chosen Agent', availability: 'observed' } }
      : { catalog: originalCatalog })
    const overlay = document.createElement('div'); document.body.append(overlay)
    const view = await mount(<MobileApp client={f.client} connection={connection} platform={createBrowserPlatform({ overlayContainer: () => overlay })} />)
    const row = [...view.element.querySelectorAll<HTMLButtonElement>('.mobile-session-list button')].find(item => item.textContent?.includes('Original Project'))!
    expect(row.textContent).toContain('Chosen Agent')
    expect(row.textContent).toContain('执行中')
    expect(row.textContent).toContain('codex')
    expect(row.textContent).not.toContain(fixturePath("workspace"))
    await click(view.element.querySelector<HTMLButtonElement>('.mobile-navigation button:first-child')!)
    await click(view.element.querySelector<HTMLButtonElement>('.mobile-spatial-panel > .mobile-session-list button')!)
    expect(view.element.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id')).toBe('session-original')
    expect(view.element.querySelector('.mobile-mote-heading strong')?.textContent).toBe('Original Mote')
    expect(view.element.querySelector('.mobile-mote-heading .mote-face')).not.toBeNull()
    const input = editor(view.element)
    await click(button(view.element, '手机设置与连接'))
    expect(overlay.querySelector('.mobile-drawer')).not.toBeNull()
    expect(editor(view.element)).toBe(input)
    await click(button(overlay, '关闭面板'))
    expect(editor(view.element)).toBe(input)
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('does not claim or persist a new home when its preference write fails', async () => {
    localStorage.setItem('agentmux-mobile-home', 'space')
    const f = fixture(); f.client.forwardRpc = vi.fn().mockImplementation(async (method: string) => method === 'app.snapshot' ? { agents: [] } : method === 'agent.inspect' ? { session: f.client.agentSession('session-original'), displayName: { override: null, availability: 'observed' } } : { catalog })
    const overlay = document.createElement('div'); document.body.append(overlay)
    const view = await mount(<MobileApp client={f.client} connection={connection} platform={createBrowserPlatform({ overlayContainer: () => overlay })} />)
    await click(button(view.element, '手机设置与连接'))
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('storage unavailable') })
    await act(async () => { overlay.querySelector<HTMLInputElement>('input[aria-label="Mote"]')!.click() })
    expect(overlay.textContent).toContain('默认主页未保存')
    expect(localStorage.getItem('agentmux-mobile-home')).toBe('space')
    expect(overlay.querySelector<HTMLInputElement>('input[aria-label="Space"]')?.checked).toBe(true)
  })
})
