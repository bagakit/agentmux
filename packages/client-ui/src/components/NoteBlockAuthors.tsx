import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { Root as DismissableLayer } from '@radix-ui/react-dismissable-layer'
import { NOTE_BLOCK_TYPES } from '../note/note-content-schema.js'
import { readNoteBlockProvenance, type NoteBlockAuthorship, type NoteBlockProvenance } from '../note/note-provenance.js'
import { useModalOverlayContainer } from './Modal.js'

type AgentNames = Readonly<Record<string, string>>
type OpenAuthor = { anchor: HTMLButtonElement; provenance: NoteBlockProvenance | null; reference: boolean }
const EMPTY_NAMES: AgentNames = {}
const authorsKey = new PluginKey<DecorationSet>('noteBlockAuthors')
const authorName = (entry: NoteBlockAuthorship | null | undefined, names: AgentNames) => !entry ? 'Author unconfirmed'
  : entry.actor.kind === 'agent' ? `Agent · ${names[entry.actor.id] || (entry.actor.id.length > 12 ? entry.actor.id.slice(0, 8) + '…' : entry.actor.id)}`
    : entry.actor.kind === 'device' ? 'Person on device' : 'Person'

/** Saved attribution is a reading decoration, never part of copied or edited Markdown. */
export function NoteBlockAuthors({ editor, agentNames = EMPTY_NAMES }: { editor: Editor | null; agentNames?: AgentNames | undefined }) {
  const [opened, open] = useState<OpenAuthor | null>(null), panel = useRef<HTMLDivElement>(null), id = useId()
  const names = useRef(agentNames); names.current = agentNames
  const container = useModalOverlayContainer(opened?.anchor.ownerDocument.body)
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const decorate = (doc: typeof editor.state.doc) => {
      const decorations: Decoration[] = []
      doc.descendants((node, position) => {
        if (!NOTE_BLOCK_TYPES.includes(node.type.name as typeof NOTE_BLOCK_TYPES[number]) || !node.attrs.blockId) return
        const provenance = readNoteBlockProvenance(node.attrs.provenance)
        const entry = provenance?.lastEdited?.actor.kind === 'agent' ? provenance.lastEdited : provenance?.created?.actor.kind === 'agent' ? provenance.created : provenance?.lastEdited ?? provenance?.created
        const label = authorName(entry, names.current)
        const unknown = !provenance?.created || !provenance?.lastEdited
        const human = !unknown && provenance?.created?.actor.kind !== 'agent' && provenance?.lastEdited?.actor.kind !== 'agent'
        const reference = node.type.name === 'noteInclude' || node.type.name === 'blockReference'
        const afterBlock = ['codeBlock', 'table', 'noteRawBlock'].includes(node.type.name)
        decorations.push(Decoration.widget(position + node.nodeSize - (node.isLeaf || afterBlock ? 0 : 1), view => {
          const button = view.dom.ownerDocument.createElement('button')
          button.type = 'button'; button.contentEditable = 'false'; button.className = 'note-block-author nodrag nopan'
          button.dataset.authorBlock = node.attrs.blockId
          if (afterBlock) button.dataset.authorPlacement = 'block-end'
          if (human) button.dataset.humanOnly = ''
          button.textContent = unknown && entry?.actor.kind !== 'agent' ? 'Author unconfirmed' : label
          button.setAttribute('aria-label', `${reference ? 'Reference' : 'Block'} authors: ${label}${unknown && entry ? ' · some attribution is unconfirmed' : ''}`)
          button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false')
          button.addEventListener('mousedown', event => event.preventDefault())
          button.addEventListener('click', event => { event.stopPropagation(); open({ anchor: button, provenance, reference }) })
          return button
        }, { key: JSON.stringify([node.attrs.blockId, provenance, label, reference]), side: -1, marks: [], stopEvent: () => true, ignoreSelection: true }))
      })
      return DecorationSet.create(doc, decorations)
    }
    editor.registerPlugin(new Plugin<DecorationSet>({ key: authorsKey,
      state: { init: (_, state) => decorate(state.doc), apply: (tr, previous) => tr.docChanged ? decorate(tr.doc) : previous },
      props: { decorations: state => authorsKey.getState(state) },
      view: () => ({ update: (view, before) => { if (view.state.doc !== before.doc) open(null) } })
    }))
    return () => { if (!editor.isDestroyed) editor.unregisterPlugin(authorsKey) }
  }, [editor, agentNames])
  useLayoutEffect(() => {
    if (!opened || !panel.current || !container) return
    const anchor = opened.anchor, floating = panel.current
    anchor.setAttribute('aria-expanded', 'true'); anchor.setAttribute('aria-controls', id)
    floating.focus({ preventScroll: true })
    let current = true
    const update = async () => {
      if (!anchor.isConnected || anchor.closest('[hidden], [inert], [aria-hidden="true"]')) { open(null); return }
      const result = await computePosition(anchor, floating, { strategy: 'fixed', placement: 'bottom-end', middleware: [offset(6), flip({ padding: 12 }), shift({ padding: 12 }), size({ padding: 12, apply: ({ availableHeight, availableWidth }) => {
        floating.style.maxHeight = `${Math.max(0, availableHeight)}px`; floating.style.maxWidth = `${Math.max(0, availableWidth)}px`
      } })] })
      if (current) Object.assign(floating.style, { left: `${result.x}px`, top: `${result.y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(anchor, floating, () => { void update() })
    return () => { current = false; stop(); anchor.setAttribute('aria-expanded', 'false'); anchor.removeAttribute('aria-controls') }
  }, [opened, container, id])
  const close = (restoreFocus = false) => { if (restoreFocus) opened?.anchor.focus({ preventScroll: true }); open(null) }
  return opened && container ? createPortal(<DismissableLayer asChild onEscapeKeyDown={event => { event.preventDefault(); close(true) }} onPointerDownOutside={() => close()} onFocusOutside={() => close()}>
    <div ref={panel} id={id} role="dialog" aria-label="Block authors" tabIndex={-1} className="note-authorship" style={{ visibility: 'hidden' }}>
      <header><strong>{opened.reference ? 'Reference authors' : 'Block authors'}</strong><button type="button" aria-label="Close block authors" onClick={() => close(true)}>×</button></header>
      <p>{opened.reference ? 'Recorded for this saved reference occurrence.' : 'Recorded for the saved content.'}</p>
      <dl>{(['created', 'lastEdited'] as const).map(kind => {
        const entry = opened.provenance?.[kind]
        return <div key={kind}><dt>{kind === 'created' ? 'Created by' : 'Last edited by'}</dt><dd>
          <span>{authorName(entry, agentNames)}</span>
          {entry ? <><time dateTime={new Date(entry.at).toJSON() ?? undefined}>{new Date(entry.at).toLocaleString()}</time><details><summary>Full identity</summary><code>{entry.actor.kind} · {entry.actor.id}</code></details></> : <small>No confirmed author record.</small>}
        </dd></div>
      })}</dl>
    </div>
  </DismissableLayer>, container) : null
}
