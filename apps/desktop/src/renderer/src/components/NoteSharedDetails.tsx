import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link2, SquareDot, X } from 'lucide-react'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { noteInlineLinkContent, noteWikiQueryForLabel } from '@agentmux/client-ui/note/note-wikilinks'
import { readNoteMarkdownHeader } from '@agentmux/core/note-format'
import { NOTE_SCHEMA, serializeNoteDocument, type NoteDocument, type NoteInclude } from '../../../shared/note-document'
import type { NoteFileTarget } from '../lib/file-document-consumers'
import { noteSharedRelations } from '../lib/note-shared-relations'
import { noteGraphReferenceKey } from '../lib/note-graph-references'
import { writeNoteShareClipboard } from '../lib/note-share-staging'
import type { useNoteCanvasObservation } from '../lib/use-note-canvas-observation'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import '../styles/note-shared-details.css'

type Props = { note: NoteDocument; target: NoteFileTarget; host: NoteFileTarget; include: NoteInclude; active: boolean;
  graph: ReturnType<typeof useNoteCanvasObservation>; onOpen(target: NoteFileTarget, blockId?: string, signal?: AbortSignal): Promise<void> }

/** One nearby reader of the saved graph; it never writes a Note or creates a shared entity. */
export function NoteSharedDetails({ note, target, host, include, graph, active, onOpen }: Props) {
  const [open, setOpen] = useState(false), [anchor, setAnchor] = useState<HTMLButtonElement | null>(null), [content, setContent] = useState<HTMLDivElement | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const explicit = useRef(false), suppressFocus = useRef(false), restoreFocus = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const navigation = useRef<AbortController | null>(null)
  const identity = JSON.stringify([target.hostId, target.workspaceId, target.workspacePath, target.path, target.noteId,
    host.hostId, host.workspaceId, host.workspacePath, host.path, host.noteId, include.referenceId])
  const id = useId()
  const relations = useMemo(() => graph.snapshot ? noteSharedRelations(graph.snapshot, note.noteId, note.origin, { target: host, referenceId: include.referenceId }) : null,
    [graph.snapshot, note.noteId, note.origin, host, include.referenceId])
  const source = relations?.uses.some(use => use.current && use.source) ?? false
  const clear = () => { clearTimeout(timer.current); timer.current = undefined }
  const cancelNavigation = () => { navigation.current?.abort(); navigation.current = null }
  const close = () => { clear(); cancelNavigation(); setOpen(false); explicit.current = false }
  const enter = () => { clear(); if (!open) timer.current = setTimeout(() => setOpen(true), 180) }
  const leave = () => { clear(); if (!explicit.current) timer.current = setTimeout(close, 220) }
  useEffect(() => { if (!active) close(); return () => { clear(); cancelNavigation() } }, [active, identity])
  useLayoutEffect(() => {
    if (!open || !anchor || !content) return
    let current = true
    const boundary = anchor.closest<HTMLElement>('[data-workbench-region-id]') ?? undefined
    const position = async () => {
      const result = await computePosition(anchor, content, { strategy: 'fixed', placement: 'left-start', middleware: [offset(12),
        flip({ ...(boundary ? { boundary } : {}), padding: 12, fallbackPlacements: ['right-start', 'bottom-start'] }),
        shift({ ...(boundary ? { boundary } : {}), padding: 12, crossAxis: true }),
        size({ ...(boundary ? { boundary } : {}), padding: 12, apply({ availableWidth, availableHeight }) {
          if (current) Object.assign(content.style, { maxWidth: `${Math.max(0, availableWidth)}px`, maxHeight: `${Math.max(0, availableHeight)}px` })
        } })] })
      if (current) Object.assign(content.style, { left: `${result.x}px`, top: `${result.y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(anchor, content, () => { void position() })
    return () => { current = false; stop() }
  }, [open, anchor, content])
  async function navigate(file: NoteFileTarget, blockId?: string) {
    cancelNavigation()
    const controller = new AbortController(); navigation.current = controller
    const pending = () => navigation.current === controller && !controller.signal.aborted
    try { setMessage(null); await onOpen(file, blockId, controller.signal); if (pending()) close() }
    catch (error) { if (pending()) setMessage(error instanceof Error ? error.message : String(error)) }
  }
  function copy(shared: boolean) {
    if (!anchor) return
    try {
      if (shared) writeNoteShareClipboard(anchor.ownerDocument, { version: 1, source: target, block: { path: [], fingerprint: '' }, include: { ...include, path: target.path, workspaceId: target.workspaceId } }, note.title ?? 'Shared content')
      else {
        const owner = anchor.ownerDocument, attrs = { referenceId: crypto.randomUUID(), text: noteWikiQueryForLabel(note.title ?? 'Shared content'), target: { noteId: note.noteId } }
        const span = owner.createElement('span'); span.dataset.noteLink = JSON.stringify(attrs); span.textContent = `[[${attrs.text}]]`
        const raw = readNoteMarkdownHeader(serializeNoteDocument({ schema: NOTE_SCHEMA, noteId: note.noteId, content: { type: 'doc', content: [{ type: 'paragraph', content: [noteInlineLinkContent(attrs)] }] } }))
        if (raw.status !== 'valid') throw Error(raw.message)
        const copy = (event: ClipboardEvent) => { event.preventDefault(); event.clipboardData?.setData('text/html', span.outerHTML); event.clipboardData?.setData('text/plain', raw.body.trim()) }
        owner.addEventListener('copy', copy, { once: true })
        try { if (!owner.execCommand('copy')) throw Error('Copy was not confirmed. Try copying this content link again.') } finally { owner.removeEventListener('copy', copy) }
      }
      setMessage(shared ? 'Reference copied · paste to share' : 'Content link copied')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }
  const last = graph.stale || Boolean(graph.issue), partial = graph.snapshot?.graph.completeness !== 'complete'
  return <Dialog.Root modal={false} open={open && active} onOpenChange={value => { if (!value) close(); else setOpen(true) }}>
    <button ref={setAnchor} type="button" className="note-shared-block__marker" aria-label={`${source ? 'Shared source' : 'Shared reference'} · show details`} aria-haspopup="dialog" aria-expanded={open && active} aria-controls={id}
      onPointerEnter={enter} onPointerLeave={leave} onFocus={() => { if (suppressFocus.current) { suppressFocus.current = false; return } clear(); setOpen(true) }}
      onClick={() => { clear(); explicit.current = true; setOpen(true); content?.focus({ preventScroll: true }) }}>{source ? <SquareDot size={13} /> : <Link2 size={13} />}</button>
    <DocumentOverlayPortal component={Dialog.Portal}>
      <Dialog.Content ref={setContent} id={id} className="note-shared-details" style={{ visibility: 'hidden' }} tabIndex={-1}
        onPointerEnter={clear} onPointerLeave={leave} onPointerDown={() => { explicit.current = true }}
        onOpenAutoFocus={event => { event.preventDefault(); if (explicit.current) content?.focus({ preventScroll: true }) }}
        onFocusOutside={event => { if (!explicit.current) event.preventDefault() }}
        onEscapeKeyDown={() => { restoreFocus.current = true }}
        onCloseAutoFocus={event => { event.preventDefault(); if (restoreFocus.current && anchor?.isConnected) { suppressFocus.current = true; anchor.focus({ preventScroll: true }) } restoreFocus.current = false }}>
        <div className="note-shared-details__heading"><Dialog.Title>{note.title ?? 'Shared content'}</Dialog.Title><button type="button" className="icon-button" aria-label="Close shared details" onClick={() => { restoreFocus.current = true; close() }}><X size={14} /></button></div>
        <Dialog.Description>{source ? 'This is the source position.' : 'This position uses the same original content.'} Edits update every use.</Dialog.Description>
        <div className="note-shared-details__origin"><span>Originally extracted at</span>{relations?.source ? <button type="button" onClick={() => void navigate({ ...relations.source!.reference.sourceResource, noteId: relations.source!.reference.source.noteId }, relations.source!.reference.source.blockId)}>{relations.source.title}</button>
          : <p>{note.origin ? 'The original position is not confirmed in this observation. Shared content remains available.' : 'No original extraction position is recorded.'}</p>}</div>
        <div className="note-shared-details__uses-heading"><strong>Use locations</strong>{relations && <span>{last ? 'Last confirmed · ' : partial ? 'At least · ' : ''}{relations.documents} documents · {relations.uses.length} uses</span>}</div>
        {relations && <ol className="note-shared-details__uses">{relations.uses.map(use => <li key={noteGraphReferenceKey(use.reference)}><button type="button" onClick={() => void navigate({ ...use.reference.sourceResource, noteId: use.reference.source.noteId }, use.reference.source.blockId)}><span>{use.title}</span><small>{use.source ? 'Source' : 'Use'}{use.current ? ' · Current position' : ''}</small></button></li>)}</ol>}
        {(last || partial || !relations) && <p className="note-shared-details__notice" role="status">{graph.issue ?? (last ? 'Saved originals changed. These are the last confirmed locations.' : graph.busy ? 'Reading saved locations…' : 'Some sources have not been read; this is not the complete set.')} <button type="button" onClick={graph.refresh}>Refresh locations</button></p>}
        <div className="note-shared-details__actions"><button type="button" onClick={() => void navigate(target)}>Open shared content</button><button type="button" onClick={() => copy(false)}>Copy content link</button><button type="button" onClick={() => copy(true)}>Copy shared reference</button></div>
        {message && <p className="note-shared-details__notice" role="status">{message}</p>}
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
