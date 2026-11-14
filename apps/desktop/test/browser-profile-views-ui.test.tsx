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
    bulkUpdateProfiles: vi.fn(async () => [] as unknown[]), saveProfileView: vi.fn(), deleteProfileView: vi.fn(), updateProfile: vi.fn(),
    detectProfileImportSources: vi.fn(async () => []), readProfileProxySignIn: vi.fn(async () => null), listProfileSites: vi.fn(async () => []) }
})
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: { ...port,
  createProfileIdentity: async (input: any) => { const saved = await port.saveProfileView(input.label, input.query, input.expectedRevision); return { revision: saved.revision, creation: { operationId: input.operationId, receipt: { createdId: saved.view.id }, current: { state: 'present' }, durability: 'confirmed' } } },
  inspectProfileCreation: async () => ({ creation: { receipt: null } })
}, ui: { requestStorageFlush: async () => {} } } }))
const state = vi.hoisted(() => ({ tabs: {}, config: { browser: { agentAutomation: true } }, reportError: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state }) }))
import { BROWSER_PROFILE_RESULT_METHODS, ipcResult, unwrapIpcResultMethods } from '../src/shared/ipc-result'
import { browserProfiles } from '../src/renderer/src/lib/browser-profiles'
import { BrowserProfilesSettingsPane } from '../src/renderer/src/components/settings/BrowserProfilesSettingsPane'

const profile = (id: string, label = 'Same name'): BrowserProfileSummary => ({ id, label, revision: `${id}-token`, createdAt: 1, isDefault: id === 'p-a', source: null })
let root: Root, container: HTMLDivElement
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear(); vi.clearAllMocks(); browserProfiles.reset()
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

describe('Original Profile library query and exact selection consumer', () => {
  it('unwraps confirmed view/bulk receipts and typed refusals through the exact API registry used by preload and the product API', async () => {
    const view = { id: 'v-exact', label: 'Saved query', query: {} }, results = [{ profileId: 'p-a', expectedRevision: 'a-token', outcome: 'failed', code: 'CONFLICT', message: 'Kept original' }]
    const wire = {
      saveProfileView: async () => ipcResult(() => ({ view, revision: 7 })),
      deleteProfileView: async () => ipcResult(() => { throw Object.assign(new Error('Original bytes kept'), { code: 'BROWSER_PROFILE_REVISION_CONFLICT' }) }),
      bulkUpdateProfiles: async () => ipcResult(() => results)
    }
    const gui = unwrapIpcResultMethods<any, any>(wire as never, BROWSER_PROFILE_RESULT_METHODS)
    expect(await gui.saveProfileView()).toEqual({ view, revision: 7 })
    expect(await gui.bulkUpdateProfiles()).toEqual(results)
    await expect(gui.deleteProfileView()).rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT', message: 'Original bytes kept' })
  })

  it('keeps a confirmed save baseline available for immediate query edits and repeated Update without Reload', async () => {
    port.saveProfileView.mockImplementation(async (label, query, expectedRevision, viewId) => {
      expect(expectedRevision).toBe(port.get().revision)
      const view = { id: viewId ?? 'v-created', label, query: structuredClone(query) }, next = { ...port.get(), revision: port.get().revision + 1, sequence: port.get().sequence + 1, views: [view] }
      port.set(next)
      return { view, revision: next.revision }
    })
    await render()
    await input(container.querySelector<HTMLInputElement>('[aria-label="Profile view name"]')!, 'Immediate edits')
    await click(button('Save new'))
    await input(container.querySelector<HTMLSelectElement>('[aria-label="Profile order"]')!, 'name')
    expect(button('Update view')?.disabled).toBe(false)
    await click(button('Update view'))
    expect(port.get().views[0]!.query).toEqual({ sort: 'name' })
    await input(container.querySelector<HTMLSelectElement>('[aria-label="Profile observed status"]')!, 'unknown')
    expect(button('Update view')?.disabled).toBe(false)
    await click(button('Update view'))
    expect(port.get().views[0]!.query).toEqual({ status: 'unknown', sort: 'name' })
    expect(port.saveProfileView.mock.calls.map(call => call[2])).toEqual([1, 2, 3])
  })

  it('keeps a later selected view and later query/name inputs when an earlier Save acknowledgement arrives', async () => {
    const existing = { id: 'v-other', label: 'Other saved view', query: { route: 'system' as const } }
    port.set({ ...port.get(), views: [existing] })
    let finish!: (view: unknown) => void
    port.saveProfileView.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve }))
    await render()
    await input(container.querySelector<HTMLInputElement>('[aria-label="Profile view name"]')!, 'Earlier submitted view')
    await click(button('Save new'))
    await input(container.querySelector<HTMLSelectElement>('[aria-label="Saved Profile view"]')!, existing.id)
    await input(container.querySelector<HTMLSelectElement>('[aria-label="Profile order"]')!, 'recent')
    await input(container.querySelector<HTMLInputElement>('[aria-label="Profile view name"]')!, 'Keep newer view draft')
    const saved = { id: 'v-earlier', label: 'Earlier submitted view', query: {} }
    await act(async () => { port.set({ ...port.get(), revision: 2, sequence: 2, views: [existing, saved] }); finish({ view: saved, revision: 2 }) })
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Saved Profile view"]')!.value).toBe(existing.id)
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Profile order"]')!.value).toBe('recent')
    expect(container.querySelector<HTMLInputElement>('[aria-label="Profile view name"]')!.value).toBe('Keep newer view draft')
  })

  it('keeps the original editor and notes/route drafts while filters, order, selection and pushes change the list', async () => {
    await render()
    await click(container.querySelector<HTMLElement>('.browser-profile-editor__note')!)
    const notes = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Profile notes"]')!
    const note = notes ?? container.querySelector<HTMLTextAreaElement>('textarea')!
    await input(note, 'unsaved original note')
    await click(button('Select Profiles')); await click(button('Select displayed'))
    await act(async () => port.set({ revision: 2, sequence: 2, profiles: [profile('p-c', 'New matching'), profile('p-b'), profile('p-a')], folders: [], views: [] }))
    await input(container.querySelector<HTMLSelectElement>('[aria-label="Profile order"]')!, 'name')
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('unsaved original note')
    expect(container.textContent).toContain('2 selected')
    await click(button('Apply to 2 selected'))
    expect(port.bulkUpdateProfiles).toHaveBeenCalledWith([{ profileId: 'p-a', expectedRevision: 'p-a-token' }, { profileId: 'p-b', expectedRevision: 'p-b-token' }], { kind: 'pin', pinned: true })
    await input(container.querySelector<HTMLInputElement>('[aria-label="Filter profiles"]')!, 'New matching')
    expect(container.textContent).toContain('2 outside this view')
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('unsaved original note')
    expect(port.updateProfile).not.toHaveBeenCalled()
  })

  it('detaches the hidden pane and all its mark subscriptions and stops its relative-time clock, while retaining the draft', async () => {
    vi.useFakeTimers()
    await render()
    expect(port.listeners.size).toBe(1)
    await input(container.querySelector<HTMLSelectElement>('[aria-label="Profile last use filter"]')!, 'week')
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await render(false)
    expect(port.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    // A healthy unrelated Browser consumer keeps its own subscription while Settings is hidden.
    const stopOther = browserProfiles.subscribe(() => {})
    expect(port.listeners.size).toBe(1)
    await render(true)
    expect(port.listeners.size).toBe(1)
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Profile last use filter"]')!.value).toBe('week')
    await render(false)
    expect(port.listeners.size).toBe(1)
    stopOther(); expect(port.listeners.size).toBe(0)
  })

  it('keeps missing exact view scope narrow and shows every failed result rather than replacing the selected identities', async () => {
    port.set({ revision: 1, sequence: 1, profiles: [profile('p-a'), profile('p-b')], folders: [], views: [{ id: 'v-one', label: 'Missing folder', query: { folderId: 'f-missing' } }] })
    port.bulkUpdateProfiles.mockResolvedValueOnce([{ profileId: 'p-a', expectedRevision: 'p-a-token', outcome: 'failed', code: 'BROWSER_PROFILE_REVISION_CONFLICT', message: 'Kept original' }])
    await render(); await click(button('Select Profiles'))
    await click(container.querySelector<HTMLElement>('[data-resource-row="p-a"]')!)
    await input(container.querySelector<HTMLSelectElement>('[aria-label="Saved Profile view"]')!, 'v-one')
    expect(container.querySelectorAll('[data-resource-row]')).toHaveLength(0)
    expect(container.textContent).toContain('no longer available')
    expect(container.textContent).toContain('1 outside this view')
    await click(button('Apply to 1 selected'))
    expect(container.textContent).toContain('0 updated · 1 failed')
    expect(container.textContent).toContain('Kept original')
    expect(container.textContent).toContain('p-a')
  })
})
