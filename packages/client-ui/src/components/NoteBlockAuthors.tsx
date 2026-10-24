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
import { createSemanticIconElement } from '../theme/icons.js'

type AgentNames = Readonly<Record<string, string>>
type AuthorEntry = { blockId: string; provenance: NoteBlockProvenance | null; reference: boolean; item: boolean; quote: boolean; afterBlock: boolean; human: boolean; agent: boolean; unknown: boolean; label: string }
type OpenAuthor = { anchor: HTMLButtonElement; entries: AuthorEntry[] }
const scopeName = (entry: AuthorEntry) => entry.item ? 'Item' : entry.quote ? 'Quote' : entry.reference ? 'Reference' : 'Block'
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
      const widgets = new Map<number, AuthorEntry[]>()
      doc.descendants((node, position) => {
        if (!NOTE_BLOCK_TYPES.includes(node.type.name as typeof NOTE_BLOCK_TYPES[number]) || !node.attrs.blockId) return
        const provenance = readNoteBlockProvenance(node.attrs.provenance)
        const entry = provenance?.lastEdited?.actor.kind === 'agent' ? provenance.lastEdited : provenance?.created?.actor.kind === 'agent' ? provenance.created : provenance?.lastEdited ?? provenance?.created
        const label = authorName(entry, names.current)
        const unknown = !provenance?.created || !provenance?.lastEdited
        const human = !unknown && provenance?.created?.actor.kind !== 'agent' && provenance?.lastEdited?.actor.kind !== 'agent'
        const reference = node.type.name === 'noteInclude' || node.type.name === 'blockReference'
        const item = node.type.name === 'taskItem' || node.type.name === 'listItem'
        const afterBlock = reference || ['codeBlock', 'table', 'noteRawBlock'].includes(node.type.name)
        const quote = node.type.name === 'blockquote'
        // Container and paragraph keep separate records behind one nearby footnote.
        const anchor = (item || quote) && node.firstChild?.type.name === 'paragraph' ? position + node.firstChild.nodeSize
          : position + node.nodeSize - (node.isLeaf || afterBlock ? 0 : 1)
        const entries = widgets.get(anchor) ?? []
        entries.push({ blockId: node.attrs.blockId, provenance, reference, item, quote, afterBlock, human,
          agent: entry?.actor.kind === 'agent', unknown, label })
        widgets.set(anchor, entries)
      })
      for (const [position, entries] of widgets) decorations.push(Decoration.widget(position, view => {
        const document = view.dom.ownerDocument, button = document.createElement('button')
        button.type = 'button'; button.contentEditable = 'false'; button.className = 'note-block-author nodrag nopan'
        button.dataset.authorBlock = entries[0]!.blockId
        button.dataset.authorBlocks = JSON.stringify(entries.map(entry => entry.blockId))
        if (entries.some(entry => entry.item)) button.dataset.authorScope = 'item'
        if (entries.every(entry => entry.human)) button.dataset.humanOnly = ''
        const agent = entries.some(entry => entry.agent), unknown = entries.some(entry => entry.unknown)
        button.append(createSemanticIconElement(agent ? 'object.agent' : unknown ? 'status.unknown' : 'object.user', document, { size: 12 }))
        const description = entries.map(entry => `${scopeName(entry)} authors: ${entry.label}${entry.unknown && entry.provenance && (entry.provenance.created || entry.provenance.lastEdited) ? ' · some attribution is unconfirmed' : ''}`).join('; ')
        button.setAttribute('aria-label', description); button.title = description
        button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false')
        button.addEventListener('mousedown', event => event.preventDefault())
        button.addEventListener('click', event => { event.stopPropagation(); open({ anchor: button, entries }) })
        if (!entries.some(entry => entry.afterBlock)) return button
        button.dataset.authorPlacement = 'block-end'
        const anchor = document.createElement('span')
        anchor.className = 'note-block-author-anchor'; anchor.contentEditable = 'false'; anchor.append(button)
        return anchor
      }, { key: JSON.stringify(entries), side: -1, marks: [], stopEvent: () => true, ignoreSelection: true }))
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
      <header><strong>{opened.entries.length > 1 ? 'Authors' : `${scopeName(opened.entries[0]!)} authors`}</strong><button type="button" aria-label="Close block authors" onClick={() => close(true)}>×</button></header>
      {opened.entries.map(record => <section key={record.blockId} data-author-record={record.blockId}>
        {opened.entries.length > 1 ? <h4>{scopeName(record)} authors</h4> : null}
        <p>{record.item ? 'Recorded for this saved list item, including its structure and checked state.' : record.quote ? 'Recorded for this saved quotation structure.' : record.reference ? 'Recorded for this saved reference occurrence.' : 'Recorded for the saved content.'}</p>
        <dl>{(['created', 'lastEdited'] as const).map(kind => {
          const entry = record.provenance?.[kind]
          return <div key={kind}><dt>{kind === 'created' ? 'Created by' : 'Last edited by'}</dt><dd>
            <span>{authorName(entry, agentNames)}</span>
            {entry ? <><time dateTime={new Date(entry.at).toJSON() ?? undefined}>{new Date(entry.at).toLocaleString()}</time><details><summary>Full identity</summary><code>{entry.actor.kind} · {entry.actor.id}</code></details></> : <small>No confirmed author record.</small>}
          </dd></div>
        })}</dl>
      </section>)}
    </div>
  </DismissableLayer>, container) : null
}
