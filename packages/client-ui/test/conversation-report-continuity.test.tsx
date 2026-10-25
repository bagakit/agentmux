// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryItem, AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { consumeConversationWindowPage } from '@agentmux/core/conversation'
import { nativeHistoryFixture, jsonl } from '../../core/test/fixtures/native-history-session.js'
import { conversationMessageSourceKey } from '../src/lib/conversation-message-location.js'
import { ConversationView } from '../src/components/ConversationView.js'
import { NativeProcessObservation } from '../src/components/NativeProcessObservation.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { projectConversationReading, projectConversationWindow, type ConversationRecord } from '../src/lib/conversation-records.js'
import { projectConversationRecordSequence, conversationPresentationKey } from '../src/lib/conversation-record-sequence.js'

const sid = 'original-agent-session'
const source = { providerId: 'codex', nativeSessionId: 'original-native-source' }
const copy = vi.fn(async (_text: string, _failed?: (error: unknown) => void) => true)
const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { getSelection()?.removeAllRanges(); for (const close of closes.splice(0).reverse()) await close(); copy.mockClear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const step = (id: string, turnId: string | null = 'original-turn'): AgentSessionHistoryItem => ({ id, kind: 'activity', ...(turnId === null ? {} : { turnId }), contentParts: [{ kind: 'text', text: 'Original process ' + id }] })
const report = (id: string, turnId: string | null = 'original-turn', native = source): AgentSessionHistoryItem => ({ ...step(id, turnId),
  collaboration: { kind: 'message', source: native, sender: '/root/reporter', recipient: '/root' },
  contentParts: [{ kind: 'text', text: 'Original report ' + id + '. Merely saying failed is not an operation status.' }] })
function page(items: AgentSessionHistoryItem[], native = source, sourceHostId = 'local'): AgentSessionHistoryPage {
  return { agentSessionId: sid, sourceHostId, source: native, nextCursor: null, items }
}
function reading(items: AgentSessionHistoryItem[], captured: AgentTimelineItem[] = [], native = source, sourceHostId = 'local') {
  const historyPage = page(items, native, sourceHostId)
  const projection = projectConversationReading({ agentSessionId: sid, executionHostId: 'local', historyPage,
    ...(captured.length ? { timeline: { agentSessionId: sid, sourceHostId: 'local', revision: 1, items: captured } } : {}) })
  return { page: historyPage, records: projection.records, originalRecords: projection.originalRecords, coverage: projection.timeline.coverage }
}
function record(item: AgentSessionHistoryItem, native = source, sourceHostId = 'local') { return reading([item], [], native, sourceHostId).records[0]! }
function captured(item: Partial<AgentTimelineItem> & Pick<AgentTimelineItem, 'id' | 'kind'>) {
  const original = { agentSessionId: sid, source: 'native-hook' as const, status: 'complete' as const, title: 'Original captured', createdAt: 3, updatedAt: 3, ...item }
  const projected = projectConversationReading({ agentSessionId: sid, executionHostId: 'local', timeline: { agentSessionId: sid, sourceHostId: 'local', revision: 1, items: [original] } })
  return projected.records[0]!
}
const sequence = (records: readonly ConversationRecord[], previous = new Map<string, string>(), beforeRecordId?: string) => projectConversationRecordSequence(records, 'original-source-key', previous, beforeRecordId)
const groups = (value: ReturnType<typeof sequence>) => value.rows.filter(row => row.kind === 'process')
const ids = (value: ReturnType<typeof sequence>) => value.rows.flatMap(row => row.kind === 'process' ? row.entries.flatMap(entry => entry.kind === 'record' ? [entry.record.rawId] : []) : row.kind === 'record' ? [row.record.rawId] : [])

async function realCoreRecords() {
  const rows = (cwd: string) => [
    { type: 'session_meta', payload: { id: source.nativeSessionId, cwd } },
    { type: 'turn_context', payload: { turn_id: 'original-turn' } },
    { type: 'response_item', timestamp: new Date(1000).toISOString(), payload: { id: 'step-before', type: 'reasoning', turn_id: 'original-turn', summary: [{ type: 'summary_text', text: 'Original before step' }] } },
    { type: 'response_item', timestamp: new Date(2000).toISOString(), payload: { id: 'native-report', type: 'agent_message', turn_id: 'original-turn', author: '/root/reporter', recipient: '/root', content: [{ type: 'input_text', text: 'Original native report. Text saying failed is not a status.' }] } },
    { type: 'response_item', timestamp: new Date(4000).toISOString(), payload: { id: 'step-after', type: 'reasoning', turn_id: 'original-turn', summary: [{ type: 'summary_text', text: 'Original after step' }] } }
  ]
  const f = await nativeHistoryFixture('codex', root => jsonl(rows(root)), { nativeSessionId: source.nativeSessionId, agentSessionId: sid }); closes.push(f.close)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: { id: 'independent-observation', agentSessionId: sid, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Original independent capture', content: 'Independent original observation', createdAt: 3000, updatedAt: 3000 } })
  const result = consumeConversationWindowPage(await f.client.readAgentConversation({ hostId: 'local', agentSessionId: sid, limit: 100 }))
  expect(result.kind).toBe('complete')
  if (result.kind !== 'complete') throw Error('Bounded original fixture did not complete')
  const projected = projectConversationWindow(result.snapshot)
  expect(projected.records.map(record => record.rawId)).toEqual(['step-before', 'native-report', 'independent-observation', 'step-after'])
  expect(projected.records.map(record => record.role)).toEqual(['process', 'message', 'observation', 'process'])
  expect(projected.records.filter(record => record.original.kind === 'native').map(record => record.original.kind === 'native' && record.original.item.turnId)).toEqual(['original-turn', 'original-turn', 'original-turn'])
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
  return { f, props: { page: projected.historyPage!, records: projected.records, originalRecords: projected.originalRecords, coverage: projected.timeline.coverage } }
}
function surface() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  const render = (node: ReactNode) => act(async () => root.render(<ClientUiProvider platform={platform}>{node}</ClientUiProvider>))
  const draw = (props: ReturnType<typeof reading>, extra: Partial<ComponentProps<typeof ConversationView>> = {}) => render(<ConversationView {...props} sessionId={sid} executionHostId="local" renderProcess={props => <NativeProcessObservation {...props} compact />} {...extra} />)
  const click = async (selector: string) => { const button = host.querySelector<HTMLButtonElement>(selector); expect(button).not.toBeNull(); await act(async () => button!.click()) }
  return { host, render, draw, click }
}

it('projects one same-source same-turn interval over actual Core message reports and observations without changing any original role', async () => {
  const { props } = await realCoreRecords(), originals = structuredClone(props.records)
  const result = sequence(props.records)
  expect(groups(result)).toHaveLength(1)
  expect(ids(result)).toEqual(props.records.map(record => record.rawId))
  expect(groups(result)[0]!.records).toEqual(props.records)
  expect(props.records).toEqual(originals)
  const originalReport = props.records.find(record => record.rawId === 'native-report')!
  expect(originalReport.role).toBe('message'); expect(originalReport.original.kind).toBe('native')
  expect(originalReport.original.kind === 'native' && originalReport.original.item.collaboration?.kind).toBe('message')
})

it('actual process renderer exposes original messages while collapsed and counts only true process members', async () => {
  const { props } = await realCoreRecords(), { host, render, click } = surface()
  await render(<NativeProcessObservation id="original-accepted-interval" compact records={props.records}
    entries={props.records.map(record => ({ kind: 'record', record }))} renderRecord={record => <article data-original-record={record.rawId}>{record.content}</article>} />)
  const reportNode = host.querySelector('[data-original-record="native-report"]')
  const observationNode = host.querySelector('[data-original-record="independent-observation"]')
  expect(reportNode).not.toBeNull(); expect(observationNode).not.toBeNull()
  expect(reportNode!.closest('[hidden],[inert],.native-process-observation__step')).toBeNull()
  expect(observationNode!.closest('[hidden],[inert],.native-process-observation__step')).toBeNull()
  expect(host.querySelector('.log-fold__steps')?.textContent).toBe('2 条已加载记录')
  expect(host.querySelector('.wf-card')?.getAttribute('data-status')).not.toBe('failed')
  await click('.wf-head'); await click('.wf-head')
  expect(host.querySelector('[data-original-record="native-report"]')).toBe(reportNode)
  expect(host.querySelector('[data-original-record="independent-observation"]')).toBe(observationNode)
  expect(host.querySelectorAll('[data-original-record="native-report"]')).toHaveLength(1)
  expect([...host.querySelectorAll('.native-process-observation__step')].every(node => node.hasAttribute('hidden'))).toBe(true)
})

it('full shared consumer retains the report body, Range, Copy and disclosure across process collapse and nonempty prepend/append', async () => {
  const { props } = await realCoreRecords(), { host, draw, click } = surface()
  await draw(props)
  const original = host.querySelector('[data-native-record-id="native-report"]')!
  expect(original).not.toBeNull(); expect(original.closest('.native-process-observation__step')).toBeNull()
  await click('[data-native-record-id="native-report"] .log-turn__collaboration-toggle')
  const body = original.querySelector('.log-turn__body')!, text = body.querySelector('p')!.firstChild!
  const range = document.createRange(); range.selectNodeContents(text); getSelection()!.addRange(range)
  const selection = getSelection()!.toString()
  await click('[data-native-record-id="native-report"] [title="Copy message"]')
  expect(copy).toHaveBeenLastCalledWith('Original native report. Text saying failed is not a status.', expect.any(Function))
  await click('[data-native-record-id="native-report"] [aria-label="Message details"]')
  expect(original.querySelector('.conversation-input-details__body')?.textContent).toContain('/root/reporter')
  await click('[data-native-record-id="native-report"] [aria-label="Message details"]')
  const key = host.querySelector('.conversation-record-process')!.getAttribute('data-conversation-process-key')
  expect(key).not.toBeNull()
  await click('.wf-head'); await click('.wf-head')
  expect(original.closest('[hidden],[inert]')).toBeNull()
  const before = record(step('prepended-step')), after = record(step('appended-step'))
  await draw({ ...props, records: [before, ...props.records, after] })
  expect(host.querySelector('[data-native-record-id="native-report"]')).toBe(original)
  expect(original.querySelector('.log-turn__body')).toBe(body); expect(text.isConnected).toBe(true)
  expect(range.startContainer).toBe(text); expect(getSelection()!.toString()).toBe(selection)
  expect(original.querySelector('.log-turn__collaboration-toggle')?.getAttribute('aria-expanded')).toBe('true')
  expect(host.querySelectorAll('.conversation-record-process')).toHaveLength(1)
  expect(host.querySelector('.conversation-record-process')?.getAttribute('data-conversation-process-key')).toBe(key)
  expect(host.querySelector('.log-fold__steps')?.textContent).toBe('4 条已加载记录')
  expect(host.querySelectorAll('[data-native-record-id="native-report"]')).toHaveLength(1)
})

it.each(['host', 'provider', 'native-session', 'turn', 'host-without-turn', 'provider-without-turn', 'native-session-without-turn'])('does not attach a report across a known %s boundary', boundary => {
  const missingTurn = boundary.endsWith('without-turn'), turn = missingTurn ? null : 'original-turn'
  const foreign = { providerId: boundary.startsWith('provider') ? 'another-provider' : source.providerId, nativeSessionId: boundary.startsWith('native-session') ? 'another-native-source' : source.nativeSessionId }
  const a = record(step('a', turn)), r = record(report('report', boundary === 'turn' ? 'different-turn' : turn, foreign), foreign, boundary.startsWith('host') ? 'another-host' : 'local'), b = record(step('b', turn))
  if (missingTurn) for (const original of [a, r, b]) expect(original.original.kind === 'native' && original.original.item.turnId).toBeUndefined()
  const result = sequence([a, r, b])
  expect(groups(result)).toHaveLength(2)
  expect(groups(result).every(group => !group.records.includes(r))).toBe(true)
  expect(result.rows.some(row => row.kind === 'record' && row.record === r)).toBe(true)
  expect(ids(result)).toEqual(['a', 'report', 'b'])
})

it('unknown turns never erase two already known incompatible turns', () => {
  const a = record(step('a', 'known-a')), r = record(report('report', null)), b = record(step('b', 'known-b'))
  const result = sequence([a, r, b])
  expect(groups(result)).toHaveLength(2)
  expect(groups(result).some(group => group.records.includes(a) && group.records.includes(b))).toBe(false)
  expect(ids(result)).toEqual(['a', 'report', 'b'])
})

it.each(['user', 'independent-session', 'progress', 'final', 'system', 'interaction', 'self-described-report'])('preserves the real %s boundary without deriving report qualification from labels or prose', kind => {
  const a = record(step('a')), b = record(step('b'))
  const barrier = kind === 'independent-session' ? captured({ id: 'barrier', kind: 'user_message', source: 'user', authorAgentSessionId: 'independent-agent-session', content: 'Subagent /root/reporter' })
    : kind === 'interaction' ? captured({ id: 'barrier', kind: 'permission', status: 'failed', content: 'Original interaction' })
    : record({ id: 'barrier', kind: kind === 'user' ? 'user-message' : kind === 'system' ? 'system-message' : 'assistant-message', turnId: 'original-turn',
      title: 'Subagent /root/reporter', ...(kind === 'progress' ? { messagePhase: 'progress' as const } : kind === 'final' ? { messagePhase: 'final' as const } : {}), contentParts: [{ kind: 'text', text: 'Subagent report: /root/reporter says complete.' }] })
  const result = sequence([a, barrier, b])
  expect(groups(result)).toHaveLength(2)
  expect(result.rows.some(row => row.kind === 'record' && row.record === barrier)).toBe(true)
  expect(ids(result)).toEqual(['a', 'barrier', 'b'])
})

it.each(['report', 'following-step'])('retains the exact reading boundary before the %s', location => {
  const a = record(step('a')), r = record(report('report')), b = record(step('b'))
  const result = sequence([a, r, b], new Map(), conversationPresentationKey(location === 'report' ? r : b))
  expect(result.rows.filter(row => row.kind === 'boundary')).toHaveLength(1)
  expect(groups(result).some(group => group.records.includes(a) && group.records.includes(b))).toBe(false)
  expect(ids(result)).toEqual(['a', 'report', 'b'])
})

it('an isolated report stays standalone and never creates an empty process interval', () => {
  const r = record(report('alone')), result = sequence([r])
  expect(groups(result)).toHaveLength(0); expect(result.rows).toEqual([{ kind: 'record', record: r }])
  const next = sequence([r, record(step('after'))])
  expect(next.rows[0]).toEqual({ kind: 'record', record: r }); expect(groups(next)).toHaveLength(1)
  expect(groups(next)[0]!.records.map(record => record.rawId)).toEqual(['after'])
})

it('never merges two already mounted parents when an eligible report is discovered between them', () => {
  const a = record(step('a')), r = record(report('report')), b = record(step('b'))
  const previous = new Map([...sequence([a]).groups, ...sequence([b]).groups])
  expect(new Set(previous.values()).size).toBe(2)
  const result = sequence([a, r, b], previous)
  expect(groups(result)).toHaveLength(2)
  expect(result.groups.get(conversationPresentationKey(a))).toBe(previous.get(conversationPresentationKey(a)))
  expect(result.groups.get(conversationPresentationKey(b))).toBe(previous.get(conversationPresentationKey(b)))
  expect(ids(result)).toEqual(['a', 'report', 'b'])
})

it('nonempty same-source prepend and append keep the accepted parent and exact source order', () => {
  const a = record(step('a')), r = record(report('report')), b = record(step('b')), initial = sequence([a, r, b])
  expect(groups(initial)).toHaveLength(1)
  const earlier = record(step('earlier')), later = record(step('later')), current = sequence([earlier, a, r, b, later], new Map(initial.groups))
  expect(groups(current)).toHaveLength(1); expect(groups(current)[0]!.id).toBe(groups(initial)[0]!.id)
  expect(ids(current)).toEqual(['earlier', 'a', 'report', 'b', 'later'])
})


it('switching the actual source scope drops old parents and disclosure choices without inheriting a selected original', async () => {
  const { host, draw, click } = surface(), a = step('before'), r = report('report'), b = step('after')
  await draw(reading([a, r, b]))
  await click('.wf-head'); await click('[data-native-record-id="report"] .log-turn__collaboration-toggle')
  const old = host.querySelector('[data-native-record-id="report"]')!, oldGroup = host.querySelector('.conversation-record-process')!
  const text = old.querySelector('.log-turn__body p')!.firstChild!, range = document.createRange(); range.selectNodeContents(text); getSelection()!.addRange(range)
  const nextSource = { ...source, nativeSessionId: 'other-original-source' }
  const nextPage = page([step('other-before'), report('report', 'original-turn', nextSource), step('other-after')], nextSource, 'other-host')
  const next = projectConversationReading({ agentSessionId: sid, executionHostId: 'other-host', historyPage: nextPage })
  await draw({ page: nextPage, records: next.records, originalRecords: next.originalRecords, coverage: next.timeline.coverage }, { executionHostId: 'other-host' })
  const current = host.querySelector('[data-native-record-id="report"]')!
  expect(current).not.toBeNull(); expect(current).not.toBe(old); expect(old.isConnected).toBe(false); expect(oldGroup.isConnected).toBe(false)
  expect(current.querySelector('.log-turn__collaboration-toggle')?.getAttribute('aria-expanded')).toBe('false')
  expect(current.querySelector('.log-turn__body')).toBeNull()
  expect([...host.querySelectorAll('.wf-head')].every(node => node.getAttribute('aria-expanded') === 'false')).toBe(true)
  expect(host.querySelector('[data-native-step-id="before"]')).toBeNull()
  expect(host.querySelectorAll('[data-native-record-id="report"]')).toHaveLength(1)
})

it('late preceding process holds a selected standalone report until the existing presentation release', async () => {
  const { host, draw, click } = surface(), r = report('report'), b = step('after'), a = step('late-before')
  await draw(reading([r, b]))
  await click('[data-native-record-id="report"] .log-turn__collaboration-toggle')
  const original = host.querySelector('[data-native-record-id="report"]')!, body = original.querySelector('.log-turn__body')!, text = body.querySelector('p')!.firstChild!
  const range = document.createRange(); range.selectNodeContents(text); getSelection()!.addRange(range)
  const selected = getSelection()!.toString(), focused = original.querySelector<HTMLButtonElement>('.log-turn__collaboration-toggle')!
  await act(async () => focused.focus())
  await draw(reading([a, r, b]))
  expect(host.querySelector('[data-native-record-id="report"]')).toBe(original)
  expect(original.querySelector('.log-turn__body')).toBe(body); expect(range.startContainer).toBe(text); expect(getSelection()!.toString()).toBe(selected)
  expect(host.querySelector('[data-conversation-process-members*="late-before"]')).toBeNull()
  expect(document.activeElement).toBe(focused)
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  expect(host.querySelector('[data-conversation-process-members*="late-before"]')).toBeNull()
  await act(async () => focused.blur())
  expect(host.querySelectorAll('.conversation-record-process')).toHaveLength(1)
  expect(host.querySelector('[data-conversation-process-members*="late-before"]')).not.toBeNull()
  const accepted = host.querySelector('[data-native-record-id="report"]')!
  expect(accepted).not.toBeNull(); expect(accepted.closest('.native-process-observation__step')).toBeNull()
  expect(host.querySelectorAll('[data-native-record-id="report"]')).toHaveLength(1)
})

it('exact original report location opens its body in the accepted interval and retains the real reading boundary', async () => {
  const { host, draw } = surface(), props = reading([step('before'), report('report'), step('after')])
  const original = props.records.find(record => record.rawId === 'report')!
  const location = conversationMessageSourceKey(sid, original.source)
  expect(location).toBeTypeOf('string')
  await draw(props, { locatedMessageKey: location!,
    recordBoundary: { beforeRecordId: 'after', content: <span data-original-boundary>Original reading boundary</span> } })
  const reportNode = host.querySelector('[data-native-record-id="report"]')!
  expect(reportNode).not.toBeNull(); expect(reportNode.closest('.native-process-observation__step')).toBeNull()
  expect(reportNode.querySelector('.log-turn__collaboration-toggle')?.getAttribute('aria-expanded')).toBe('true')
  expect(reportNode.querySelector('.log-turn__body')?.textContent).toContain('Original report report.')
  expect(host.querySelectorAll('[data-original-boundary]')).toHaveLength(1)
  expect(host.querySelectorAll('.conversation-record-process')).toHaveLength(2)
  const parent = reportNode.closest('.conversation-record-process')!
  expect(parent).not.toBeNull(); expect(parent.getAttribute('data-conversation-process-members')).toContain('before')
  expect(parent.getAttribute('data-conversation-process-members')).not.toContain('after')
})

it('report messages never inflate true step count or erase an exact completed operation status', async () => {
  const operation: AgentSessionHistoryItem = { ...step('completed-operation'), collaboration: { kind: 'operation', operation: 'wait', status: 'completed', receivers: [], agentStates: [] } }
  const records = reading([operation, report('original-report')]).records
  expect(records.map(record => record.role)).toEqual(['process', 'message'])
  const { host, render } = surface()
  await render(<NativeProcessObservation id="accepted-operation-and-report" records={records}
    entries={records.map(record => ({ kind: 'record', record }))} renderRecord={record => <span data-original-record={record.rawId}>{record.content}</span>} />)
  expect.soft(host.querySelector('.log-fold__steps')?.textContent).toBe('1 loaded records')
  expect.soft(host.querySelector('.wf-card')?.getAttribute('data-status')).toBe('complete')
  expect(host.querySelectorAll('[data-original-record="original-report"]')).toHaveLength(1)
})

it.each([false, true])('the shared consumer preserves a report’s own metrics without promoting them into process summary (step metrics: %s)', async withStepMetrics => {
  const diagnostic = { code: 'ORIGINAL_REPORT_METRICS_GAP', message: 'Original report retained diagnostic.' }
  const process: AgentSessionHistoryItem = withStepMetrics ? { ...step('real-process'),
    collaboration: { kind: 'operation', operation: 'wait', status: 'completed', receivers: [], agentStates: [] },
    metrics: { scope: 'response', durationMs: 11, usage: { outputTokens: 3 } } } : step('real-process')
  const originalReport: AgentSessionHistoryItem = { ...report('report-with-metrics'),
    metrics: { scope: 'response', durationMs: 31, usage: { outputTokens: 7 } }, metricsDiagnostic: diagnostic }
  const props = reading([process, originalReport, report('following-report')]), { host, draw, click } = surface()
  expect(props.records.map(record => record.role)).toEqual(['process', 'message', 'message'])
  await draw(props)
  expect(host.querySelectorAll('.conversation-record-process')).toHaveLength(1)
  const processCard = host.querySelector('.wf-card')!
  expect(processCard.getAttribute('data-status')).toBe(withStepMetrics ? 'complete' : null)
  expect(processCard.querySelector('.log-fold__steps')?.textContent).toBe('1 条已加载记录')
  expect(processCard.querySelector('.wf-head')?.textContent).not.toContain('31 ms')
  const reportMetrics = [...host.querySelectorAll<HTMLDetailsElement>('.conversation-metrics')].find(node => [...node.querySelectorAll('code')].some(code => code.textContent === 'report-with-metrics'))!
  expect(reportMetrics).not.toBeNull(); expect(reportMetrics).not.toBeUndefined()
  expect(reportMetrics.closest('.native-process-observation__step,[hidden],[inert]')).toBeNull()
  expect(reportMetrics.querySelector('summary')?.textContent).toContain('本次响应用量')
  expect(reportMetrics.textContent).toContain('31 ms'); expect(reportMetrics.textContent).toContain('7 tokens')
  await act(async () => { reportMetrics.open = true; reportMetrics.dispatchEvent(new Event('toggle')) })
  await click('.wf-head'); await click('.wf-head')
  expect(reportMetrics.isConnected).toBe(true); expect(reportMetrics.open).toBe(true)
  expect(reportMetrics.closest('.native-process-observation__step,[hidden],[inert]')).toBeNull()
  expect(host.querySelectorAll('.conversation-metrics')).toHaveLength(1)
  const notices = [...host.querySelectorAll('.conversation-metrics__notice')].filter(node => node.textContent === diagnostic.message)
  expect(notices).toHaveLength(1); expect(notices[0]!.closest('[hidden],[inert]')).toBeNull()
  const originalNode = host.querySelector('[data-native-record-id="report-with-metrics"]')!, laterNode = host.querySelector('[data-native-record-id="following-report"]')!
  const peer = originalNode.closest('.wf-body > div')!
  expect(peer).not.toBeNull(); expect(peer.contains(notices[0]!)).toBe(true); expect(peer.contains(laterNode)).toBe(false)
  expect(originalNode.compareDocumentPosition(notices[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  expect(notices[0]!.compareDocumentPosition(laterNode) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
})
