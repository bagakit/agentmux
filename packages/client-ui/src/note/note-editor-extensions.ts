import { mintObjectId } from '@agentmux/core/object-id'
import UniqueID from '@tiptap/extension-unique-id'
import { NOTE_BLOCK_TYPES, NoteBlockReferenceNode, NoteIncludeNode, NoteInlineLinkNode } from './note-content-schema.js'

/** Reading never allocates identities. New reference occurrences are authored by editor transactions;
 * missing semantic block IDs are assigned only by the original file writer. */
export function noteIdentityExtensions() {
  return [
    UniqueID.extend({ name: 'noteBlockUniqueId', onCreate() {} }).configure({ attributeName: 'blockId', types: [...NOTE_BLOCK_TYPES], generateID: () => null, filterTransaction: transaction => !transaction.getMeta('preventUpdate') && !transaction.getMeta('noteSelectionRestore') }),
    UniqueID.extend({ name: 'noteReferenceUniqueId', onCreate() {} }).configure({ attributeName: 'referenceId', types: [NoteBlockReferenceNode.name, NoteIncludeNode.name, NoteInlineLinkNode.name], generateID: () => mintObjectId(), filterTransaction: transaction => !transaction.getMeta('preventUpdate') && !transaction.getMeta('noteSelectionRestore') })
  ]
}
export { closeHistory } from '@tiptap/pm/history'
