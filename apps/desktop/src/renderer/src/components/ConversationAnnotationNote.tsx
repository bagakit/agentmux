import { autoUpdate, computePosition, flip, inline, offset, shift, size } from '@floating-ui/dom'
import { ChevronDown, X } from 'lucide-react'
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref, type RefObject } from 'react'
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
  const [error, setError] = useState<string | null>(null)
  const [rects, setRects] = useState<DOMRect[]>([])
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const focusRequested = useRef<{ origin: Element | null } | null>(null)
  const current = useRef({ edit, note })
  current.current = { edit, note }
  const available = active && onAnnotate !== undefined && edit?.sessionId === sessionId
  const availableRef = useRef(available)
  availableRef.current = available

  useImperativeHandle(ref, () => ({
    select(target, sourceSessionId) {
      if (!onAnnotate || sourceSessionId !== sessionId || !target.messageId || !target.quote.trim()) return
      const previous = current.current
      if (previous.edit && previous.note.trim() &&
        (previous.edit.sessionId !== sourceSessionId || previous.edit.target.messageId !== target.messageId ||
          !sameRange(previous.edit.target.range, target.range))) {
        setError('Finish or discard the current note before choosing another passage.')
        if (previous.edit.sessionId === sessionId) setOpened(true)
        return
      }
      if (previous.edit?.sessionId === sourceSessionId && previous.edit.target.messageId === target.messageId &&
        sameRange(previous.edit.target.range, target.range)) {
        setOpened(true)
        return
      }
      const next = visibleRects(target, regionRef.current)
      // Selecting text is a reading action. Keep native selection and focus;
      // editing starts when the user enters the floating input.
      focusRequested.current = null
      setEdit({ target, sessionId: sourceSessionId })
      setNote(''); setError(null); setOpened(true)
      setRects(next); setPosition(null)
    }
  }), [onAnnotate, regionRef, sessionId])

  useLayoutEffect(() => {
    if (available || !edit) return
    focusRequested.current = null
    const selection = window.getSelection()
    if (selection?.rangeCount && sameRange(selection.getRangeAt(0), edit.target.range)) selection.removeAllRanges()
    // An untouched popover is transient selection chrome, not a note draft.
    // Written notes keep their original identity without measuring hidden DOM.
    if (!note.trim()) { setEdit(null); setError(null) }
  }, [available, edit, note])

  useLayoutEffect(() => {
    if (!edit || !available) { setRects([]); setPosition(null); return }
    let disposed = false
    const target = edit.target
    let revision = 0
    const update = async () => {
      if (disposed || !availableRef.current) return
      const request = ++revision
      const region = regionRef.current
      if (!region?.isConnected) return
      const next = visibleRects(target, region)
      setRects(previous => previous.length === next.length && previous.every((r, i) =>
        r.left === next[i]!.left && r.top === next[i]!.top && r.width === next[i]!.width && r.height === next[i]!.height) ? previous : next)
      if (!opened || !surfaceRef.current) { setPosition(null); return }
      const surface = surfaceRef.current
      // Freeze this update's geometry before Floating UI awaits its platform.
      // A late computation never reads a Range in a now-hidden reading surface.
      const bounds = region.getBoundingClientRect()
      const left = Math.min(...next.map(rect => rect.left))
      const top = Math.min(...next.map(rect => rect.top))
      const reference = next.length ? new DOMRect(left, top,
        Math.max(...next.map(rect => rect.right)) - left, Math.max(...next.map(rect => rect.bottom)) - top) : bounds
      const result = await computePosition({
        contextElement: next.length ? target.contextElement : region,
        getBoundingClientRect: () => reference,
        getClientRects: () => next
      }, surface, {
        strategy: 'fixed', placement: next.length ? 'bottom-start' : 'bottom-end',
        middleware: [inline(), offset(next.length ? 8 : -surface.offsetHeight - 8),
          flip({ boundary: region, padding: 8 }),
          shift({ boundary: region, padding: 8 }), size({ boundary: region, padding: 8,
            apply({ availableWidth, availableHeight }) {
              if (disposed || !availableRef.current || request !== revision) return
              surface.style.maxWidth = `${Math.max(0, Math.min(280, availableWidth))}px`
              surface.style.maxHeight = `${Math.max(0, availableHeight)}px`
            }
          })]
      })
      if (!disposed && availableRef.current && request === revision) {
        setPosition(previous => previous?.x === result.x && previous?.y === result.y ? previous : { x: result.x, y: result.y })
      }
    }
    const refresh = () => { void update() }
    const region = regionRef.current
    if (!region) return
    const surface = surfaceRef.current
    const stop = surface && opened && target.contextElement.isConnected ? autoUpdate(target.contextElement, surface, refresh,
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
    }
  }, [edit, available, opened, regionRef])

  useEffect(() => {
    if (!available) { focusRequested.current = null; return }
    if (focusRequested.current && opened && position && inputRef.current) {
      const { origin } = focusRequested.current
      const focused = document.activeElement
      // Opening requested focus, but awaiting position is not permission to
      // take it back from another control/Region chosen in the meantime.
      const stillOwned = focused === origin || surfaceRef.current?.contains(focused) ||
        (!origin?.isConnected && focused === document.body)
      if (stillOwned) inputRef.current.focus({ preventScroll: true })
      focusRequested.current = null
    }
  }, [edit, available, opened, position !== null])

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
    data-anchor-state={rects.length ? 'range' : 'unavailable'}
    style={{ position: 'fixed', left: position?.x, top: position?.y, visibility: position ? 'visible' : 'hidden' }}
    onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); close() } }}>
    <header className="conversation-annotation-note__header">
      <strong>Note</strong>
      <button type="button" className="conversation-annotation-note__close" aria-label="Close note" title="Close note · keep draft" onClick={close}><X size={14} aria-hidden="true" /></button>
    </header>
    {!rects.length ? <span className="conversation-annotation-note__location" role="status">Original selection position is unavailable. Your note is retained.</span> : null}
    <details className="conversation-annotation-note__passage">
      <summary aria-label="Selected passage"><span className="conversation-annotation-note__preview">{edit.target.quote}</span><ChevronDown size={12} aria-hidden="true" /></summary>
      <blockquote className="log-turn__annotation-quote" tabIndex={0} aria-label="Selected passage">{edit.target.quote}</blockquote>
    </details>
    <ComposerTextarea ref={inputRef} value={note} onValueChange={setNote} aria-label="Note for selected text" placeholder="Add a note…" rows={2} />
    {error ? <div className="conversation-annotation-note__error" role="alert">{error}</div> : null}
    <div className="log-turn__annotation-actions"><button type="button" className="conversation-annotation-note__discard" onClick={discard}>Discard note</button><button type="button" className="primary-button" disabled={!note.trim()} onClick={add}>Add to reply draft</button></div>
  </div>

  return <>
    <WindowOverlayPortal>{rects.map((rect, index) => <span key={index} className="conversation-annotation-underline" aria-hidden="true"
      style={{ position: 'fixed', left: rect.left, top: rect.bottom - 1, width: rect.width }} />)}
      {opened ? editor : null}
    </WindowOverlayPortal>
    {!opened ? <div className="conversation-annotation-recovery" role="status">
      {rects.length ? 'Note draft retained for the underlined passage.' : 'Note draft retained; original selection position unavailable.'}
      <button type="button" className="small-button" onClick={() => { focusRequested.current = { origin: document.activeElement }; setOpened(true) }}>Resume note</button>
    </div> : null}
  </>
}
