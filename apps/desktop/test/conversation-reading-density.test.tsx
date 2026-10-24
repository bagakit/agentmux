// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryItem, AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { projectConversationReading } from '@agentmux/client-ui/conversation-records'
import { NativeProcessObservation } from '@agentmux/client-ui/components/NativeProcessObservation'
import * as previews from '@agentmux/client-ui/conversation-reply-preview'

const sid = 'reading-agent', source = { providerId: 'codex', nativeSessionId: 'native-reading-source' }
const copy = vi.fn(async () => true)
const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => <span>Avatar</span>, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
const body = '**确认两处问题**，已经修复。\n\n- 保留原输入与选区。\n- 原 Session 不变。\n\n**完整记录可继续阅读。**'
const hook = (extra: Partial<AgentTimelineItem> = {}): AgentTimelineItem => ({ id: 'hook', agentSessionId: sid, kind: 'assistant_message', source: 'native-hook', eventName: 'Stop', title: 'Recorded reply', status: 'complete', content: body, createdAt: 3, updatedAt: 3, ...extra })
const native = (id: string, time: number, kind: AgentSessionHistoryItem['kind'] = 'activity', extra: Partial<AgentSessionHistoryItem> = {}): AgentSessionHistoryItem => ({ id, kind, turnId: 'turn-one', startedAt: time, contentParts: [{ kind: 'text', text: id === 'final' ? body : 'Original ' + id }], ...extra })
const page = (items: AgentSessionHistoryItem[]): AgentSessionHistoryPage => ({ agentSessionId: sid, sourceHostId: 'local', source, items, nextCursor: null })
let root: Root, host: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); copy.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => { getSelection()?.removeAllRanges(); root.unmount() }); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function render(items: AgentSessionHistoryItem[], captured = [hook()], active = true) {
  const history = page(items), timeline = { agentSessionId: sid, sourceHostId: 'local', revision: 1, items: captured }
  const projection = projectConversationReading({ agentSessionId: sid, executionHostId: 'local', historyPage: history, timeline })
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationView active={active} sessionId={sid} executionHostId="local" page={history} timeline={timeline} records={projection.records} originalRecords={projection.originalRecords} coverage={projection.timeline.coverage}
    describeSpeaker={speaker => ({ name: speaker.id, project: { workspaceId: 'project', name: 'Current project', path: '' } })}
    renderProcess={props => <NativeProcessObservation {...props} compact />} /></ClientUiProvider>))
}
const click = async (selector: string) => { const button = host.querySelector<HTMLButtonElement>(selector); expect(button).not.toBeNull(); await act(async () => button!.click()) }

it('keeps a short repeated reply as one readable Markdown summary and copies the complete original on demand', async () => {
  await render([native('final', 2, 'assistant-message', { messagePhase: 'final' })])
  const summary = host.querySelector('.conversation-reply-observation__preview')!
  expect(summary.textContent).toBe('确认两处问题，已经修复。')
  expect(summary.closest('button')?.getAttribute('aria-expanded')).toBe('false')
  expect(host.querySelectorAll('.log-turn__body')).toHaveLength(1)
  expect(host.querySelectorAll('[data-conversation-layout-key]')).toHaveLength(2)
  await click('[data-captured-reply-observation] button[aria-expanded]')
  expect(host.querySelectorAll('.log-turn__body')).toHaveLength(2)
  await click('[data-captured-reply-observation] [aria-label="Copy message"]')
  expect(copy).toHaveBeenLastCalledWith(body, expect.any(Function))
})

it('keeps observations visible in one adjoining process and preserves each original in the expanded order', async () => {
  await render([native('before', 1), native('after', 5), native('final', 6, 'assistant-message', { messagePhase: 'final' })])
  const groups = host.querySelectorAll('.conversation-record-process')
  expect(groups).toHaveLength(1)
  const head = groups[0]!.querySelector('.wf-head')!
  expect(head.textContent).toContain('2 条已加载记录')
  expect(head.textContent).not.toContain('Status not recorded')
  expect(head.getAttribute('aria-description')).toContain('状态未记录')
  expect(host.querySelector('[data-captured-reply-observation]')).not.toBeNull()
  await click('.wf-head')
  const group = groups[0]!
  const before = group.querySelector('[data-native-record-id="before"]')!, observation = group.querySelector('[data-captured-reply-observation]')!, after = group.querySelector('[data-native-record-id="after"]')!
  expect(before.compareDocumentPosition(observation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(observation.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('still separates real mid-process inputs and different native turns', async () => {
  await render([native('first', 1), native('input', 2, 'user-message'), native('second', 4), native('third', 5, 'activity', { turnId: 'turn-two' })])
  expect(host.querySelectorAll('.conversation-record-process')).toHaveLength(3)
  expect(host.querySelector('[data-native-record-id="input"]')).not.toBeNull()
})

it('preserves the opened original body, selection and disclosure through appends and hidden updates', async () => {
  const initial = [native('before', 1), native('after', 5)]
  await render(initial)
  await click('[data-captured-reply-observation] button[aria-expanded]')
  const original = host.querySelector('[data-captured-reply-observation] .log-turn__body')!
  const range = document.createRange(); range.selectNodeContents(original); getSelection()!.addRange(range)
  const selected = getSelection()!.toString()
  await click('.wf-head'); await click('.wf-head')
  expect(host.querySelector('[data-captured-reply-observation] .log-turn__body')).toBe(original)
  expect(original.closest('[hidden]')).toBeNull()
  expect(getSelection()!.toString()).toBe(selected)
  await render([...initial, native('later', 7)], [hook()], false)
  await render([...initial, native('later', 7)])
  expect(host.querySelector('[data-captured-reply-observation] .log-turn__body')).toBe(original)
  expect(getSelection()!.toString()).toBe(selected)
  expect(host.querySelector('[data-captured-reply-observation] button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true')
})

it('does not parse the same preview again for unrelated updates or parse changed content while hidden', async () => {
  const preview = vi.spyOn(previews, 'conversationReplyPreview')
  await render([native('before', 1)])
  expect(preview).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 8; i++) await render([native('before', 1), native('unrelated-' + i, 5)])
  expect(preview).toHaveBeenCalledTimes(1)
  await render([native('before', 1)], [hook({ content: 'New original snapshot' })], false)
  expect(preview).toHaveBeenCalledTimes(1)
  await render([native('before', 1)], [hook({ content: 'New original snapshot' })])
  expect(preview).toHaveBeenCalledTimes(2)
})

it('continues exact same-author progress identities while final replies, input and turn boundaries remain distinct', async () => {
  const progress = (id: string, time: number, turnId = 'turn-one') => native(id, time, 'assistant-message', { messagePhase: 'progress', turnId })
  await render([progress('progress-one', 1), native('work', 2), progress('progress-two', 4), native('input', 5, 'user-message'), progress('new-group', 6),
    native('final', 7, 'assistant-message', { messagePhase: 'final' }), progress('after-final', 8), progress('new-turn', 9, 'turn-two'),
    native('unscoped-before', 10, 'assistant-message', { messagePhase: 'progress', turnId: undefined }),
    native('next-turn-work', 11, 'activity', { turnId: 'turn-three' }), native('unscoped-progress', 12, 'assistant-message', { messagePhase: 'progress', turnId: undefined })], [])
  const continued = host.querySelectorAll('[data-message-continuation="true"]')
  expect(continued).toHaveLength(2)
  expect([...continued].map(node => node.closest('[data-native-record-id]')?.getAttribute('data-native-record-id'))).toEqual(['progress-two', 'unscoped-before'])
  expect(continued[0]!.closest('[data-native-record-id]')?.getAttribute('data-native-record-id')).toBe('progress-two')
  expect(continued[0]!.querySelector('.log-turn__sender-id code')?.textContent).toBe(sid)
  expect(continued[0]!.querySelector('[aria-label="Copy Agent ID"]')).not.toBeNull()
  expect(continued[0]!.querySelector(':scope > .log-turn__meta')).toBeNull()
  await click('[data-native-record-id="progress-two"] [aria-label="Message details"]')
  expect(continued[0]!.querySelector('.conversation-input-details__body')?.textContent).toContain('Current project')
  expect(host.querySelector('[data-native-record-id="final"] .log-turn')?.hasAttribute('data-message-continuation')).toBe(false)
})

it('uses exact Core contributions for one canonical body while keeping the original snapshot independently accessible', async () => {
  const observed = hook({ conversation: { sameEvent: { hostId: 'local', agentSessionId: sid, source: { kind: 'native', ...source, recordId: 'final' } } } })
  await render([native('final', 2, 'assistant-message', { messagePhase: 'final' })], [observed])
  expect(host.querySelectorAll('.log-turn__body')).toHaveLength(1)
  expect(host.querySelectorAll('.conversation-original-record')).toHaveLength(1)
  const original = host.querySelector<HTMLDetailsElement>('.conversation-original-record')!
  await act(async () => { original.open = true; original.dispatchEvent(new Event('toggle')) })
  expect(original.querySelector('[data-captured-reply-observation]')).not.toBeNull()
  await click('.conversation-original-record [data-captured-reply-observation] button[aria-expanded]')
  expect(original.querySelector('.log-turn__body')?.textContent).toContain('完整记录可继续阅读')
})

it('reads native collaboration participants without interpreting text declarations as AgentMux identities', async () => {
  const report = native('report', 3, 'activity', { collaboration: { kind: 'message', source, sender: 'native-reviewer', recipient: 'native-coordinator' },
    contentParts: [{ kind: 'text', text: 'Sender: misleading-body-name\n\nThe recorded review is complete.' }] })
  await render([native('before', 1), report, native('after', 5)], [])
  const row = host.querySelector('[data-native-record-id="report"]')!
  expect(host.querySelectorAll('.conversation-record-process')).toHaveLength(1)
  expect(row.querySelector('.log-turn__collaboration-path')?.textContent).toBe('native-reviewer')
  expect(row.querySelector('.log-turn__collaboration-toggle')?.getAttribute('aria-expanded')).toBe('false')
  await click('[data-native-record-id="report"] .log-turn__collaboration-toggle')
  expect(row.querySelector('.log-turn__body')?.textContent).toContain('misleading-body-name')
  expect(row.querySelector('.log-turn')?.getAttribute('data-conversation-author')).toBe('{"kind":"unknown"}')
  expect(row.querySelector('[aria-label="Copy Agent ID"]')).toBeNull()
  await click('[data-native-record-id="report"] [aria-label="Message details"]')
  expect(row.querySelector('.conversation-input-details__body')?.textContent).toContain(source.nativeSessionId)
})
