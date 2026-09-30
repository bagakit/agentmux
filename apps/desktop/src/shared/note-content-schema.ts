import { Extension, Node, getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'

export const NOTE_BLOCK_TYPES = ['paragraph', 'heading', 'codeBlock', 'listItem', 'blockquote', 'horizontalRule', 'blockReference'] as const

const BlockIdentity = Extension.create({
  name: 'noteBlockIdentity',
  addGlobalAttributes() {
    return [{ types: [...NOTE_BLOCK_TYPES], attributes: { blockId: { default: null,
      parseHTML: element => element.getAttribute('data-block-id'),
      renderHTML: attrs => attrs.blockId ? { 'data-block-id': attrs.blockId } : {}
    } } }]
  }
})

export const NoteBlockReferenceNode = Node.create({
  name: 'blockReference',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      referenceId: { default: null, parseHTML: element => element.getAttribute('data-reference-id'), renderHTML: attrs => attrs.referenceId ? { 'data-reference-id': attrs.referenceId } : {} },
      target: { default: null, parseHTML: element => {
        try { return JSON.parse(element.getAttribute('data-note-target') ?? 'null') } catch { return null }
      }, renderHTML: attrs => attrs.target ? { 'data-note-target': JSON.stringify(attrs.target) } : {} },
      mode: { default: 'reference', parseHTML: element => element.getAttribute('data-note-reference-mode'), renderHTML: attrs => ({ 'data-note-reference-mode': attrs.mode }) }
    }
  },
  parseHTML() { return [{ tag: 'div[data-note-block-reference]' }] },
  renderHTML({ HTMLAttributes }) { return ['div', { ...HTMLAttributes, 'data-note-block-reference': '' }] }
})

/** The parser and rich editor share the installed TipTap node/mark schema. */
export function noteContentExtensions() {
  return [StarterKit.configure({ trailingNode: false }), BlockIdentity, NoteBlockReferenceNode]
}
export const noteContentSchema: ReturnType<typeof getSchema> = getSchema(noteContentExtensions())
