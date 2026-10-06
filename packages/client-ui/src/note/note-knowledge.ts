import type { JSONContent } from '@tiptap/core'
import { NOTE_FILE_EXTENSION, readNoteDocument, type NoteBlockTarget, type NoteDocument, type NoteDocumentRead } from './note-document.js'
import { noteContentSchema } from './note-content-schema.js'
import { indexNoteReferences, noteSemanticText } from './note-wikilinks.js'
import type { NoteGraphOccurrence, NoteGraphTarget } from '@agentmux/core/notebook-observation'
import type { NoteLinkTarget } from '@agentmux/core/note-links'
export type NoteFileDocument = { path: string; content: string; revision: string }
export type NoteLocation = { workspaceId: string; path: string }
export type NoteBlock = { blockId: string; content: JSONContent; text: string; list?: { type: string; attrs: Record<string, unknown>; index: number; item?: boolean } }
export type NoteSource = { location: NoteLocation; note: NoteDocument; revision: string; blocks: ReadonlyMap<string, NoteBlock> }
export type NoteBacklink = { source: NoteSource; blockId: string; occurrence: NoteGraphOccurrence; mode: 'reference' | 'embed' | 'link'; target: NoteGraphTarget }
export type NoteKnowledge = {
  scope: 'partial' | 'complete' | 'unknown'
  sources: readonly NoteSource[]
  invalid: readonly { location: NoteLocation; message: string }[]
  references: readonly NoteBacklink[]
}
export type NoteBlockResolution =
  | { status: 'resolved'; source: NoteSource; block: NoteBlock }
  | { status: 'ambiguous' | 'missing' | 'unknown'; message: string }

// A cache of the original immutable document, never another content or identity registry.
// Two displays of the same document share parsing; a content/revision change replaces that document.
const parsedDocuments = new WeakMap<NoteFileDocument, NoteDocumentRead>()
const indexedDocuments = new WeakMap<NoteFileDocument, { blocks: ReadonlyMap<string, NoteBlock>; references: Omit<NoteBacklink, 'source'>[] }>()
export function parseNoteFile(document: NoteFileDocument): NoteDocumentRead {
  const cached = parsedDocuments.get(document)
  if (cached) return cached
  const read = readNoteDocument(document.content)
  parsedDocuments.set(document, read)
  return read
}

/** Derive only from files the original owner has actually read. No discovery or IO at render time. */
export function noteKnowledge(documents: readonly { location: NoteLocation; document: NoteFileDocument }[], scope: NoteKnowledge['scope'] = 'partial'): NoteKnowledge {
  const sources: NoteSource[] = [], invalid: NoteKnowledge['invalid'][number][] = [], references: NoteBacklink[] = []
  const seen = new Set<string>()
  for (const { location, document } of documents) {
    if (!location.path.endsWith(NOTE_FILE_EXTENSION)) continue
    const key = JSON.stringify([location.workspaceId, location.path])
    if (seen.has(key)) continue
    seen.add(key)
    const read = parseNoteFile(document)
    if (read.status === 'invalid') { invalid.push({ location, message: read.message }); continue }
    let indexed = indexedDocuments.get(document)
    if (!indexed) {
      const blocks = new Map<string, NoteBlock>(), forward: Omit<NoteBacklink, 'source'>[] = []
      const tree = noteContentSchema.nodeFromJSON(read.note.content)
      tree.descendants((node, _position, parent, index) => {
        const blockId: unknown = node.attrs.blockId
        if (typeof blockId !== 'string') return
        const position = tree.resolve(_position)
        let list: NoteBlock['list']
        if (node.type.name === 'listItem' && parent) list = { type: parent.type.name, attrs: { ...parent.attrs }, index, item: true }
        else if (parent?.type.name === 'listItem' && position.depth >= 2) {
          const originalList = position.node(position.depth - 1)
          list = { type: originalList.type.name, attrs: { ...originalList.attrs }, index: position.index(position.depth - 1) }
        }
        blocks.set(blockId, { blockId, content: node.toJSON(), text: noteSemanticText(node), ...list ? { list } : {} })
      })
      forward.push(...indexNoteReferences(tree).map(reference => ({ ...reference, occurrence: reference.occurrence.kind === 'text' ? { ...reference.occurrence, revision: document.revision } : reference.occurrence })))
      indexed = { blocks, references: forward }
      indexedDocuments.set(document, indexed)
    }
    const source: NoteSource = { location, note: read.note, revision: document.revision, blocks: indexed.blocks }
    sources.push(source)
    references.push(...indexed.references.map(reference => ({ ...reference, source })))
  }
  return { scope, sources, invalid, references }
}

export function resolveNoteBlock(knowledge: NoteKnowledge, target: NoteBlockTarget): NoteBlockResolution {
  const sources = knowledge.sources.filter(source => source.note.noteId === target.noteId)
  if (sources.length > 1) return { status: 'ambiguous', message: 'This Note identity exists in multiple files. Choose the original source before editing.' }
  const source = sources[0]
  if (!source) return knowledge.scope === 'complete' && knowledge.invalid.length === 0
    ? { status: 'missing', message: 'The referenced Note is missing from the confirmed scope. Its reference is preserved.' }
    : { status: 'unknown', message: 'The referenced Note has not been confirmed in the current scope. Its reference is preserved.' }
  const block = source.blocks.get(target.blockId)
  return block ? { status: 'resolved', source, block }
    : { status: 'missing', message: 'The original Note no longer contains this block. Its reference is preserved.' }
}

/** Exact forward occurrences, not transitive embed expansion or the number of visible surfaces. */
export function noteBacklinks(knowledge: NoteKnowledge, target: NoteLinkTarget): readonly NoteBacklink[] {
  return knowledge.references.filter(reference => reference.target.kind !== 'unbound' && reference.target.noteId === target.noteId &&
    (target.blockId === undefined || reference.target.kind === 'block' && reference.target.blockId === target.blockId))
}

/** A reading projection; knowledge and identities always remain those of the complete original file. */
export function projectNoteBlocks(source: NoteSource, ids: readonly string[]): { content: JSONContent; shownBlockIds: string[]; missingBlockIds: string[]; rootBlockIds: string[] } {
  const requested = new Set(ids), covered = new Set<string>(), content: JSONContent[] = [], rootBlockIds: string[] = []
  const cover = (node: JSONContent) => {
    const id: unknown = node.attrs?.blockId
    if (typeof id === 'string') covered.add(id)
    node.content?.forEach(cover)
  }
  for (const block of source.blocks.values()) {
    if (!requested.has(block.blockId) || covered.has(block.blockId)) continue
    content.push(block.list ? { type: block.list.type, attrs: { ...block.list.attrs, ...(block.list.type === 'orderedList' ? { start: Number(block.list.attrs.start ?? 1) + block.list.index } : {}) }, content: [block.list.item ? block.content : { type: 'listItem', content: [block.content] }] } : block.content)
    rootBlockIds.push(block.blockId)
    cover(block.content)
  }
  return { content: { type: 'doc', content }, shownBlockIds: [...covered], rootBlockIds, missingBlockIds: ids.filter(id => !source.blocks.has(id)) }
}
