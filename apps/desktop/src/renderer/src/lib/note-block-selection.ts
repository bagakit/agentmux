import type { NoteBlockTarget } from '../../../shared/note-document'
import type { WorkbenchProjectionSelection } from './workbench-projection'

/** Semantic selection is durable presentation metadata, never Note content or a reference edge. */
export type NoteBlockPresentation = { tabHostId: string; reference: WorkbenchProjectionSelection }
export function noteBlockSelectionKey({ tabHostId, reference }: NoteBlockPresentation): string {
  return JSON.stringify([tabHostId, reference.displayWorkspaceId, reference.groupId, reference.tabId, reference.regionId])
}
export function restoreNoteBlockSelections(candidate: unknown): Record<string, NoteBlockTarget> {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {}
  const selections: Record<string, NoteBlockTarget> = {}
  for (const [key, target] of Object.entries(candidate)) {
    let address: unknown
    try { address = JSON.parse(key) } catch { continue }
    if (!Array.isArray(address) || address.length !== 5 || !address.every(value => typeof value === 'string' && value.length > 0) ||
      !target || typeof target !== 'object' || Array.isArray(target) || !('noteId' in target) || !('blockId' in target) ||
      typeof target.noteId !== 'string' || !target.noteId || typeof target.blockId !== 'string' || !target.blockId) continue
    // Resources and Note content may still be unconfirmed at startup. Retain the exact target.
    selections[key] = { noteId: target.noteId, blockId: target.blockId }
  }
  return selections
}
