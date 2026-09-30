import { autoUpdate, computePosition, inline, offset, shift, size } from '@floating-ui/dom'
import { ChevronDown, X } from 'lucide-react'
import { useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from 'react'
import type { ConversationAnnotation } from './ConversationMessage'
import { ComposerTextarea } from './ComposerTextarea'
import { WindowOverlayPortal } from './WindowOverlayHost'

export type ConversationAnnotationSelection = {
  messageId: string
  quote: string
  range: Range
  contextElement: HTMLElement
}
export type ConversationAnnotationNoteHandle = {
  select(target: ConversationAnnotationSelection, sourceSessionId: string): void
}
type Edit = { target: ConversationAnnotationSelection; sessionId: string }

function sameRange(left: Range, right: Range): boolean {
  return left.startContainer === right.startContainer && left.startOffset === right.startOffset &&
    left.endContainer === right.endContainer && left.endOffset === right.endOffset
}

function visibleRects(target: ConversationAnnotationSelection, region: HTMLElement | null): DOMRect[] {
  if (!region?.isConnected || !target.contextElement.isConnected ||
    !target.contextElement.contains(target.range.startContainer) || !target.contextElement.contains(target.range.endContainer) ||
    target.contextElement.closest('[hidden], [inert]') || target.range.toString() !== target.quote) return []
  const bounds = region.getBoundingClientRect()
  const viewport = target.contextElement.closest<HTMLElement>('.activity-feed, .session-history__viewport')?.getBoundingClientRect()
  const bottom = Math.min(bounds.bottom, viewport?.bottom ?? bounds.bottom)
  const top = Math.max(bounds.top, viewport?.top ?? bounds.top)
  if (bounds.width <= 0 || bounds.height <= 0) return []
  return Array.from(target.range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0 &&
    Number.isFinite(rect.left) && Number.isFinite(rect.top) && rect.bottom > top && rect.top < bottom &&
    rect.right > bounds.left && rect.left < bounds.right).map(rect => {
      const left = Math.max(rect.left, bounds.left)
      const clippedTop = Math.max(rect.top, top)
      return new DOMRect(left, clippedTop, Math.min(rect.right, bounds.right) - left, Math.min(rect.bottom, bottom) - clippedTop)
    })
}

/** One volatile editor per SessionPane. Typing/position never updates the message list. */
export function ConversationAnnotationNote({ ref, sessionId, regionRef, active, onAnnotate }: {
  ref?: Ref<ConversationAnnotationNoteHandle>
  sessionId: string
  regionRef: RefObject<HTMLElement | null>
  active: boolean
  onAnnotate?: (annotation: ConversationAnnotation) => void
}) {
  const [edit, setEdit] = useState<Edit | null>(null)
  const [note, setNote] = useState('')
  const [opened, setOpened] = useState(true)
  const [docked, setDocked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rects, setRects] = useState<DOMRect[]>([])
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const focusRequested = useRef<{ origin: Element | null } | null>(null)
  const current = useRef({ edit, note })
  current.current = { edit, note }

  useImperativeHandle(ref, () => ({
    select(target, sourceSessionId) {
      if (!onAnnotate || sourceSessionId !== sessionId || !target.messageId || !target.quote.trim()) return
      const previous = current.current
      if (previous.edit && previous.note.trim() &&
        (previous.edit.sessionId !== sourceSessionId || previous.edit.target.messageId !== target.messageId ||
          !sameRange(previous.edit.target.range, target.range))) {
        setError('Finish or discard the current note before choosing another passage.')
        if (previous.edit.sessionId === sessionId) { focusRequested.current = { origin: document.activeElement }; setOpened(true) }
        return
      }
      if (previous.edit?.sessionId === sourceSessionId && previous.edit.target.messageId === target.messageId &&
        sameRange(previous.edit.target.range, target.range)) {
        focusRequested.current = { origin: document.activeElement }; setOpened(true)
        return
      }
      const next = visibleRects(target, regionRef.current)
      focusRequested.current = { origin: document.activeElement }
      setEdit({ target, sessionId: sourceSessionId })
      setNote(''); setError(null); setOpened(true); setDocked(next.length === 0)
      setRects(next); setPosition(null)
    }
  }), [onAnnotate, regionRef, sessionId])

  const available = active && onAnnotate !== undefined && edit?.sessionId === sessionId
  useEffect(() => {
    if (!edit || !available) { setRects([]); setPosition(null); return }
    let disposed = false
    const target = edit.target
    const update = async () => {
      if (disposed) return
      const region = regionRef.current!
      // Reserve a real side gutter only in this Pane, with room left to read.
      // Narrow Panes keep the same editor below their reading viewport.
      const side = opened && region.getBoundingClientRect().width >= 680 &&
        visibleRects(target, region).length > 0
      if (side) region.dataset.conversationNote = 'side'
      else delete region.dataset.conversationNote
      const next = visibleRects(target, region)
      const nextDocked = !side
      if (docked !== nextDocked) { setDocked(nextDocked); return }
      setRects(previous => previous.length === next.length && previous.every((r, i) =>
        r.left === next[i]!.left && r.top === next[i]!.top && r.width === next[i]!.width && r.height === next[i]!.height) ? previous : next)
      if (!next.length || docked || !surfaceRef.current) { setPosition(null); return }
      const surface = surfaceRef.current
      const result = await computePosition({
        contextElement: target.contextElement,
        getBoundingClientRect: () => target.range.getBoundingClientRect(),
        getClientRects: () => target.range.getClientRects()
      }, surface, {
        strategy: 'fixed', placement: 'right-start',
        middleware: [inline(), offset(({ rects: measured }) => ({
          mainAxis: region.getBoundingClientRect().right - 308 - measured.reference.x - measured.reference.width
        })),
          shift({ boundary: region, padding: 8 }), size({ boundary: region, padding: 8,
            apply({ availableWidth, availableHeight }) {
              if (disposed) return
              surface.style.maxWidth = `${Math.max(0, Math.min(300, availableWidth))}px`
              surface.style.maxHeight = `${Math.max(0, availableHeight)}px`
            }
          })]
      })
      if (!disposed && visibleRects(target, regionRef.current).length) {
        const body = target.contextElement.closest<HTMLElement>('.log-turn__body')!.getBoundingClientRect()
        const floating = surface.getBoundingClientRect()
        // No room beside the original body: keep the editor below the reading
        // viewport, in this Pane's normal flow, rather than covering its text.
        // Stay outside the body column, including other messages above/below
        // this passage. Vertical flip/shift alone cannot promise that.
        if (result.x < body.right && result.x + floating.width > body.left) {
          setDocked(true)
          return
        }
        setPosition(previous => previous?.x === result.x && previous?.y === result.y ? previous : { x: result.x, y: result.y })
      }
    }
    const refresh = () => { void update() }
    const region = regionRef.current!
    const surface = surfaceRef.current
    const stop = surface && opened ? autoUpdate(target.contextElement, surface, refresh,
      { ancestorScroll: false, ancestorResize: false }) : undefined
    region.addEventListener('scroll', refresh, true)
    window.addEventListener('resize', refresh)
    const resize = new ResizeObserver(() => { void update() })
    const viewport = target.contextElement.closest<HTMLElement>('.activity-feed, .session-history__viewport')
    if (viewport) resize.observe(viewport)
    // Only the selected body and its ancestor chain; no message-list subtree scan.
    const observer = new MutationObserver(changes => {
      if (changes.some(change => change.type === 'attributes' || change.type === 'characterData' ||
        [...change.removedNodes].some(node => node === target.contextElement || node.contains(target.contextElement)) ||
        target.contextElement.contains(change.target))) void update()
    })
    observer.observe(target.contextElement, { subtree: true, childList: true, characterData: true })
    for (let ancestor = target.contextElement.parentElement; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor, { attributes: true, attributeFilter: ['hidden', 'inert', 'style', 'class'], childList: true })
      if (ancestor === regionRef.current) break
    }
    void update()
    return () => {
      disposed = true; stop?.(); observer.disconnect(); resize.disconnect()
      region.removeEventListener('scroll', refresh, true); window.removeEventListener('resize', refresh)
      delete region.dataset.conversationNote
    }
  }, [edit, available, docked, opened, regionRef, rects.length > 0])

  useEffect(() => {
    if (!available) { focusRequested.current = null; return }
    if (focusRequested.current && available && opened && (docked || position) && inputRef.current) {
      // A wide Pane reopens from its retained flow editor into the side gutter.
      // Wait for that stable surface before focusing an input about to unmount.
      if (docked && rects.length > 0 && regionRef.current!.getBoundingClientRect().width >= 680) return
      const { origin } = focusRequested.current
      const focused = document.activeElement
      // Opening requested focus, but awaiting position is not permission to
      // take it back from another control/Region chosen in the meantime.
      const stillOwned = focused === origin || surfaceRef.current?.contains(focused) ||
        (!origin?.isConnected && focused === document.body)
      if (stillOwned) inputRef.current.focus({ preventScroll: true })
      focusRequested.current = null
    }
  }, [edit, available, opened, docked, position !== null, regionRef, rects.length > 0])

  function close(): void {
    const ownedFocus = surfaceRef.current?.contains(document.activeElement)
    setOpened(false)
    focusRequested.current = null
    if (ownedFocus && edit && available && visibleRects(edit.target, regionRef.current).length) {
      edit.target.contextElement.focus({ preventScroll: true })
    }
  }
  function discard(): void {
    close(); setEdit(null); setNote(''); setError(null); setRects([]); setPosition(null)
  }
  function add(): void {
    if (!edit || !available || !note.trim() || !onAnnotate) return
    try {
      onAnnotate({ messageId: edit.target.messageId, quote: edit.target.quote, note: note.trim() })
    } catch (failure) {
      setError(`Could not add note to reply draft: ${failure instanceof Error ? failure.message : String(failure)}`)
      return
    }
    const selection = window.getSelection()
    if (selection?.rangeCount && sameRange(selection.getRangeAt(0), edit.target.range)) selection.removeAllRanges()
    discard()
  }

  if (!edit || !available) return null
  const editor = <div ref={surfaceRef} className="log-turn__annotation" role="dialog" aria-label="Annotate selected text"
    data-anchor-state={docked ? rects.length ? 'range-docked' : 'unavailable' : 'range'}
    style={docked ? undefined : { position: 'fixed', left: position?.x, top: position?.y, visibility: position ? 'visible' : 'hidden' }}
    onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); close() } }}>
    <header className="conversation-annotation-note__header">
      <strong>Note</strong>
      <button type="button" className="conversation-annotation-note__close" aria-label="Close note" title="Close note · keep draft" onClick={close}><X size={14} aria-hidden="true" /></button>
    </header>
    {docked && !rects.length ? <span className="conversation-annotation-note__location" role="status">Original selection position is unavailable. Your note is retained.</span> : null}
    <details className="conversation-annotation-note__passage">
      <summary><span>Selected passage</span><ChevronDown size={12} aria-hidden="true" /><span className="conversation-annotation-note__preview">{edit.target.quote}</span></summary>
      <blockquote className="log-turn__annotation-quote" tabIndex={0} aria-label="Selected passage">{edit.target.quote}</blockquote>
    </details>
    <label className="conversation-annotation-note__field"><span>Your note</span>
      <ComposerTextarea ref={inputRef} value={note} onValueChange={setNote} aria-label="Note for selected text" placeholder="What would you like to add?" rows={3} />
    </label>
    {error ? <div className="conversation-annotation-note__error" role="alert">{error}</div> : null}
    <div className="log-turn__annotation-actions"><button type="button" className="conversation-annotation-note__discard" onClick={discard}>Discard note</button><button type="button" className="primary-button" disabled={!note.trim()} onClick={add}>Add to reply draft</button></div>
  </div>

  return <>
    {rects.length > 0 ? <WindowOverlayPortal>{rects.map((rect, index) => <span key={index} className="conversation-annotation-underline" aria-hidden="true"
      style={{ position: 'fixed', left: rect.left, top: rect.bottom - 1, width: rect.width }} />)}
      {!docked && opened ? editor : null}
    </WindowOverlayPortal> : null}
    {docked && opened ? editor : null}
    {(!rects.length && !docked) || !opened ? <div className="conversation-annotation-recovery" role="status">
      {rects.length ? 'Note draft retained for the underlined passage.' : 'Note draft retained; original selection position unavailable.'}
      <button type="button" className="small-button" onClick={() => { focusRequested.current = { origin: document.activeElement }; setDocked(true); setOpened(true) }}>Resume note</button>
    </div> : null}
  </>
}
