import { useSyncExternalStore } from 'react'
import type { BrowserProfileList, BrowserProfileSummary, BrowserProfileFolder } from '../../../shared/contracts'
import { api } from './api'
import { presentError } from '@agentmux/client-ui/error-presentation'

/**
 * The one Renderer view of Main's Browser Profile list. Main pushes the whole
 * committed list after every change; reads and pushes are ordered by snapshot sequence,
 * so a late reply can never replace a newer list. Components never copy it.
 */
export type BrowserProfilesState = {
  revision: number | null
  sequence: number | null
  /** Last list Main confirmed; kept while a later read fails. */
  profiles: BrowserProfileSummary[] | null
  folders: BrowserProfileFolder[] | null
  views: import('@agentmux/core/control').BrowserProfileView[] | null
  error: string | null
  reading: boolean
}

type Listener = () => void
const EMPTY: BrowserProfilesState = { revision: null, sequence: null, profiles: null, folders: null, views: null, error: null, reading: false }

export function createBrowserProfilesStore(port: Pick<typeof api.browser, 'readProfiles' | 'onProfilesChanged'>) {
  let state = EMPTY
  const listeners = new Set<Listener>()
  let stopPush: (() => void) | null = null
  let reading: Promise<void> | null = null
  let pushGeneration = 0
  const set = (next: BrowserProfilesState): void => { state = next; for (const listener of listeners) listener() }
  const accept = (list: BrowserProfileList): void => {
    if (!list || !Number.isSafeInteger(list.revision) || !Number.isSafeInteger(list.sequence) || !Array.isArray(list.profiles) || !Array.isArray(list.folders) || !Array.isArray(list.views)) throw new Error('Main returned an unreadable Browser Profile list.')
    if (state.sequence !== null && list.sequence < state.sequence) return
    set({ revision: list.revision, sequence: list.sequence, profiles: list.profiles, folders: list.folders, views: list.views, error: null, reading: state.reading })
  }
  // Concurrent consumers and retries share one Main read.
  const read = (): Promise<void> => reading ??= (async () => {
    const startedAtPush = pushGeneration
    set({ ...state, reading: true })
    try {
      const list = await port.readProfiles()
      // Native application can change without a metadata commit. At the same
      // sequence a push after this read began is newer; a higher metadata
      // sequence still wins, even if a native push arrived while reading.
      if (list.sequence !== state.sequence || startedAtPush === pushGeneration) accept(list)
    }
    catch (cause) { set({ ...state, error: presentError(cause) }) }
    finally { reading = null; set({ ...state, reading: false }) }
  })()
  return {
    get: (): BrowserProfilesState => state,
    subscribe(listener: Listener): () => void {
      listeners.add(listener)
      if (!stopPush) { stopPush = port.onProfilesChanged(list => { try { accept(list); pushGeneration++ } catch (cause) { set({ ...state, error: presentError(cause) }) } }); void read() }
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

const inactiveSubscription = () => () => {}
export function useBrowserProfiles(active = true): BrowserProfilesState {
  return useSyncExternalStore(active ? browserProfiles.subscribe : inactiveSubscription, browserProfiles.get)
}
