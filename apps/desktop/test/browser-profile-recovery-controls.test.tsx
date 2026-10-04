import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrowserProfilesPanel } from '../src/renderer/src/components/BrowserProfilesPanel'

// Data boundary: controlled list/request replies. The complete actual Panel, React effects,
// event handlers, catalog and production error presenter execute; no Main/Native claim here.
const methods = vi.hoisted(() => ({ listProfiles: vi.fn(), createProfile: vi.fn(), deleteProfile: vi.fn(),
  switchProfile: vi.fn(), detectProfileImportSources: vi.fn(), importProfile: vi.fn() }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: methods } }))
const profile = { id: '9e633a7d-bbfa-4f9c-aad7-6d968fa5b581', label: 'Original Profile', createdAt: 3, isDefault: true, source: null }
const unused = { ...profile, id: 'f52c77ea-d5e3-40b1-9721-d6cd89439c49', label: 'Unused', isDefault: false }
let container: HTMLDivElement, root: Root
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function mount(strict = false) {
  const content = <BrowserProfilesPanel browsers={[]} allBrowsers={[]} />
  await act(async () => root.render(strict ? <StrictMode>{content}</StrictMode> : content))
}
function retry() {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => /Retry(?:ing)? Profile connection/.test(button.textContent ?? ''))
  expect(found, 'actual Profile connection Retry is present').toBeDefined()
  return found!
}
async function click(button: HTMLButtonElement) { await act(async () => button.click()) }
function noReplay() {
  for (const name of ['createProfile', 'deleteProfile', 'switchProfile', 'detectProfileImportSources', 'importProfile'] as const)
    expect(methods[name], `${name} must not be replayed by metadata retry`).not.toHaveBeenCalled()
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  for (const method of Object.values(methods)) method.mockReset()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('pending metadata is unknown; original failure becomes readable and stops indefinite loading', async () => {
  const pending = deferred<typeof profile[]>()
  methods.listProfiles.mockReturnValueOnce(pending.promise)
  await mount()
  expect(methods.listProfiles).toHaveBeenCalledExactlyOnceWith()
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading Profiles')
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(container.querySelector<HTMLInputElement>('[aria-label="New Browser Profile name"]')?.disabled).toBe(true)
  await act(async () => pending.reject(new Error("Error invoking remote method 'browser:listProfiles': Error: Profile metadata could not be read: invalid JSON")))
  expect(container.querySelector('[role="alert"]')?.textContent, 'original metadata failure is retained').toContain('Profile metadata could not be read: invalid JSON')
  expect(container.textContent).not.toContain('Error invoking remote method')
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Profiles unavailable')
  expect(container.querySelector('.browser-profiles__loading .spin')).toBeNull()
  expect(retry().disabled).toBe(false)
  noReplay()
})

it('explicit Retry uses the original list once, keeps reason during pending, then consumes repaired original IDs', async () => {
  const pending = deferred<typeof profile[]>()
  methods.listProfiles.mockRejectedValueOnce(new Error('Profile metadata unavailable: EACCES')).mockReturnValueOnce(pending.promise)
  await mount(); await click(retry())
  expect(methods.listProfiles, 'Retry dispatches original listProfiles').toHaveBeenCalledTimes(2)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('EACCES')
  expect(retry().disabled, 'in-flight explicit list cannot duplicate').toBe(true)
  await click(retry())
  expect(methods.listProfiles).toHaveBeenCalledTimes(2)
  await act(async () => pending.resolve([profile]))
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(container.querySelector('[aria-label="Delete Original Profile"]')).not.toBeNull()
  expect(container.querySelector<HTMLInputElement>('[aria-label="New Browser Profile name"]')?.disabled).toBe(false)
  expect(methods.listProfiles).toHaveBeenNthCalledWith(2)
  noReplay()
})

it('repeated failed retry preserves the new actual reason and waits for a further explicit action', async () => {
  methods.listProfiles.mockRejectedValueOnce(new Error('invalid JSON')).mockRejectedValueOnce(new Error('Default Browser Profile must identify a persisted Profile')).mockResolvedValueOnce([profile])
  await mount(); await click(retry())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Default Browser Profile must identify a persisted Profile')
  expect(retry().disabled).toBe(false)
  await act(async () => Promise.resolve())
  expect(methods.listProfiles).toHaveBeenCalledTimes(2)
  expect(container.querySelector('.browser-profiles__catalog')).toBeNull()
  await click(retry())
  expect(methods.listProfiles).toHaveBeenCalledTimes(3)
  expect(container.querySelector('[aria-label="Delete Original Profile"]')).not.toBeNull()
  noReplay()
})

it('a stale StrictMode failure cannot replace the newer successful Profile list', async () => {
  const older = deferred<typeof profile[]>(), newer = deferred<typeof profile[]>()
  methods.listProfiles.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
  await mount(true)
  expect(methods.listProfiles).toHaveBeenCalledTimes(2)
  await act(async () => newer.resolve([profile]))
  await act(async () => older.reject(new Error('stale rejected metadata')))
  expect(container.querySelector('[role="alert"]'), 'stale failure cannot commit').toBeNull()
  expect(container.querySelector('[aria-label="Delete Original Profile"]')).not.toBeNull()
  noReplay()
})

it('a stale StrictMode success cannot replace the newer original Profile identity', async () => {
  const older = deferred<typeof profile[]>(), newer = deferred<typeof profile[]>()
  methods.listProfiles.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
  await mount(true)
  await act(async () => newer.resolve([profile]))
  await act(async () => older.resolve([{ ...profile, id: unused.id, label: 'Stale Profile' }]))
  expect(container.querySelector('[aria-label="Delete Original Profile"]'), 'newer actual Profile identity is retained').not.toBeNull()
  expect(container.querySelector('[aria-label="Delete Stale Profile"]')).toBeNull()
  noReplay()
})

it('healthy cached profiles do not re-list on ordinary rendering and retain original usage guards', async () => {
  methods.listProfiles.mockResolvedValue([profile, unused]); await mount()
  await act(async () => root.render(<BrowserProfilesPanel browsers={[]} allBrowsers={[{ browserId: 'other', profileId: unused.id, title: 'Other Browser', url: 'https://other.test/' }]} />))
  expect(methods.listProfiles).toHaveBeenCalledTimes(1)
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Delete Unused"]')?.disabled).toBe(true)
  expect(container.querySelector('[role="alert"]')).toBeNull()
  noReplay()
})

it('an operation error cannot expose metadata Retry or replay the operation', async () => {
  methods.listProfiles.mockResolvedValue([profile, unused])
  methods.deleteProfile.mockRejectedValue(new Error('Browser Profile is still used by an open Browser'))
  await mount(); await click(container.querySelector<HTMLButtonElement>('[aria-label="Delete Unused"]')!)
  await click(container.querySelector<HTMLButtonElement>('.browser-profiles__delete-confirm button:last-child')!)
  expect(methods.deleteProfile).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Browser Profile is still used')
  expect([...container.querySelectorAll('button')].some(button => button.textContent?.includes('Retry Profile connection'))).toBe(false)
  expect(methods.listProfiles).toHaveBeenCalledTimes(1)
})
