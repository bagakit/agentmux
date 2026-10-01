import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitHistoryResult } from '../../../shared/git-contracts'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { gitBridge } from '../lib/git-bridge'

type HistoryState = {
  key: string
  reference: string | null
  result: GitHistoryResult | null
  loading: boolean
  error: string | null
}

/** Component-owned read window. Hidden tabs keep completed pages and reject pending reads. */
export function useGitHistory(workspace: Pick<WorkspaceRecord, 'id' | 'hostId' | 'path'>, visible: boolean) {
  const workspaceId = workspace.id
  const key = JSON.stringify([workspace.id, workspace.hostId, workspace.path])
  const [selection, setSelection] = useState({ key, reference: null as string | null })
  const reference = selection.key === key ? selection.reference : null
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState !== 'hidden')
  const [state, setState] = useState<HistoryState | null>(null)
  const latest = useRef(state)
  const generation = useRef(0)
  const busy = useRef(false)
  const enabled = visible && documentVisible
  const scope = useRef({ key, reference, enabled })
  scope.current = { key, reference, enabled }

  const publish = useCallback((next: HistoryState) => {
    latest.current = next
    setState(next)
  }, [])

  useEffect(() => {
    const changed = () => setDocumentVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])

  const read = useCallback(async (more: boolean) => {
    if (!scope.current.enabled || (more && busy.current)) return false
    const previous = latest.current?.key === key && latest.current.reference === reference ? latest.current : null
    const cursor = more && previous?.result?.kind === 'ready' ? previous.result.nextCursor : null
    if (more && !cursor) return false
    const id = ++generation.current
    const lookup = gitBridge()
    const base: HistoryState = { key, reference, result: previous?.result ?? null, loading: false, error: null }
    if (!lookup.available) { publish({ ...base, error: lookup.reason }); return false }
    busy.current = true
    publish({ ...base, loading: true })
    const current = () => generation.current === id && scope.current.enabled &&
      scope.current.key === key && scope.current.reference === reference
    try {
      const next = await lookup.bridge.history(workspaceId, cursor ? { ref: reference, cursor } : { ref: reference })
      if (!current()) return false
      let result = next
      if (cursor && next.kind === 'ready' && previous?.result?.kind === 'ready') {
        const commits = [...previous.result.commits, ...next.commits]
        if (new Set(commits.map(commit => commit.oid)).size !== commits.length) throw new Error('History page repeated an already loaded commit. Refresh to read a new snapshot.')
        result = { ...next, commits }
      }
      busy.current = false
      publish({ ...base, result, loading: false })
      return true
    } catch (error) {
      if (!current()) return false
      busy.current = false
      publish({ ...base, loading: false, error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }, [workspaceId, key, reference, publish])

  useEffect(() => {
    generation.current += 1
    busy.current = false
    const previous = latest.current
    if (!enabled) {
      if (previous?.loading) publish({ ...previous, loading: false })
    } else if (!previous || previous.key !== key || previous.reference !== reference ||
      (!previous.result && !previous.error)) {
      void read(false)
    }
    return () => { generation.current += 1; busy.current = false }
  }, [key, reference, enabled, read, publish])

  const owned = state?.key === key && state.reference === reference ? state : null
  return {
    result: owned?.result ?? null, loading: owned?.loading ?? enabled, error: owned?.error ?? null,
    refs: state?.key === key && state.result?.kind === 'ready' ? state.result.snapshot.refs : [],
    reference,
    selectReference: (value: string | null) => setSelection({ key, reference: value }),
    refresh: () => read(false), loadMore: () => read(true)
  }
}
