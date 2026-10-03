import { ArrowUp, Check, CircleHelp, Clock3, Copy, LoaderCircle, Pencil, TriangleAlert, X } from 'lucide-react'
import { autoUpdate, computePosition, offset, shift, size } from '@floating-ui/dom'
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { queuedMessageState, type ComposerQueuedMessage } from './ComposerOutbox'
import { ComposerQueuedMessageEditor, type EditQueuedMessage } from './ComposerQueuedMessageEditor'
import { WindowOverlayPortal } from './WindowOverlayHost'

/** Original queue facts, viewed by operation identity; this surface owns no delivery state. */
export function ComposerPendingDelivery({ queued, pendingInteraction, anchorRef, onSend, onCopy, onEdit, sendImmediately = false, suppressed = false, onMore }: {
  queued: readonly ComposerQueuedMessage[]
  pendingInteraction: boolean
  anchorRef: RefObject<HTMLButtonElement | null>
  onSend?: ((id: string) => void) | undefined
  onCopy?: ((text: string) => Promise<boolean>) | undefined
  onEdit?: EditQueuedMessage | undefined
  sendImmediately?: boolean
  suppressed?: boolean
  onMore: (id: string) => void
}) {
  const [disclosed, setDisclosed] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [copyResult, setCopyResult] = useState<{ id: string; text: string; state: 'copied' | 'failed' } | null>(null)
  const copyActionRef = useRef(0)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const queuedRef = useRef(queued)
  const surfaceRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const active = queued.find(entry => entry.preparing || entry.sending)
  const selected = queued.find(entry => entry.id === (editingId ?? selectedId)) ?? active ?? queued.find(entry => entry.deliverable) ?? queued[0]
  const readingOpen = disclosed || Boolean(editingId)
  const currentIndex = selected ? queued.indexOf(selected) : -1

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
    if (!list || suppressed || dismissed) return
    const updateScrollPivot = () => {
      list.style.setProperty('--queue-pivot-y', list.scrollTop + list.offsetHeight + 'px')
    }
    const updateLayoutPivot = () => {
      const offsets = Array.from(list.children, card => ({
        card: card as HTMLElement, x: (card as HTMLElement).offsetLeft, y: (card as HTMLElement).offsetTop
      }))
      list.style.setProperty('--queue-pivot-x', list.offsetWidth + 'px')
      updateScrollPivot()
      for (const { card, x, y } of offsets) {
        card.style.setProperty('--queue-offset-x', x + 'px')
        card.style.setProperty('--queue-offset-y', y + 'px')
      }
    }
    updateLayoutPivot()
    // Native scrolling changes only the shared pivot, not React or queue state.
    list.addEventListener('scroll', updateScrollPivot, { passive: true })
    const resize = new ResizeObserver(updateLayoutPivot)
    resize.observe(list)
    return () => { list.removeEventListener('scroll', updateScrollPivot); resize.disconnect() }
  }, [queued, currentIndex, dismissed, suppressed])

  useLayoutEffect(() => {
    if (suppressed || dismissed || !selected) return
    const card = Array.from(listRef.current?.children ?? []).find(node => (node as HTMLElement).dataset.operationId === selected.id)
    card?.scrollIntoView({ block: 'nearest' })
  }, [selected?.id, dismissed, suppressed])

  useLayoutEffect(() => {
    const anchor = anchorRef.current, floating = surfaceRef.current
    if (suppressed || !queued.length || !anchor?.isConnected || !floating) return
    const composer = anchor.closest<HTMLElement>('.composer')
    const region = anchor.closest<HTMLElement>('[data-workbench-region-id]') ?? anchor.closest<HTMLElement>('.agent-surface') ?? composer
    if (!composer || !region) return
    const terminalContainer = composer.closest('.agent-surface')?.querySelector<HTMLElement>('.terminal-view__xterm')
    let disposed = false, revision = 0
    const update = async () => {
      const request = ++revision
      if (!composer.isConnected || composer.closest('[hidden], [inert]')) return
      const tool = composer.getBoundingClientRect()
      const terminal = Array.from(composer.closest('.agent-surface')?.querySelectorAll<HTMLElement>('.terminal-view__xterm .xterm') ?? [])
        .find(node => !node.closest('[hidden], [inert]') && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0)
      const helper = terminal?.querySelector<HTMLElement>('.xterm-helper-textarea')
      const rowHeight = helper ? Number.parseFloat(getComputedStyle(helper).lineHeight) : 0
      // Keep the native input row and up to one row of grid-fit slack clear.
      // Only the tool owns the absolute anchor; stale inner height cannot move it.
      const clearance = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight * 2 : 0
      const reference = { contextElement: composer, getBoundingClientRect: () => new DOMRect(tool.right, tool.top, 0, 0) }
      const padding = { top: 8, left: 8, right: 0, bottom: 0 }
      const position = await computePosition(reference, floating, {
        strategy: 'fixed', placement: 'top-end', middleware: [offset(8 + clearance), shift({ boundary: region, padding }),
          size({ boundary: region, padding, apply({ availableWidth, availableHeight }) {
            if (disposed || request !== revision) return
            floating.style.maxWidth = Math.max(0, Math.min(360, availableWidth, tool.right - region.getBoundingClientRect().left - 8)) + 'px'
            floating.style.maxHeight = Math.max(0, Math.min(320, availableHeight)) + 'px'
          } })]
      })
      if (disposed || request !== revision) return
      floating.style.left = position.x + 'px'; floating.style.top = position.y + 'px'
      floating.dataset.positioned = 'true'
    }
    const stop = autoUpdate(composer, floating, () => { void update() })
    const resize = new ResizeObserver(() => { void update() }); resize.observe(composer); resize.observe(region); if (terminalContainer) resize.observe(terminalContainer)
    return () => { disposed = true; stop(); resize.disconnect() }
  }, [anchorRef, queued.length, dismissed, suppressed])

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
      data-operation-id={selected.id} data-count={queued.length} data-dismissed={dismissed}
      onPointerLeave={event => { if (!editingId && !event.currentTarget.contains(document.activeElement)) setDisclosed(false) }}
      onBlur={event => { if (!editingId && !event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) setDisclosed(false) }}
      onKeyDown={event => {
        if (editingId || isImeOwnedKeyboardEvent(event)) return
        if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); anchorRef.current?.focus() }
        else if (event.key === 'ArrowDown') { event.preventDefault(); move(currentIndex + 1) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); move(currentIndex - 1) }
        else if (event.key === 'Home') { event.preventDefault(); move(0) }
        else if (event.key === 'End') { event.preventDefault(); move(queued.length - 1) }
      }}>
      {dismissed ? <button type="button" className="composer-pending__restore" onClick={() => setDismissed(false)}>待发 {queued.length}</button> : <>
        <header className="composer-pending__heading"><button type="button" className="composer-pending__count" aria-label="在 Outbox 查看待发消息和操作" title="查看当前消息的原操作" disabled={Boolean(editingId)} onClick={() => onMore(selected.id)}>待发 {queued.length}</button>
          <span className="composer-pending__position">{currentIndex + 1} / {queued.length}</span>
          <button type="button" className="composer-tool" aria-label="收起待发卡片" onClick={() => setDismissed(true)}><X size={13} aria-hidden="true" /></button>
        </header>
        {readingOpen ? <div className="composer-pending__reading" data-reading-id={selected.id} aria-label="当前待发消息全文">{editingId === selected.id && onEdit ? <ComposerQueuedMessageEditor key={selected.id} entry={selected} onSave={onEdit} onCancel={() => { setEditingId(null); listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.focus() }} /> : <><p className="composer-pending__body">{selected.text}</p><p className="composer-pending__reading-state"><strong>{queuedMessageState(selected, pendingInteraction).label}</strong><span>{queuedMessageState(selected, pendingInteraction).detail}</span></p></>}</div> : null}
        <ol ref={listRef} className="composer-pending__cards" aria-label="逐条待发消息">
          {queued.map((entry, index) => {
            const state = queuedMessageState(entry, pendingInteraction)
            const immediate = entry.immediateSend ?? sendImmediately
            const canSend = entry.id !== editingId && !active && !pendingInteraction && entry.deliverable && Boolean(onSend)
            const Icon = state.busy ? LoaderCircle : entry.unconfirmed ? CircleHelp : !entry.deliverable || entry.error || entry.status === 'failed' ? TriangleAlert : Clock3
            const copied = copyResult?.id === entry.id && copyResult.text === entry.text ? copyResult.state : 'idle'
            return <li key={entry.id} className="composer-pending__card" data-operation-id={entry.id}
              data-queue-index={index} style={{ '--queue-depth': Math.min(4, Math.abs(index - currentIndex)) } as CSSProperties} data-selected={entry.id === selected.id} data-busy={state.busy}
              tabIndex={0} aria-label={'待发 ' + (index + 1) + ': ' + entry.text} onPointerMove={() => { setDisclosed(true); if (entry.id !== selected.id) select(entry.id) }} onFocus={() => { setDisclosed(true); select(entry.id) }}>
              <span className="composer-pending__state" aria-label={state.label}><Icon size={12} aria-hidden="true" /><span className="composer-pending__sr-only">{state.label}</span></span>
              <span className="composer-pending__preview">{entry.text.replace(/\s+/g, ' ').trim()}</span>
              <div className="composer-pending__actions">
                <button type="button" className="composer-pending__send" aria-label={immediate ? '立即发送这条待发消息' : '发送这条待发消息'} title={canSend ? immediate ? '立即发送这条消息' : '只发送这条消息' : !onSend ? '当前显示面只读' : state.detail}
                  disabled={!canSend} onClick={() => onSend?.(entry.id)}><ArrowUp size={14} aria-hidden="true" /></button>
                <button type="button" className="composer-tool composer-pending__copy" aria-label="复制这条待发消息" title={copied === 'copied' ? '已复制' : copied === 'failed' ? '复制未确认，请重试' : '复制全文'} data-copy-state={copied} disabled={!onCopy}
                  onClick={() => { void copy(entry) }}>{copied === 'copied' ? <Check size={13} aria-hidden="true" /> : copied === 'failed' ? <TriangleAlert size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}</button>
                <button type="button" className="composer-tool" aria-label="编辑这条待发消息" title={entry.editable && onEdit ? '编辑原消息，保存不会发送' : '投递状态不允许编辑；保留原文与原操作身份'} disabled={!entry.editable || !onEdit || Boolean(editingId)}
                  onClick={() => { setSelectedId(entry.id); setEditingId(entry.id); setCopyResult(null) }}><Pencil size={13} aria-hidden="true" /></button>
              </div>
            </li>
          })}
        </ol>
        <span className="composer-pending__sr-only" role="status">{copyResult && queued.some(entry => entry.id === copyResult.id && entry.text === copyResult.text) ? copyResult.state === 'copied' ? '已复制待发消息' : '复制未确认，请重试' : ''}</span>
      </>}
    </section>
  </WindowOverlayPortal>
}
