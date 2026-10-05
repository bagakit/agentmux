import type { ConversationAnnotationSelection } from '@agentmux/client-ui/conversation-annotation'
import { useClientUiPlatform } from '@agentmux/client-ui/platform'
import { autoUpdate, computePosition, flip, inline, offset, shift } from '@floating-ui/dom'
import { Check, ChevronDown, Copy, MessageSquarePlus, Plus, X } from 'lucide-react'
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref, type RefObject } from 'react'
import type { ConversationAnnotation } from '@agentmux/client-ui/components/ConversationMessage'
import { ComposerTextarea } from '@agentmux/client-ui/input'
import type { OpenHttpLinkOrigin } from '../lib/open-destination'
import { ConversationAnnotationDelivery } from './ConversationAnnotationDelivery'
import { WindowOverlayPortal } from './WindowOverlayHost'

export type ConversationAnnotationNoteHandle = {
  select(target: ConversationAnnotationSelection, sourceSessionId: string): void
}
type Edit = { key: string; target: ConversationAnnotationSelection; sessionId: string; origin?: OpenHttpLinkOrigin }
type Position = { x: number; y: number; height: number; width: number }

function sameRange(left: Range, right: Range): boolean {
  return left.startContainer === right.startContainer && left.startOffset === right.startOffset &&
    left.endContainer === right.endContainer && left.endOffset === right.endOffset
}
function sameTarget(left: Edit, right: Edit): boolean {
  return left.sessionId === right.sessionId && left.target.messageId === right.target.messageId && sameRange(left.target.range, right.target.range)
}
function visibleRects(target: ConversationAnnotationSelection, region: HTMLElement | null): DOMRect[] {
  if (!region?.isConnected || !target.contextElement.isConnected ||
    !target.contextElement.contains(target.range.startContainer) || !target.contextElement.contains(target.range.endContainer) ||
    target.contextElement.closest('[hidden], [inert]') || target.range.toString() !== target.quote) return []
  const bounds = region.getBoundingClientRect()
  const viewport = target.contextElement.closest<HTMLElement>('.activity-feed')?.getBoundingClientRect()
  const bottom = Math.min(bounds.bottom, viewport?.bottom ?? bounds.bottom)
  const top = Math.max(bounds.top, viewport?.top ?? bounds.top)
  if (bounds.width <= 0 || bounds.height <= 0) return []
  return Array.from(target.range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0 &&
    Number.isFinite(rect.left) && Number.isFinite(rect.top) && rect.bottom > top && rect.top < bottom &&
    rect.right > bounds.left && rect.left < bounds.right).map(rect => {
      const left = Math.max(rect.left, bounds.left), clippedTop = Math.max(rect.top, top)
      return new DOMRect(left, clippedTop, Math.min(rect.right, bounds.right) - left, Math.min(rect.bottom, bottom) - clippedTop)
    })
}

/** Selection is transient reading chrome; only an explicit action owns a draft. */
export function ConversationAnnotationNote({ ref, sessionId, regionRef, active, origin, onAnnotate }: {
  ref?: Ref<ConversationAnnotationNoteHandle>
  sessionId: string
  regionRef: RefObject<HTMLElement | null>
  active: boolean
  origin?: OpenHttpLinkOrigin
  onAnnotate?: (annotation: ConversationAnnotation) => void
}) {
  const platform = useClientUiPlatform()
  const [selection, setSelection] = useState<Edit | null>(null)
  const [edit, setEdit] = useState<Edit | null>(null)
  const [note, setNote] = useState('')
  const [opened, setOpened] = useState(false)
  const [pending, setPending] = useState(false)
  const [copied, setCopied] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rects, setRects] = useState<DOMRect[]>([])
  const [position, setPosition] = useState<Position | null>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const focusRequested = useRef<{ origin: Element | null } | null>(null)
  const current = useRef({ edit, note, pending }); current.current = { edit, note, pending }
  const available = active && onAnnotate !== undefined
  const anchor = selection?.sessionId === sessionId ? selection : edit?.sessionId === sessionId ? edit : null
  const editing = !selection && edit?.sessionId === sessionId && opened
  const showing = available && anchor !== null && (selection !== null || editing)
  const availableRef = useRef(showing); availableRef.current = showing

  useImperativeHandle(ref, () => ({
    select(target, sourceSessionId) {
      if (!onAnnotate || sourceSessionId !== sessionId || !target.messageId || !target.quote.trim()) return
      focusRequested.current = null
      if (!current.current.note.trim() && !current.current.pending) setEdit(null)
      setSelection({ key: crypto.randomUUID(), target, sessionId: sourceSessionId, ...(origin ? { origin } : {}) })
      setOpened(false); setCopied(false); setError(null); setStatus(null); setPosition(null)
    }
  }), [onAnnotate, origin, sessionId])

  useEffect(() => {
    if (!selection || !available) return
    const dismissChangedSelection = () => {
      const native = window.getSelection()
      if (!native?.rangeCount || native.isCollapsed || !sameRange(native.getRangeAt(0), selection.target.range)) setSelection(null)
    }
    document.addEventListener('selectionchange', dismissChangedSelection)
    return () => document.removeEventListener('selectionchange', dismissChangedSelection)
  }, [selection, available])

  useLayoutEffect(() => {
    if (available) return
    focusRequested.current = null
    const nativeSelection = window.getSelection()
    if (selection && nativeSelection?.rangeCount && sameRange(nativeSelection.getRangeAt(0), selection.target.range)) nativeSelection.removeAllRanges()
    setSelection(null); setPosition(null); setRects([])
    if (edit && !note.trim() && !pending) { setEdit(null); setOpened(false); setError(null) }
  }, [available, edit, note, pending, selection])

  useLayoutEffect(() => {
    if (selection && selection.sessionId !== sessionId) setSelection(null)
  }, [selection, sessionId])

  useLayoutEffect(() => {
    if (!anchor || !showing) { setRects([]); setPosition(null); return }
    let disposed = false, revision = 0
    const target = anchor.target
    const update = async () => {
      if (disposed || !availableRef.current) return
      const request = ++revision, region = regionRef.current, surface = surfaceRef.current
      if (!region?.isConnected || !surface) return
      const next = visibleRects(target, region)
      setRects(previous => previous.length === next.length && previous.every((r, i) =>
        r.left === next[i]!.left && r.top === next[i]!.top && r.width === next[i]!.width && r.height === next[i]!.height) ? previous : next)
      const bounds = region.getBoundingClientRect()
      const viewport = target.contextElement.closest<HTMLElement>('.activity-feed')?.getBoundingClientRect() ?? bounds
      const left = Math.max(0, bounds.left, viewport.left), right = Math.min(window.innerWidth, bounds.right, viewport.right)
      const top = Math.max(0, bounds.top, viewport.top), bottom = Math.min(window.innerHeight, bounds.bottom, viewport.bottom)
      const clip = { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
      if (clip.width < 32 || clip.height < 32) { setPosition(null); return }
      if (!next.length) {
        // A written draft remains reachable without pretending its old Range is visible.
        setPosition(selection ? null : { x: left + 8, y: top + 8, width: clip.width - 16, height: clip.height - 16 })
        return
      }
      const rangeLeft = Math.min(...next.map(rect => rect.left)), rangeTop = Math.min(...next.map(rect => rect.top))
      const reference = new DOMRect(rangeLeft, rangeTop,
        Math.max(...next.map(rect => rect.right)) - rangeLeft, Math.max(...next.map(rect => rect.bottom)) - rangeTop)
      const result = await computePosition({ contextElement: target.contextElement,
        getBoundingClientRect: () => reference, getClientRects: () => next }, surface, {
        strategy: 'fixed', placement: 'bottom-start', middleware: [inline(), offset(10),
          flip({ boundary: [], rootBoundary: clip, padding: 8 }),
          shift({ boundary: [], rootBoundary: clip, padding: 8, crossAxis: true })]
      })
      if (!disposed && availableRef.current && request === revision) {
        const value = { x: result.x, y: result.y, width: clip.width - 16, height: clip.height - 16 }
        setPosition(previous => previous && Object.keys(value).every(key => previous[key as keyof Position] === value[key as keyof Position]) ? previous : value)
      }
    }
    const refresh = () => { void update() }, region = regionRef.current
    if (!region) return
    const surface = surfaceRef.current
    const stop = surface && target.contextElement.isConnected ? autoUpdate(target.contextElement, surface, refresh,
      { ancestorScroll: false, ancestorResize: false }) : undefined
    region.addEventListener('scroll', refresh, true); window.addEventListener('resize', refresh)
    const resize = new ResizeObserver(refresh), viewport = target.contextElement.closest<HTMLElement>('.activity-feed')
    if (viewport) resize.observe(viewport)
    if (surface) resize.observe(surface)
    const observer = new MutationObserver(changes => {
      if (changes.some(change => change.type === 'attributes' || change.type === 'characterData' ||
        [...change.removedNodes].some(node => node === target.contextElement || node.contains(target.contextElement)) ||
        target.contextElement.contains(change.target))) refresh()
    })
    observer.observe(target.contextElement, { subtree: true, childList: true, characterData: true })
    for (let ancestor = target.contextElement.parentElement; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor, { attributes: true, attributeFilter: ['hidden', 'inert', 'style', 'class'], childList: true })
      if (ancestor === region) break
    }
    refresh()
    return () => { disposed = true; stop?.(); observer.disconnect(); resize.disconnect()
      region.removeEventListener('scroll', refresh, true); window.removeEventListener('resize', refresh) }
  }, [anchor, showing, regionRef, selection !== null, editing])

  useEffect(() => {
    if (!showing) { focusRequested.current = null; return }
    if (focusRequested.current && editing && position && inputRef.current) {
      const focused = document.activeElement, { origin: original } = focusRequested.current
      if (focused === original || surfaceRef.current?.contains(focused) || (!original?.isConnected && focused === document.body)) inputRef.current.focus({ preventScroll: true })
      focusRequested.current = null
    }
  }, [showing, editing, position !== null])

  function close(): void {
    const ownedFocus = surfaceRef.current?.contains(document.activeElement)
    setOpened(false); setSelection(null); focusRequested.current = null
    if (ownedFocus && anchor && available && visibleRects(anchor.target, regionRef.current).length) anchor.target.contextElement.focus({ preventScroll: true })
  }
  function discard(): void {
    if (pending) return
    close(); setEdit(null); setNote(''); setError(null); setRects([]); setPosition(null)
  }
  function annotate(): void {
    if (!selection) return
    if (pending) {
      setError('原批注请求仍待确认，请先检查同一请求。新的选区仍可复制。')
    } else if (edit && note.trim() && !sameTarget(edit, selection)) {
      setError('已有未完成的批注。请先发送、加入草稿或丢弃，再批注另一处。')
    } else {
      if (!edit || !sameTarget(edit, selection)) { setEdit(selection); setNote('') }
      setError(null)
    }
    focusRequested.current = { origin: document.activeElement }
    setSelection(null); setOpened(true); setPosition(null)
  }
  async function copy(): Promise<void> {
    if (!selection) return
    const original = selection
    try {
      const accepted = await platform.copyText(original.target.quote, () => {})
      if (original !== selectionRef.current) return
      if (accepted) { setCopied(true); setError(null) }
      else setError('复制失败，原选区已保留，请重试。')
    } catch { if (original === selectionRef.current) setError('复制失败，原选区已保留，请重试。') }
  }
  const selectionRef = useRef(selection); selectionRef.current = selection
  function accepted(message: string): void { setPending(false); close(); setEdit(null); setNote(''); setError(null); setStatus(message) }
  function add(): void {
    if (!edit || !available || !note.trim() || !onAnnotate || pending) return
    try { onAnnotate({ messageId: edit.target.messageId, quote: edit.target.quote, note: note.trim() }) }
    catch (failure) { setError(`无法将批注加入回复草稿：${failure instanceof Error ? failure.message : String(failure)}`); return }
    accepted('批注已加入当前回复草稿。')
  }

  const annotation = edit ? { messageId: edit.target.messageId, quote: edit.target.quote, note: note.trim() } : null
  return <>
    <WindowOverlayPortal layer="window-chrome">
      {available && editing ? rects.map((rect, index) => <span key={index} className="conversation-annotation-underline" aria-hidden="true"
        style={{ position: 'fixed', left: rect.left, top: rect.bottom - 1, width: rect.width }} />) : null}
      {showing && selection ? <div ref={surfaceRef} className="conversation-selection-actions"
        role="toolbar" aria-label="选中文字的操作" data-presentation="floating"
        style={{ position: 'fixed', left: position?.x ?? 0, top: position?.y ?? 0,
          maxWidth: position?.width, visibility: position ? 'visible' : 'hidden' }}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
          <button type="button" onMouseDown={event => event.preventDefault()} onClick={annotate}><MessageSquarePlus size={14} aria-hidden="true" />批注</button>
          <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => { void copy() }}>{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied ? '已复制' : '复制'}</button>
          {error ? <span role="alert">{error}</span> : null}
      </div> : null}
      {edit ? <div ref={editing ? surfaceRef : undefined} className="log-turn__annotation"
        role="dialog" aria-label="批注选中原文" hidden={!available || !editing} inert={!available || !editing}
        data-anchor-state={rects.length ? 'range' : 'unavailable'} data-presentation="floating"
        style={{ position: 'fixed', left: position?.x ?? 0, top: position?.y ?? 0,
          maxWidth: position?.width, maxHeight: position?.height, visibility: position ? 'visible' : 'hidden' }}
        onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); close() } }}>

          <header className="conversation-annotation-note__header"><strong>批注</strong><button type="button" className="conversation-annotation-note__close" aria-label="关闭批注" title="关闭批注 · 保留草稿" onClick={close}><X size={14} aria-hidden="true" /></button></header>
          {!rects.length ? <span className="conversation-annotation-note__location" role="status">原选区位置暂不可用，批注已保留。</span> : null}
          <details className="conversation-annotation-note__passage"><summary aria-label="Selected passage"><span className="conversation-annotation-note__preview">{edit.target.quote}</span><ChevronDown size={12} aria-hidden="true" /></summary><blockquote className="log-turn__annotation-quote" tabIndex={0} aria-label="Selected passage">{edit.target.quote}</blockquote></details>
          <ComposerTextarea ref={inputRef} value={note} onValueChange={setNote} disabled={pending} aria-label="批注内容" placeholder="添加批注…" rows={2} />
          {error ? <div className="conversation-annotation-note__error" role="alert">{error}</div> : null}
          {edit.origin && annotation ? <ConversationAnnotationDelivery key={edit.key} active={available && editing} sessionId={edit.sessionId} origin={edit.origin} annotation={annotation} onAccepted={accepted} onError={setError} onPendingChange={setPending} /> : null}
          <div className="log-turn__annotation-actions"><button type="button" className="conversation-annotation-note__discard" disabled={pending} onClick={discard}>丢弃批注</button><button type="button" className="conversation-annotation-note__add" aria-label="将批注加入回复草稿" disabled={!note.trim() || pending} onClick={add}><Plus size={12} aria-hidden="true" />加入草稿</button></div>
      </div> : null}
    </WindowOverlayPortal>
    {available && edit?.sessionId === sessionId && !opened && !selection ? <div className="conversation-annotation-recovery" role="status">批注草稿已保留。<button type="button" className="small-button" onClick={() => { focusRequested.current = { origin: document.activeElement }; setOpened(true) }}>继续批注</button></div> : null}
    {status ? <span className="conversation-annotation-status" role="status">{status}</span> : null}
  </>
}
