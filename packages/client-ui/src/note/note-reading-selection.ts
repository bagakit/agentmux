import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/** Read-only emphasis of exact original identities; no content or selection transaction is written. */
export function noteReadingSelectionExtension(selected: () => readonly string[]) {
  return Extension.create({ name: 'noteReadingSelection', addProseMirrorPlugins() {
    return [new Plugin({ props: { decorations(state) {
      const ids = new Set(selected()), decorations: Decoration[] = []
      if (ids.size) state.doc.descendants((node, pos) => {
        if (typeof node.attrs.blockId === 'string' && ids.has(node.attrs.blockId)) decorations.push(Decoration.node(pos, pos + node.nodeSize, { 'data-note-selected-block': node.attrs.blockId }))
      })
      return DecorationSet.create(state.doc, decorations)
    } } })]
  } })
}
