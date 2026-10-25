// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { StaticActivityView } from './helpers/conversation-static-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { RecordedToolRow, RecordedStepsCard, RecordedAgentRow } from '@agentmux/client-ui/components/WorkflowObservation'
import { NativeProcessObservation } from '@agentmux/client-ui/components/NativeProcessObservation'
import { projectConversationReading, type ConversationRecord } from '@agentmux/client-ui/conversation-records'
import { deferConversationProcessRecord } from '../../../packages/core/src/conversation-process-detail'

let host: HTMLDivElement, root: Root
const page = (failed: boolean): AgentSessionHistoryPage => ({ agentSessionId: 'summary-agent', sourceHostId: 'local',
  source: { providerId: 'example-provider', nativeSessionId: 'original-summary-thread' }, nextCursor: null,
  items: [
    { id: 'call', kind: 'assistant-message', contentParts: [{ kind: 'tool-call', callId: 'original-call', name: 'inspect', input: '{"exact":"original parameter"}' }] },
    { id: 'result', kind: 'activity', contentParts: [{ kind: 'tool-result', callId: 'original-call', name: 'inspect', failed, output: 'Original complete result. The word failed is not a status fact.' }] },
    { id: 'answer', kind: 'assistant-message', messagePhase: 'final', contentParts: [{ kind: 'text', text: 'The original public answer stays readable.' }] }
  ] })
const render = async (node: ReactNode) => { await act(async () => root.render(node)) }
async function click(button: HTMLButtonElement) { await act(async () => button.click()) }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('keeps typed tool failure visible in the real Activity consumer while folding only its process details', async () => {
  await render(<StaticActivityView capability="complete-events" items={[]} sessionId="summary-agent" nativeHistoryPage={page(true)} />)
  const head = host.querySelector<HTMLButtonElement>('.wf-head')!
  expect(head).not.toBeNull(); expect(head.getAttribute('aria-expanded')).toBe('false')
  expect(host.querySelector('.native-process-observation__issue')?.textContent).toContain('1 条已加载记录标记为失败')
  expect(host.querySelector('.native-process-observation__issue')?.closest('[hidden]')).toBeNull()
  expect(host.textContent).not.toContain('Original complete result.')
  const answer = host.querySelector('[data-native-record-id="answer"]')!
  expect(answer).not.toBeNull(); expect(answer.textContent).toContain('original public answer')
  expect(answer.closest('[hidden]')).toBeNull()
  await click(head)
  expect(host.querySelector('.native-process-observation__issue')?.textContent).toContain('1 条已加载记录标记为失败')
  expect(host.querySelector('.native-process-observation__issue')?.closest('[hidden]')).toBeNull()
  expect(host.querySelector('[data-native-record-id="answer"]')).toBe(answer)
  const result = host.querySelector('[data-native-record-id="result"]')!
  expect(result).not.toBeNull(); expect(result.querySelector('[data-semantic-icon="conversation.tool-result"]')).not.toBeNull()
  expect(result.querySelector('[data-semantic-icon="status.completed"]')).toBeNull()
  await click(head)
  expect(host.querySelector('.native-process-observation__issue')?.textContent).toContain('1 条已加载记录标记为失败')
  expect(host.querySelector('[data-native-record-id="answer"]')).toBe(answer)
})

it('never infers a failure from the original tool output or a result record alone', async () => {
  await render(<StaticActivityView capability="complete-events" items={[]} sessionId="summary-agent" nativeHistoryPage={page(false)} />)
  expect(host.querySelector('.wf-head')).not.toBeNull()
  expect(host.querySelector('.native-process-observation__issue')).toBeNull()
})

it('reads exact deferred native and captured failure headers without fetching their bodies', async () => {
  const native = projectConversationReading({ agentSessionId: 'summary-agent', historyPage: page(true) }).records.find(record => record.rawId === 'result')!
  expect(native).toBeDefined()
  const { records: _originalContributors, ...summary } = native
  const deferred: ConversationRecord = { ...summary, original: { kind: 'deferred', item: { kind: 'native', item: { id: 'result', kind: 'activity' }, parts: [{ kind: 'tool-result', callId: 'original-call', failed: true }] } } }
  const captured: ConversationRecord = { ...summary, id: 'captured-failure', rawId: 'captured-failure', source: { kind: 'captured', recordId: 'captured-failure' },
    original: { kind: 'deferred', item: { kind: 'captured', item: { id: 'captured-failure', agentSessionId: 'summary-agent', kind: 'tool_call', status: 'failed', source: 'native-hook', createdAt: 1, updatedAt: 2 }, fields: ['toolOutput'] } } }
  const read = vi.fn(() => <p>Loaded payload</p>)
  await render(<NativeProcessObservation id="mixed-originals" records={[deferred, captured]} entries={[{ kind: 'record', record: deferred }, { kind: 'record', record: captured }]} renderRecord={read} compact />)
  expect(host.querySelector('.native-process-observation__issue')?.textContent).toContain('2 条已加载记录标记为失败')
  expect(read).not.toHaveBeenCalled()
})

it.each(['full', 'deferred'] as const)('keeps same-event contributor failures in the %s summary, counted once per presented record', async mode => {
  const reading = projectConversationReading({ agentSessionId: 'summary-agent', executionHostId: 'local', historyPage: page(false),
    timeline: { agentSessionId: 'summary-agent', sourceHostId: 'local', revision: 1, items: [
      { id: 'captured-contribution', agentSessionId: 'summary-agent', kind: 'tool_call', status: 'failed', source: 'native-hook', createdAt: 1, updatedAt: 2,
        conversation: { sameEvent: { hostId: 'local', agentSessionId: 'summary-agent', source: { kind: 'native', providerId: 'example-provider', nativeSessionId: 'original-summary-thread', recordId: 'call' } } } }
    ] } })
  const merged = reading.records.find(record => record.rawId === 'call')!
  expect(merged).toBeDefined(); expect(merged.records).toHaveLength(2)
  expect(merged.original.kind).toBe('native')
  const originals = merged.records!, deferred = originals.map(deferConversationProcessRecord)
  const checkpoint = { hostId: 'local', agentSessionId: 'summary-agent', sourceHostId: 'local', frontier: { hostId: 'local', agentSessionId: 'summary-agent', scope: { sources: [] }, cuts: [] } }
  // The accepted event's exact contributor set is the UI input; this scene never performs an anchor read.
  const record: ConversationRecord = mode === 'full' ? merged : { ...merged, records: [], original: deferred[0]!.original, deferred: { records: deferred, frontier: checkpoint } }
  await render(<NativeProcessObservation id="accepted-event" records={[record]} entries={[{ kind: 'record', record }]} renderRecord={() => null} compact />)
  expect(host.querySelector('.native-process-observation__issue')?.textContent).toContain('1 条已加载记录标记为失败')
})

it('keeps interruption distinct from explicit Stop and leaves recorded activity static', async () => {
  await render(<><RecordedStepsCard observation={{ id: 'group', stepCount: 1, status: 'interrupted' }} expanded={false} onExpandedChange={() => {}}>Original</RecordedStepsCard>
    <RecordedToolRow className="log-row" icon={null} observation={{ id: 'original', title: 'Original operation', status: 'interrupted', source: 'Original source', persistentSource: true }} />
    <ol><RecordedAgentRow observation={{ id: 'original-agent', label: 'Original Agent', source: 'Original reference', state: 'interrupted' }} /></ol></>)
  expect(host.querySelectorAll('[data-semantic-icon="status.interrupted"]')).toHaveLength(3)
  expect(host.querySelector('[data-semantic-icon="status.killed"]')).toBeNull()
  expect(host.querySelector('[data-icon-animation]')).toBeNull()
  await render(<RecordedToolRow className="log-row" icon={null} observation={{ id: 'running-original', title: 'Historical running', status: 'running', source: 'Original source', persistentSource: true }} />)
  expect(host.textContent).toContain('Recorded running')
  expect(host.querySelector('[data-icon-animation]')).toBeNull()
})
