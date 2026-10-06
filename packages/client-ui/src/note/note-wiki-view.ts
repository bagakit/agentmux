import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { noteWikiTextTokens } from './note-wikilinks.js'
import type { NoteLinkOpenRequest } from '../components/NoteInlineLink.js'

/** Saved raw syntax is a view of original text, never a minted or persisted link node. */
export function noteWikiLiteralExtension(open: (link: NoteLinkOpenRequest) => void) {
  return Extension.create({ name: 'noteWikiLiteralLinks', addProseMirrorPlugins() {
    return [new Plugin({ props: {
      decorations(state) {
        const decorations: Decoration[] = []
        state.doc.descendants((node, pos) => {
          if (node.type.name === 'codeBlock') return false
          if (!node.isTextblock) return
          const tokens = noteWikiTextTokens(node.toJSON().content ?? [])
          for (const token of tokens) decorations.push(Decoration.inline(pos + 1 + token.from, pos + 1 + token.to,
            { class: 'note-inline-link note-inline-link--unbound', style: 'cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px', 'data-note-wiki-text': token.text, 'data-note-wiki-from': String(pos + 1 + token.from), 'data-note-wiki-to': String(pos + 1 + token.to), role: 'link', tabindex: '0', title: 'Unconfirmed page query · open to choose or retry' }))
        })
        return DecorationSet.create(state.doc, decorations)
      },
      handleDOMEvents: {
        click(view, event) {
          const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-note-wiki-text]') : null
          if (!target || view.editable && !(event.metaKey || event.ctrlKey)) return false
          event.preventDefault(); event.stopPropagation(); open({ text: target.dataset.noteWikiText!, target: null, rawRange: { from: Number(target.dataset.noteWikiFrom), to: Number(target.dataset.noteWikiTo) } }); return true
        },
        keydown(_view, event) {
          const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-note-wiki-text]') : null
          if (!target || event.key !== 'Enter' || event.isComposing) return false
          event.preventDefault(); open({ text: target.dataset.noteWikiText!, target: null, rawRange: { from: Number(target.dataset.noteWikiFrom), to: Number(target.dataset.noteWikiTo) } }); return true
        }
      }
    } })]
  } })
}
