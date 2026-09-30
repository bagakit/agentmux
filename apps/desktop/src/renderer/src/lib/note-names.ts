import type { WorkspaceFileWriteResult } from '../../../shared/contracts'
export { NOTE_FILE_EXTENSION } from '../../../shared/note-document'
import { NOTE_FILE_EXTENSION } from '../../../shared/note-document'
export const NOTE_NAME_ATTEMPTS = 100
export function noteStemForDate(now: Date): string {
  return `note-${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, '0')}-${`${now.getDate()}`.padStart(2, '0')}`
}
export function noteNameCandidates(now: Date, attempts = NOTE_NAME_ATTEMPTS): string[] {
  const stem = noteStemForDate(now)
  return Array.from({ length: attempts }, (_, index) => `${stem}${index ? `-${index + 1}` : ''}${NOTE_FILE_EXTENSION}`)
}
export type NoteNameResult = { path: string; result: Exclude<WorkspaceFileWriteResult, { status: 'conflict' }> }
/** Only a confirmed collision advances the name. A thrown transport outcome remains unknown. */
export async function createNoteWithAvailableName(now: Date, write: (path: string) => Promise<WorkspaceFileWriteResult>, attempts = NOTE_NAME_ATTEMPTS): Promise<NoteNameResult> {
  const candidates = noteNameCandidates(now, attempts)
  for (const path of candidates) {
    let result: WorkspaceFileWriteResult
    try { result = await write(path) }
    catch (error) { return { path, result: { status: 'unknown', code: 'NOTE_CREATE_TRANSPORT_UNKNOWN', message: error instanceof Error ? error.message : String(error) } } }
    if (result.status !== 'conflict') return { path, result }
  }
  return { path: candidates.at(-1) ?? '', result: { status: 'error', code: 'NOTE_NAME_EXHAUSTED', message: `All ${candidates.length} Note names are occupied.` } }
}
