import { useSyncExternalStore } from 'react'
import type { BrowserProfileList, BrowserProfileSummary } from '../../../shared/contracts'
import { api } from './api'
import { presentError } from '@agentmux/client-ui/error-presentation'

/**
 * The one Renderer view of Main's Browser Profile list. Main pushes the whole
 * committed list after every change; reads and pushes are ordered by revision,
 * so a late reply can never replace a newer list. Components never copy it.
 */
export type BrowserProfilesState = {
  revision: number | null
  /** Last list Main confirmed; kept while a later read fails. */
  profiles: BrowserProfileSummary[] | null
  error: string | null
  reading: boolean
}

type Listener = () => void
const EMPTY: BrowserProfilesState = { revision: null, profiles: null, error: null, reading: false }

export function createBrowserProfilesStore(port: Pick<typeof api.browser, 'readProfiles' | 'onProfilesChanged'>) {
  let state = EMPTY
  const listeners = new Set<Listener>()
  let stopPush: (() => void) | null = null
  let reading: Promise<void> | null = null
  const set = (next: BrowserProfilesState): void => { state = next; for (const listener of listeners) listener() }
  const accept = (list: BrowserProfileList): void => {
    if (!list || !Number.isSafeInteger(list.revision) || !Array.isArray(list.profiles)) throw new Error('Main returned an unreadable Browser Profile list.')
    if (state.revision !== null && list.revision < state.revision) return
    set({ revision: list.revision, profiles: list.profiles, error: null, reading: state.reading })
  }
  // Concurrent consumers and retries share one Main read.
  const read = (): Promise<void> => reading ??= (async () => {
    set({ ...state, reading: true })
    try { accept(await port.readProfiles()) }
    catch (cause) { set({ ...state, error: presentError(cause) }) }
    finally { reading = null; set({ ...state, reading: false }) }
  })()
  return {
    get: (): BrowserProfilesState => state,
    subscribe(listener: Listener): () => void {
      listeners.add(listener)
      if (!stopPush) { stopPush = port.onProfilesChanged(list => { try { accept(list) } catch (cause) { set({ ...state, error: presentError(cause) }) } }); void read() }
      return () => {
        listeners.delete(listener)
        // Without a subscriber no push arrives; the last list stays and the next consumer reads again.
        if (!listeners.size && stopPush) { stopPush(); stopPush = null }
      }
    },
    /** Retry after a failed read; the list itself only changes through Main. */
    refresh: read,
    /** Tests and previews start from an unread list. */
    reset(): void { reading = null; stopPush?.(); stopPush = null; state = EMPTY; listeners.clear() }
  }
}

export const browserProfiles = createBrowserProfilesStore(api.browser)

export function useBrowserProfiles(): BrowserProfilesState {
  return useSyncExternalStore(browserProfiles.subscribe, browserProfiles.get)
}
