import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSessionHistoryDescriptor, AgentSessionHistoryReadPage, AgentSessionHistoryReadEntry } from '@agentmux/core'
import { readHistoryQuery } from '@agentmux/client-ui/history-query-read'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { FOCUS_READING_BYTES, FOCUS_READING_CAPTURED_RECORDS, FOCUS_READING_NATIVE_RECORDS } from './focus-reading-budget'
import { api } from './api'

type Source = { hostId: string; agentSessionId: string; source: 'captured' | 'native'; cursor?: string }
export type FocusHistoryHit = { reference: Source; entry: Extract<AgentSessionHistoryReadEntry, { kind: 'item' }>; nativeSource?: AgentSessionHistoryReadPage['nativeSource'] }
export const focusHistoryHitKey = (hit: FocusHistoryHit) => JSON.stringify([hit.reference.hostId, hit.reference.agentSessionId, hit.reference.source, hit.nativeSource?.providerId, hit.nativeSource?.nativeSessionId, hit.entry.item.id])
type Search = { matched: number; trimmed: number; query: string; label: string; pending: Source[]; total: number; completed: number; examined: number; hits: FocusHistoryHit[]; issues: string[]; loading: boolean }
/** One explicit reading projection, using the shared Host query owner and its continuations. */
export function useFocusHistorySearch(query: string, visible: boolean, sources: readonly AgentSessionHistoryDescriptor[], catalogueIssue: string | null) {
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
  let next = { ...initial, pending: [...initial.pending], hits: [...initial.hits], issues: [...initial.issues], loading: true }
  setResult(next)
  const current = () => epoch === generation.current && !controller.signal.aborted && latest.current.visible && latest.current.query === originalQuery
  // Each deliberate batch performs at most eight original source pages. A
  // partial cursor stays first, so an idle/evicted query is never silently skipped.
  for (let pages = 0; pages < 8 && next.pending.length && current(); pages++) {
   const source = next.pending[0]!
   try {
    const page = await readHistoryQuery({ source: source.source, kind: 'text', query: next.query, scanLimit: 200, limit: 10, maxBytes: 1024 * 1024, ...(source.cursor ? { cursor: source.cursor } : {}) }, (input, signal) => api.sessions.readHistory({ hostId: source.hostId, agentSessionId: source.agentSessionId }, input, { signal }), controller.signal, current)
    if (!current()) return
    if (page.kind !== 'text' || page.hostId !== source.hostId || page.agentSessionId !== source.agentSessionId || page.source !== source.source || !page.scan) throw new Error('The history query returned another source or an unconfirmed text view. Its original source is kept.')
    next.examined += page.scan.examined
    const seen = new Set(next.hits.map(focusHistoryHitKey))
    for (const entry of page.items) if (entry.kind === 'item') {
     const hit: FocusHistoryHit = { reference: source, entry, ...(page.nativeSource ? { nativeSource: page.nativeSource } : {}) }, key = focusHistoryHitKey(hit)
     if (!seen.has(key)) { seen.add(key); next.hits.push(hit); next.matched++ }
    }
    next.trimmed += retain(next.hits)
    if (page.nextCursor) {
     if (page.nextCursor === source.cursor) throw new Error('The original history cursor did not advance; this source remains unconfirmed.')
     next.pending[0] = { ...source, cursor: page.nextCursor }
    } else { next.pending.shift(); next.completed++ }
   } catch (error) {
    if (!current()) return
    next.issues.push(`${source.hostId} / ${source.agentSessionId} / ${source.source}: ${presentError(error)}`)
    next.pending.shift()
   }
   next = { ...next, pending: [...next.pending], hits: [...next.hits], issues: [...next.issues] }; setResult(next)
  }
  if (current()) { next.loading = false; setResult({ ...next }); active.current = null }
 }, [])
 const start = useCallback((selected?: AgentSessionHistoryDescriptor) => {
  if (!latest.current.visible || !selected && !query.trim()) return
  const pending: Source[] = [], seen = new Set<string>()
  for (const source of selected ? [selected] : sources) for (const kind of ['captured', ...(source.history?.nativeHandle ? ['native'] : [])] as const) {
   const key = JSON.stringify([source.hostId, source.agentSessionId, kind]); if (seen.has(key)) continue
   seen.add(key); pending.push({ hostId: source.hostId, agentSessionId: source.agentSessionId, source: kind as Source['source'] })
  }
  pinned.current = null; setExpandedKey(null)
  void read({ matched: 0, trimmed: 0, query: selected ? '' : query.trim(), label: selected ? `Recorded conversation · ${selected.agentSessionId}` : query.trim(), pending, total: pending.length, completed: 0, examined: 0, hits: [], issues: catalogueIssue ? [`Source catalogue: ${catalogueIssue}`] : [], loading: false })
 }, [query, sources, catalogueIssue, read])
 const more = useCallback(() => { if (result && !result.loading) void read(result) }, [result, read])
 return { result, start, more, cancel, expandedKey, expand }
}
