import { Extension, Mark, Node, getSchema } from '@tiptap/core'
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

/** CommonMark escaping is semantic: a literal wiki label must not become a query. */
const NoteWikiLiteral = Mark.create({ name: 'noteWikiLiteral', inclusive: false,
  parseHTML() { return [{ tag: 'span[data-note-wiki-literal]' }] },
  renderHTML() { return ['span', { 'data-note-wiki-literal': '' }, 0] }
})

/** The parser and rich editor share the installed TipTap node/mark schema. */
export function noteContentExtensions() {
  return [StarterKit.configure({ trailingNode: false }), BlockIdentity, NoteBlockReferenceNode, NoteInlineLinkNode, NoteWikiLiteral]
}
export const noteContentSchema: ReturnType<typeof getSchema> = getSchema(noteContentExtensions())

/** Reading never allocates identities. New reference occurrences are authored by editor transactions;
 * missing semantic block IDs are assigned only by the original file writer. */
export function noteIdentityExtensions() {
  return [
    UniqueID.extend({ name: 'noteBlockUniqueId', onCreate() {} }).configure({ attributeName: 'blockId', types: [...NOTE_BLOCK_TYPES], generateID: () => null, filterTransaction: transaction => !transaction.getMeta('preventUpdate') && !transaction.getMeta('noteSelectionRestore') }),
    UniqueID.extend({ name: 'noteReferenceUniqueId', onCreate() {} }).configure({ attributeName: 'referenceId', types: [NoteBlockReferenceNode.name, NoteInlineLinkNode.name], generateID: () => crypto.randomUUID(), filterTransaction: transaction => !transaction.getMeta('preventUpdate') && !transaction.getMeta('noteSelectionRestore') })
  ]
}
