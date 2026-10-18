import { Extension } from '@tiptap/core'
import { DOMSerializer } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import type { NodeViewConstructor } from '@tiptap/pm/view'
import { noteContentExtensions } from '../note/note-content-schema.js'
import { NoteCodeBlock } from './NoteCodeBlock.js'
import { NoteMathInline, NoteMathBlock } from './NoteMath.js'

// Provenance has no DOM attributes in the canonical schema. Updating that saved
// metadata must not recreate an ancestor of a focused formula or diagram editor.
const provenanceContainerView: NodeViewConstructor = (node, view) => {
  const rendered = DOMSerializer.renderSpec(view.dom.ownerDocument, node.type.spec.toDOM!(node))
  let current = node
  return { ...rendered, update(next) {
    if (!current.hasMarkup(next.type, { ...next.attrs, provenance: current.attrs.provenance }, next.marks)) return false
    current = next
    return true
  } }
}
const provenanceContainers = Extension.create({
  name: 'noteProvenanceContainers',
  addProseMirrorPlugins() {
    return [new Plugin({ props: { nodeViews: {
      paragraph: provenanceContainerView, heading: provenanceContainerView,
      listItem: provenanceContainerView, blockquote: provenanceContainerView
    } } })]
  }
})

/** Client-only node views share the canonical schema used by files and public writes. */
export function noteRichContentExtensions() {
  return [...noteContentExtensions().map(extension => extension.name === 'starterKit' ? extension.configure({ codeBlock: false })
    : extension.name === 'noteMathInline' ? NoteMathInline : extension.name === 'noteMathBlock' ? NoteMathBlock : extension), NoteCodeBlock, provenanceContainers]
}
