import { useCallback, useEffect, useRef, useState } from 'react'
import type { NotebookPage, NotebookState } from '@agentmux/core/notebook-catalog'
import type { NoteLinkTarget, NotebookResolveResult } from '@agentmux/core/note-links'
import type { NoteLinkOpenRequest } from '@agentmux/client-ui/components/NoteReader'
import { api } from './api'
import { sameNoteResource, useNotebookLibrary } from './notebook-library'
import { presentError } from '@agentmux/client-ui/error-presentation'

type Resolution = Extract<NotebookResolveResult, { mode: 'resolve' }>
type Request = { link: NoteLinkOpenRequest; result?: Resolution; issue?: string; busy: boolean }

/** Opening consumes the same original lookup as completion. It never writes a read-only source. */
export function useNoteLinkNavigation(onOpen: (page: NotebookPage, blockId?: string) => void | Promise<void>, catalog?: NotebookState | null, active = true,
  onResolved?: (link: NoteLinkOpenRequest, target: NoteLinkTarget) => boolean, sourceIdentity?: string) {
  const current = useRef({ onOpen, catalog, active, onResolved }); current.current = { onOpen, catalog, active, onResolved }
  const [request, setRequest] = useState<Request | null>(null)
  const generation = useRef(0), controller = useRef<AbortController | null>(null)
  const close = useCallback(() => { generation.current++; controller.current?.abort(); controller.current = null; setRequest(null) }, [])
  useEffect(() => { close(); return () => { generation.current++; controller.current?.abort() } }, [active, sourceIdentity, close])
  const openLink = useCallback(async (link: NoteLinkOpenRequest, select?: NoteLinkTarget) => {
    controller.current?.abort()
    const cancel = new AbortController(), intent = ++generation.current
    controller.current = cancel
    const pending = () => !cancel.signal.aborted && current.current.active && intent === generation.current
    setRequest({ link, busy: true })
    try {
      let target = link.target, resolution: Resolution | undefined
      if (!target) {
        const result = await api.notebooks.resolve({ mode: 'resolve', text: link.text, ...(select ? { select } : {}) }, { signal: cancel.signal })
        if (!pending()) return
        if (result.mode !== 'resolve') throw new Error('The original Note lookup returned another request mode. The query is retained.')
        resolution = result
        if (result.result.status !== 'resolved') { setRequest({ link, result, busy: false }); return }
        target = result.result.target
      }
      const observed = resolution?.candidates.find(page => page.noteId === target!.noteId)
      const held = current.current.catalog ?? useNotebookLibrary.getState().state
      let page = held?.pages[target.noteId]
      if (!page || observed && !sameNoteResource(page.resource, observed.resource)) {
        const fresh = await api.notebooks.read()
        if (!pending()) return
        page = fresh.pages[target.noteId]
      }
      if (!page || observed && !sameNoteResource(page.resource, observed.resource)) throw new Error('The exact Note resource is unconfirmed. The original query and target are retained; refresh its directory and retry.')
      if (!pending()) return
      if (!link.target && current.current.onResolved && !current.current.onResolved(link, target)) throw new Error('The original link changed while choosing its target. Your later draft is kept; choose its current link again.')
      await current.current.onOpen(page, target.blockId)
      if (pending()) setRequest(null)
    } catch (error) { if (pending()) setRequest({ link, busy: false, issue: presentError(error) }) }
  }, [])
  const dialog = request ? <section className="note-link-lookup" role="dialog" aria-label="Open original Note link">
    <div className="note-link-lookup__heading"><strong>{`[[${request.link.text}]]`}</strong><button type="button" className="note-text-button" onClick={close}>Close</button></div>
    {request.busy ? <p role="status">Checking the original Note…</p> : <>
      <p role="status">{request.issue ?? (request.result?.result.status !== 'resolved' ? request.result?.result.message : undefined)}</p>
      {request.result?.candidates.map(page => <button type="button" className="note-link-option" key={page.noteId} onClick={() => { void openLink(request.link, { noteId: page.noteId }) }}>
        <strong>{page.title}</strong><small>{page.notebookId} · {page.resource.path}</small></button>)}
      {request.result?.observation?.status === 'read' && request.result.blocks.map(block => <button type="button" className="note-link-option" key={block.blockId}
        onClick={() => { void openLink(request.link, { noteId: request.result!.observation!.noteId, blockId: block.blockId }) }}><strong>{block.text || 'Empty block'}</strong><small>{block.type} · {block.blockId}</small></button>)}
      <button type="button" className="note-text-button" onClick={() => { void openLink(request.link) }}>Retry original link</button>
      <p className="note-scope">The source and your current draft are kept. New pages remain available from the original New page action.</p>
    </>}
  </section> : null
  return { openLink, dialog }
}
