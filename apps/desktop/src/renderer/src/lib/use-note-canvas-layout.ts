import { useCallback, useMemo } from 'react'
import { saveNoteCanvasPresentation, useAppStore } from '../store'
import { defaultNoteCanvasLayout, noteCanvasScopeKey, type NoteCanvasLayout, type NoteCanvasScope } from './note-canvas-state'

/** Uses the original persisted UI writer; only completed gestures change durable presentation. */
export function useNoteCanvasLayout(scope: NoteCanvasScope) {
  const key = noteCanvasScopeKey(scope)
  const fallback = useMemo(() => defaultNoteCanvasLayout(scope), [key])
  const saved = useAppStore(state => state.noteCanvasLayouts[key])
  const issue = useAppStore(state => state.noteCanvasSaveIssues[key] ?? null)
  const save = useCallback((patch: Partial<NoteCanvasLayout>) => { void saveNoteCanvasPresentation(scope, patch) }, [key])
  const retry = useCallback(() => { void saveNoteCanvasPresentation(scope) }, [key])
  return { layout: saved ?? fallback, issue, save, retry }
}
