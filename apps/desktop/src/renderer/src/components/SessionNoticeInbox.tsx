import { useEffect, useId } from 'react'
import { Inbox, X } from 'lucide-react'
import { useAppStore } from '../store'
import type { RenderableServiceNotice } from '../lib/service-window-notice'

export type ComposerNotice = {
  id: string
  occurrence?: string
  notice: RenderableServiceNotice
  action?: { label: string; run(): void }
}

const EMPTY_RECEIPTS: Readonly<Record<string, string>> = Object.freeze({})
function fingerprint(item: ComposerNotice): string {
  return JSON.stringify([item.occurrence, item.notice.kind, item.notice.notice])
}

/** Only acknowledgement is persisted. Current problems remain projections of their owners. */
export function useSessionNoticeInbox(scope: string, notices: readonly ComposerNotice[], available = true) {
  const receipts = useAppStore((state) => state.noticeReadReceipts[scope] ?? EMPTY_RECEIPTS)
  const current = Object.fromEntries(notices.map((item) => [item.id, fingerprint(item)]))
  const signature = JSON.stringify(current)
  useEffect(() => {
    if (!available) return
    useAppStore.setState((state) => {
      const prior = state.noticeReadReceipts[scope]
      if (!prior) return state
      const retained = Object.fromEntries(Object.entries(prior).filter(([id, value]) => current[id] === value))
      if (JSON.stringify(prior) === JSON.stringify(retained)) return state
      const next = { ...state.noticeReadReceipts }
      if (Object.keys(retained).length) next[scope] = retained
      else delete next[scope]
      return { noticeReadReceipts: next }
    })
  }, [scope, signature, available])
  function acknowledge(item: ComposerNotice) {
    useAppStore.setState((state) => ({ noticeReadReceipts: {
      ...state.noticeReadReceipts,
      [scope]: { ...state.noticeReadReceipts[scope], [item.id]: fingerprint(item) }
    } }))
  }
  return { available, notices, unread: notices.filter((item) => receipts[item.id] !== fingerprint(item)), acknowledge }
}

type NoticeInbox = ReturnType<typeof useSessionNoticeInbox>

function Notice({ item, onDismiss }: { item: ComposerNotice; onDismiss?: () => void }) {
  return <div className="composer-notice" data-kind={item.notice.kind}>
    <div className="composer-notice__body">
      <strong>{item.notice.notice.step}</strong>
      <span>{item.notice.notice.mode}</span>
      <span>{item.notice.notice.restore}</span>
      {item.action ? <button type="button" className="composer-tool" onClick={item.action.run}>{item.action.label}</button> : null}
    </div>
    {onDismiss ? <button type="button" className="composer-tool composer-notice__close" onClick={onDismiss}
      aria-label="Move notice to inbox" title="Move notice to inbox"><X size={14} /></button> : null}
  </div>
}

export function SessionNoticeBanners({ inbox }: { inbox: NoticeInbox }) {
  return inbox.unread.length ? <div className="composer__notices" role="status" aria-live="polite">
    {inbox.unread.map((item) => <Notice key={item.id} item={item} onDismiss={() => inbox.acknowledge(item)} />)}
  </div> : null
}

export function SessionNoticeInbox({ inbox }: { inbox: NoticeInbox }) {
  const id = useId()
  return <>
    <button type="button" className="composer__inbox" data-unread={inbox.unread.length > 0}
      aria-label={`Notification inbox: ${inbox.notices.length} current, ${inbox.unread.length} unread`}
      title="Notification inbox" popoverTarget={id} popoverTargetAction="toggle">
      <Inbox size={14} />{inbox.notices.length ? <span>{inbox.notices.length}</span> : null}
    </button>
    <div id={id} popover="auto" className="composer__inbox-card" aria-label="Notification inbox">
      <h3>Notifications</h3>
      {inbox.notices.length ? inbox.notices.map((item) => <Notice key={item.id} item={item}
        {...(inbox.unread.includes(item) ? { onDismiss: () => inbox.acknowledge(item) } : {})} />)
        : <p>{inbox.available ? 'No current notices.' : 'Waiting for Session status.'}</p>}
    </div>
  </>
}
