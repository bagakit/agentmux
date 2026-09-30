import type { JSONContent } from '@tiptap/core'
import type { FileDocument } from '../../../shared/contracts'
import { NOTE_FILE_EXTENSION, readNoteDocument, type NoteBlockTarget, type NoteDocument, type NoteDocumentRead } from '../../../shared/note-document'
import { noteContentSchema } from '../../../shared/note-content-schema'
import { documentKey } from './workbench-tabs'

export type NoteLocation = { workspaceId: string; path: string }
export type NoteBlock = { blockId: string; content: JSONContent; text: string }
export type NoteSource = { location: NoteLocation; note: NoteDocument; blocks: ReadonlyMap<string, NoteBlock> }
export type NoteBacklink = { source: NoteSource; blockId: string; referenceId: string; mode: 'reference' | 'embed'; target: NoteBlockTarget }
export type NoteKnowledge = {
  scope: 'partial' | 'complete' | 'unknown'
  sources: readonly NoteSource[]
  invalid: readonly { location: NoteLocation; message: string }[]
  references: readonly NoteBacklink[]
}
export type NoteBlockResolution =
  | { status: 'resolved'; source: NoteSource; block: NoteBlock }
  | { status: 'ambiguous' | 'missing' | 'unknown'; message: string }

export function loadedNoteFiles(documents: Readonly<Record<string, FileDocument>>): { location: NoteLocation; document: FileDocument }[] {
  return Object.entries(documents).flatMap(([key, document]) => {
    const separator = key.indexOf('\0'), workspaceId = key.slice(0, separator)
    return separator > 0 && key === documentKey(workspaceId, document.path) && document.path.endsWith(NOTE_FILE_EXTENSION)
      ? [{ location: { workspaceId, path: document.path }, document }] : []
  })
}

const noteFilesByDocuments = new WeakMap<Readonly<Record<string, FileDocument>>, Readonly<Record<string, FileDocument>>>()
/** Immutable Files input is the cache key; unrelated Store updates do no document enumeration. */
export function noteFilesFromDocuments(documents: Readonly<Record<string, FileDocument>>): Readonly<Record<string, FileDocument>> {
  const noteFiles = noteFilesByDocuments.get(documents)
  if (noteFiles) return noteFiles
  const derived = Object.fromEntries(loadedNoteFiles(documents).map(({ location, document }) => [documentKey(location.workspaceId, location.path), document]))
  noteFilesByDocuments.set(documents, derived)
  return derived
}

// A cache of the original immutable document, never another content or identity registry.
// Two displays of the same document share parsing; a content/revision change replaces that document.
const parsedDocuments = new WeakMap<FileDocument, NoteDocumentRead>()
const indexedDocuments = new WeakMap<FileDocument, { blocks: ReadonlyMap<string, NoteBlock>; references: Omit<NoteBacklink, 'source'>[] }>()
export function parseNoteFile(document: FileDocument): NoteDocumentRead {
  const cached = parsedDocuments.get(document)
  if (cached) return cached
  const read = readNoteDocument(document.content)
  parsedDocuments.set(document, read)
  return read
}

/** Derive only from files the original owner has actually read. No discovery or IO at render time. */
export function noteKnowledge(documents: readonly { location: NoteLocation; document: FileDocument }[], scope: NoteKnowledge['scope'] = 'partial'): NoteKnowledge {
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
      tree.descendants(node => {
        const blockId: unknown = node.attrs.blockId
        if (typeof blockId === 'string') blocks.set(blockId, { blockId, content: node.toJSON(), text: node.textContent })
        if (node.type.name === 'blockReference') forward.push({ blockId: node.attrs.blockId, referenceId: node.attrs.referenceId, mode: node.attrs.mode, target: node.attrs.target })
      })
      indexed = { blocks, references: forward }
      indexedDocuments.set(document, indexed)
    }
    const source: NoteSource = { location, note: read.note, blocks: indexed.blocks }
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
export function noteBacklinks(knowledge: NoteKnowledge, target: NoteBlockTarget): readonly NoteBacklink[] {
  return knowledge.references.filter(reference => reference.target.noteId === target.noteId && reference.target.blockId === target.blockId)
}
