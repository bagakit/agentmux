import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { parseMoteDialogueResult, sameMoteDialogue, type MoteDialogueRead, type MoteDialoguePage } from '@agentmux/core/mote-dialogue'
export type MoteDialogueReader = (input: MoteDialogueRead) => Promise<MoteDialoguePage>
type Snapshot = { page: MoteDialoguePage | null; issue: string | null; unavailable: boolean; loading: boolean }
const empty: Snapshot = { page: null, issue: null, unavailable: false, loading: false }
/** Read-only projections are shared across retained DOM presentations of the
 * same original resource and reader. Core remains the only role/link owner. */
function createProjection(read: MoteDialogueReader, target: MoteDialogueRead['target']) {
  let snapshot = empty, pending: Promise<void> | null = null, revision: string | undefined, refreshRequested = false
  const listeners = new Set<() => void>()
  const publish = (value: Snapshot) => { snapshot = value; for (const listener of listeners) listener() }
  async function fetchPage(older = false) {
    if (pending) { if (!older) refreshRequested = true; return pending }
    const prior = snapshot.page
    if (older && !prior?.next) return
    const query: MoteDialogueRead = { target, limit: 50, ...(older ? { cursor: prior!.next! } : {}) }
    publish({ ...snapshot, issue: null, loading: true })
    pending = Promise.resolve().then(async () => {
      try {
        const page = parseMoteDialogueResult('space.mote.dialogue.read', await read(query), query)
        if (!page.main.identity && prior) {
          publish({ page: prior, loading: false, unavailable: true, issue: page.sourceIssue ?? page.main.issue ?? '原 Mote 来源尚未确认；保留上次读取的原引用。' })
          return
        }
        const same = prior?.main.identity && page.main.identity && sameMoteDialogue(prior.main.identity, page.main.identity)
        const links = page.sourceStatus === 'unconfirmed' && same ? prior!.links
          : older && same ? [...prior!.links, ...page.links.filter(link => !prior!.links.some(known => known.sequence === link.sequence))] : page.links
        publish({ page: { ...page, links, ...(page.sourceStatus === 'unconfirmed' ? { next: null } : {}) },
          loading: false, unavailable: false, issue: page.sourceIssue ?? page.main.issue })
      } catch (error) { publish({ ...snapshot, loading: false, ...(older ? {} : { unavailable: true }), issue: error instanceof Error ? error.message : String(error) }) }
      finally { pending = null; if (refreshRequested) { refreshRequested = false; void fetchPage() } }
    })
    return pending
  }
  return { snapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh: () => { void fetchPage() }, older: () => fetchPage(true),
    activate(sourceRevision?: string) { if (!snapshot.page || revision !== sourceRevision) { revision = sourceRevision; void fetchPage() } }
  }
}
const readers = new WeakMap<MoteDialogueReader, Map<string, ReturnType<typeof createProjection>>>()
const noProjection = { snapshot: () => empty, subscribe: (_listener: () => void) => () => {}, refresh: () => {}, older: async () => {} }
export function useMoteDialogue(read: MoteDialogueReader | undefined, target: MoteDialogueRead['target'] | undefined, visible: boolean, sourceRevision?: string) {
  const key = target ? JSON.stringify(target) : ''
  const projection = useMemo(() => {
    if (!read || !target) return null
    let resources = readers.get(read)
    if (!resources) { resources = new Map(); readers.set(read, resources) }
    let value = resources.get(key)
    if (!value) { value = createProjection(read, target); resources.set(key, value) }
    return value
  }, [read, key])
  const source = projection ?? noProjection
  const state = useSyncExternalStore(source.subscribe, source.snapshot, source.snapshot)
  useEffect(() => { if (visible) projection?.activate(sourceRevision) }, [projection, visible, sourceRevision])
  return { key, read, ...state, refresh: source.refresh, older: source.older }
}
