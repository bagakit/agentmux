import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteContentObservation } from '@agentmux/core'
import { noteKnowledge, type NoteFileDocument } from '@agentmux/client-ui/note/note-knowledge'
import { noteContentMatchesGraph, type NotebookGraphSnapshot } from '../../../shared/notebook-observation'
import { api } from './api'

export type CanvasContent = { snapshot: NotebookGraphSnapshot; value?: NoteContentObservation; issue?: string; pending?: boolean; document?: NoteFileDocument }
// A bounded automatic reading window, not a limit on explicit reading or the original file.
const AUTO_FILES = 6, CONCURRENCY = 2, AUTO_BYTES = 256 * 1024
type Request = { full: boolean; attempt: number }

/** One ephemeral observation per original/snapshot, shared by every reader on this surface. */
export function useNoteCanvasContent(snapshot: NotebookGraphSnapshot | null, active: boolean, visible: readonly string[], priority: readonly string[]) {
  const [results, setResults] = useState<Record<string, CanvasContent>>({})
  const [explicit, setExplicit] = useState<Record<string, Request>>({})
  const jobs = useRef(new Map<string, { controller: AbortController; snapshot: NotebookGraphSnapshot; request: Request }>())
  const current = useRef({ results, snapshot }); current.current = { results, snapshot }
  const request = useCallback((noteId: string, full = true) => {
    const { results, snapshot } = current.current, held = results[noteId]
    if (jobs.current.get(noteId)?.request.full || held?.snapshot === snapshot && held.value?.status === 'read' && snapshot && noteContentMatchesGraph(snapshot, held.value)) return
    setExplicit(values => ({ ...values, [noteId]: { full, attempt: (values[noteId]?.attempt ?? 0) + 1 } }))
  }, [])
  useEffect(() => {
    setResults({}); setExplicit({})
    return () => { for (const job of jobs.current.values()) job.controller.abort(); jobs.current.clear() }
  }, [snapshot])
  useEffect(() => {
    if (!active || !snapshot) {
      for (const job of jobs.current.values()) job.controller.abort()
      jobs.current.clear()
      return
    }
    const admitted = Object.keys(results).filter(id => results[id]?.snapshot === snapshot)
    const automatic = [...new Set([...priority, ...visible])].filter(id => snapshot.catalog.pages[id] && !snapshot.graph.duplicateNoteIds.includes(id))
    const withinBudget = automatic.filter(id => { if (admitted.includes(id)) return true; if (admitted.length >= AUTO_FILES) return false; admitted.push(id); return true })
    const wanted = [...new Set([...Object.keys(explicit), ...priority, ...withinBudget])]
    for (const id of wanted) {
      if (jobs.current.size >= CONCURRENCY) break
      if (jobs.current.has(id) || !snapshot.catalog.pages[id]) continue
      const intent = explicit[id] ?? { full: false, attempt: 0 }, held = results[id]
      if (explicit[id] && held?.snapshot === snapshot && held.value?.status === 'read' && noteContentMatchesGraph(snapshot, held.value)) {
        setExplicit(values => Object.fromEntries(Object.entries(values).filter(([key]) => key !== id)))
        continue
      }
      if (held?.snapshot === snapshot && !held.pending && !explicit[id]) continue
      if (held?.snapshot === snapshot && held.pending) continue
      const controller = new AbortController(), job = { controller, snapshot, request: intent }
      jobs.current.set(id, job)
      setResults(values => ({ ...values, [id]: { snapshot, pending: true } }))
      // Explicit reading keeps the original owner's full-file budget and remains available after a small automatic read.
      void api.notebooks.content(id, { signal: controller.signal, ...intent.full ? {} : { maxBytes: AUTO_BYTES } }).then(value => {
        if (!controller.signal.aborted && jobs.current.get(id) === job) setResults(values => ({ ...values, [id]: { snapshot, value, ...value.status === 'read' ? { document: { path: value.resource.path, content: value.content, revision: value.revision } } : {} } }))
      }).catch(error => {
        if (!controller.signal.aborted && jobs.current.get(id) === job) setResults(values => ({ ...values, [id]: { snapshot, issue: error instanceof Error ? error.message : String(error) } }))
      }).finally(() => {
        if (jobs.current.get(id) !== job) return
        jobs.current.delete(id)
        setExplicit(values => values[id] === intent ? Object.fromEntries(Object.entries(values).filter(([key]) => key !== id)) : values)
      })
    }
  }, [active, snapshot, visible, priority, results, explicit])
  // Stop this observation only; the original files and other clients remain unaffected.
  useEffect(() => {
    if (!active) setResults(values => Object.fromEntries(Object.entries(values).filter(([, value]) => !value.pending)))
    return () => { for (const job of jobs.current.values()) job.controller.abort(); jobs.current.clear() }
  }, [active])
  const documents = useMemo(() => Object.entries(results).flatMap(([id, result]) => {
    const value = result.value
    return result.snapshot === snapshot && value?.status === 'read' && noteContentMatchesGraph(snapshot!, value) && !snapshot!.graph.duplicateNoteIds.includes(id)
      ? [{ location: { workspaceId: value.resource.workspaceId, path: value.resource.path }, document: result.document! }] : []
  }), [results, snapshot])
  const knowledge = useMemo(() => noteKnowledge(documents), [documents])
  return { results, documents, knowledge, request }
}
