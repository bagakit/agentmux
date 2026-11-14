import { useCallback, useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { desktopUserDocument } from './desktop-user-state'
import { readWorkbenchInputArchive, type WorkbenchInputArchiveEntry } from './workbench-input-archive'

const NO_RECORDS: readonly WorkbenchInputArchiveEntry[] = []

type ArchiveWindow = {
  ownerKey: string | undefined
  entries: readonly WorkbenchInputArchiveEntry[]
  nextCursor: string | null
  observed: boolean
  loading: boolean
  error: string | null
}

function emptyArchive(ownerKey: string | undefined): ArchiveWindow {
  return { ownerKey, entries: NO_RECORDS, nextCursor: null, observed: false, loading: false, error: null }
}

function mergeArchive(known: readonly WorkbenchInputArchiveEntry[], page: readonly WorkbenchInputArchiveEntry[]) {
  if (!known.length) return page
  const records = new Map(known.map(item => [JSON.stringify([item.ownerKey, item.entry.operationId]), item]))
  for (const item of page) records.set(JSON.stringify([item.ownerKey, item.entry.operationId]), item)
  return [...records.values()]
}

/** The reader keeps only pages this surface requested and ignores late pages from a previous owner. */
export function useWorkbenchInputArchive(ownerKey: string | undefined, enabled: boolean) {
  const [window, setWindow] = useState(() => emptyArchive(ownerKey))
  const current = useRef({ ownerKey, enabled })
  current.current = { ownerKey, enabled }
  const pending = useRef<object | null>(null)
  const state = window.ownerKey === ownerKey ? window : emptyArchive(ownerKey)

  const read = useCallback(async (after?: string, clear = false) => {
    if (!current.current.enabled || current.current.ownerKey !== ownerKey) return
    const request = {}
    pending.current = request
    const applies = () => pending.current === request && current.current.enabled && current.current.ownerKey === ownerKey
    setWindow(previous => ({ ...(previous.ownerKey === ownerKey && !clear ? previous : emptyArchive(ownerKey)), loading: true, error: null }))
    try {
      const page = await readWorkbenchInputArchive({ ...(ownerKey === undefined ? {} : { ownerKey }), ...(after === undefined ? {} : { after }), limit: 30 })
      if (!applies()) return
      setWindow(previous => ({ ownerKey, entries: mergeArchive(previous.entries, page.entries), nextCursor: page.nextCursor,
        observed: true, loading: false, error: null }))
    } catch (error) {
      if (applies()) setWindow(previous => ({ ...previous, observed: true, loading: false, error: presentError(error) }))
    }
  }, [ownerKey])

  useEffect(() => {
    if (!enabled) return
    void read()
    const unsubscribe = desktopUserDocument.subscribeInputQueueCommits(owners => {
      if (owners === null || ownerKey === undefined || owners.has(ownerKey)) void read(undefined, owners === null)
    })
    return () => { pending.current = null; unsubscribe() }
  }, [enabled, ownerKey, read])

  return { ...state, loading: enabled && (state.loading || !state.observed), refresh: () => read(), loadEarlier: () => {
    if (!state.loading && state.nextCursor !== null) void read(state.nextCursor)
  } }
}
