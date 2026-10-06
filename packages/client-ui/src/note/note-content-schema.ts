import { Extension, Node, getSchema } from '@tiptap/core'
import UniqueID from '@tiptap/extension-unique-id'
import StarterKit from '@tiptap/starter-kit'
import { noteProvenanceAttributes } from './note-provenance.js'

export const NOTE_BLOCK_TYPES = ['paragraph', 'heading', 'codeBlock', 'listItem', 'blockquote', 'horizontalRule', 'blockReference'] as const

const BlockIdentity = Extension.create({
  name: 'noteBlockIdentity',
  addGlobalAttributes() {
    return [{ types: [...NOTE_BLOCK_TYPES], attributes: { blockId: { default: null,
      parseHTML: element => element.getAttribute('data-block-id'),
      renderHTML: attrs => attrs.blockId ? { 'data-block-id': attrs.blockId } : {}
    }, provenance: { default: null, parseHTML: () => null, renderHTML: attrs => noteProvenanceAttributes(attrs.provenance) } } }]
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
export const NoteInlineLinkNode = Node.create({
  name: 'noteLink', group: 'inline', inline: true, atom: true,
  addAttributes() {
    return {
      referenceId: { default: null }, text: { default: '' }, target: { default: null }
    }
  },
  parseHTML() { return [{ tag: 'span[data-note-link]', getAttrs: element => {
    try { return JSON.parse((element as HTMLElement).getAttribute('data-note-link') ?? 'null') } catch { return false }
  } }] },
  renderHTML({ node }) { return ['span', { 'data-note-link': JSON.stringify(node.attrs) }, `[[${String(node.attrs.text)}]]`] },
  renderText({ node }) { return `[[${String(node.attrs.text)}]]` }
})

/** The parser and rich editor share the installed TipTap node/mark schema. */
export function noteContentExtensions() {
  return [StarterKit.configure({ trailingNode: false }), BlockIdentity, NoteBlockReferenceNode, NoteInlineLinkNode]
}
export const noteContentSchema: ReturnType<typeof getSchema> = getSchema(noteContentExtensions())

/** The original editor allocators: only missing/new block and reference identities are assigned. */
export function noteIdentityExtensions() {
  return [
    UniqueID.extend({ name: 'noteBlockUniqueId' }).configure({ attributeName: 'blockId', types: [...NOTE_BLOCK_TYPES] }),
    UniqueID.extend({ name: 'noteReferenceUniqueId' }).configure({ attributeName: 'referenceId', types: [NoteBlockReferenceNode.name, NoteInlineLinkNode.name] })
  ]
}
