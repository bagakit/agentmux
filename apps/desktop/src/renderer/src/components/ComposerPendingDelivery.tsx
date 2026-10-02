import { ArrowUp, Clock3, Copy, LoaderCircle, MoreHorizontal, Pencil, X } from 'lucide-react'
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
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const surfaceRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const active = queued.find(entry => entry.preparing || entry.sending)
  const selected = queued.find(entry => entry.id === (editingId ?? selectedId)) ?? active ?? queued.find(entry => entry.deliverable) ?? queued[0]
  const readingOpen = disclosed || Boolean(editingId)
  const currentIndex = selected ? queued.indexOf(selected) : -1

  useLayoutEffect(() => {
    const anchor = anchorRef.current, floating = surfaceRef.current
    if (suppressed || !queued.length || !anchor?.isConnected || !floating) return
    const composer = anchor.closest<HTMLElement>('.composer')
    const region = anchor.closest<HTMLElement>('[data-workbench-region-id]') ?? anchor.closest<HTMLElement>('.agent-surface') ?? composer
    if (!composer || !region) return
    const terminal = composer.closest('.agent-surface')?.querySelector<HTMLElement>('.terminal-view__xterm .xterm')
    let disposed = false, revision = 0
    const update = async () => {
      const request = ++revision
      if (!anchor.isConnected || anchor.closest('[hidden], [inert]')) return
      const tool = composer.getBoundingClientRect(), mailbox = anchor.getBoundingClientRect()
      const anchorY = Math.min(tool.top, terminal?.getBoundingClientRect().bottom ?? tool.top)
      const reference = { contextElement: anchor, getBoundingClientRect: () => new DOMRect(mailbox.right, anchorY, 0, 0) }
      const position = await computePosition(reference, floating, {
        strategy: 'fixed', placement: 'top-end', middleware: [offset(28), shift({ boundary: region, padding: 8 }),
          size({ boundary: region, padding: 8, apply({ availableWidth, availableHeight }) {
            if (disposed || request !== revision) return
            floating.style.maxWidth = Math.max(0, Math.min(360, availableWidth, mailbox.right - region.getBoundingClientRect().left - 8)) + 'px'
            floating.style.maxHeight = Math.max(0, Math.min(320, availableHeight)) + 'px'
          } })]
      })
      if (disposed || request !== revision) return
      floating.style.left = position.x + 'px'; floating.style.top = position.y + 'px'
      floating.dataset.positioned = 'true'
    }
    const stop = autoUpdate(anchor, floating, () => { void update() }, { ancestorScroll: false })
    const resize = new ResizeObserver(() => { void update() }); resize.observe(composer); resize.observe(region); if (terminal) resize.observe(terminal)
    return () => { disposed = true; stop(); resize.disconnect() }
  }, [anchorRef, queued.length, dismissed, suppressed])

  useLayoutEffect(() => { if (!suppressed && editingId) surfaceRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus() }, [suppressed, editingId])

  if (!queued.length || !selected) return null
  const select = (id: string) => { if (editingId) return; setSelectedId(id); setCopiedId(null) }
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
        if (isImeOwnedKeyboardEvent(event)) return
        if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); anchorRef.current?.focus() }
        else if (event.key === 'ArrowDown') { event.preventDefault(); move(currentIndex + 1) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); move(currentIndex - 1) }
        else if (event.key === 'Home') { event.preventDefault(); move(0) }
        else if (event.key === 'End') { event.preventDefault(); move(queued.length - 1) }
      }}>
      {dismissed ? <button type="button" className="composer-pending__restore" onClick={() => setDismissed(false)}>待发 {queued.length}</button> : <>
        <header className="composer-pending__heading"><span className="composer-pending__count">待发 {queued.length}</span>
          <span className="composer-pending__position">{currentIndex + 1} / {queued.length}</span>
          <button type="button" className="composer-tool" aria-label="收起待发卡片" onClick={() => setDismissed(true)}><X size={13} aria-hidden="true" /></button>
        </header>
        {readingOpen ? <div className="composer-pending__reading" data-reading-id={selected.id} aria-label="当前待发消息全文">{editingId === selected.id && onEdit ? <ComposerQueuedMessageEditor key={selected.id} entry={selected} onSave={onEdit} onCancel={() => { setEditingId(null); listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.focus() }} /> : <p>{selected.text}</p>}</div> : null}
        <ol ref={listRef} className="composer-pending__cards" aria-label="逐条待发消息">
          {queued.map((entry, index) => {
            const state = queuedMessageState(entry, pendingInteraction)
            const immediate = entry.immediateSend ?? sendImmediately
            const canSend = entry.id !== editingId && !active && !pendingInteraction && entry.deliverable && Boolean(onSend)
            const Icon = state.busy ? LoaderCircle : Clock3
            return <li key={entry.id} className="composer-pending__card" data-operation-id={entry.id}
              data-queue-index={index} style={{ '--queue-depth': Math.min(4, Math.abs(index - currentIndex)) } as CSSProperties} data-selected={entry.id === selected.id} data-busy={state.busy}
              tabIndex={0} aria-label={'待发 ' + (index + 1) + ': ' + entry.text} onPointerMove={() => { setDisclosed(true); if (entry.id !== selected.id) select(entry.id) }} onFocus={() => { setDisclosed(true); select(entry.id) }}>
              <span className="composer-pending__preview" title={entry.text}>{entry.text.replace(/\s+/g, ' ').trim()}</span>
              <span className="composer-pending__state" role="status" title={state.detail}><Icon size={11} aria-hidden="true" /><span>{state.label}</span></span>
              <div className="composer-pending__actions">
                <button type="button" className="composer-pending__send" aria-label={immediate ? '立即发送这条待发消息' : '发送这条待发消息'} title={canSend ? immediate ? '立即发送这条消息' : '只发送这条消息' : !onSend ? '当前显示面只读' : state.detail}
                  disabled={!canSend} onClick={() => onSend?.(entry.id)}><ArrowUp size={14} aria-hidden="true" /></button>
                <button type="button" className="composer-tool" aria-label="复制这条待发消息" title={copiedId === entry.id ? '已复制' : '复制全文'} disabled={!onCopy}
                  onClick={() => { void onCopy?.(entry.text).then(ok => { if (ok) setCopiedId(entry.id) }) }}><Copy size={13} aria-hidden="true" /></button>
                <button type="button" className="composer-tool" aria-label="编辑这条待发消息" title={entry.editable && onEdit ? '编辑原消息，保存不会发送' : '投递状态不允许编辑；保留原文与原操作身份'} disabled={!entry.editable || !onEdit || Boolean(editingId)}
                  onClick={() => { setSelectedId(entry.id); setEditingId(entry.id); setCopiedId(null) }}><Pencil size={13} aria-hidden="true" /></button>
                <button type="button" className="composer-tool" aria-label="在 Outbox 查看待发消息和操作" title="查看这条消息的原操作" disabled={Boolean(editingId)}
                  onClick={() => onMore(entry.id)}><MoreHorizontal size={14} aria-hidden="true" /></button>
              </div>
            </li>
          })}
        </ol>
      </>}
    </section>
  </WindowOverlayPortal>
}
