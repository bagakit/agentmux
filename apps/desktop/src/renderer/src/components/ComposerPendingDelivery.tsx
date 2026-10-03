import { ArrowUp, Check, CircleHelp, Clock3, Copy, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { autoUpdate, computePosition, offset, shift, size } from '@floating-ui/dom'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { queuedMessageState, type ComposerQueuedMessage, type ArchiveQueuedMessage } from './ComposerOutbox'
import { ComposerQueuedMessageEditor, type EditQueuedMessage } from './ComposerQueuedMessageEditor'
import { WindowOverlayPortal } from './WindowOverlayHost'
import { observeTerminalInputGeometry, readTerminalInputOverlapTop } from '../lib/terminal-view-observation'

/** Original queue facts, viewed by operation identity; this surface owns no delivery state. */
export function ComposerPendingDelivery({ queued, pendingInteraction, anchorRef, onSend, onCopy, onEdit, onArchive, sendImmediately = false, suppressed = false, onMore }: {
  queued: readonly ComposerQueuedMessage[]
  pendingInteraction: boolean
  anchorRef: RefObject<HTMLButtonElement | null>
  onSend?: ((id: string) => void) | undefined
  onCopy?: ((text: string) => Promise<boolean>) | undefined
  onEdit?: EditQueuedMessage | undefined
  onArchive?: ArchiveQueuedMessage | undefined
  sendImmediately?: boolean
  suppressed?: boolean
  onMore: (id: string) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [copyResult, setCopyResult] = useState<{ id: string; text: string; state: 'copied' | 'failed' } | null>(null)
  const copyActionRef = useRef(0)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const queuedRef = useRef(queued)
  const surfaceRef = useRef<HTMLElement>(null)
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const active = queued.find(entry => entry.preparing || entry.sending)
  const selected = queued.find(entry => entry.id === (editingId ?? hoveredId ?? selectedId)) ?? active ?? queued.find(entry => entry.deliverable) ?? queued[0]
  const currentIndex = selected ? queued.indexOf(selected) : -1

  function paintPointer() {
    const floating = surfaceRef.current, pointer = pointerRef.current
    if (!pointer || !floating?.isConnected || floating.closest('[hidden], [inert]')) return
    const rect = floating.getBoundingClientRect()
    floating.style.setProperty('--queue-pointer-x', pointer.x - rect.left + 'px')
    floating.style.setProperty('--queue-pointer-y', pointer.y - rect.top + 'px')
  }

  useLayoutEffect(() => { queuedRef.current = queued }, [queued])
  useLayoutEffect(() => () => {
    copyActionRef.current++
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
  }, [])

  async function copy(entry: ComposerQueuedMessage) {
    const action = ++copyActionRef.current
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    setCopyResult(null)
    let accepted = false
    try { accepted = (await onCopy?.(entry.text)) === true } catch { /* The original clipboard owner reports errors. */ }
    if (action !== copyActionRef.current || !queuedRef.current.some(current => current.id === entry.id && current.text === entry.text)) return
    setCopyResult({ id: entry.id, text: entry.text, state: accepted ? 'copied' : 'failed' })
    copyTimerRef.current = setTimeout(() => {
      if (action === copyActionRef.current) setCopyResult(null)
      copyTimerRef.current = null
    }, 1600)
  }

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || suppressed) return
    let bottomGutter = 0
    const updateScrollPivot = () => {
      list.style.setProperty('--queue-pivot-y', list.scrollTop + list.clientHeight - bottomGutter + 'px')
      list.style.setProperty('--queue-scroll-y', list.scrollTop + 'px')
    }
    const updateLayoutPivot = () => {
      const offsets = Array.from(list.children, card => ({
        card: card as HTMLElement, x: (card as HTMLElement).offsetLeft, y: (card as HTMLElement).offsetTop,
        width: (card as HTMLElement).offsetWidth, height: (card as HTMLElement).offsetHeight
      }))
      const style = getComputedStyle(list)
      bottomGutter = parseFloat(style.paddingBottom)
      list.style.setProperty('--queue-pivot-x', list.clientWidth - parseFloat(style.paddingRight) + 'px')
      list.style.setProperty('--queue-viewport-height', list.offsetHeight + 'px')
      updateScrollPivot()
      for (const { card, x, y, width, height } of offsets) {
        card.style.setProperty('--queue-offset-x', x + 'px')
        card.style.setProperty('--queue-offset-y', y + 'px')
        card.style.setProperty('--queue-card-width', width + 'px')
        card.style.setProperty('--queue-card-height', height + 'px')
      }
      // Expanding the original editor changes its visible height without changing its ID.
      // Keep its actions in the existing scrollport, including after a local error grows it.
      if (editingId) offsets.find(({ card }) => card.dataset.operationId === editingId)?.card.scrollIntoView({ block: 'nearest' })
    }
    updateLayoutPivot()
    // Native scrolling changes only the shared pivot, not React or queue state.
    list.addEventListener('scroll', updateScrollPivot, { passive: true })
    const resize = new ResizeObserver(updateLayoutPivot)
    resize.observe(list)
    for (const card of list.children) resize.observe(card)
    return () => { list.removeEventListener('scroll', updateScrollPivot); resize.disconnect() }
  }, [queued, currentIndex, editingId, suppressed])

  useLayoutEffect(() => {
    const revealId = editingId ?? selectedId ?? active?.id
    if (suppressed || !revealId) return
    const card = Array.from(listRef.current?.children ?? []).find(node => (node as HTMLElement).dataset.operationId === revealId)
    card?.scrollIntoView({ block: 'nearest' })
  }, [editingId, selectedId, active?.id, suppressed])

  useEffect(() => {
    const anchor = anchorRef.current, floating = surfaceRef.current
    if (suppressed || !queued.length || !anchor?.isConnected || !floating) return
    const composer = anchor.closest<HTMLElement>('.composer')
    const region = anchor.closest<HTMLElement>('[data-workbench-region-id]') ?? anchor.closest<HTMLElement>('.agent-surface') ?? composer
    if (!composer || !region) return
    const agentSurface = composer.closest('.agent-surface')
    const terminalContainer = agentSurface?.querySelector<HTMLElement>('.terminal-view__xterm')
    const interactionBody = agentSurface?.querySelector<HTMLElement>('.agent-body')
    let disposed = false, revision = 0
    let observedInteraction: HTMLElement | null = null
    let observedHelper: HTMLElement | null = null
    let observedTerminal: HTMLElement | null = null, observedRegionId: string | undefined
    let stopInputGeometry = () => {}, geometryFrame = 0
    const scheduleUpdate = () => {
      if (disposed || geometryFrame) return
      geometryFrame = requestAnimationFrame(() => { geometryFrame = 0; void update() })
    }
    const cursorObserver = new MutationObserver(scheduleUpdate)
    const terminalObserver = new MutationObserver(scheduleUpdate)
    if (terminalContainer) terminalObserver.observe(terminalContainer, { childList: true })
    // Observe only this Region's request host and its current request shell.
    // Reading history or an unrelated Region must not schedule this placement.
    const interactionObserver = new MutationObserver(scheduleUpdate)
    const observeInteraction = () => {
      interactionObserver.disconnect()
      if (interactionBody) interactionObserver.observe(interactionBody, { childList: true, attributes: true, attributeFilter: ['hidden', 'inert', 'style', 'class'] })
      if (observedInteraction) interactionObserver.observe(observedInteraction, { attributes: true, attributeFilter: ['hidden', 'inert', 'style', 'class', 'data-request-id'] })
    }
    observeInteraction()
    const resize = new ResizeObserver(() => { void update() })
    const update = async () => {
      const request = ++revision
      if (!composer.isConnected || composer.closest('[hidden], [inert]')) return
      const interaction = Array.from(interactionBody?.children ?? []).find(node =>
        node instanceof HTMLElement && node.matches('.agent-interaction[data-request-id]') &&
        (node.closest('[data-workbench-region-id]') ?? node.closest('.agent-surface')) === region) as HTMLElement | undefined
      if ((interaction ?? null) !== observedInteraction) {
        if (observedInteraction) resize.unobserve(observedInteraction)
        observedInteraction = interaction ?? null
        if (observedInteraction) resize.observe(observedInteraction)
        observeInteraction()
      }
      const tool = composer.getBoundingClientRect()
      const terminal = Array.from(composer.closest('.agent-surface')?.querySelectorAll<HTMLElement>('.terminal-view__xterm .xterm') ?? [])
        .find(node => !node.closest('[hidden], [inert]') && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0)
      const helper = terminal?.querySelector<HTMLElement>('.xterm-helper-textarea')
      const regionId = region.dataset.workbenchRegionId
      if (terminal !== observedTerminal || regionId !== observedRegionId) {
        stopInputGeometry()
        observedTerminal = terminal ?? null; observedRegionId = regionId
        stopInputGeometry = terminal && regionId ? observeTerminalInputGeometry(regionId, terminal, scheduleUpdate) : () => {}
      }
      if (helper !== observedHelper) {
        cursorObserver.disconnect()
        observedHelper = helper ?? null
        if (observedHelper) cursorObserver.observe(observedHelper, { attributes: true, attributeFilter: ['style'] })
      }
      // The transparent gutter protects outlines and shadows; the painted card
      // edge, rather than its scrollport, stays attached to the original Tool.
      const cards = listRef.current!
      const style = getComputedStyle(cards)
      const rightGutter = parseFloat(style.paddingRight) + cards.offsetWidth - cards.clientWidth
      const bottomGutter = parseFloat(style.paddingBottom)
      const right = Math.min(document.documentElement.clientWidth, tool.right + rightGutter)
      const gap = Math.max(0, 8 - bottomGutter)
      floating.style.left = 'auto'; floating.style.right = document.documentElement.clientWidth - right + 'px'
      const reference = { contextElement: composer, getBoundingClientRect: () => new DOMRect(right, tool.top, 0, 0) }
      const padding = { top: 8, left: 8, right: 0, bottom: 0 }
      const locate = (gap: number) => computePosition(reference, floating, {
        strategy: 'fixed', placement: 'top-end', middleware: [offset(gap), shift({ boundary: region, padding }),
          size({ boundary: region, padding, apply({ availableWidth, availableHeight }) {
            if (disposed || request !== revision) return
            floating.style.maxWidth = Math.max(0, Math.min(360, availableWidth, tool.right - region.getBoundingClientRect().left - 8)) + 'px'
            floating.style.maxHeight = Math.max(0, Math.min(320, availableHeight)) + 'px'
          } })]
      })
      let position = await locate(gap)
      // A move can encounter another protected row/control above the first one.
      // The mounted terminal reads at most cursor/last-two rows; with its helper
      // and this request there are at most five barriers, never history scans.
      for (let barrier = 0; barrier < 5; barrier++) {
        const cursor = helper?.getBoundingClientRect()
        const width = floating.offsetWidth, height = floating.offsetHeight
        const left = right - width
        let overlapTop = terminal && regionId
          ? readTerminalInputOverlapTop(regionId, terminal, new DOMRect(left, position.y, width, height)) : undefined
        if (cursor && cursor.width > 0 && cursor.height > 0 &&
            left < cursor.right && left + width > cursor.left &&
            position.y < cursor.bottom && position.y + height > cursor.top) {
          overlapTop = overlapTop === undefined ? cursor.top : Math.min(overlapTop, cursor.top)
        }
        if (interaction?.isConnected && !interaction.closest('[hidden], [inert]')) {
          const style = getComputedStyle(interaction)
          const rect = interaction.getBoundingClientRect()
          if (style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
              rect.width > 0 && rect.height > 0 && left < rect.right && left + width > rect.left &&
              position.y < rect.bottom && position.y + height > rect.top) {
            overlapTop = overlapTop === undefined ? rect.top : Math.min(overlapTop, rect.top)
          }
        }
        if (overlapTop === undefined) break
        position = await locate(Math.max(gap, tool.top - overlapTop + 2))
      }
      if (disposed || request !== revision) return
      floating.style.top = position.y + 'px'
      floating.dataset.positioned = 'true'
      paintPointer()
    }
    const stop = autoUpdate(composer, floating, () => { void update() })
    resize.observe(composer); resize.observe(region); if (terminalContainer) resize.observe(terminalContainer)
    return () => {
      disposed = true; stop(); resize.disconnect(); cursorObserver.disconnect(); terminalObserver.disconnect(); interactionObserver.disconnect()
      stopInputGeometry(); cancelAnimationFrame(geometryFrame)
    }
  }, [anchorRef, queued.length, suppressed])

  useLayoutEffect(() => {
    const floating = surfaceRef.current
    if (suppressed || !queued.length || !floating) return
    const hover = matchMedia('(hover: hover) and (pointer: fine)')
    let frame = 0
    const paint = () => { frame = 0; paintPointer() }
    const move = (event: PointerEvent) => {
      if (!hover.matches || event.pointerType === 'touch') return
      pointerRef.current = { x: event.clientX, y: event.clientY }
      if (!frame) frame = requestAnimationFrame(paint)
    }
    const reset = () => {
      pointerRef.current = null
      setHoveredId(null)
      floating.style.removeProperty('--queue-pointer-x')
      floating.style.removeProperty('--queue-pointer-y')
    }
    const resize = new ResizeObserver(() => { if (pointerRef.current && !frame) frame = requestAnimationFrame(paint) })
    resize.observe(floating)
    document.addEventListener('pointermove', move, { passive: true })
    const leave = (event: PointerEvent) => { if (!event.relatedTarget) reset() }
    window.addEventListener('pointerout', leave)
    window.addEventListener('blur', reset)
    hover.addEventListener('change', reset)
    return () => {
      document.removeEventListener('pointermove', move)
      window.removeEventListener('pointerout', leave)
      window.removeEventListener('blur', reset)
      hover.removeEventListener('change', reset)
      resize.disconnect()
      reset()
      cancelAnimationFrame(frame)
    }
  }, [queued.length > 0, suppressed])

  useLayoutEffect(() => { if (!suppressed && editingId) surfaceRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus() }, [suppressed, editingId])

  if (!queued.length || !selected) return null
  const select = (id: string) => { if (editingId) return; setSelectedId(id) }
  const move = (index: number) => {
    const entry = queued[Math.max(0, Math.min(queued.length - 1, index))]
    if (!entry) return
    select(entry.id)
    const node = listRef.current?.querySelector<HTMLElement>('[data-queue-index="' + queued.indexOf(entry) + '"]')
    node?.focus(); node?.scrollIntoView({ block: 'nearest' })
  }
  return <WindowOverlayPortal>
    <section ref={surfaceRef} className="composer-pending" aria-label="待发消息" hidden={suppressed} data-state={suppressed ? 'closed' : 'open'}
      data-operation-id={selected.id} data-count={queued.length}
      onPointerLeave={() => setHoveredId(null)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setSelectedId(null) }}
      onKeyDown={event => {
        if (editingId || isImeOwnedKeyboardEvent(event)) return
        if (event.key === 'Escape') { event.preventDefault(); anchorRef.current?.focus() }
        else if (event.key === 'ArrowDown') { event.preventDefault(); move(currentIndex + 1) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); move(currentIndex - 1) }
        else if (event.key === 'Home') { event.preventDefault(); move(0) }
        else if (event.key === 'End') { event.preventDefault(); move(queued.length - 1) }
      }}>

        <ol ref={listRef} className="composer-pending__cards" aria-label="逐条待发消息">
          {queued.map((entry, index) => {
            const state = queuedMessageState(entry, pendingInteraction)
            const immediate = entry.immediateSend ?? sendImmediately
            const canSend = entry.id !== editingId && !active && !pendingInteraction && entry.deliverable && Boolean(onSend)
            const Icon = state.busy ? LoaderCircle : entry.unconfirmed ? CircleHelp : !entry.deliverable || entry.error || entry.status === 'failed' ? TriangleAlert : Clock3
            const editing = entry.id === editingId && Boolean(onEdit)
            const copied = copyResult?.id === entry.id && copyResult.text === entry.text ? copyResult.state : 'idle'
            return <li key={entry.id} className="composer-pending__card" data-operation-id={entry.id}
              data-queue-index={index} style={{ '--queue-depth': Math.min(4, Math.abs(index - currentIndex)) } as CSSProperties} data-selected={entry.id === selected.id} data-busy={state.busy} data-editing={editing}
              tabIndex={0} aria-label={'待发 ' + (index + 1) + ': ' + entry.text}
              onPointerMove={event => { if (!editingId && event.pointerType !== 'touch' && entry.id !== hoveredId) setHoveredId(entry.id) }}
              onPointerLeave={() => setHoveredId(current => current === entry.id ? null : current)} onFocus={() => select(entry.id)}>
              <span className="composer-pending__state" aria-label={state.label} title={state.label}><Icon size={12} aria-hidden="true" /><span className="composer-pending__sr-only">{state.label}</span></span>
              {editing && onEdit ? <ComposerQueuedMessageEditor key={entry.id} entry={entry} onSave={onEdit} onCancel={() => {
                setEditingId(null)
                if (surfaceRef.current?.contains(document.activeElement)) listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.focus()
              }} /> : <button type="button" className="composer-pending__preview" aria-label="编辑这条待发消息" disabled={!entry.editable || !onEdit || Boolean(editingId)}
                onClick={() => { setSelectedId(entry.id); setEditingId(entry.id); setCopyResult(null) }}>{entry.text.replace(/\s+/g, ' ').trim()}</button>}
              <div className="composer-pending__actions">
                {entry.id === selected.id ? <button key="archive" type="button" className="composer-tool composer-pending__archive" aria-label="归档这条待发消息" title="归档原条目，保留原文和投递记录" disabled={Boolean(editingId) || state.busy || !onArchive} onClick={() => { void onArchive?.(entry.id, entry.text, true) }}><X size={12} aria-hidden="true" /></button> : null}
                <button key="send" type="button" className="composer-pending__send" aria-label={immediate ? '立即发送这条待发消息' : '发送这条待发消息'} title={canSend ? immediate ? '立即发送这条消息' : '只发送这条消息' : !onSend ? '当前显示面只读' : state.detail}
                  disabled={!canSend} onClick={() => onSend?.(entry.id)}><ArrowUp size={14} aria-hidden="true" /></button>
                <button key="copy" type="button" className="composer-tool composer-pending__copy" aria-label="复制这条待发消息" title={copied === 'copied' ? '已复制' : copied === 'failed' ? '复制未确认，请重试' : '复制全文'} data-copy-state={copied} disabled={!onCopy}
                  onClick={() => { void copy(entry) }}>{copied === 'copied' ? <Check size={13} aria-hidden="true" /> : copied === 'failed' ? <TriangleAlert size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}</button>
                <button key="more" type="button" className="composer-tool composer-pending__more" aria-label="在 Outbox 查看待发消息和操作" title="在 Mail 查看全文、状态和原操作" disabled={Boolean(editingId)} onClick={() => onMore(entry.id)}><span>{index + 1}/{queued.length}</span></button>
              </div>
            </li>
          })}
        </ol>
        <span className="composer-pending__sr-only" role="status">{copyResult && queued.some(entry => entry.id === copyResult.id && entry.text === copyResult.text) ? copyResult.state === 'copied' ? '已复制待发消息' : '复制未确认，请重试' : ''}</span>
    </section>
  </WindowOverlayPortal>
}
