// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserProfileList, BrowserProfileSummary } from '../src/shared/contracts'
const port = vi.hoisted(() => {
  const listeners = new Set<(list: BrowserProfileList) => void>()
  let list: BrowserProfileList = { revision: 1, sequence: 1, profiles: [], folders: [], views: [] }
  return { listeners, set(value: BrowserProfileList) { list = value; listeners.forEach(listener => listener(list)) },
    get: () => list, readProfiles: vi.fn(async () => list), onProfilesChanged: vi.fn((listener: (list: BrowserProfileList) => void) => { listeners.add(listener); return () => listeners.delete(listener) }),
    readProfileTrash: vi.fn(async () => ({ revision: 2, sequence: 2, entries: [], legacyPendingDeletes: [] })), restoreProfile: vi.fn(), deleteProfile: vi.fn(), bulkUpdateProfiles: vi.fn(async () => [] as unknown[]), saveProfileView: vi.fn(), deleteProfileView: vi.fn(), updateProfile: vi.fn(),
    detectProfileImportSources: vi.fn(async () => []), readProfileProxySignIn: vi.fn(async () => null), listProfileSites: vi.fn(async () => []) }
})
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: port } }))
const state = vi.hoisted(() => ({ tabs: {}, config: { browser: { agentAutomation: true } }, reportError: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state }) }))
import { BROWSER_PROFILE_RESULT_METHODS, ipcResult, unwrapIpcResultMethods } from '../src/shared/ipc-result'
import { browserProfiles } from '../src/renderer/src/lib/browser-profiles'
import { BrowserProfilesSettingsPane } from '../src/renderer/src/components/settings/BrowserProfilesSettingsPane'

const profile = (id: string, label = 'Same name'): BrowserProfileSummary => ({ id, label, revision: `${id}-token`, createdAt: 1, isDefault: id === 'p-a', source: null })
let root: Root, container: HTMLDivElement
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks(); browserProfiles.reset()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  port.set({ revision: 1, sequence: 1, profiles: [profile('p-a'), profile('p-b')], folders: [], views: [] })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); browserProfiles.reset(); vi.useRealTimers() })
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === text)!
async function click(element: HTMLElement) { expect(element).toBeTruthy(); await act(async () => element.click()) }
async function render(active = true) { await act(async () => { root.render(<BrowserProfilesSettingsPane active={active} />) }) }
async function input(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  expect(element).toBeTruthy()
  await act(async () => {
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}


describe('Recycled Profiles in the original Settings workface', () => {
  it('keeps the original selected editor and unsaved proxy query while opening/closing trash; hidden reads unsubscribe', async () => {
    await render()
    await click(container.querySelector<HTMLElement>('[data-resource-row="p-b"]')!)
    const proxyChoice = [...container.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent?.trim() === 'Proxy')!
    await click(proxyChoice)
    const draft = container.querySelector<HTMLInputElement>('input[aria-label="Proxy server"]')!
    await input(draft, 'http://keep-unsaved.example:8080')
    const editor = container.querySelector('article.browser-profile-editor')
    await click(button('Recycled Profiles'))
    expect(port.readProfileTrash).toHaveBeenCalledTimes(1)
    expect(container.querySelector('article.browser-profile-editor')).toBe(editor)
    expect(draft.value).toBe('http://keep-unsaved.example:8080')
    await click(button('All Profiles'))
    expect(container.querySelector('article.browser-profile-editor')).toBe(editor)
    expect(draft.value).toBe('http://keep-unsaved.example:8080')
    expect(port.updateProfile).not.toHaveBeenCalled()
    const reads = port.readProfileTrash.mock.calls.length
    await act(async () => port.set({ ...port.get(), sequence: 3 }))
    expect(port.readProfileTrash).toHaveBeenCalledTimes(reads)
    await render(false)
    expect(port.listeners.size).toBe(0)
  })

  it('restores the exact original archive/token through the product API and keeps the source draft/selection until explicit navigation', async () => {
    const entry = { id: 'archive-exact', revision: 'archive-token', archivedAt: 100, profile: profile('old-profile', 'Retained original'), dataOwner: 'original-partition' as const }
    port.readProfileTrash.mockResolvedValue({ revision: 2, sequence: 2, entries: [entry], legacyPendingDeletes: [] } as never)
    port.restoreProfile.mockResolvedValue({ revision: 3, archiveId: entry.id, profile: { ...entry.profile, revision: 'fresh-token' } })
    await render()
    const editor = container.querySelector('article.browser-profile-editor')
    await click(button('Recycled Profiles')); await click(button('Restore Retained original'))
    expect(port.restoreProfile).toHaveBeenCalledExactlyOnceWith('archive-exact', 'archive-token', undefined)
    expect(container.textContent).toContain('Restored "Retained original"')
    expect(button('Edit restored Profile')).toBeTruthy()
    expect(container.querySelector('article.browser-profile-editor')).toBe(editor)
    expect(port.updateProfile).not.toHaveBeenCalled()
  })

  it('keeps the last confirmed archive and an actionable notice after an IO refusal, without fabricating legacy Restore actions', async () => {
    const entry = { id: 'archive-exact', revision: 'archive-token', archivedAt: 100, profile: profile('old-profile', 'Retained original'), dataOwner: 'original-partition' as const }
    port.readProfileTrash.mockResolvedValue({ revision: 2, sequence: 2, entries: [entry], legacyPendingDeletes: ['legacy-id'] } as never)
    port.restoreProfile.mockRejectedValue(Object.assign(new Error('Original source access is unknown; original data is kept.'), { code: 'BROWSER_PROFILE_DATA_UNAVAILABLE' }))
    await render(); await click(button('Recycled Profiles')); await click(button('Restore Retained original'))
    expect(container.textContent).toContain('Original source access is unknown')
    expect(container.textContent).toContain('Earlier cleanup is unconfirmed')
    expect(container.textContent).toContain('legacy-id')
    expect(button('Retry')).toBeTruthy(); expect(button('Restore Retained original')).toBeTruthy()
    expect([...container.querySelectorAll('button')].some(value => value.textContent?.includes('Restore legacy'))).toBe(false)
    expect(port.get().profiles.map(p => p.id)).toEqual(['p-a', 'p-b'])
  })
  it('keeps an unknown write acknowledgement visible outside its original retired editor and preserves the draft', async () => {
    port.deleteProfile.mockImplementationOnce(async()=>{port.set({...port.get(),sequence:4,revision:3,profiles:[profile('p-a')]});throw Object.assign(new Error('The recycle of Profile p-b could not be confirmed. Original data is kept.'),{code:'BROWSER_PROFILE_WRITE_UNCONFIRMED'})})
    await render();await click(container.querySelector<HTMLElement>('[data-resource-row="p-b"]')!)
    await click([...container.querySelectorAll<HTMLButtonElement>('button')].find(e=>e.textContent?.trim()==='Proxy')!)
    const draft=container.querySelector<HTMLInputElement>('input[aria-label="Proxy server"]')!;await input(draft,'http://unsaved-original.example:8080')
    const editor=container.querySelector('article.browser-profile-editor')
    const trigger=container.querySelector<HTMLButtonElement>('[aria-label="More for Same name"]')!
    await act(async()=>{trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true}));await new Promise(resolve=>setTimeout(resolve,0))})
    const item=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(e=>e.textContent?.trim()==='Recycle Profile…')!
    await click(item)
    const confirm=[...container.querySelectorAll<HTMLButtonElement>('button')].find(e=>e.textContent?.trim()==='Recycle Same name')!
    await click(confirm)
    expect(port.deleteProfile).toHaveBeenCalledWith('p-b',expect.objectContaining({profileId:'p-b'}),'p-b-token')
    expect(container.querySelector('.browser-profiles-settings__service')?.textContent).toContain('could not be confirmed')
    expect(button('Show recycled Profiles')).toBeTruthy()
    expect(container.querySelector('article.browser-profile-editor')).toBe(editor);expect(draft.value).toBe('http://unsaved-original.example:8080')
  })

  it('does not clear a Restore write acknowledgement failure when its automatic snapshot readback succeeds', async () => {
    const entry={id:'archive-exact',revision:'archive-token',archivedAt:100,profile:profile('old-profile','Retained original'),dataOwner:'original-partition' as const}
    let deliverReadback!:()=>void
    const readback=new Promise<any>(resolve=>{deliverReadback=()=>resolve({revision:3,sequence:3,entries:[],legacyPendingDeletes:[]})})
    port.readProfileTrash.mockResolvedValue({revision:3,sequence:3,entries:[],legacyPendingDeletes:[]} as never)
      .mockResolvedValueOnce({revision:2,sequence:2,entries:[entry],legacyPendingDeletes:[]} as never).mockReturnValueOnce(readback)
    port.restoreProfile.mockImplementationOnce(async()=>{port.set({...port.get(),revision:3,sequence:3});throw Object.assign(new Error('The change applied, but saving it was not confirmed.'),{code:'BROWSER_PROFILE_WRITE_UNCONFIRMED'})})
    await render();await click(button('Recycled Profiles'));await click(button('Restore Retained original'))
    expect(container.textContent).toContain('saving it was not confirmed')
    // A real IPC readback can arrive after the failed write acknowledgement is already visible.
    await act(async()=>{deliverReadback();await readback})
    expect(container.textContent).toContain('saving it was not confirmed')
    expect(container.textContent).toContain('No recycled Profiles.')
    await click(button('Retry'));expect(container.textContent).not.toContain('saving it was not confirmed')
    expect(port.restoreProfile).toHaveBeenCalledTimes(1)
  })

})
