// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentSessionHistoryObservation } from '@agentmux/core'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

const source = { providerId: 'codex', nativeSessionId: 'original-native-session' } as const
const control = { kind: 'agent', hostId: 'local', agentSessionId: 'live-native-agent', run: { runId: 'original-run' } } as const
let result: ReturnType<typeof useSessionUserMessages>
let publish: (e: AgentSessionHistoryObservation) => void
let page: AgentSessionHistoryPage
let records: AgentSessionHistoryPage['items']
let root: Root, host: HTMLDivElement
const initial = useAppStore.getState()
const record = (id: string, kind: 'user-message' | 'activity' = 'activity') => ({ id, kind, contentParts: [{ kind: 'text' as const, text: kind === 'user-message' ? 'Original terminal input' : `Real process record ${id}` }] })
const flush = async () => { await act(async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }) }
const invalidate = async () => { await act(async () => { publish({ kind: 'invalidated', agentSessionId: control.agentSessionId, source }); await new Promise(r => setTimeout(r, 80)) }); await flush() }
let historyOpens: number
function Reader({ enabled = true, hookOnly = false, currentControl = control }: { enabled?: boolean; hookOnly?: boolean; currentControl?: typeof control }) {
  result = useSessionUserMessages(currentControl, { enabled })
  return hookOnly ? null : <ActivityView capability="complete-events" sessionId={currentControl.agentSessionId} items={[]} userMessages={result.messages}
    nativeHistoryPage={result.nativeHistoryPage} userMessageRead={{ loading: result.loading, error: result.error,
      observationError: result.observationError, windowFrozen: result.windowFrozen, windowIncomplete: result.windowIncomplete,
      hasMore: result.hasMore, onRetry: () => { void result.refresh() }, onReadEarlier: () => { historyOpens++ } }} />
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  page = { agentSessionId: control.agentSessionId, source, items: [record('old-user', 'user-message'), ...Array.from({ length: 29 }, (_, i) => record(`process-${i}`))], nextCursor: 'original-earlier-cursor' }
  records = page.items
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (_c, options) => {
    const end = options?.cursor ? Number(options.cursor.slice(7)) : records.length
    const start = Math.max(0, end - 30)
    return { ...page, items: records.slice(start, end), nextCursor: start > 0 ? `opaque-${start}` : null }
  })
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async (_c, listener) => { publish = listener; return { agentSessionId: control.agentSessionId, source, dispose() {} } })
  historyOpens = 0
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  useAppStore.setState({ timelines: {} })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); useAppStore.setState(initial, true) })
it('continues observing new input after process activity fills the current reading window', async () => {
  await act(async () => root.render(<Reader />)); await flush()
  const oldBody = host.querySelector('[data-native-record-id="old-user"] .log-turn__body')!; expect(oldBody).not.toBeNull()
  for (const start of [29, 59]) {
    records = [...records, ...Array.from({ length: 30 }, (_, i) => record(`process-${start + i}`))]
    await invalidate()
  }
  records = [...records, ...Array.from({ length: 29 }, (_, i) => record(`process-${89 + i}`)), record('new-user', 'user-message')]
  await invalidate()
  expect(host.querySelector('[data-native-record-id="new-user"] .log-turn__body')?.textContent).toBe('Original terminal input')
  expect(host.querySelector('[data-native-record-id="old-user"] .log-turn__body')).toBe(oldBody)
  expect(result.windowFrozen).toBe(false)
  expect(result.windowIncomplete).toBe(true)
  expect(result.nativeHistoryPage!.items.some(i => i.id === 'new-user')).toBe(true)
})

it('keeps new actual source records visible when the last overlap is beyond three recent pages', async () => {
  await act(async () => root.render(<Reader />)); await flush()
  const oldBody = host.querySelector('[data-native-record-id="old-user"] .log-turn__body')!
  expect(oldBody).not.toBeNull()
  records = [...records, ...Array.from({ length: 120 }, (_, i) => record(`burst-${i}`)), record('new-user', 'user-message')]
  await invalidate()
  expect(host.querySelector('[data-native-record-id="new-user"] .log-turn__body')?.textContent).toBe('Original terminal input')
  expect(host.querySelector('[data-native-record-id="old-user"] .log-turn__body')).toBe(oldBody)
  expect(result.windowFrozen).toBe(false)
  expect(result.windowIncomplete).toBe(true)
})

it('exposes the partial window and delegates older reading to the original History action', async () => {
  await act(async () => root.render(<Reader />)); await flush()
  records = [...records, ...Array.from({ length: 120 }, (_, i) => record(`gap-${i}`)), record('fresh', 'user-message')]
  await invalidate()
  expect(host.querySelector('.activity-feed__read-notice')?.textContent).toContain('History reads the original sequence')
  const button = [...host.querySelectorAll('button')].find(n => n.textContent === 'Read earlier records')!
  expect(button).toBeDefined(); await act(async () => button.click()); expect(historyOpens).toBe(1)
})
it('keeps equal input bodies under their two original record identities', async () => {
  records = [record('first', 'user-message'), record('second', 'user-message')]
  await act(async () => root.render(<Reader />)); await flush()
  expect([...host.querySelectorAll('.log-turn__body')].map(n => n.textContent)).toEqual(['Original terminal input', 'Original terminal input'])
  expect(result.messages.map(m => m.rawId)).toEqual(['first', 'second'])
})
it('does not replace a retained input Range when process retention rolls forward', async () => {
  await act(async () => root.render(<Reader />)); await flush()
  const body = host.querySelector('[data-native-record-id="old-user"] .log-turn__body')!
  const text = body.querySelector('p')!.firstChild!; const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8)
  const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  records = [...records, ...Array.from({ length: 120 }, (_, i) => record(`range-${i}`)), record('fresh', 'user-message')]
  await invalidate()
  expect(host.querySelector('[data-native-record-id="old-user"] .log-turn__body')).toBe(body)
  expect(range.startContainer.isConnected).toBe(true); expect(range.toString()).toBe('Original'); expect(selection.toString()).toBe('Original')
})
it('continues taking newest speech within the independent message and total byte budgets', async () => {
  await act(async () => root.render(<Reader hookOnly />)); await flush()
  for (let turn = 0; turn < 8; turn++) {
    records = [...records, ...Array.from({ length: 30 }, (_, i) => ({ ...record(`large-${turn}-${i}`, 'user-message'), contentParts: [{ kind: 'text' as const, text: 'x'.repeat(80_000) }] }))]
    await invalidate()
    const retained = result.nativeHistoryPage!.items
    expect(retained.filter(i => i.kind !== 'activity').length).toBeLessThanOrEqual(200)
    expect(retained.filter(i => i.kind === 'activity').length).toBeLessThanOrEqual(90)
    expect(retained.reduce((n, item) => n + new TextEncoder().encode(JSON.stringify(item)).byteLength, 0)).toBeLessThanOrEqual(12 * 1024 * 1024)
    expect(retained.at(-1)?.id).toBe(`large-${turn}-29`); expect(result.windowFrozen).toBe(false)
  }
  expect(result.windowIncomplete).toBe(true)
})
it('stops hidden demand and ignores its late read without losing the same-control body', async () => {
  await act(async () => root.render(<Reader />)); await flush()
  const body = host.querySelector('[data-native-record-id="old-user"] .log-turn__body')!
  let release!: (value: AgentSessionHistoryPage) => void
  vi.mocked(api.sessions.historyPage).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  await invalidate(); const calls = vi.mocked(api.sessions.historyPage).mock.calls.length
  await act(async () => root.render(<Reader enabled={false} />)); await flush()
  await act(async () => release({ ...page, items: [record('late', 'user-message')] })); await flush()
  expect(host.querySelector('[data-native-record-id="old-user"] .log-turn__body')).toBe(body)
  expect(host.querySelector('[data-native-record-id="late"]')).toBeNull()
  await invalidate(); expect(api.sessions.historyPage).toHaveBeenCalledTimes(calls)
})
it('preserves healthy same-source speech after an ordinary native read failure', async () => {
  await act(async () => root.render(<Reader />)); await flush()
  const body = host.querySelector('[data-native-record-id="old-user"] .log-turn__body')!
  vi.mocked(api.sessions.historyPage).mockRejectedValueOnce(new Error('Readonly source temporarily unavailable'))
  await invalidate()
  expect(host.querySelector('[data-native-record-id="old-user"] .log-turn__body')).toBe(body)
  expect(result.error?.message).toBe('Readonly source temporarily unavailable')
  expect(host.textContent).toContain('Existing messages are kept')
  records = [...records, record('retry-input', 'user-message')]; await invalidate()
  expect(host.querySelector('[data-native-record-id="retry-input"] .log-turn__body')?.textContent).toBe('Original terminal input')
})

it('rejects a different native source without adopting its input or closing the healthy reader', async () => {
  await act(async () => root.render(<Reader />)); await flush()
  const body = host.querySelector('[data-native-record-id="old-user"] .log-turn__body')!
  vi.mocked(api.sessions.historyPage).mockResolvedValueOnce({ ...page, source: { ...source, nativeSessionId: 'different-source' }, items: [record('wrong-source', 'user-message')] })
  await invalidate()
  expect(host.querySelector('[data-native-record-id="old-user"] .log-turn__body')).toBe(body)
  expect(host.querySelector('[data-native-record-id="wrong-source"]')).toBeNull()
  expect(result.sourceChanged).toBe(true)
})
it('ignores unrelated invalidation and coalesces a relevant burst into one bounded read', async () => {
  await act(async () => root.render(<Reader />)); await flush()
  const before = vi.mocked(api.sessions.historyPage).mock.calls.length
  await act(async () => { publish({ kind: 'invalidated', source, agentSessionId: 'unrelated-agent' }); await new Promise(r => setTimeout(r, 80)) }); await flush()
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(before)
  records = [...records, record('one-new-input', 'user-message')]
  await act(async () => { for (let i = 0; i < 3; i++) publish({ kind: 'invalidated', source, agentSessionId: control.agentSessionId }); await new Promise(r => setTimeout(r, 80)) }); await flush()
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(before + 1)
  expect(host.querySelector('[data-native-record-id="one-new-input"] .log-turn__body')?.textContent).toBe('Original terminal input')
})
