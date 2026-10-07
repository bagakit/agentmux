import { useEffect } from 'react'
import { useAppStore } from '../store'
import type { RenderableServiceNotice } from './service-window-notice'
import { compactNotificationIdentity } from './notification-read-identity'

export type ServiceNoticeItem = {
  id: string
  occurrence?: string
  /** Stable semantic cause from the fact owner; diagnostic metadata is not an occurrence. */
  cause?: string
  /** Display metadata from this notice's owner; never part of its read identity. */
  observedAt?: number
  notice: RenderableServiceNotice
  /** Compact owner-supplied explanation; the original facts remain in Details. */
  summary?: RenderableServiceNotice['notice']
  action?: { label: string; run(): void }
}

const EMPTY_RECEIPTS: Readonly<Record<string, string>> = Object.freeze({})
export function serviceNoticeFingerprint(item: ServiceNoticeItem): string {
  const cause = item.cause ?? item.notice.notice
  return JSON.stringify([item.occurrence, item.notice.kind,
    compactNotificationIdentity(typeof cause === 'string' ? cause : JSON.stringify(cause))])
}

/** Only acknowledgement is persisted. Only a complete, available owner projection may prune receipts. */
export function useReadReceipts(scope: string, current: Readonly<Record<string, string>>, available = true, complete = true) {
  const receipts = useAppStore((state) => state.noticeReadReceipts[scope] ?? EMPTY_RECEIPTS)
  const signature = JSON.stringify(current)
  useEffect(() => {
    if (!available || !complete) return
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
  }, [scope, signature, available, complete])
  function acknowledge(ids: readonly string[]) {
    if (!ids.length) return
    useAppStore.setState((state) => ({ noticeReadReceipts: {
      ...state.noticeReadReceipts,
      [scope]: { ...state.noticeReadReceipts[scope], ...Object.fromEntries(ids.map((id) => [id, current[id]!])) }
    } }))
  }
  return { unread: Object.keys(current).filter((id) => receipts[id] !== current[id]), acknowledge }
}


export function useServiceNotices(scope: string, notices: readonly ServiceNoticeItem[], available = true, complete = true) {
  const current = Object.fromEntries(notices.map((item) => [item.id, serviceNoticeFingerprint(item)]))
  const receipts = useReadReceipts(scope, current, available, complete)
  return { available, notices, unread: notices.filter((item) => receipts.unread.includes(item.id)),
    acknowledge: (items: readonly ServiceNoticeItem[]) => receipts.acknowledge(items.map((item) => item.id)) }
}
