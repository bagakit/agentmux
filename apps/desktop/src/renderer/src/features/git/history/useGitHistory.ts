import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitHistoryRef, GitHistoryResult } from '../../../../../shared/git-contracts'
import type { WorkspaceRecord } from '../../../../../shared/contracts'
import { gitBridge } from '../../../lib/git-bridge'

type HistoryState = {
  key: string
  reference: string | null
  result: GitHistoryResult | null
  refs: GitHistoryRef[]
  loading: boolean
  error: string | null
  repository: { hostId: string; repoPath: string } | null
}

/** Component-owned read window. Hidden tabs keep completed pages and reject pending reads. */
export function useGitHistory(workspace: Pick<WorkspaceRecord, 'id' | 'hostId' | 'path'>, visible: boolean) {
  const workspaceId = workspace.id
  const key = JSON.stringify([workspace.id, workspace.hostId, workspace.path])
  const [selection, setSelection] = useState({ key, reference: null as string | null, intent: false })
  const reference = selection.key === key ? selection.reference : null
  const referenceIntent = selection.key === key && selection.intent
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState !== 'hidden')
  const [state, setState] = useState<HistoryState | null>(null)
  const latest = useRef(state)
  const generation = useRef(0)
  const busy = useRef(false)
  const selectionIntent = useRef<string | null>(null)
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
    if (!scope.current.enabled || scope.current.key !== key || scope.current.reference !== reference || (more && busy.current)) return false
    const previous = latest.current?.key === key && latest.current.reference === reference ? latest.current : null
    const cursor = more && previous?.result?.kind === 'ready' ? previous.result.nextCursor : null
    if (more && !cursor) return false
    const id = ++generation.current
    const lookup = gitBridge()
    // Available ranges belong to this exact Workspace, independently of the selected commit page.
    const base: HistoryState = { key, reference, result: previous?.result ?? null,
      refs: latest.current?.key === key ? latest.current.refs : [],
      repository: latest.current?.key === key ? latest.current.repository : null, loading: false, error: null }
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
        if (next.nextCursor && (next.commits.length === 0 || next.nextCursor.offset <= cursor.offset)) throw new Error('History page did not advance. Retry or refresh to read a new snapshot.')
        result = { ...next, commits }
      }
      busy.current = false
      publish({ ...base, result, refs: next.kind === 'ready' ? next.snapshot.refs : [],
        repository: next.kind === 'ready' ? { hostId: next.snapshot.hostId, repoPath: next.snapshot.repoPath } : null, loading: false })
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

  const selectReference = useCallback((value: string | null) => {
    if (scope.current.key !== key) return
    selectionIntent.current = key
    if (scope.current.reference === value) {
      setSelection(current => current.key === key && current.intent ? current : { key, reference: value, intent: true })
      return
    }
    generation.current += 1
    busy.current = false
    // A durable range can be selected during layout, before the old enabled effect runs.
    scope.current = { ...scope.current, reference: value }
    setSelection({ key, reference: value, intent: true })
  }, [key])
  const restoreReference = useCallback((value: string | null) => {
    if (scope.current.key !== key || selectionIntent.current === key || latest.current?.key === key) return
    selectReference(value)
  }, [key, selectReference])
  const refresh = useCallback(() => read(false), [read])
  const loadMore = useCallback(() => read(true), [read])
  const owned = state?.key === key && state.reference === reference ? state : null
  return useMemo(() => ({
    result: owned?.result ?? null, loading: owned?.loading ?? enabled, error: owned?.error ?? null,
    refs: state?.key === key ? state.refs : [],
    repository: state?.key === key ? state.repository : null,
    reference, referenceIntent, enabled,
    selectReference, restoreReference, refresh, loadMore
  }), [owned, state, key, reference, referenceIntent, enabled, selectReference, restoreReference, refresh, loadMore])
}
