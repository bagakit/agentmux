// @vitest-environment happy-dom
import { appendFile } from 'node:fs/promises'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentFailure, AgentTimelineItem } from '@agentmux/core'
import { consumeConversationWindowPage, type ConversationWindowSnapshot } from '@agentmux/core/conversation'
import { nativeHistoryFixture, jsonl } from '../../core/test/fixtures/native-history-session'
import { projectConversationReading, projectConversationWindow } from '../src/lib/conversation-records'
import { ConversationView } from '../src/components/ConversationView'
import { NativeProcessObservation } from '../src/components/NativeProcessObservation'
import { ClientUiProvider, type ClientUiPlatform, type ObjectLinkReference } from '../src/platform'

const message = 'Selected model is at capacity. Please try a different model.'
const failure: AgentFailure = { code: 'MODEL_CAPACITY', message, publicMessage: 'Public provider failure summary', nativeCode: 'server_overloaded',
  recovery: 'Review the model choice before submitting another request.', nativeTurnId: 'failed-turn' }
const renderObjectLink = vi.fn((reference: ObjectLinkReference) => <a href={reference.uri}>{reference.label}</a>)
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderObjectLink, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); renderObjectLink.mockClear() })
function surface() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  return { host, draw: async (node: ReactNode) => act(async () => root.render(<ClientUiProvider platform={platform}>{node}</ClientUiProvider>)) }
}
async function open(element: HTMLDetailsElement) { await act(async () => { element.open = true; element.dispatchEvent(new Event('toggle')) }) }
function view(snapshot: ConversationWindowSnapshot, readDetail = vi.fn()) {
  const projection = projectConversationWindow(snapshot)
  return <ConversationView sessionId={snapshot.agentSessionId} executionHostId={snapshot.hostId} page={projection.historyPage}
    records={projection.records} originalRecords={projection.originalRecords} timeline={projection.captured}
    readProcessDetail={readDetail} renderProcess={props => <NativeProcessObservation {...props} compact />} />
}

it.each(['inline', 'deferred'] as const)('real Provider history exposes the original failure before opening %s process details and retains it after a new turn', async mode => {
  const f = await nativeHistoryFixture('codex', root => jsonl([
    { type: 'session_meta', payload: { id: 'native-main', cwd: root, source: 'cli' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'failed-turn' } },
    { type: 'event_msg', payload: { id: 'failed-result', type: 'task_complete', turn_id: 'failed-turn', error: { message, codex_error_info: 'server_overloaded' } } }
  ])); closes.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const read = async () => {
    const result = consumeConversationWindowPage(await f.client.readAgentConversation({ ...ref, ...(mode === 'deferred' ? { processDetails: mode } : {}) }))
    expect(result.kind).toBe('complete')
    if (result.kind !== 'complete') throw Error('Small actual history must finish')
    return result.snapshot
  }
  const initial = await read(), detail = vi.fn(), { host, draw } = surface()
  const sourceRecord = initial.units.flatMap(unit => unit.records).find(record => (record.original.kind === 'deferred' ? record.original.item.item.id : record.original.item.id) === 'failed-result')!
  expect(sourceRecord).toBeDefined()
  expect(sourceRecord.original.kind).toBe(mode === 'deferred' ? 'deferred' : 'native')
  await draw(view(initial, detail))
  const card = host.querySelector<HTMLElement>('[data-turn-failure-record-id="failed-result"]')!
  expect(card, host.textContent).not.toBeNull()
  expect(card.closest('[hidden],[inert],.conversation-record-process')).toBeNull()
  expect(card.querySelector('.conversation-turn-failure__cause')?.textContent).toBe(message)
  expect(card.querySelector('.conversation-turn-failure__scope')?.textContent).toContain('failed-turn')
  expect(card.querySelector('.conversation-turn-failure__recovery')?.textContent).toBeTruthy()
  expect(card.querySelector('pre')).toBeNull(); expect(detail).not.toHaveBeenCalled()
  await open(card.querySelector<HTMLDetailsElement>('.conversation-turn-failure__details')!)
  expect(card.textContent).toContain('failed-turn'); expect(card.textContent).toContain('native-main')
  expect(card.textContent).toContain('server_overloaded')
  expect(card.textContent).toContain('AgentMux 分类'); expect(detail).not.toHaveBeenCalled()
  expect(card.querySelector('button')).toBeNull()
  expect(renderObjectLink).toHaveBeenCalledWith({ uri: 'amux://agent/private-agent', target: { kind: 'agent', agentSessionId: f.session.agentSessionId }, label: '原 Agent' })
  await appendFile(f.path, jsonl([
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'next-turn' } },
    { type: 'response_item', payload: { id: 'later-answer', type: 'message', role: 'assistant', phase: 'commentary',
      internal_chat_message_metadata_passthrough: { turn_id: 'next-turn' }, content: [{ type: 'output_text', text: 'The next turn is working.' }] } }
  ]))
  await draw(view(await read(), detail))
  expect(host.querySelectorAll('[data-turn-failure-record-id]')).toHaveLength(1)
  expect(host.querySelector('[data-turn-failure-record-id="failed-result"]')).toBe(card)
  expect(host.textContent).toContain('The next turn is working.')
  expect(card.querySelector<HTMLDetailsElement>('.conversation-turn-failure__details')?.open).toBe(true)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('renders generic captured outcomes before host overrides and never promotes matching prose or private summaries into outcome facts', async () => {
  const item: AgentTimelineItem = { id: 'captured-failure', agentSessionId: 'session', kind: 'lifecycle', status: 'failed', source: 'native-hook',
    title: 'Recorded native outcome', content: '{"original":"retained failure evidence"}', turnOutcome: { status: 'failed', failure: { ...failure, nativeCode: undefined } }, createdAt: 1, updatedAt: 1 }
  const timeline = { agentSessionId: 'session', sourceHostId: 'local', revision: 1, items: [item,
    { ...item, id: 'matching-prose', kind: 'assistant_message' as const, status: 'complete' as const, turnOutcome: undefined, content: message }] }
  const page = { agentSessionId: 'session', sourceHostId: 'local', source: { providerId: 'unfamiliar-provider', nativeSessionId: 'retained-source' }, nextCursor: null,
    items: [{ id: 'unknown-outcome', kind: 'activity' as const, contentParts: [{ kind: 'text' as const, text: 'Original record remains readable.' }],
      turnOutcomeDiagnostic: { code: 'OUTCOME_UNAVAILABLE', message: 'The outcome could not be confirmed; the original record remains readable.' } }] }
  const projection = projectConversationReading({ agentSessionId: 'session', executionHostId: 'local', historyPage: page, timeline })
  const hostOverride = vi.fn(record => <p>{record.rawId}</p>), { host, draw } = surface()
  await draw(<ConversationView sessionId="session" executionHostId="local" {...projection} page={page} renderCapturedRecord={hostOverride}
    renderProcess={props => <NativeProcessObservation {...props} compact />} />)
  const card = host.querySelector<HTMLElement>('[data-turn-failure-record-id]')!
  expect(host.querySelectorAll('[data-turn-failure-record-id]')).toHaveLength(1)
  expect(card.querySelector('.conversation-turn-failure__cause')?.textContent).toBe(message)
  expect(card.textContent).not.toContain(failure.publicMessage)
  expect(hostOverride.mock.calls.map(([record]) => record.rawId)).not.toContain('captured-failure')
  const diagnostic = [...host.querySelectorAll('[role="status"]')].find(node => node.textContent?.includes('The outcome could not be confirmed'))!
  expect(diagnostic).toBeDefined(); expect(diagnostic.closest('[hidden],[inert]')).toBeNull()
  await open(card.querySelector<HTMLDetailsElement>('.conversation-turn-failure__details')!)
  expect(card.textContent).toContain('未记录')
  expect(card.querySelector('a')?.getAttribute('href')).toBe('amux://agent/session')
  await open(card.querySelector<HTMLDetailsElement>('.conversation-turn-failure__original')!)
  expect(hostOverride.mock.calls.map(([record]) => record.rawId)).toContain('captured-failure')
})

it('uses only accepted Core same-event relations to coalesce native and captured failures', async () => {
  const f = await nativeHistoryFixture('codex', root => jsonl([{ type: 'session_meta', payload: { id: 'native-main', cwd: root, source: 'cli' } },
    { type: 'event_msg', payload: { id: 'native-result', type: 'task_complete', turn_id: 'failed-turn', error: { message, codex_error_info: 'server_overloaded' } } }])); closes.push(f.close)
  const base: AgentTimelineItem = { id: 'captured-result', agentSessionId: f.session.agentSessionId, kind: 'lifecycle', status: 'failed', source: 'native-hook',
    title: 'Native failure observation', turnOutcome: { status: 'failed', failure }, createdAt: 1, updatedAt: 1 }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: { ...base,
    conversation: { sameEvent: { hostId: 'local', agentSessionId: f.session.agentSessionId, source: { kind: 'native', providerId: 'codex', nativeSessionId: 'native-main', recordId: 'native-result' } } } } })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: { ...base, id: 'separate-result' } })
  const result = consumeConversationWindowPage(await f.client.readAgentConversation({ hostId: 'local', agentSessionId: f.session.agentSessionId, processDetails: 'deferred' }))
  expect(result.kind).toBe('complete'); if (result.kind !== 'complete') throw Error('Small actual history must finish')
  expect(result.snapshot.units.flatMap(unit => unit.records).some(record => record.reference?.source.kind === 'native')).toBe(true)
  const { host, draw } = surface(); await draw(view(result.snapshot))
  expect(host.querySelectorAll('[data-turn-failure-record-id]')).toHaveLength(2)
  expect([...host.querySelectorAll('.conversation-turn-failure__cause')].map(node => node.textContent)).toEqual([message, message])
})
