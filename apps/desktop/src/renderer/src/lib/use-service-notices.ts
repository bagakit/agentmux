import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import type { RenderableServiceNotice } from './service-window-notice'
import { compactNotificationIdentity } from './notification-read-identity'

export type ServiceNoticeItem = {
  id: string
  /** Same original Session notice in local and global readers. Not a business identity. */
  readKey?: string
  /** Lifecycle notices read their original event record; other Session notices use global:sessions. */
  readScope?: 'global:events'
  readOrigin?: { scope: string; id: string }
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
const fingerprints = new WeakMap<ServiceNoticeItem, { facts: readonly unknown[]; value: string }>()
export function serviceNoticeFingerprint(item: ServiceNoticeItem): string {
  const cause = item.cause ?? item.notice.notice
  const facts = [item.occurrence, item.notice.kind, ...(typeof cause === 'string'
    ? [cause] : [cause.step, cause.mode, cause.restore])]
  const known = fingerprints.get(item)
  if (known && facts.length === known.facts.length && facts.every((fact, index) => fact === known.facts[index])) return known.value
  const value = JSON.stringify([item.occurrence, item.notice.kind,
    compactNotificationIdentity(typeof cause === 'string' ? cause : JSON.stringify(cause))])
  fingerprints.set(item, { facts, value })
  return value
}

/** Only acknowledgement is persisted. Only a complete, available owner projection may prune receipts. */
export function useReadReceipts(scope: string, current: Readonly<Record<string, string>>, available = true, complete = true) {
  const receipts = useAppStore((state) => state.noticeReadReceipts[scope] ?? EMPTY_RECEIPTS)
  const signature = useMemo(() => JSON.stringify(current), [current])
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
  const unread = useMemo(() => Object.keys(current).filter((id) => receipts[id] !== current[id]), [current, receipts])
  return { unread, acknowledge }
}


export function useServiceNotices(scope: string, notices: readonly ServiceNoticeItem[], available = true, complete = true) {
  const current = Object.fromEntries(notices.map((item) => [item.id, serviceNoticeFingerprint(item)]))
  const receipts = useReadReceipts(scope, current, available, complete)
  // Select only these readers' values: reading an unrelated Session must not wake
  // every retained local surface. The original global owner alone prunes shared receipts.
  const shared = useAppStore(useShallow(state => notices.map(item => item.readKey
    ? state.noticeReadReceipts[item.readScope ?? 'global:sessions']?.[item.readKey] : undefined)))
  const sharedValue = (item: ServiceNoticeItem) => item.readScope === 'global:events' ? 'read' : serviceNoticeFingerprint(item)
  const signature = JSON.stringify(notices.map(item => [item.readKey, item.readScope, item.readOrigin, current[item.id]]))
  useEffect(() => {
    if (!available) return
    // Preserve pre-existing local reading facts at the original owner's exact
    // identity. Consume them once so an old local receipt cannot hide recurrence.
    useAppStore.setState(state => {
      let next = state.noticeReadReceipts
      for (const item of notices) {
        const origin = item.readOrigin
        const targetScope = item.readScope ?? 'global:sessions'
        if (!item.readKey || !origin || origin.scope === targetScope) continue
        const prior = next[origin.scope]
        if (prior?.[origin.id] !== current[item.id]) continue
        if (next === state.noticeReadReceipts) next = { ...next }
        const remaining = { ...prior }; delete remaining[origin.id]
        if (Object.keys(remaining).length) next[origin.scope] = remaining
        else delete next[origin.scope]
        if (next[targetScope]?.[item.readKey] !== sharedValue(item)) next[targetScope] = {
          ...next[targetScope], [item.readKey]: sharedValue(item)
        }
      }
      return next === state.noticeReadReceipts ? state : { noticeReadReceipts: next }
    })
  }, [available, signature])
  const unread = new Set(receipts.unread)
  return { scope, available, notices, unread: notices.filter((item, index) => item.readKey
    ? shared[index] !== sharedValue(item) : unread.has(item.id)),
    acknowledge(items: readonly ServiceNoticeItem[]) {
      if (!items.length) return
      useAppStore.setState(state => {
        const next = { ...state.noticeReadReceipts }
        for (const item of items) {
          const targetScope = item.readKey ? item.readScope ?? 'global:sessions' : scope
          const key = item.readKey ?? item.id
          next[targetScope] = { ...next[targetScope], [key]: item.readKey ? sharedValue(item) : serviceNoticeFingerprint(item) }
        }
        return { noticeReadReceipts: next }
      })
    } }
}
