import type { JSONContent } from '@tiptap/core'
import type { NotebookActor } from '@agentmux/core/notebook-catalog'
import type { NoteDocument } from './note-document.js'

export type NoteBlockAuthorship = { actor: NotebookActor; at: number }
export type NoteBlockProvenance = { created: NoteBlockAuthorship | null; lastEdited: NoteBlockAuthorship | null }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Missing historical authorship stays unknown; a caller's text is never a credential. */
export function readNoteBlockProvenance(value: unknown): NoteBlockProvenance | null {
  if (value === undefined || value === null) return null
  if (!record(value) || Object.keys(value).some(key => key !== 'created' && key !== 'lastEdited')) throw new Error('The block authorship record is invalid.')
  const read = (entry: unknown): NoteBlockAuthorship | null => {
    if (entry === null) return null
    if (!record(entry) || Object.keys(entry).some(key => key !== 'actor' && key !== 'at') || !Number.isSafeInteger(entry.at) || Number(entry.at) < 0 ||
      !record(entry.actor) || Object.keys(entry.actor).some(key => key !== 'kind' && key !== 'id') ||
      !['user', 'agent', 'device'].includes(String(entry.actor.kind)) || typeof entry.actor.id !== 'string' || !entry.actor.id.trim() || /[\0\r\n]/u.test(entry.actor.id)) throw new Error('The block author or recording time is invalid.')
    return entry as NoteBlockAuthorship
  }
  return { created: read(value.created), lastEdited: read(value.lastEdited) }
}

/** The owning block's content, with nested semantic blocks represented by their stable identities. */
function ownContent(node: JSONContent, root = true): unknown {
  if (!root && typeof node.attrs?.blockId === 'string') return { type: node.type, blockId: node.attrs.blockId }
  const attrs = Object.fromEntries(Object.entries(node.attrs ?? {}).filter(([key, value]) => key !== 'provenance' && key !== 'blockId' && value !== null))
  return { type: node.type, ...(Object.keys(attrs).length ? { attrs } : {}), ...(node.text !== undefined ? { text: node.text } : {}),
    ...(node.marks?.length ? { marks: node.marks } : {}), ...(node.content?.length ? { content: node.content.map(child => ownContent(child, false)) } : {}) }
}

/** Called only by the original file writer with its out-of-band, authenticated actor. */
export function attributeNoteBlocks(before: NoteDocument | null, candidate: NoteDocument, actor: NotebookActor | undefined, at: number): NoteDocument {
  const previous = new Map<string, JSONContent>()
  function visit(node: JSONContent, apply: (node: JSONContent, id: string) => void) {
    if (typeof node.attrs?.blockId === 'string') apply(node, node.attrs.blockId)
    for (const child of node.content ?? []) visit(child, apply)
  }
  if (before?.noteId === candidate.noteId) visit(before.content, (node, id) => previous.set(id, node))
  const next = structuredClone(candidate)
  visit(next.content, (node, id) => {
    const original = previous.get(id), old = readNoteBlockProvenance(original?.attrs?.provenance)
    const changed = !original || JSON.stringify(ownContent(original)) !== JSON.stringify(ownContent(node))
    const author = actor ? { actor: { ...actor }, at } : null
    const provenance = changed ? { created: original ? old?.created ?? null : author, lastEdited: author } : old
    // Restore even an unchanged block's original metadata; submitted JSON cannot rewrite its author.
    node.attrs = { ...node.attrs, provenance }
  })
  return next
}

export function noteProvenanceDescription(value: unknown): string {
  const provenance = readNoteBlockProvenance(value)
  const describe = (entry: NoteBlockAuthorship | null | undefined) => entry
    ? `${entry.actor.kind === 'agent' ? 'Agent ' : entry.actor.kind === 'device' ? 'Person on device ' : 'Person '}${entry.actor.id} · ${new Date(entry.at).toLocaleString()}` : 'Unknown'
  return `Created: ${describe(provenance?.created)}\nLast edited: ${describe(provenance?.lastEdited)}`
}

export function noteProvenanceAttributes(value: unknown): Record<string, string> {
  const provenance = readNoteBlockProvenance(value)
  const agents = [...new Set([provenance?.created?.actor, provenance?.lastEdited?.actor].filter(actor => actor?.kind === 'agent').map(actor => actor!.id))]
  return provenance ? { title: noteProvenanceDescription(provenance), ...(agents.length ? { 'data-note-agent-author': agents.map(id => 'Agent ' + id).join(' · ') } : {}) } : {}
}
