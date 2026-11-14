// @vitest-environment happy-dom
import { act, useState, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryItem, AgentSessionHistoryPage } from '@agentmux/core'
import { consumeConversationWindowPage } from '@agentmux/core/conversation'
import { nativeHistoryFixture, jsonl } from '../../core/test/fixtures/native-history-session.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { ConversationView } from '../src/components/ConversationView.js'
import { ConversationRecordSequence } from '../src/components/ConversationRecordSequence.js'
import { NativeProcessObservation } from '../src/components/NativeProcessObservation.js'
import { projectConversationReading, projectConversationWindow, type ConversationRecord } from '../src/lib/conversation-records.js'
import { conversationPresentationKey as key, projectConversationRecordSequence as project } from '../src/lib/conversation-record-sequence.js'
import type { ConversationPresentationController } from '../src/lib/use-conversation-record-layout.js'
import { ConversationProcessDockSlot, ConversationProcessObservation, ConversationProcessSurface } from '../../../apps/desktop/src/renderer/src/components/ConversationProcessSurface.js'

const source = { providerId: 'codex', nativeSessionId: 'original-native' }, sid = 'original-session'
const step = (id: string, turnId = 'original-turn'): AgentSessionHistoryItem => ({ id, kind: 'activity', turnId, contentParts: [{ kind: 'text', text: 'Original ' + id }] })
const peer = (id: string): AgentSessionHistoryItem => ({ ...step(id), collaboration: { kind: 'message', source, sender: '/root/reporter', recipient: '/root' } })
const page = (items: AgentSessionHistoryItem[], native = source): AgentSessionHistoryPage => ({ agentSessionId: sid, sourceHostId: 'local', source: native, nextCursor: null, items })
function frame(items: AgentSessionHistoryItem[], native = source) {
  const nextPage = page(items, native), value = projectConversationReading({ agentSessionId: sid, executionHostId: 'local', historyPage: nextPage })
  return { page: nextPage, records: value.records, originalRecords: value.originalRecords, coverage: value.timeline.coverage }
}
const groups = (value: ReturnType<typeof project>) => value.rows.filter(row => row.kind === 'process')
const originalOrder = (value: ReturnType<typeof project>) => value.rows.flatMap(row => row.kind === 'record' ? [row.record.rawId]
  : row.kind === 'process' ? row.records.map(record => record.rawId) : [])

let host: HTMLElement, root: Root
const closes: Array<() => Promise<unknown>> = []
const copy = vi.fn(async (_text: string) => true)
const platform: ClientUiPlatform = { conversationDetailLevel: 'system', copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); copy.mockClear() })
afterEach(async () => { getSelection()?.removeAllRanges(); await act(async () => root.unmount()); host.remove();
  for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
type ReadingFrame = Pick<ComponentProps<typeof ConversationView>, 'page' | 'records' | 'originalRecords' | 'coverage'>
const boundary = (id: string) => ({ beforeRecordId: id, content: <span data-history-cut role="separator">Earlier original records</span> })
async function draw(value: ReadingFrame, extra: Partial<ComponentProps<typeof ConversationView>> = {}, level: 'simple' | 'system' = 'system') {
  await act(async () => root.render(<ClientUiProvider platform={{ ...platform, conversationDetailLevel: level }}><ConversationView {...value} sessionId={sid} executionHostId="local"
    renderProcess={props => <NativeProcessObservation {...props} compact />} {...extra} /></ClientUiProvider>))
}
async function click(selector: string) { const button = host.querySelector<HTMLButtonElement>(selector); expect(button, selector).not.toBeNull(); await act(async () => button!.click()) }
function select(node: Node) { const range = document.createRange(); range.selectNodeContents(node); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); return range }

it('keeps a history cut inside one compatible process without changing original source order or roles', () => {
  const records = frame([step('a'), peer('report'), step('b')]).records, original = structuredClone(records)
  const result = project(records, 'original-scope', undefined, key(records[2]!))
  expect(groups(result), 'history-cut-must-not-split-compatible-process').toHaveLength(1)
  expect(groups(result)[0]!.entries.map(entry => entry.kind)).toEqual(['record', 'record', 'boundary', 'record'])
  expect(groups(result)[0]!.records).toEqual(records); expect(originalOrder(result)).toEqual(['a', 'report', 'b'])
  expect(records).toEqual(original); expect(records[1]!.role).toBe('message')
})

it('hides original additional step shells and a pure system process without regrouping or remounting', async () => {
  const events = [
    { type: 'event_msg', payload: { id: 'system-only', type: 'task_started', turn_id: 'first-turn' } },
    { type: 'response_item', payload: { id: 'answer', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Original answer separates the two intervals.' }] } },
    { type: 'response_item', payload: { id: 'step-before', type: 'reasoning', turn_id: 'last-turn', summary: [{ type: 'summary_text', text: 'Original visible reasoning' }] } },
    { type: 'event_msg', payload: { id: 'system-between', type: 'task_complete', turn_id: 'last-turn' } },
    { type: 'response_item', payload: { id: 'step-after', type: 'reasoning', turn_id: 'last-turn', summary: [{ type: 'summary_text', text: 'Original following reasoning' }] } }
  ]
  const f = await nativeHistoryFixture('codex', root => jsonl([{ type: 'session_meta', payload: { id: 'native-main', cwd: root } }, ...events]), { agentSessionId: sid }); closes.push(f.close)
  const read = consumeConversationWindowPage(await f.client.readAgentConversation({ hostId: 'local', agentSessionId: sid }))
  expect(read.kind).toBe('complete'); if (read.kind !== 'complete') throw Error('Original private read must finish')
  const value = projectConversationWindow(read.snapshot)
  expect(value.records.filter(record => record.original.kind === 'native' && record.original.item.recordPurpose === 'system-event')).toHaveLength(2)
  await draw({ ...value, page: value.historyPage })
  const parents = [...host.querySelectorAll<HTMLElement>('.conversation-record-process')]
  expect(parents).toHaveLength(2)
  await act(async () => parents[0]!.querySelector<HTMLButtonElement>('.wf-head')!.click())
  const only = host.querySelector<HTMLElement>('[data-native-step-id="system-only"]')!, middle = host.querySelector<HTMLElement>('[data-native-step-id="system-between"]')!
  expect(only).not.toBeNull(); expect(middle).not.toBeNull()
  const onlyShell = only.closest<HTMLElement>('.native-process-observation__step')!, middleShell = middle.closest<HTMLElement>('.native-process-observation__step')!
  await draw({ ...value, page: value.historyPage }, {}, 'simple')
  expect([...host.querySelectorAll('.conversation-record-process')]).toEqual(parents)
  expect(parents[0]!.hidden, 'pure-system-process-shell-must-not-leave-a-heading').toBe(true)
  expect(parents[1]!.hidden).toBe(false)
  expect(middleShell.hidden, 'additional-step-shell-must-not-leave-spacing').toBe(true)
  expect(middleShell.inert).toBe(true); expect(onlyShell.hidden).toBe(true)
  expect(host.querySelector('[data-native-step-id="system-only"]')).toBe(only)
  await draw({ ...value, page: value.historyPage })
  expect(parents[0]!.hidden).toBe(false); expect(middleShell.hidden).toBe(false)
  expect(host.querySelector('[data-native-step-id="system-only"]')).toBe(only)
  expect(host.querySelector('[data-native-step-id="system-between"]')).toBe(middle)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('keeps original per-record usage visible when its raw system record is hidden in a mixed-source process', async () => {
  const f = await nativeHistoryFixture('codex', root => jsonl([
    { type: 'session_meta', payload: { id: 'native-main', cwd: root } },
    { timestamp: new Date(1000).toISOString(), type: 'response_item', payload: { id: 'before', type: 'reasoning', turn_id: 'original-turn', summary: [{ type: 'summary_text', text: 'Original reasoning' }] } },
    { timestamp: new Date(2000).toISOString(), type: 'token_usage_record', payload: { id: 'usage', thread_id: 'native-main', turn_id: 'original-turn', turn_token_usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } },
    { timestamp: new Date(3000).toISOString(), type: 'response_item', payload: { id: 'after', type: 'reasoning', turn_id: 'original-turn', summary: [{ type: 'summary_text', text: 'Following reasoning' }] } }
  ]), { agentSessionId: sid }); closes.push(f.close)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: { id: 'original-observation', agentSessionId: sid, kind: 'assistant_message', source: 'native-hook',
    status: 'complete', title: 'Original observation', content: 'Original recorded reply remains readable.', createdAt: 2500, updatedAt: 2500 } })
  const read = consumeConversationWindowPage(await f.client.readAgentConversation({ hostId: 'local', agentSessionId: sid }))
  expect(read.kind).toBe('complete'); if (read.kind !== 'complete') throw Error('Original private read must finish')
  const value = projectConversationWindow(read.snapshot)
  expect(value.records.map(record => record.rawId)).toEqual(['before', 'usage', 'original-observation', 'after'])
  await draw({ ...value, page: value.historyPage }, {}, 'simple')
  const raw = host.querySelector('[data-native-step-id="usage"]')!
  expect(raw).not.toBeNull(); expect(raw.closest('.conversation-detail-record[hidden]')).not.toBeNull()
  const usage = host.querySelector('.conversation-metrics__inline')!
  expect(usage, 'original-usage-retained-beside-hidden-raw-system-record').not.toBeNull()
  expect(usage.textContent).toContain('3 tokens'); expect(usage.closest('[hidden],[inert]')).toBeNull()
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('retains the original collapsed disclosure for two real response metrics without a group summary', async () => {
  const f = await nativeHistoryFixture('claude', jsonl(['first', 'second'].map((id, index) => ({ type: 'assistant', uuid: id, sessionId: 'native-main',
    message: { id: 'response-' + id, role: 'assistant', usage: { input_tokens: 7 + index, output_tokens: 3 + index },
      content: [{ type: 'tool_use', id: 'call-' + id, name: 'inspect', input: { body: id } }] } }))), { agentSessionId: sid }); closes.push(f.close)
  const read = consumeConversationWindowPage(await f.client.readAgentConversation({ hostId: 'local', agentSessionId: sid }))
  expect(read.kind).toBe('complete'); if (read.kind !== 'complete') throw Error('Original private read must finish')
  const value = projectConversationWindow(read.snapshot)
  expect(value.records).toHaveLength(2)
  expect(value.records.map(record => record.original.kind === 'native' && record.original.item.metrics?.scope)).toEqual(['response', 'response'])
  function Surface() {
    const [expanded, setExpanded] = useState(false)
    return <ConversationRecordSequence records={value.records} sequence={project(value.records, 'original-metrics-scope')} sourceKey="original-metrics-scope"
      isRecordVisible={() => false} renderRecord={record => <div hidden data-original-response={record.rawId}>{record.content}</div>}
      renderProcess={process => {
        expect(process.metrics).toBeUndefined()
        expect(process.entries.filter(entry => entry.kind === 'record' && entry.hasMetrics)).toHaveLength(2)
        return <NativeProcessObservation {...process} compact disclosure={{ ...process.disclosure!, expanded, onExpandedChange: setExpanded }} />
      }} />
  }
  await act(async () => root.render(<ClientUiProvider platform={platform}><Surface /></ClientUiProvider>))
  const parent = host.querySelector<HTMLElement>('.conversation-record-process')!, native = parent.querySelector('.native-process-observation')!
  expect(parent.hidden).toBe(false)
  expect(native.hasAttribute('data-no-visible-process'), 'collapsed-multiple-metrics-must-retain-reopen-heading').toBe(false)
  expect(parent.querySelector('.wf-head')?.getAttribute('aria-expanded')).toBe('false')
  expect(parent.querySelector('.wf-observation__body')?.hasAttribute('hidden')).toBe(true)
  await click('.wf-head')
  const usage = [...parent.querySelectorAll('.conversation-metrics__inline')]
  expect(usage).toHaveLength(2); expect(usage.every(node => !node.closest('[hidden],[inert]'))).toBe(true)
  expect(usage.map(node => node.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('3 tokens'), expect.stringContaining('4 tokens')]))
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('initially opens the latest visible tool process instead of a hidden trailing system-only group', async () => {
  const f = await nativeHistoryFixture('codex', root => jsonl([
    { type: 'session_meta', payload: { id: 'native-main', cwd: root } },
    { type: 'response_item', payload: { id: 'visible-tool', type: 'function_call', call_id: 'original-call', name: 'inspect', arguments: '{"file":"src/change.ts"}' } },
    { type: 'response_item', payload: { id: 'answer', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Original answer' }] } },
    { type: 'event_msg', payload: { id: 'trailing-system', type: 'task_complete' } }
  ]), { agentSessionId: sid }); closes.push(f.close)
  const read = consumeConversationWindowPage(await f.client.readAgentConversation({ hostId: 'local', agentSessionId: sid }))
  expect(read.kind).toBe('complete'); if (read.kind !== 'complete') throw Error('Original private read must finish')
  const value = projectConversationWindow(read.snapshot)
  expect(value.records).toHaveLength(3)
  await draw({ ...value, page: value.historyPage }, {}, 'simple')
  const parents = [...host.querySelectorAll<HTMLElement>('.conversation-record-process')]
  expect(parents).toHaveLength(2); expect(parents[1]!.hidden).toBe(true)
  expect(parents[0]!.querySelector('.wf-head')?.getAttribute('aria-expanded'), 'latest-visible-tool-keeps-initial-disclosure').toBe('true')
  expect(host.querySelector('[data-native-step-id="visible-tool"]')).not.toBeNull()
  await act(async () => parents[0]!.querySelector<HTMLButtonElement>('.wf-head')!.click())
  await draw({ ...value, page: value.historyPage }, {}, 'simple')
  expect(parents[0]!.querySelector('.wf-head')?.getAttribute('aria-expanded')).toBe('false')
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it.each(['source', 'turn', 'user', 'answer', 'failed'] as const)('keeps the reading separator outside a true %s boundary', reason => {
  const a = frame([step('a')]).records[0]!, c = frame([step('c')]).records[0]!
  const original = reason === 'source' ? frame([step('barrier')], { ...source, nativeSessionId: 'other-original' }).records[0]!
    : frame([{ ...step('barrier', reason === 'turn' ? 'other-turn' : 'original-turn'),
      ...(reason === 'user' ? { kind: 'user-message' as const } : reason === 'answer' ? { kind: 'assistant-message' as const, messagePhase: 'final' as const }
        : reason === 'failed' ? { turnOutcome: { status: 'failed' as const } } : {}) }]).records[0]!
  const result = project([a, original, c], 'original-scope', undefined, key(original))
  const divider = result.rows.findIndex(row => row.kind === 'boundary')
  expect(divider).toBe(1); expect(result.rows[0]?.kind).toBe('process')
  expect(groups(result)[0]!.entries.some(entry => entry.kind === 'boundary')).toBe(false)
  expect(groups(result).some(group => group.records.includes(a) && group.records.includes(original))).toBe(false)
  expect(originalOrder(result)).toEqual(['a', 'barrier', 'c'])
})

it('retains both already mounted process parents and the original root separator', async () => {
  const a = step('a', 'left-turn'), b = step('b', 'right-turn')
  await draw(frame([a, b]), { recordBoundary: boundary('b') })
  const parents = [...host.querySelectorAll('.conversation-record-process')], divider = host.querySelector('[data-history-cut]')!
  expect(parents).toHaveLength(2); expect(divider.closest('.conversation-record-process')).toBeNull()
  // Removing a reading annotation cannot merge parents that already own mounted originals.
  await draw(frame([{ ...a, turnId: 'same-observed-turn' }, { ...b, turnId: 'same-observed-turn' }]), { recordBoundary: boundary('b') })
  expect([...host.querySelectorAll('.conversation-record-process')]).toEqual(parents)
  expect(host.querySelector('[data-history-cut]')).toBe(divider); expect(divider.closest('.conversation-record-process')).toBeNull()
})

it('keeps a previously standalone peer body and Range in the root when preceding process facts arrive', async () => {
  const r = peer('report'), b = step('after')
  await draw(frame([r, b]))
  await click('[data-native-record-id="report"] .log-turn__collaboration-toggle')
  const original = host.querySelector('[data-native-record-id="report"]')!, body = original.querySelector('.log-turn__body')!, text = body.querySelector('p')!.firstChild!
  const range = select(text), selected = getSelection()!.toString()
  expect(original.closest('.conversation-record-process')).toBeNull()
  await draw(frame([step('earlier'), r, b]), { recordBoundary: boundary('report') })
  expect(host.querySelector('[data-native-record-id="report"]')).toBe(original)
  expect(original.closest('.conversation-record-process')).toBeNull(); expect(original.querySelector('.log-turn__body')).toBe(body)
  expect(getSelection()!.getRangeAt(0)).toBe(range); expect(range.startContainer).toBe(text); expect(getSelection()!.toString()).toBe(selected)
  expect(host.querySelector('[data-conversation-process-members*="earlier"]')).not.toBeNull()
})

it('uses the same accepted internal boundary for deferred precommit and a selected divider', async () => {
  const f = await nativeHistoryFixture('claude', jsonl(['first', 'boundary'].map(id => ({ type: 'assistant', uuid: id, sessionId: 'native-main',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `call-${id}`, name: 'inspect', input: { body: id } }] } }))), { agentSessionId: sid }); closes.push(f.close)
  const read = consumeConversationWindowPage(await f.client.readAgentConversation({ hostId: 'local', agentSessionId: sid, processDetails: 'deferred' }))
  expect(read.kind).toBe('complete'); if (read.kind !== 'complete') throw Error('Original private read must finish')
  const value = projectConversationWindow(read.snapshot), controller = { current: null as ConversationPresentationController | null }
  expect(value.records).toHaveLength(2); expect(value.records.every(record => record.original.kind === 'deferred')).toBe(true)
  await draw({ ...value, page: value.historyPage }, { recordBoundary: boundary('boundary'), presentation: { controller, pending: false, onRelease: () => {} } })
  const divider = host.querySelector('[data-history-cut]')!, parent = divider.closest('.conversation-record-process')!
  expect(parent, 'deferred-divider-owned-by-compatible-process').not.toBeNull()
  const range = select(divider.firstChild!)
  expect(controller.current!.canPresent(value, { beforeRecordId: 'boundary' })).toBe(true)
  expect(controller.current!.canPresent(value)).toBe(false)
  expect(host.querySelector('[data-history-cut]')).toBe(divider); expect(getSelection()!.getRangeAt(0)).toBe(range)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('retains actual Core invocation payload, Range, original Copy, pin and draft through a nonempty prepend and append', async () => {
  const data = (cwd: string) => jsonl([
    { type: 'session_meta', payload: { id: source.nativeSessionId, cwd } }, { type: 'turn_context', payload: { turn_id: 'original-turn' } },
    { type: 'response_item', payload: { id: 'call-input', type: 'function_call', call_id: 'original-call', name: 'inspect', arguments: '{"file":"src/change.ts"}' } },
    { type: 'response_item', payload: { id: 'call-result', type: 'function_call_output', call_id: 'original-call', output: 'Original exact output' } }
  ])
  const f = await nativeHistoryFixture('codex', data, { nativeSessionId: source.nativeSessionId, agentSessionId: sid }); closes.push(f.close)
  const read = consumeConversationWindowPage(await f.client.readAgentConversation({ hostId: 'local', agentSessionId: sid }))
  expect(read.kind).toBe('complete'); if (read.kind !== 'complete') throw Error('Original private read must finish')
  const value = projectConversationWindow(read.snapshot), [input, output] = value.records
  expect(value.records).toHaveLength(2); expect(input!.invocationKey).toBe(output!.invocationKey); expect(input!.invocationKey).toBeTruthy()
  const locate = vi.fn(async () => ({ kind: 'located' as const }))
  function Surface({ records }: { records: readonly ConversationRecord[] }) {
    const [selected, select] = useState<string | null>(null)
    return <ConversationProcessSurface><ConversationView sessionId={sid} executionHostId="local" page={value.historyPage} records={records}
      originalRecords={records} recordBoundary={boundary(output!.rawId)}
      renderProcess={process => <ConversationProcessObservation process={process} scope="original-scope" selected={selected} onSelect={select} active onLocate={locate} />} />
      <ConversationProcessDockSlot /><input aria-label="Unsent original draft" defaultValue="Keep original draft" /></ConversationProcessSurface>
  }
  async function show(records: readonly ConversationRecord[]) { await act(async () => root.render(<ClientUiProvider platform={platform}><Surface records={records} /></ClientUiProvider>)) }
  await show(value.records)
  expect(host.querySelectorAll('.conversation-record-process'), 'actual-core-history-cut-must-not-split').toHaveLength(1)
  const parent = host.querySelector('.conversation-record-process')!, divider = host.querySelector('[data-history-cut]')!
  const inputId = input!.rawId, outputId = output!.rawId
  const row = host.querySelector<HTMLButtonElement>(`[data-native-step-id="${inputId}"] .wf-tool-row--observation`)!
  expect(row).not.toBeNull(); expect(row.getAttribute('aria-controls')?.split(' ')).toHaveLength(2)
  expect(host.querySelector(`[data-native-step-id="${outputId}"] .wf-tool-row--observation`)?.hasAttribute('hidden')).toBe(true)
  expect(host.querySelector('.conversation-tool-payload__actions')).toBeNull()
  await act(async () => row.click())
  const body = host.querySelector(`[data-native-step-id="${inputId}"] .wf-native-process__body`)!, pre = body.querySelector('pre')!, text = pre.firstChild!
  expect(pre.textContent).toBe('{"file":"src/change.ts"}')
  expect(host.querySelector(`[data-native-step-id="${outputId}"] .wf-native-process__body`)?.hasAttribute('hidden')).toBe(false)
  await click('[aria-label="固定过程摘要到输入框上方"]')
  const dock = host.querySelector('.wf-observed-dock')!, draft = host.querySelector<HTMLInputElement>('input')!
  expect(dock.textContent).toContain('2 条记录'); draft.value = 'Original unsent edit'
  const range = select(text), selected = getSelection()!.toString()
  await click(`[data-native-step-id="${inputId}"] .conversation-tool-payload__tools button:last-child`)
  expect(copy).toHaveBeenLastCalledWith('{"file":"src/change.ts"}', expect.any(Function))
  const neighbors = frame([step('earlier'), step('later')]).records
  await show([neighbors[0]!, ...value.records, neighbors[1]!])
  expect(host.querySelector('.conversation-record-process')).toBe(parent)
  expect(host.querySelector('[data-history-cut]')).toBe(divider)
  expect(host.querySelector(`[data-native-step-id="${inputId}"] .wf-native-process__body`)).toBe(body)
  expect(body.querySelector('pre')).toBe(pre); expect(getSelection()!.getRangeAt(0)).toBe(range); expect(range.startContainer).toBe(text)
  expect(getSelection()!.toString()).toBe(selected); expect(host.querySelector('.wf-observed-dock')).toBe(dock)
  expect(dock.textContent).toContain('4 条记录'); expect(host.querySelector('input')).toBe(draft); expect(draft.value).toBe('Original unsent edit')
  expect(host.querySelectorAll('.conversation-record-process')).toHaveLength(1)
  await click('.wf-head'); await click('.wf-head')
  expect(body.querySelector('pre')).toBe(pre); expect(host.querySelector('[data-history-cut]')!.closest('[hidden],[inert]')).toBeNull()
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})
