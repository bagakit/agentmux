import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSessionHistoryDescriptor, AgentSessionHistoryReadPage, AgentSessionHistoryReadEntry } from '@agentmux/core'
import type { AgentMuxSearchHistoryReference, AgentMuxSearchInput } from '@agentmux/core/search'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { FOCUS_READING_BYTES, FOCUS_READING_CAPTURED_RECORDS, FOCUS_READING_NATIVE_RECORDS } from './focus-reading-budget'
import { api } from './api'

export type FocusHistoryHit = { reference: AgentMuxSearchHistoryReference; entry: Extract<AgentSessionHistoryReadEntry, { kind: 'item' }>; nativeSource?: AgentSessionHistoryReadPage['nativeSource'] }
export const focusHistoryHitKey = (hit: FocusHistoryHit) => JSON.stringify([hit.reference.hostId, hit.reference.agentSessionId, hit.reference.source, hit.nativeSource?.providerId, hit.nativeSource?.nativeSessionId, hit.entry.item.id])
type Search = { confirmed: boolean; matched: number; trimmed: number; query: string; label: string; input: AgentMuxSearchInput; nextCursor: string | null; remaining: number; total: number; completed: number; examined: number; hits: FocusHistoryHit[]; issues: string[]; loading: boolean }
/** One explicit reading projection, using the shared Host query owner and its continuations. */
export function useFocusHistorySearch(query: string, visible: boolean) {
 const [result, setResult] = useState<Search | null>(null), [expandedKey, setExpandedKey] = useState<string | null>(null)
 const pinned = useRef<string | null>(null), sizes = useRef(new WeakMap<object, number>())
 const expand = useCallback((key: string, open: boolean) => {
  if (open) { pinned.current = key; setExpandedKey(key) }
  else if (pinned.current === key) { pinned.current = null; setExpandedKey(null) }
 }, [])
 const retain = (hits: FocusHistoryHit[]) => {
  const byteSize = (hit: FocusHistoryHit) => { let size = sizes.current.get(hit.entry.item); if (size === undefined) { size = new TextEncoder().encode(JSON.stringify(hit.entry.item)).byteLength; sizes.current.set(hit.entry.item, size) } return size }
  let bytes = 0, native = 0, captured = 0, trimmed = 0
  for (const hit of hits) if (focusHistoryHitKey(hit) !== pinned.current) { bytes += byteSize(hit); if (hit.reference.source === 'native') native++; else captured++ }
  while (native > FOCUS_READING_NATIVE_RECORDS || captured > FOCUS_READING_CAPTURED_RECORDS || bytes > FOCUS_READING_BYTES) {
   const candidates = hits.filter(hit => focusHistoryHitKey(hit) !== pinned.current)
   // One original result can exceed the ordinary window budget, up to the
   // Core's single-record query budget. Never truncate its original content.
   if (candidates.length <= 1) break
   const index = hits.findIndex(hit => focusHistoryHitKey(hit) !== pinned.current && (native > FOCUS_READING_NATIVE_RECORDS ? hit.reference.source === 'native' : captured > FOCUS_READING_CAPTURED_RECORDS ? hit.reference.source === 'captured' : true))
   if (index < 0) break
   const [removed] = hits.splice(index, 1); bytes -= byteSize(removed!); if (removed!.reference.source === 'native') native--; else captured--; trimmed++
  }
  return trimmed
 }
 const generation = useRef(0), active = useRef<AbortController | null>(null), latest = useRef({ query, visible })
 latest.current = { query, visible }
 const cancel = useCallback(() => { generation.current++; active.current?.abort(); active.current = null; setResult(current => current && { ...current, loading: false }) }, [])
 useEffect(() => { cancel(); pinned.current = null; setExpandedKey(null); setResult(null); return () => { generation.current++; active.current?.abort() } }, [query, cancel])
 useEffect(() => { if (!visible) cancel(); return () => { generation.current++; active.current?.abort() } }, [visible, cancel])
 const read = useCallback(async (initial: Search) => {
  active.current?.abort(); const controller = new AbortController(), epoch = ++generation.current, originalQuery = latest.current.query
  active.current = controller
  const next = { ...initial, hits: [...initial.hits], issues: [...initial.issues], loading: true }
  setResult(next)
  const current = () => epoch === generation.current && !controller.signal.aborted && latest.current.visible && latest.current.query === originalQuery
  try {
   const page = await api.search.query({ ...next.input, ...(next.nextCursor ? { cursor: next.nextCursor } : {}) }, { signal: controller.signal })
   if (!current()) return
   next.confirmed = true; next.examined += page.coverage.examined; next.total = page.coverage.totalSources
   next.completed = page.coverage.completedSources; next.remaining = page.coverage.remainingSources; next.nextCursor = page.nextCursor
   next.issues.push(...page.coverage.unavailable.map(issue => `${[issue.hostId, issue.agentSessionId, issue.source].filter(Boolean).join(' / ')}: ${issue.message} ${issue.recovery}`))
   const seen = new Set(next.hits.map(focusHistoryHitKey))
   for (const hit of page.hits) if (hit.kind === 'history') for (const entry of hit.page.items) if (entry.kind === 'item') {
    const result: FocusHistoryHit = { reference: hit.reference, entry, ...(hit.page.nativeSource ? { nativeSource: hit.page.nativeSource } : {}) }, key = focusHistoryHitKey(result)
    if (!seen.has(key)) { seen.add(key); next.hits.push(result); next.matched++ }
   }
   next.trimmed += retain(next.hits)
  } catch (error) {
   if (!current()) return
   next.issues.push(presentError(error))
  }
  if (current()) { next.loading = false; setResult({ ...next }); active.current = null }
 }, [])
 const start = useCallback((selected?: AgentSessionHistoryDescriptor) => {
  if (!latest.current.visible || !selected && !query.trim()) return
  const input: AgentMuxSearchInput = { mode: 'history', query: selected ? '' : query.trim(), limit: 30, scanLimit: 1600,
   ...(selected ? { hostId: selected.hostId, agentSessionId: selected.agentSessionId } : {}) }
  pinned.current = null; setExpandedKey(null)
  void read({ confirmed: false, matched: 0, trimmed: 0, query: input.query, label: selected ? `Recorded conversation · ${selected.agentSessionId}` : input.query,
   input, nextCursor: null, remaining: 0, total: 0, completed: 0, examined: 0, hits: [], issues: [], loading: false })
 }, [query, read])
 const more = useCallback(() => { if (result && !result.loading) void read(result) }, [result, read])
 return { result, start, more, cancel, expandedKey, expand }
}
