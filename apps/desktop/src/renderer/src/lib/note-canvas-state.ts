/** Canvas coordinates are client presentation, never Note content or relationship authority. */
export type NoteCanvasScope = { kind: 'notebook'; notebookId: string } | { kind: 'note'; noteId: string }
export type NoteCanvasPoint = { x: number; y: number }
export type NoteCanvasViewport = NoteCanvasPoint & { zoom: number }
export type NoteCanvasLayout = {
  positions: Record<string, NoteCanvasPoint>
  viewport?: NoteCanvasViewport | undefined
  expandedNoteIds: string[]
  previewNoteIds: string[]
}
export function noteCanvasScopeKey(scope: NoteCanvasScope): string {
  return JSON.stringify([scope.kind, scope.kind === 'note' ? scope.noteId : scope.notebookId])
}
export function defaultNoteCanvasLayout(scope: NoteCanvasScope): NoteCanvasLayout {
  return { positions: {}, expandedNoteIds: scope.kind === 'note' ? [scope.noteId] : [], previewNoteIds: [] }
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const point = (value: unknown): value is NoteCanvasPoint => record(value) && typeof value.x === 'number' && Number.isFinite(value.x) && typeof value.y === 'number' && Number.isFinite(value.y)
const identities = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))] : []

/** A malformed field cannot erase other valid scopes or coordinates. No count-based truncation. */
export function restoreNoteCanvasLayouts(value: unknown): Record<string, NoteCanvasLayout> {
  if (!record(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([key, layout]) => {
    if (!record(layout)) return []
    const positions = record(layout.positions) ? Object.fromEntries(Object.entries(layout.positions).filter(([, position]) => point(position)).map(([id, position]) => [id, { x: (position as NoteCanvasPoint).x, y: (position as NoteCanvasPoint).y }])) : {}
    const candidate = layout.viewport, zoom = record(candidate) ? candidate.zoom : undefined
    const viewport = point(candidate) && typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0
      ? { x: candidate.x, y: candidate.y, zoom } : undefined
    return [[key, { positions, ...(viewport ? { viewport } : {}), expandedNoteIds: identities(layout.expandedNoteIds), previewNoteIds: identities(layout.previewNoteIds) }]]
  }))
}
export function mergeNoteCanvasLayout(current: NoteCanvasLayout, patch: Partial<NoteCanvasLayout>): NoteCanvasLayout {
  return { positions: patch.positions === undefined ? current.positions : { ...patch.positions },
    viewport: Object.hasOwn(patch, 'viewport') ? patch.viewport : current.viewport,
    expandedNoteIds: patch.expandedNoteIds === undefined ? current.expandedNoteIds : [...new Set(patch.expandedNoteIds)],
    previewNoteIds: patch.previewNoteIds === undefined ? current.previewNoteIds : [...new Set(patch.previewNoteIds)] }
}
