// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserProfileList, BrowserProfileSummary } from '../src/shared/contracts'

const port = vi.hoisted(() => {
  const listeners = new Set<(list: BrowserProfileList) => void>()
  return {
    listeners,
    readProfiles: vi.fn<() => Promise<BrowserProfileList>>(),
    onProfilesChanged: vi.fn((listener: (list: BrowserProfileList) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
    push(list: BrowserProfileList) { for (const listener of listeners) listener(list) }
  }
})
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: {
  readProfiles: port.readProfiles, onProfilesChanged: port.onProfilesChanged,
  createProfile: vi.fn(), deleteProfile: vi.fn(), switchProfile: vi.fn(), detectProfileImportSources: vi.fn(), importProfile: vi.fn()
} } }))

import { createBrowserProfilesStore } from '../src/renderer/src/lib/browser-profiles'
import { BrowserProfilesPanel } from '../src/renderer/src/components/BrowserProfilesPanel'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'

const personal: BrowserProfileSummary = { revision: 'personal-token', id: 'p-personal', label: 'Personal', createdAt: 1, isDefault: true, source: null }
const client: BrowserProfileSummary = { revision: 'client-token', id: 'p-client', label: 'Northwind client', createdAt: 2, isDefault: false, source: null }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('one Profile list from Main', () => {
  beforeEach(() => { port.readProfiles.mockReset(); port.onProfilesChanged.mockClear(); port.listeners.clear() })

  it('reads once for many consumers and applies pushes in revision order', async () => {
    port.readProfiles.mockResolvedValue({ revision: 3, sequence: 3, folders: [], profiles: [personal] })
    const store = createBrowserProfilesStore(port)
    const a = vi.fn(), b = vi.fn()
    const stopA = store.subscribe(a), stopB = store.subscribe(b)
    await act(async () => {})
    expect(port.readProfiles).toHaveBeenCalledTimes(1)
    expect(port.onProfilesChanged).toHaveBeenCalledTimes(1)
    expect(store.get()).toMatchObject({ revision: 3, sequence: 3, folders: [], profiles: [personal], error: null })

    port.push({ revision: 4, sequence: 4, folders: [], profiles: [personal, client] })
    expect(store.get().profiles).toEqual([personal, client])
    port.push({ revision: 2, sequence: 2, folders: [], profiles: [] })
    expect(store.get()).toMatchObject({ revision: 4, sequence: 4, folders: [], profiles: [personal, client] })
    expect(a).toHaveBeenCalled(); expect(b).toHaveBeenCalled()
    stopA(); stopB()
    expect(port.listeners.size).toBe(0)
  })

  it('orders activity pushes by sequence even when their configuration collection revision stays unchanged', async () => {
    port.readProfiles.mockResolvedValue({ revision: 3, sequence: 7, folders: [], profiles: [personal] })
    const store = createBrowserProfilesStore(port), stop = store.subscribe(() => {})
    await act(async () => {})
    port.push({ revision: 3, sequence: 8, folders: [], profiles: [{ ...personal, activity: { observedRunMs: 1200, lastUsedAt: 100, observedAt: 100, state: 'running', history: 'partial', interruptions: 0 } }] })
    expect(store.get()).toMatchObject({ revision: 3, sequence: 8, profiles: [{ activity: { observedRunMs: 1200 } }] })
    port.push({ revision: 4, sequence: 6, folders: [], profiles: [] })
    expect(store.get().profiles).toHaveLength(1)
    expect(store.get().sequence).toBe(8)
    stop()
  })

  it('concurrent retries share one Main read, and a later subscriber reads again after everyone left', async () => {
    const slow = deferred<BrowserProfileList>()
    port.readProfiles.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ revision: 9, sequence: 9, folders: [], profiles: [personal, client] })
    const store = createBrowserProfilesStore(port)
    const stop = store.subscribe(() => {})
    void store.refresh(); void store.refresh()
    expect(port.readProfiles).toHaveBeenCalledTimes(1)
    expect(store.get().reading).toBe(true)
    await act(async () => slow.resolve({ revision: 8, sequence: 8, folders: [], profiles: [personal] }))
    expect(store.get()).toMatchObject({ revision: 8, reading: false })
    stop()
    expect(store.get().profiles, 'the last list stays visible').toEqual([personal])
    const again = store.subscribe(() => {})
    await act(async () => {})
    expect(port.readProfiles).toHaveBeenCalledTimes(2)
    expect(store.get()).toMatchObject({ revision: 9, sequence: 9, folders: [], profiles: [personal, client] })
    again()
  })

  it('a slow first read cannot overwrite a newer pushed list', async () => {
    const slow = deferred<BrowserProfileList>()
    port.readProfiles.mockReturnValue(slow.promise)
    const store = createBrowserProfilesStore(port)
    const stop = store.subscribe(() => {})
    port.push({ revision: 6, sequence: 6, folders: [], profiles: [personal, client] })
    await act(async () => slow.resolve({ revision: 5, sequence: 5, folders: [], profiles: [personal] }))
    expect(store.get()).toMatchObject({ revision: 6, sequence: 6, folders: [], profiles: [personal, client] })
    stop()
  })

  it('keeps the last list visible when a later read fails, and recovers on refresh', async () => {
    port.readProfiles.mockResolvedValueOnce({ revision: 1, sequence: 1, folders: [], profiles: [personal] }).mockRejectedValueOnce(new Error('Profile metadata unavailable: EACCES'))
      .mockResolvedValueOnce({ revision: 2, sequence: 2, folders: [], profiles: [personal, client] })
    const store = createBrowserProfilesStore(port)
    const stop = store.subscribe(() => {})
    await act(async () => {})
    await act(async () => { await store.refresh() })
    expect(store.get()).toMatchObject({ profiles: [personal], error: expect.stringContaining('EACCES') })
    await act(async () => { await store.refresh() })
    expect(store.get()).toMatchObject({ revision: 2, error: null })
    stop()
  })
})

describe('Browser tools panel renders the shared list', () => {
  let root: Root, container: HTMLDivElement
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    port.readProfiles.mockReset(); port.listeners.clear()
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

  it('two panels show a Profile created elsewhere without reading again, and link to Settings', async () => {
    const open = vi.fn()
    port.readProfiles.mockResolvedValue({ revision: 1, sequence: 1, folders: [], profiles: [personal] })
    await act(async () => root.render(<SettingsNavigation.Provider value={{ open } as never}><BrowserProfilesPanel /><BrowserProfilesPanel /></SettingsNavigation.Provider>))
    expect(container.querySelectorAll('.browser-profiles__marks li')).toHaveLength(2)
    await act(async () => port.push({ revision: 2, sequence: 2, folders: [], profiles: [personal, client] }))
    expect(container.querySelectorAll('.browser-profiles__marks li')).toHaveLength(4)
    expect(port.readProfiles).toHaveBeenCalledTimes(1)
    await act(async () => container.querySelector<HTMLButtonElement>('.browser-profiles__manage')!.click())
    expect(open).toHaveBeenCalledWith('browser-profiles')
  })
})
