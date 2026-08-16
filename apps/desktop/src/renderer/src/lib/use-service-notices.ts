import { useEffect } from 'react'
import { useAppStore } from '../store'
import type { RenderableServiceNotice } from './service-window-notice'

export type ServiceNoticeItem = {
  id: string
  occurrence?: string
  notice: RenderableServiceNotice
  action?: { label: string; run(): void }
}

const EMPTY_RECEIPTS: Readonly<Record<string, string>> = Object.freeze({})
function fingerprint(item: ServiceNoticeItem): string {
  return JSON.stringify([item.occurrence, item.notice.kind, item.notice.notice])
}

/** Only acknowledgement is persisted. Current problems remain projections of their owners. */
export function useServiceNotices(scope: string, notices: readonly ServiceNoticeItem[], available = true) {
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
  function acknowledge(items: readonly ServiceNoticeItem[]) {
    useAppStore.setState((state) => ({ noticeReadReceipts: {
      ...state.noticeReadReceipts,
      [scope]: { ...state.noticeReadReceipts[scope], ...Object.fromEntries(items.map((item) => [item.id, fingerprint(item)])) }
    } }))
  }
  return { available, notices, unread: notices.filter((item) => receipts[item.id] !== fingerprint(item)), acknowledge }
}

