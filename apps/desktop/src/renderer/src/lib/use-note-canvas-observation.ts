import { useCallback, useEffect, useRef, useState } from 'react'
import type { NotebookGraphSnapshot } from '../../../shared/notebook-observation'
import { api } from './api'
import { documentKey } from './workbench-tabs'
import { useAppStore } from '../store'

/** A visible consumer of the existing owner, with explicit refresh and real cancellation. */
export function useNoteCanvasObservation(active: boolean) {
  const [snapshot, setSnapshot] = useState<NotebookGraphSnapshot | null>(null)
  const [issue, setIssue] = useState<string | null>(null), [stale, setStale] = useState(false), [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0), accepted = useRef(-1), current = useRef(snapshot); current.current = snapshot
  useEffect(() => {
    if (!active || accepted.current === attempt) return
    const controller = new AbortController()
    setBusy(true)
    void api.notebooks.graph({}, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return
      accepted.current = attempt; setSnapshot(value); setIssue(null); setStale(false)
    }).catch(error => {
      if (!controller.signal.aborted) setIssue(error instanceof Error ? error.message : String(error))
    }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => { controller.abort(); setBusy(false) }
  }, [active, attempt])
  useEffect(() => {
    if (!active) return
    return api.notebooks.onChange(event => {
      if ('issue' in event) setIssue(event.issue)
      else if (current.current && event.state.revision !== current.current.catalog.revision) setStale(true)
    })
  }, [active])
  useEffect(() => {
    if (!active || !snapshot) return
    const relevant = new Map(snapshot.graph.observations.map(observation => [documentKey(observation.resource.workspaceId, observation.resource.path), observation]))
    const offFiles = api.files.onInvalidated(event => { if (relevant.has(documentKey(event.workspaceId, event.path))) setStale(true) })
    const offStore = useAppStore.subscribe((state, previous) => {
      if (state.documents === previous.documents) return
      for (const [key, observation] of relevant) {
        const document = state.documents[key], before = previous.documents[key]
        if (document && before && document.revision !== before.revision && document.revision !== observation.revision) { setStale(true); return }
      }
    })
    return () => { offFiles(); offStore() }
  }, [active, snapshot])
  const refresh = useCallback(() => setAttempt(value => value + 1), [])
  return { snapshot, issue, stale, busy, refresh }
}
