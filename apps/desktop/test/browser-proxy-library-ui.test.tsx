// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserProxyAsset } from '@agentmux/core/control'
const port = vi.hoisted(() => ({ saveProxy: vi.fn(), confirm: vi.fn(), loseReply: false, deleteProxy: vi.fn(), assignProxy: vi.fn(), flush: vi.fn() }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: { ...port,
  createProfileIdentity: async (input: any) => { const saved = await port.saveProxy(input.edit); (port as any).createdProxy = saved.proxy; if (port.loseReply) throw new Error('Injected lost creation reply'); return { revision: saved.revision, creation: { operationId: input.operationId, receipt: { createdId: saved.proxy.id }, current: { state: 'present' }, durability: 'confirmed' } } },
  inspectProfileCreation: async (operationId: string) => ({ revision: 4, creation: { operationId, receipt: (port as any).createdProxy ? { createdId: (port as any).createdProxy.id } : null, current: { state: 'present' }, durability: 'unconfirmed', confirmation: 'observation' } }),
  confirmProfileCreation: (input: any) => port.confirm(input),
  readProfiles: async () => ({ revision: 4, proxies: [(port as any).createdProxy] })
}, ui: { requestStorageFlush: port.flush } } }))
import { BrowserProfilePendingCreations } from '../src/renderer/src/components/settings/BrowserProfilePendingCreations'
import { BrowserProxyLibrary } from '../src/renderer/src/components/settings/BrowserProxyLibrary'
import { browserProxyDrafts } from '../src/renderer/src/lib/browser-proxy-drafts'
import { DESKTOP_FRAGMENT_KEYS } from '../src/renderer/src/lib/desktop-user-fragments'
const a: BrowserProxyAsset = { id: 'asset-a', revision: 'asset-a-v1', label: 'Work proxy', server: 'http://proxy.example:8080' }
const b: BrowserProxyAsset = { id: 'asset-b', revision: 'asset-b-v1', label: 'Lab proxy', server: 'socks5://lab.example:1080' }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
let root: Root, container: HTMLDivElement
const field = (label: string) => container.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!
async function render(assets = [a, b]) { await act(async () => root.render(createElement('div', null, createElement(BrowserProfilePendingCreations), createElement(BrowserProxyLibrary, { assets, active: true })))) }
async function input(label: string, text: string) { await act(async () => { const element = field(label), prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, text); element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) }) }
async function click(label: string) { expect(button(label), label).toBeDefined(); await act(async () => button(label).click()) }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); vi.resetAllMocks()
  ;(port as any).createdProxy = undefined
  port.loseReply = false
  port.confirm.mockImplementation(async (input: any) => { if (!(port as any).createdProxy) throw new Error('No original receipt observed'); return { revision: 4, creation: { operationId: input.operationId, receipt: { createdId: (port as any).createdProxy.id }, current: { state: 'present' }, durability: 'confirmed', confirmation: 'current-metadata-sync' } } })
  port.flush.mockResolvedValue(undefined)
  port.saveProxy.mockImplementation(async (edit, id) => ({ proxy: { ...edit, id: id ?? 'new-asset', revision: 'saved-v2' }, revision: 4 }))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('original proxy library editor and Desktop draft owner', () => {
  it('saves the exact asset token through the product API and keeps drafts isolated across asset choices and remount', async () => {
    await render(); await input('Saved proxy asset', a.id); await input('Proxy asset notes', 'Unfinished work note')
    await input('Saved proxy asset', b.id); expect(field('Proxy asset notes').value).toBe('')
    await input('Proxy asset notes', 'Lab draft'); await input('Saved proxy asset', a.id)
    expect(field('Proxy asset notes').value).toBe('Unfinished work note')
    await act(async () => root.unmount()); root = createRoot(container); await render(); await input('Saved proxy asset', a.id)
    expect(field('Proxy asset notes').value).toBe('Unfinished work note')
    await click('Save proxy')
    expect(port.saveProxy).toHaveBeenCalledWith({ label: a.label, server: a.server, notes: 'Unfinished work note', bypass: [] }, a.id, a.revision)
    expect(browserProxyDrafts.get(a.id)?.active).toBeUndefined()
    expect(browserProxyDrafts.get(b.id)?.active?.notes).toBe('Lab draft')
  })
  it('uses the original batched writer while typing and checkpoints only when the editing field is left', async () => {
    await render()
    for (const text of ['G', 'Ga', 'Gat', 'Gate', 'Gateway']) await input('Proxy asset name', text)
    expect(browserProxyDrafts.get('new')?.active?.label).toBe('Gateway')
    expect(port.flush).not.toHaveBeenCalled()
    await act(async () => field('Proxy asset name').dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(port.flush).toHaveBeenCalledTimes(1)
  })
  it('keeps later input and uses the original save ACK token for its next explicit update', async () => {
    const hold = deferred<{ proxy: BrowserProxyAsset; revision: number }>(); port.saveProxy.mockReturnValueOnce(hold.promise)
    await render(); await input('Saved proxy asset', a.id); await input('Proxy asset notes', 'Submitted note'); await click('Save proxy')
    await input('Proxy asset notes', 'Later note')
    await act(async () => hold.resolve({ proxy: { ...a, notes: 'Submitted note', revision: 'exact-ack-token' }, revision: 6 }))
    expect(field('Proxy asset notes').value).toBe('Later note')
    await click('Save proxy')
    expect(port.saveProxy.mock.calls[1]).toEqual([{ label: a.label, server: a.server, bypass: [], notes: 'Later note' }, a.id, 'exact-ack-token'])
  })
  it('a late save cannot take over another selected asset or delete its input', async () => {
    const hold = deferred<{ proxy: BrowserProxyAsset; revision: number }>(); port.saveProxy.mockReturnValueOnce(hold.promise)
    await render(); await input('Saved proxy asset', a.id); await input('Proxy asset name', 'Submitted A'); await click('Save proxy')
    await input('Saved proxy asset', b.id); await input('Proxy asset notes', 'Keep B input')
    await act(async () => hold.resolve({ proxy: { ...a, label: 'Submitted A', revision: 'a-v2' }, revision: 4 }))
    expect(field('Saved proxy asset').value).toBe(b.id); expect(field('Proxy asset notes').value).toBe('Keep B input')
    expect(browserProxyDrafts.get(b.id)?.active?.notes).toBe('Keep B input')
  })
  it('removes only the asset version actually shown to the editing user, preserving a newer unseen version', async () => {
    await render(); await input('Saved proxy asset', a.id)
    await render([{ ...a, revision: 'a-newer-unreviewed', server: 'http://newer.example:8181' }, b])
    port.deleteProxy.mockRejectedValueOnce(new Error('The original asset version changed. Draft retained.'))
    await click('Remove unused proxy')
    expect(port.deleteProxy).toHaveBeenCalledWith(a.id, a.revision)
    expect(field('Proxy asset server').value).toBe(a.server)
    expect(container.textContent).toContain('original asset version changed')
  })
  it('keeps sensitive pasted sign-in only in memory, preserves prior disk bytes and leaves secret entry to the original Profile owner', async () => {
    await render(); await input('Proxy asset name', 'New non-secret name'); await input('Proxy asset server', 'ftp://proxy.example:21'); expect(button('Save proxy').disabled).toBe(true); expect(port.saveProxy).not.toHaveBeenCalled(); const before = localStorage.getItem(DESKTOP_FRAGMENT_KEYS.browserProxyLibraryDrafts)
    await input('Proxy asset server', 'http://user:secret-value@proxy.example:8080')
    expect(button('Save proxy').disabled).toBe(true); expect(field('Proxy asset server').value).toContain('secret-value')
    expect(localStorage.getItem(DESKTOP_FRAGMENT_KEYS.browserProxyLibraryDrafts)).toBe(before)
    expect(container.textContent).toContain('has not been saved to disk'); expect(port.saveProxy).not.toHaveBeenCalled()
  })
  it('keeps an original creation undispatched when its pending request checkpoint fails, then retries the same request', async () => {
    await render(); await input('Proxy asset name', 'Saved once'); await input('Proxy asset server', a.server)
    port.flush.mockRejectedValueOnce(new Error('Original pending request save unconfirmed')); await click('Save proxy')
    expect(container.textContent).toContain('has not been dispatched')
    expect(port.saveProxy).not.toHaveBeenCalled()
    const original = JSON.parse(localStorage.getItem(DESKTOP_FRAGMENT_KEYS.browserProfileCreations)!)['browser.profile.proxy.create']
    await click('Save proxy')
    expect(port.saveProxy).toHaveBeenCalledTimes(1)
    expect(field('Saved proxy asset').value).toBe('new-asset')
    expect(original.operationId).toBeTruthy()
  })
  it('keeps the original created identity when saving the client confirmation fails and resolves it without another creation', async () => {
    await render(); await input('Proxy asset name', 'Saved once'); await input('Proxy asset server', a.server)
    port.flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Original client confirmation save unconfirmed'))
    await click('Save proxy')
    expect(port.saveProxy).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('saving its client confirmation is unconfirmed')
    expect(field('Proxy asset name').value).toBe('Saved once')
    expect(JSON.parse(localStorage.getItem(DESKTOP_FRAGMENT_KEYS.browserProfileCreations)!)['browser.profile.proxy.create'].operationId).toBeTruthy()
    await click('Save proxy')
    expect(port.saveProxy).toHaveBeenCalledTimes(1); expect(field('Saved proxy asset').value).toBe('new-asset')
    expect(JSON.parse(localStorage.getItem(DESKTOP_FRAGMENT_KEYS.browserProfileCreations)!)['browser.profile.proxy.create']).toBeTruthy()
    await click('Confirm creation')
    expect(JSON.parse(localStorage.getItem(DESKTOP_FRAGMENT_KEYS.browserProfileCreations)!)).toEqual({})
  })
  it('keeps confirmation unavailable while the original creation is in flight, then enables it after the lost reply is observed', async () => {
    await render(); await input('Proxy asset name', 'Original in-flight proxy'); await input('Proxy asset server', a.server)
    const saving = deferred<{ proxy: BrowserProxyAsset; revision: number }>()
    port.saveProxy.mockImplementationOnce(() => saving.promise); port.loseReply = true
    await click('Save proxy')
    expect(button('Confirm creation').disabled).toBe(true)
    await click('Confirm creation'); expect(port.confirm).not.toHaveBeenCalled()
    await act(async () => saving.resolve({ proxy: { ...a, id: 'in-flight-original' }, revision: 4 }))
    expect(button('Confirm creation').disabled).toBe(false)
    await click('Confirm creation')
    expect(port.saveProxy).toHaveBeenCalledTimes(1); expect(port.confirm).toHaveBeenCalledTimes(1)
  })
  it('keeps the full original request after a read-only unknown recovery and confirms only that request without consuming newer input', async () => {
    await render(); await input('Proxy asset name', 'Original submitted proxy'); await input('Proxy asset server', a.server)
    port.loseReply = true
    await click('Save proxy')
    const original = JSON.parse(localStorage.getItem(DESKTOP_FRAGMENT_KEYS.browserProfileCreations)!)['browser.profile.proxy.create']
    expect(original.edit.label).toBe('Original submitted proxy')
    expect(port.saveProxy).toHaveBeenCalledTimes(1)
    await input('Proxy asset name', 'Keep newer name input')
    await click('Confirm creation')
    expect(port.confirm).toHaveBeenCalledExactlyOnceWith(original)
    expect(port.saveProxy).toHaveBeenCalledTimes(1)
    expect(field('Proxy asset name').value).toBe('Keep newer name input')
    expect(JSON.parse(localStorage.getItem(DESKTOP_FRAGMENT_KEYS.browserProfileCreations)!)).toEqual({})
  })
})
