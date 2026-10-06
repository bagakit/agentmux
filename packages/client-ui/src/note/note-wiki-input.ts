import { Extension, type Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { Plugin } from '@tiptap/pm/state'
import { Mapping } from '@tiptap/pm/transform'
import type { NoteInlineLinkAttributes } from '@agentmux/core/note-links'
import { noteWikiTextTokens } from './note-wikilinks.js'

export function closeNoteWikiHistory(editor: Editor): void { editor.view.dispatch(closeHistory(editor.state.tr)) }

/** Only changed textblocks are considered; the canonical writer uses the same token adapter. */
export function noteWikiInputExtension(created?: (link: NoteInlineLinkAttributes) => void) {
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
          if (selection.$from.parent.isTextblock && selection.$from.parent.type.name !== 'codeBlock') blocks.set(selection.$from.before(), selection.$from.parent)
        }
        const tokens = [...blocks].flatMap(([pos, node]) => noteWikiTextTokens(node.toJSON().content ?? []).map(token => ({ ...token, from: pos + 1 + token.from, to: pos + 1 + token.to }))).sort((a, b) => b.from - a.from)
        if (!tokens.length) return null
        const tr = state.tr.setMeta('noteWikiInput', true), pending: NoteInlineLinkAttributes[] = []
        for (const token of tokens) {
          const link = { referenceId: crypto.randomUUID(), text: token.text, target: null }
          tr.replaceWith(token.from, token.to, state.schema.nodes.noteLink!.create(link, null, state.doc.resolve(token.from).marks()))
          pending.push(link)
        }
        if (created) queueMicrotask(() => { if (!editor.isDestroyed) for (const link of pending) created(link) })
        return tr
      }
    })]
  } })
}
