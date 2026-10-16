import { NOTE_SCHEMA } from './note-format.js'
import { NOTE_BLOCK_TYPES, noteContentSchema } from './note-content-schema.js'
import { readNoteBlockProvenance } from './note-provenance.js'
import { parseNoteLinkTarget, parseNoteWikiQuery } from '@agentmux/core/note-links'
import { isNoteWorkspaceRelativePath, parseNoteSharedMetadata } from '@agentmux/core/note-format'
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0

export function validateNoteDocument(value: unknown, allowUnanchored = false): number {
    if (!record(value) || value.schema !== NOTE_SCHEMA || !identity(value.noteId) || !record(value.content) || value.content.type !== 'doc') throw new Error('The Note schema or identity is missing or unsupported.')
    if (value.title !== undefined && (typeof value.title !== 'string' || !value.title.trim() || /[\0\r\n]/u.test(value.title))) throw new Error('The Note title must be nonempty single-line text.')
    parseNoteSharedMetadata(value)
    const blocks = new Set<string>(), references = new Set<string>(); let unanchored = 0
    const visit = (node: unknown): void => {
      if (!record(node) || !identity(node.type)) throw new Error('The Note contains an invalid content node.')
      const type = noteContentSchema.nodes[node.type]
      if (!type) throw new Error(`The Note contains an unsupported node: ${node.type}.`)
      if (Object.keys(node).some(key => !['type', 'attrs', 'content', 'marks', 'text'].includes(key))) throw new Error('The Note contains unsupported node data.')
      if (node.type === 'text' && typeof node.text !== 'string') throw new Error('The Note text is invalid.')
      if (node.type !== 'text' && node.text !== undefined) throw new Error('The Note contains text on a non-text node.')
      if (node.attrs !== undefined && (!record(node.attrs) || Object.keys(node.attrs).some(key => !(key in (type.spec.attrs ?? {}))))) throw new Error('The Note contains unsupported node attributes.')
      if (node.marks !== undefined) {
        if (!Array.isArray(node.marks)) throw new Error('The Note marks are invalid.')
        for (const mark of node.marks) {
          if (!record(mark) || !identity(mark.type) || !noteContentSchema.marks[mark.type]) throw new Error('The Note contains an unsupported mark.')
          if (Object.keys(mark).some(key => !['type', 'attrs'].includes(key))) throw new Error('The Note contains unsupported mark data.')
          const markType = noteContentSchema.marks[mark.type]!
          if (mark.attrs !== undefined && (!record(mark.attrs) || Object.keys(mark.attrs).some(key => !(key in (markType.spec.attrs ?? {}))))) throw new Error('The Note contains unsupported mark attributes.')
        }
      }
      if (NOTE_BLOCK_TYPES.some(type => type === node.type)) {
        if (allowUnanchored && (!record(node.attrs) || node.attrs.blockId == null)) unanchored++
        else { if (!record(node.attrs) || !identity(node.attrs.blockId) || blocks.has(node.attrs.blockId)) throw new Error('A semantic block identity is missing or duplicated.'); blocks.add(node.attrs.blockId) }
        readNoteBlockProvenance(record(node.attrs) ? node.attrs.provenance : undefined)
      }
      if (node.type === 'blockReference') {
        const attrs = node.attrs
        if (!record(attrs) || !identity(attrs.referenceId) || references.has(attrs.referenceId) || !record(attrs.target) || !identity(attrs.target.noteId) || !identity(attrs.target.blockId) || (attrs.mode !== 'reference' && attrs.mode !== 'embed')) throw new Error('A block reference identity or exact target is invalid.')
        references.add(attrs.referenceId)
      }
      if (node.type === 'noteInclude') {
        const attrs = node.attrs
        if (!record(attrs) || !identity(attrs.referenceId) || /[\0\r\n]/u.test(attrs.referenceId) || references.has(attrs.referenceId) || !identity(attrs.noteId) || /[\0\r\n]/u.test(attrs.noteId) || !isNoteWorkspaceRelativePath(attrs.path) || attrs.workspaceId != null && (!identity(attrs.workspaceId) || /[\0\r\n]/u.test(attrs.workspaceId))) throw new Error('A shared file include identity or Workspace path is invalid.')
        if (attrs.forwardedBlockIds != null && (!Array.isArray(attrs.forwardedBlockIds) || attrs.forwardedBlockIds.some(id => !identity(id) || /[\0\r\n]/u.test(id) || id === attrs.blockId))) throw new Error('The original shared include forwarding declarations are invalid.')
        references.add(attrs.referenceId)
      }
      if (node.type === 'noteLink') {
        const attrs = node.attrs
        if (!record(attrs) || !identity(attrs.referenceId) || references.has(attrs.referenceId) || typeof attrs.text !== 'string' || !attrs.text || /[\0\r\n]/u.test(attrs.text)) throw new Error('An inline Note link identity or text is invalid.')
        if (parseNoteWikiQuery(attrs.text).status !== 'valid') throw new Error('The editable Note link query is invalid. The original input is preserved.')
        if (attrs.target !== null) parseNoteLinkTarget(attrs.target)
        if (!Array.isArray(node.content) || node.content.some(child => !record(child) || child.type !== 'text' || child.marks !== undefined && (!Array.isArray(child.marks) || child.marks.length)) || node.content.map(child => (child as { text?: string }).text ?? '').join('') !== `[[${attrs.text}]]`) throw new Error('The editable Note link text and its query do not agree. The original input is preserved.')
        references.add(attrs.referenceId)
      }
      if (node.content !== undefined) {
        if (!Array.isArray(node.content)) throw new Error('The Note block tree is invalid.')
        node.content.forEach(visit)
      }
    }
    visit(value.content)
    noteContentSchema.nodeFromJSON(value.content).check()
    if (blocks.size + unanchored === 0) throw new Error('The Note has no semantic block.')
    return unanchored
}
