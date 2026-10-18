import type { JSONContent } from '@tiptap/core'
import { NOTE_FILE_EXTENSION, readNoteDocument, type NoteBlockTarget, type NoteDocument, type NoteDocumentRead } from './note-document.js'
import { noteContentSchema } from './note-content-schema.js'
import { indexNoteReferences, noteSemanticText } from './note-wikilinks.js'
import { resolveObservedNoteBlock, type NoteBlockForwarding, type NoteGraphOccurrence, type NoteGraphTarget } from '@agentmux/core/notebook-observation'
import type { NoteLinkTarget } from '@agentmux/core/note-links'
import type { NoteProvenanceSnapshot } from '@agentmux/core/note-provenance'
import { fileUploadRevision } from '@agentmux/core/files'
import { hydrateNoteProvenance } from './note-metadata.js'
export type NoteFileDocument = { path: string; content: string; revision: string; noteProvenance?: NoteProvenanceSnapshot }
export type NoteLocation = { workspaceId: string; path: string }
export type NoteBlock = { blockId: string; content: JSONContent; text: string; list?: { type: string; attrs: Record<string, unknown>; index: number; item?: boolean; itemType?: string; itemAttrs?: Record<string, unknown> } }
export type NoteSource = { location: NoteLocation; note: NoteDocument; revision: string; blocks: ReadonlyMap<string, NoteBlock>; blockForwardings: readonly NoteBlockForwarding[] }
export type NoteBacklink = { source: NoteSource; blockId: string; occurrence: NoteGraphOccurrence; mode: 'reference' | 'embed' | 'link'; target: NoteGraphTarget }
export type NoteKnowledge = {
  scope: 'partial' | 'complete' | 'unknown'
  /** File identity coverage is independent of optional paragraph anchors. */
  fileScope?: 'partial' | 'complete' | 'unknown'
  confirmedIncludes?: readonly (NoteLocation & { noteId: string; revision: string })[]
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
const indexedDocuments = new WeakMap<NoteDocument, { blocks: ReadonlyMap<string, NoteBlock>; blockForwardings: readonly NoteBlockForwarding[]; references: Omit<NoteBacklink, 'source'>[] }>()
export function parseNoteFile(document: NoteFileDocument): NoteDocumentRead {
  const cached = parsedDocuments.get(document)
  if (cached) return cached
  const parsed = readNoteDocument(document.content)
  const read = parsed.status === 'valid' && document.noteProvenance && document.noteProvenance.resource.path === document.path
    ? { ...parsed, note: hydrateNoteProvenance(parsed.note, document.noteProvenance, fileUploadRevision(new TextEncoder().encode(document.content))) }
    : parsed
  parsedDocuments.set(document, read)
  return read
}

/** Derive only from files the original owner has actually read. No discovery or IO at render time. */
export function noteKnowledge(documents: readonly { location: NoteLocation; document: NoteFileDocument }[], scope: NoteKnowledge['scope'] = 'partial', confirmedIncludes: NonNullable<NoteKnowledge['confirmedIncludes']> = []): NoteKnowledge {
  const sources: NoteSource[] = [], invalid: NoteKnowledge['invalid'][number][] = [], references: NoteBacklink[] = []
  const seen = new Set<string>(); let unanchored = false
  for (const { location, document } of documents) {
    if (!location.path.endsWith(NOTE_FILE_EXTENSION)) continue
    const key = JSON.stringify([location.workspaceId, location.path])
    if (seen.has(key)) continue
    seen.add(key)
    const read = parseNoteFile(document.noteProvenance && document.noteProvenance.resource.workspaceId !== location.workspaceId ? { path: document.path, content: document.content, revision: document.revision } : document)
    if (read.status === 'invalid') { invalid.push({ location, message: read.message }); continue }
    unanchored ||= read.unanchoredBlockCount > 0
    let indexed = indexedDocuments.get(read.note)
    if (!indexed) {
      const blockForwardings: NoteBlockForwarding[] = [], blocks = new Map<string, NoteBlock>(), forward: Omit<NoteBacklink, 'source'>[] = []
      const tree = noteContentSchema.nodeFromJSON(read.note.content)
      tree.descendants((node, _position, parent, index) => {
        const blockId: unknown = node.attrs.blockId
        if (typeof blockId !== 'string') return
        const position = tree.resolve(_position)
        let list: NoteBlock['list']
        if (['listItem', 'taskItem'].includes(node.type.name) && parent) list = { type: parent.type.name, attrs: { ...parent.attrs }, index, item: true }
        else if (parent && ['listItem', 'taskItem'].includes(parent.type.name) && position.depth >= 2) {
          const originalList = position.node(position.depth - 1)
          list = { type: originalList.type.name, attrs: { ...originalList.attrs }, index: position.index(position.depth - 1), itemType: parent.type.name, itemAttrs: { ...parent.attrs } }
        }
        if (node.type.name === 'noteInclude' && Array.isArray(node.attrs.forwardedBlockIds)) blockForwardings.push(...node.attrs.forwardedBlockIds.map((id: string) => ({ blockId: id, includeBlockId: blockId, noteId: String(node.attrs.noteId) })))
        blocks.set(blockId, { blockId, content: node.toJSON(), text: noteSemanticText(node), ...list ? { list } : {} })
      })
      forward.push(...indexNoteReferences(tree).map(reference => ({ ...reference, occurrence: reference.occurrence.kind === 'text' ? { ...reference.occurrence, revision: document.revision } : reference.occurrence })))
      indexed = { blocks, blockForwardings, references: forward }
      indexedDocuments.set(read.note, indexed)
    }
    const source: NoteSource = { location, note: read.note, revision: document.revision, blocks: indexed.blocks, blockForwardings: indexed.blockForwardings }
    sources.push(source)
    references.push(...indexed.references.map(reference => ({ ...reference, source })))
  }
  return { scope: unanchored && scope === 'complete' ? 'partial' : scope, fileScope: invalid.length && scope === 'complete' ? 'partial' : scope, sources, invalid, references, ...(confirmedIncludes.length ? { confirmedIncludes } : {}) }
}

/** Compact display text preserves structure without changing canonical indexed text or the original file. */
export function noteContentSummary(note: NoteDocument): string {
  for (const block of note.content.content ?? []) {
    const text = noteSemanticText(noteContentSchema.nodeFromJSON(block), ' · ').replace(/\s+/gu, ' ').trim()
    if (text) return text
  }
  return ''
}

export function resolveNoteBlock(knowledge: NoteKnowledge, target: NoteBlockTarget): NoteBlockResolution {
  const sources = knowledge.sources.filter(source => source.note.noteId === target.noteId)
  if (sources.length > 1) return { status: 'ambiguous', message: 'This Note identity exists in multiple files. Choose the original source before editing.' }
  const source = sources[0]
  if (!source) return knowledge.scope === 'complete' && knowledge.invalid.length === 0
    ? { status: 'missing', message: 'The referenced Note is missing from the confirmed scope. Its reference is preserved.' }
    : { status: 'unknown', message: 'The referenced Note has not been confirmed in the current scope. Its reference is preserved.' }
  const own = source.blocks.get(target.blockId), declared = source.blockForwardings.some(item => item.blockId === target.blockId)
  if (own && !declared) return { status: 'resolved', source, block: own }
  if (!own && !declared) return { status: 'missing', message: 'The original Note no longer contains this block. Its reference is preserved.' }
  const result = resolveObservedNoteBlock(knowledge.sources.map(item => ({ noteId: item.note.noteId, status: 'read', get blockIds() { return [...item.blocks.keys()] }, blockForwardings: item.blockForwardings,
    ...(item.note.kind ? { kind: item.note.kind, fileIdentity: (knowledge.fileScope ?? knowledge.scope) === 'complete' && knowledge.invalid.length === 0 || knowledge.confirmedIncludes?.some(confirmed => confirmed.noteId === item.note.noteId && confirmed.workspaceId === item.location.workspaceId && confirmed.path === item.location.path && confirmed.revision === item.revision) ? 'confirmed' as const : 'unknown' as const } : {}) })), target)
  if (result.status === 'resolved') {
    const actual = knowledge.sources.find(item => item.note.noteId === result.target.noteId)!, block = actual.blocks.get(result.target.blockId)!
    return { status: 'resolved', source: actual, block }
  }
  return { status: result.status, message: result.status === 'ambiguous' ? 'This original address has multiple saved forwarding declarations or duplicate file identities. Preserve it and inspect the original files.' : result.status === 'unknown' ? 'The original forwarded shared content is not confirmed. Read its original files; the address is preserved.' : 'The original Note no longer contains this block. Its reference is preserved.' }
}

/** The path hint cannot prove uniqueness. The observed scope and stable file identity do. */
export function resolveNoteInclude(knowledge: NoteKnowledge, target: { noteId: string }, _workspaceId?: string, confirmed?: NoteLocation & { revision: string }): { status: 'resolved'; source: NoteSource } | { status: 'ambiguous' | 'missing' | 'unknown'; message: string } {
  const sources = knowledge.sources.filter(source => source.note.noteId === target.noteId)
  if (sources.length > 1) return { status: 'ambiguous', message: 'This shared file identity exists in multiple original files. Preserve the include and choose the original source.' }
  const source = sources[0]
  // A bounded reader may consume one identity already confirmed by the original graph.
  // Its exact resource/revision must still match the actually loaded Markdown.
  if (source?.note.kind === 'shared-block' && confirmed?.workspaceId === source.location.workspaceId && confirmed.path === source.location.path && confirmed.revision === source.revision) return { status: 'resolved', source }
  if ((knowledge.fileScope ?? knowledge.scope) !== 'complete' || knowledge.invalid.length) return { status: 'unknown', message: 'The original shared file identity is not uniquely confirmed in this scope. Refresh its original files.' }
  if (!source) return { status: 'missing', message: 'The shared file is missing from the confirmed scope. Its include is preserved.' }
  if (source.note.kind !== 'shared-block') return { status: 'unknown', message: 'The exact file is not confirmed as shared content. Preserve the include and inspect its original header.' }
  return { status: 'resolved', source }
}

/** Exact forward occurrences, not transitive embed expansion or the number of visible surfaces. */
export function noteBacklinks(knowledge: NoteKnowledge, target: NoteLinkTarget): readonly NoteBacklink[] {
  return knowledge.references.filter(reference => reference.target.kind !== 'unbound' && reference.target.noteId === target.noteId &&
    (target.blockId === undefined || reference.target.kind === 'block' && reference.target.blockId === target.blockId))
}

/** A reading projection; knowledge and identities always remain those of the complete original file. */
export function projectNoteBlocks(source: NoteSource, ids: readonly string[], priorityIds: readonly string[] = []): { content: JSONContent; shownBlockIds: string[]; missingBlockIds: string[]; rootBlockIds: string[] } {
  const requested = new Set(ids), covered = new Set<string>(), content: JSONContent[] = [], rootBlockIds: string[] = []
  const cover = (node: JSONContent) => {
    const id: unknown = node.attrs?.blockId
    if (typeof id === 'string') covered.add(id)
    node.content?.forEach(cover)
  }
  for (const block of source.blocks.values()) {
    if (!requested.has(block.blockId) || covered.has(block.blockId)) continue
    content.push(block.list ? { type: block.list.type, attrs: { ...block.list.attrs, ...(block.list.type === 'orderedList' ? { start: Number(block.list.attrs.start ?? 1) + block.list.index } : {}) }, content: [block.list.item ? block.content : { type: block.list.itemType ?? 'listItem', attrs: block.list.itemAttrs, content: [block.content] }] } : block.content)
    rootBlockIds.push(block.blockId)
    cover(block.content)
  }
  const priority = new Set(priorityIds)
  const containsSelected = (node: JSONContent): boolean => priority.has(String(node.attrs?.blockId)) || Boolean(node.content?.some(containsSelected))
  const ordered = content.map((node, index) => ({ node, index, selected: containsSelected(node) })).sort((a, b) => Number(b.selected) - Number(a.selected) || a.index - b.index)
  return { content: { type: 'doc', content: ordered.map(item => item.node) }, shownBlockIds: [...covered], rootBlockIds, missingBlockIds: ids.filter(id => !source.blocks.has(id)) }
}
