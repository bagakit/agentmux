import { Extension, type Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { Plugin } from '@tiptap/pm/state'
import { Mapping } from '@tiptap/pm/transform'
import type { NoteInlineLinkAttributes } from '@agentmux/core/note-links'
import { noteInlineLinkContent, noteInlineQuery, noteWikiTextTokens } from './note-wikilinks.js'

export function closeNoteWikiHistory(editor: Editor): void { editor.view.dispatch(closeHistory(editor.state.tr)) }

/** Only changed textblocks are considered; the canonical writer uses the same token adapter. */
export function noteWikiInputExtension(created?: (link: NoteInlineLinkAttributes, previousReferenceId?: string) => void) {
  return Extension.create({ name: 'noteWikiInput', addProseMirrorPlugins() {
    const editor = this.editor
    return [new Plugin({
      props: { handleDOMEvents: { compositionend() {
        queueMicrotask(() => { if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('noteWikiCompositionEnd', true)) })
        return false
      } } },
      appendTransaction(transactions, _old, state) {
        if (transactions.some(tr => tr.getMeta('noteWikiInput')) || editor.view.composing) return null
        if (!transactions.some(tr => tr.getMeta('noteWikiCompositionEnd') || tr.docChanged && !tr.getMeta('noteSelectionRestore') && !tr.getMeta('preventUpdate') && !tr.getMeta('__uniqueIDTransaction') && tr.getMeta('addToHistory') !== false)) return null
        const blocks = new Map<number, typeof state.doc>()
        const maps = transactions.flatMap(tr => tr.mapping.maps)
        for (let i = 0; i < maps.length; i++) maps[i]!.forEach((_a, _b, from, to) => {
          const after = new Mapping(maps.slice(i + 1)), start = after.map(from, -1), end = after.map(to, 1)
          state.doc.nodesBetween(Math.max(0, start - 1), Math.min(state.doc.content.size, end + 1), (node, pos) => {
            if (node.type.name === 'codeBlock') return false
            if (node.isTextblock) { blocks.set(pos, node); return false }
          })
        })
        if (!maps.length) {
          const selection = state.selection
          for (let depth = selection.$from.depth; depth > 0; depth--) {
            const node = selection.$from.node(depth)
            if (node.isTextblock) { if (node.type.name !== 'codeBlock') blocks.set(selection.$from.before(depth), node); break }
          }
        }
        const tokens = [...blocks].flatMap(([pos, node]) => noteWikiTextTokens(node.toJSON().content ?? [], true).map(token => ({ ...token, from: pos + 1 + token.from, to: pos + 1 + token.to })))
        const tr = state.tr.setMeta('noteWikiInput', true), pending: { link: NoteInlineLinkAttributes; previousReferenceId?: string }[] = []
        const edits: { from: number; apply(): void }[] = tokens.map(token => ({ from: token.from, apply() {
          const link = { referenceId: crypto.randomUUID(), text: token.text, target: null }
          tr.replaceWith(token.from, token.to, state.schema.nodeFromJSON({ ...noteInlineLinkContent(link), marks: state.doc.resolve(token.from).marks().map(mark => mark.toJSON()) }))
          pending.push({ link })
        } }))
        for (const [blockPos, block] of blocks) block.descendants((node, offset) => {
          if (node.type.name !== 'noteLink') return
          const pos = blockPos + 1 + offset
          const text = noteInlineQuery(node.textContent)
          if (text === node.attrs.text) return false
          edits.push({ from: pos, apply() {
            if (text === null) tr.replaceWith(pos, pos + node.nodeSize, node.textContent ? state.schema.text(node.textContent, node.marks) : [])
            else {
              // A changed query is a new lookup generation, including A -> B -> A. A late
              // response for the old occurrence cannot reattach its former exact target.
              const link = { referenceId: crypto.randomUUID(), text, target: null }
              tr.setNodeMarkup(pos, undefined, link); pending.push({ link, previousReferenceId: node.attrs.referenceId })
            }
          } })
          return false
        })
        if (!edits.length) return null
        for (const edit of edits.sort((a, b) => b.from - a.from)) {
          edit.apply()
        }
        if (created) queueMicrotask(() => { if (!editor.isDestroyed) for (const entry of pending) created(entry.link, entry.previousReferenceId) })
        return tr
      }
    })]
  } })
}
