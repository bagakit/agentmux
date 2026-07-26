import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { StateStorage } from 'zustand/middleware'
import {
  createDebouncedPersistentStorage,
  registerUnloadFlush
} from '../src/renderer/src/lib/persisted-ui-writer.js'

/**
 * The renderer-side debounced layout writer. A layout gesture (dock drag, split-ratio, tab reorder)
 * fires many state changes per second; writing localStorage synchronously on each one is what this
 * coalesces into one trailing write. The flush closes the in-memory window a hard shutdown would lose,
 * and is what the unload handler calls.
 *
 * Mutation intent:
 *  - removing the debounce (writing straight through) fails 'coalesces a burst into a single write'.
 *  - removing the flush (or not calling it on unload) fails the flush / pagehide tests below.
 *  - dropping removeItem's pending-drop fails 'a remove cancels a pending write for that key'.
 */

function recordingStorage() {
  const writes: Array<{ name: string; value: string }> = []
  const removes: string[] = []
  const backing = new Map<string, string>()
  const storage: StateStorage = {
    getItem: (name) => backing.get(name) ?? null,
    setItem: (name, value) => {
      writes.push({ name, value })
      backing.set(name, value)
    },
    removeItem: (name) => {
      removes.push(name)
      backing.delete(name)
    }
  }
  return { storage, writes, removes }
}

describe('createDebouncedPersistentStorage', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reads pass straight through to the base storage', () => {
    const base = recordingStorage()
    base.storage.setItem('k', 'seed')
    const { storage } = createDebouncedPersistentStorage(base.storage, 400)
    expect(storage.getItem('k')).toBe('seed')
  })

  it('coalesces a burst of writes into a single trailing write of the newest value', () => {
    const base = recordingStorage()
    const { storage } = createDebouncedPersistentStorage(base.storage, 400)

    storage.setItem('layout', 'a')
    storage.setItem('layout', 'b')
    storage.setItem('layout', 'c')
    // Nothing lands during the gesture — the whole point of the debounce.
    expect(base.writes).toEqual([])

    vi.advanceTimersByTime(400)
    // Exactly one durable write, carrying the last value, not one per change.
    expect(base.writes).toEqual([{ name: 'layout', value: 'c' }])
  })

  it('flush lands the pending value immediately without waiting for the timer', () => {
    const base = recordingStorage()
    const { storage, flush } = createDebouncedPersistentStorage(base.storage, 400)

    storage.setItem('layout', 'pending')
    expect(base.writes).toEqual([])

    flush()
    expect(base.writes).toEqual([{ name: 'layout', value: 'pending' }])

    // The flush also cancels the timer, so it does not double-write when the timer would have fired.
    vi.advanceTimersByTime(400)
    expect(base.writes).toEqual([{ name: 'layout', value: 'pending' }])
  })

  it('flush is a no-op when nothing is pending', () => {
    const base = recordingStorage()
    const { flush } = createDebouncedPersistentStorage(base.storage, 400)
    flush()
    expect(base.writes).toEqual([])
  })

  it('a remove cancels a pending write for that key and removes from the base', () => {
    const base = recordingStorage()
    const { storage } = createDebouncedPersistentStorage(base.storage, 400)

    storage.setItem('layout', 'stale')
    storage.removeItem('layout')
    vi.advanceTimersByTime(400)

    // The debounced value must not resurrect a key the store just deleted.
    expect(base.writes).toEqual([])
    expect(base.removes).toEqual(['layout'])
  })
})

describe('registerUnloadFlush', () => {
  const listeners = new Map<string, EventListener[]>()
  const originalWindow = globalThis.window

  beforeEach(() => {
    listeners.clear()
    vi.stubGlobal('window', {
      addEventListener: (type: string, handler: EventListener) => {
        listeners.set(type, [...(listeners.get(type) ?? []), handler])
      },
      removeEventListener: (type: string, handler: EventListener) => {
        listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== handler))
      }
    })
  })

  afterEach(() => {
    if (originalWindow === undefined) vi.unstubAllGlobals()
    else vi.stubGlobal('window', originalWindow)
  })

  it('flushes on pagehide — the reliable modern unload signal, including bfcache', () => {
    const flush = vi.fn()
    registerUnloadFlush(flush)
    for (const handler of listeners.get('pagehide') ?? []) handler(new Event('pagehide'))
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('also flushes on beforeunload as a fallback', () => {
    const flush = vi.fn()
    registerUnloadFlush(flush)
    for (const handler of listeners.get('beforeunload') ?? []) handler(new Event('beforeunload'))
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('the disposer removes every listener it added', () => {
    const flush = vi.fn()
    const dispose = registerUnloadFlush(flush)
    dispose()
    for (const handler of listeners.get('pagehide') ?? []) handler(new Event('pagehide'))
    for (const handler of listeners.get('beforeunload') ?? []) handler(new Event('beforeunload'))
    expect(flush).not.toHaveBeenCalled()
  })
})

describe('store.ts wiring: the persist layer uses the debounced writer with an unload flush', () => {
  // The store module runs its top-level persist setup on import, and localStorage/window are absent in
  // this node env, so the wiring cannot be exercised behaviorally here — the debounce and flush units
  // above cover behavior. This scans the source for the load-bearing wiring, the same technique
  // main-window-setup.test.ts uses for index.ts. Comments are stripped so a comment cannot supply a
  // match.
  const here = dirname(fileURLToPath(import.meta.url))
  const storePath = join(here, '../src/renderer/src/store.ts')

  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  it('feeds the debounced writer as the persist storage, not the raw synchronous one', async () => {
    const source = stripComments(await readFile(storePath, 'utf8'))
    expect(source).toContain('createDebouncedPersistentStorage(guardedWorkbenchStorage)')
    // The persist config must consume the debounced storage; reverting it to the raw guarded storage
    // (a synchronous write per layout change) is the regression this guards.
    expect(source).toContain('createJSONStorage(() => persistentWorkbenchStorage.storage)')
    expect(source).not.toMatch(/createJSONStorage\(\(\)\s*=>\s*guardedWorkbenchStorage\)/)
  })

  it('registers the unload trailing flush so a shutdown mid-drag keeps the last layout write', async () => {
    const source = stripComments(await readFile(storePath, 'utf8'))
    expect(source).toContain('registerUnloadFlush(flushPersistedUiWrites)')
  })
})
