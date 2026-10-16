export type NoteFileTarget = { workspaceId: string; path: string; hostId: string; workspacePath: string; noteId: string }
/** Live presentation capabilities only. FileDocument remains the single content/save owner. */
const consumers = new Map<string, Map<string, number>>()
export function retainFileDocument(key: string, occurrence: string): () => void {
  const held = consumers.get(key) ?? new Map<string, number>(); held.set(occurrence, (held.get(occurrence) ?? 0) + 1); consumers.set(key, held)
  let released = false
  return () => { if (released) return; released = true; const remaining = (held.get(occurrence) ?? 1) - 1; if (remaining) held.set(occurrence, remaining); else held.delete(occurrence); if (!held.size && consumers.get(key) === held) consumers.delete(key) }
}
export function hasFileDocumentConsumer(key: string): boolean { return Boolean(consumers.get(key)?.size) }
export function fileDocumentConsumerKeys(): IterableIterator<string> { return consumers.keys() }
