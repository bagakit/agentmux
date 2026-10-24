import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitHistoryCommit, GitHistoryRef, GitHistoryResult, GitHistorySnapshot } from '../../../../../shared/git-contracts'
import type { WorkspaceRecord } from '../../../../../shared/contracts'
import { gitBridge } from '../../../lib/git-bridge'

type HistoryState = {
  key: string
  reference: string | null
  result: GitHistoryResult | null
  refs: GitHistoryRef[]
  loading: boolean
  error: string | null
  failedRead: 'refresh' | 'more' | null
  repository: { hostId: string; repoPath: string } | null
}
type ReferenceCheck = { snapshot: GitHistorySnapshot; checking: boolean; changed: boolean | null; error: string | null }

/** Component-owned read window. Hidden tabs keep completed pages and reject pending reads. */
export function useGitHistory(workspace: Pick<WorkspaceRecord, 'id' | 'hostId' | 'path'>, visible: boolean) {
  const workspaceId = workspace.id
  const key = JSON.stringify([workspace.id, workspace.hostId, workspace.path])
  const [selection, setSelection] = useState({ key, reference: null as string | null, intent: false })
  const reference = selection.key === key ? selection.reference : null
  const referenceIntent = selection.key === key && selection.intent
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState !== 'hidden')
  const [state, setState] = useState<HistoryState | null>(null)
  const [referenceCheck, setReferenceCheck] = useState<ReferenceCheck | null>(null)
  const checking = useRef<{ generation: number } | null>(null)
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
    setReferenceCheck(prior => prior?.checking ? { ...prior, checking: false } : prior)
    const lookup = gitBridge()
    // Available ranges belong to this exact Workspace, independently of the selected commit page.
    const base: HistoryState = { key, reference, result: previous?.result ?? null,
      refs: latest.current?.key === key ? latest.current.refs : [],
      repository: latest.current?.key === key ? latest.current.repository : null, loading: false, error: null, failedRead: null }
    if (!lookup.available) { publish({ ...base, error: lookup.reason, failedRead: more ? 'more' : 'refresh' }); return false }
    busy.current = true
    publish({ ...base, loading: true })
    const current = () => generation.current === id && scope.current.enabled &&
      scope.current.key === key && scope.current.reference === reference
    try {
      let next = await lookup.bridge.history(workspaceId, cursor ? { ref: reference, cursor } : { ref: reference })
      if (!current()) return false
      // Explicit refresh replaces the read window atomically. A first-page replacement
      // would clamp a reader deep in already loaded pages back towards the top.
      if (!more && previous?.result?.kind === 'ready') {
        if (next.kind !== 'ready' || next.snapshot.hostId !== previous.result.snapshot.hostId || next.snapshot.repoPath !== previous.result.snapshot.repoPath) {
          throw new Error('The original repository could not be confirmed. The previous snapshot is retained.')
        }
        const count = previous.result.commits.length
        while (next.kind === 'ready' && next.nextCursor && next.commits.length < count) {
          const after = next.nextCursor
          const page = await lookup.bridge.history(workspaceId, { ref: reference, cursor: after })
          if (!current()) return false
          if (page.kind !== 'ready' || page.commits.length === 0 || (page.nextCursor && page.nextCursor.offset <= after.offset)) {
            throw new Error('History refresh did not advance. The previous snapshot is retained; retry refresh.')
          }
          const commits: GitHistoryCommit[] = [...next.commits, ...page.commits]
          if (new Set(commits.map(commit => commit.oid)).size !== commits.length) throw new Error('History refresh repeated a commit. The previous snapshot is retained; retry refresh.')
          next = { ...page, snapshot: next.snapshot, commits }
        }
      }
      let result = next
      if (cursor && next.kind === 'ready' && previous?.result?.kind === 'ready') {
        const commits = [...previous.result.commits, ...next.commits]
        if (new Set(commits.map(commit => commit.oid)).size !== commits.length) throw new Error('History page repeated an already loaded commit. Refresh to read a new snapshot.')
        if (next.nextCursor && (next.commits.length === 0 || next.nextCursor.offset <= cursor.offset)) throw new Error('History page did not advance. Retry or refresh to read a new snapshot.')
        result = { ...next, snapshot: previous.result.snapshot, commits }
      }
      busy.current = false
      publish({ ...base, result, refs: next.kind === 'ready' ? next.snapshot.refs : [],
        repository: next.kind === 'ready' ? { hostId: next.snapshot.hostId, repoPath: next.snapshot.repoPath } : null, loading: false })
      return true
    } catch (error) {
      if (!current()) return false
      busy.current = false
      publish({ ...base, loading: false, error: error instanceof Error ? error.message : String(error), failedRead: more ? 'more' : 'refresh' })
      return false
    }
  }, [workspaceId, key, reference, publish])

  const checkReferences = useCallback(async () => {
    const previous = latest.current
    if (checking.current?.generation === generation.current || !scope.current.enabled || scope.current.key !== key ||
      previous?.key !== key || previous.reference !== scope.current.reference || previous.result?.kind !== 'ready') return false
    const snapshot = previous.result.snapshot, id = generation.current
    const current = () => generation.current === id && scope.current.enabled && scope.current.key === key &&
      latest.current?.result?.kind === 'ready' && latest.current.result.snapshot === snapshot
    const request = { generation: id }
    checking.current = request
    setReferenceCheck(prior => ({ snapshot, checking: true, changed: prior?.snapshot === snapshot ? prior.changed : null, error: null }))
    try {
      const lookup = gitBridge()
      if (!lookup.available) throw new Error(lookup.reason)
      // One observation, no polling: limit bounds returned commits, not Git's ref/log traversal.
      const observed = await lookup.bridge.history(workspaceId, { ref: null, limit: 1 })
      if (!current()) return false
      if (observed.kind !== 'ready' || observed.snapshot.hostId !== snapshot.hostId || observed.snapshot.repoPath !== snapshot.repoPath) {
        throw new Error('The original repository could not be confirmed.')
      }
      const refs = new Map(observed.snapshot.refs.map(ref => [ref.name, ref]))
      const changed = refs.size !== snapshot.refs.length || snapshot.refs.some(ref => {
        const next = refs.get(ref.name)
        return next?.kind !== ref.kind || next.oid !== ref.oid
      })
      setReferenceCheck({ snapshot, checking: false, changed, error: null })
      return true
    } catch (error) {
      if (current()) setReferenceCheck({ snapshot, checking: false, changed: null, error: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      if (checking.current === request) {
        checking.current = null
        setReferenceCheck(prior => prior?.snapshot === snapshot && prior.checking ? { ...prior, checking: false } : prior)
      }
    }
  }, [key, workspaceId])

  useEffect(() => {
    generation.current += 1
    busy.current = false
    const previous = latest.current
    if (!enabled) {
      if (previous?.loading) publish({ ...previous, loading: false })
    } else if (!previous || previous.key !== key || previous.reference !== reference ||
      (!previous.result && !previous.error)) {
      void read(false)
    } else void checkReferences()
    return () => { generation.current += 1; busy.current = false }
  }, [key, reference, enabled, read, publish, checkReferences])

  useEffect(() => {
    if (!enabled) return
    const focus = () => { void checkReferences() }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [enabled, checkReferences])

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
  const check = owned?.result?.kind === 'ready' && referenceCheck?.snapshot === owned.result.snapshot ? referenceCheck : null
  return useMemo(() => ({
    result: owned?.result ?? null, loading: owned?.loading ?? enabled, error: owned?.error ?? null,
    refs: state?.key === key ? state.refs : [],
    repository: state?.key === key ? state.repository : null,
    reference, referenceIntent, enabled,
    referenceCheck: check, checkReferences,
    retry: owned?.failedRead === 'more' ? loadMore : refresh,
    selectReference, restoreReference, refresh, loadMore
  }), [owned, state, key, reference, referenceIntent, enabled, check, checkReferences, selectReference, restoreReference, refresh, loadMore])
}
