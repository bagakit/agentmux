import type { NoteDocument } from '../shared/note-document.js'
import { noteBlockContentFingerprint } from '@agentmux/client-ui/note/note-provenance'

/** A text merge must not transplant an edit to a deleted or replaced stable block. */
export function replacesEditedBlock(base: NoteDocument, current: NoteDocument, proposed: NoteDocument): boolean {
  const blocks = (note: NoteDocument) => {
    const result = new Map<string, { content: string; parent: string | null }>()
    const visit = (node: NoteDocument['content'], parent: string | null) => {
      const id = typeof node.attrs?.blockId === 'string' ? node.attrs.blockId : null
      if (id !== null) result.set(id, { content: noteBlockContentFingerprint(node), parent })
      node.content?.forEach(child => visit(child, id ?? parent))
    }
    visit(note.content, null); return result
  }
  const before = blocks(base), saved = blocks(current), submitted = blocks(proposed)
  const changed = (first: { content: string; parent: string | null }, second: typeof first) => first.content !== second.content || first.parent !== second.parent
  for (const [id, original] of before) {
    const left = saved.get(id), right = submitted.get(id)
    if (!left && right && changed(original, right) || !right && left && changed(original, left)) return true
  }
  return false
}

