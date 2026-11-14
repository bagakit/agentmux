// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentSessionHistoryItem, AgentTimelineItem } from '@agentmux/core'
import { ConversationView } from '../src/components/ConversationView.js'
import { NativeProcessObservation } from '../src/components/NativeProcessObservation.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { projectConversationReading } from '../src/lib/conversation-records.js'
import { conversationRecordDetailLevel as tier, type ConversationDetailLevel } from '../src/lib/conversation-detail-level.js'

const sid = 'detail-session', source = { providerId: 'codex', nativeSessionId: 'detail-native' }
const item = (id: string, extra: Partial<AgentSessionHistoryItem> = {}): AgentSessionHistoryItem => ({ id, kind: 'activity', turnId: 'original-turn', contentParts: [{ kind: 'text', text: 'Original ' + id }], ...extra })
const answer = item('answer', { kind: 'assistant-message', messagePhase: 'final' })
const system = item('system', { recordPurpose: 'system-event', metrics: { scope: 'turn', usage: { outputTokens: 37 } } })
const peer = item('peer', { collaboration: { kind: 'message', source, sender: '/root/reporter', recipient: '/root' } })
const snapshot = (id: string, recordId?: string): AgentTimelineItem => ({ id, agentSessionId: sid, kind: 'assistant_message', source: 'native-hook', status: 'complete', createdAt: 10, updatedAt: 10, title: 'Original snapshot', content: 'Original reply snapshot',
  ...(recordId ? { conversation: { observes: { hostId: 'local', agentSessionId: sid, source: { kind: 'native', ...source, recordId } } } } : {}) })
function frame(items = [system, peer, answer], snapshots = [snapshot('snapshot', 'answer')]) {
  const page: AgentSessionHistoryPage = { agentSessionId: sid, sourceHostId: 'local', source, items, nextCursor: null }
  return { page, ...projectConversationReading({ agentSessionId: sid, executionHostId: 'local', historyPage: page,
    timeline: { agentSessionId: sid, sourceHostId: 'local', revision: 1, items: snapshots } }) }
}
let host: HTMLDivElement, root: Root
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { getSelection()?.removeAllRanges(); await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
async function draw(level: ConversationDetailLevel, value = frame()) {
  await act(async () => root.render(<ClientUiProvider platform={{ ...platform, conversationDetailLevel: level }}><ConversationView sessionId={sid} executionHostId="local" {...value}
    renderProcess={props => <NativeProcessObservation {...props} compact />} /><textarea aria-label="Original draft" defaultValue="Unsent original" /></ClientUiProvider>))
}
function node(id: string) { const row = host.querySelector<HTMLElement>(`[data-native-record-id="${id}"],[data-timeline-id="${id}"]`); expect(row, id).not.toBeNull(); return row! }
const shown = (node: Element) => !node.closest('[hidden],[inert]')

it('uses cumulative typed tiers while keeping exact diagnostics, permissions, unknown records and unique readable replies', () => {
  const value = frame([system, peer, answer, item('impostor', { title: 'token_usage_record task_complete agent_state' }),
    item('failed', { recordPurpose: 'system-event', turnOutcome: { status: 'failed' } }), item('interrupted', { recordPurpose: 'system-event', turnOutcome: { status: 'interrupted' } })],
    [snapshot('snapshot', 'answer'), snapshot('sole'), snapshot('unread', 'outside-window'), { ...snapshot('notice'), kind: 'system_message', source: 'agentmux', a2aNotificationId: 'original-notice' }])
  const byId = new Map(value.records.map(record => [record.rawId, tier(record)]))
  expect(byId.get('system')).toBe('system'); expect(byId.get('peer')).toBe('collaboration')
  expect(byId.get('snapshot')).toBe('snapshots'); expect(byId.get('answer')).toBe('simple')
  expect(byId.get('sole'), 'unique-readable-snapshot-must-remain-in-simple').toBe('simple')
  expect(byId.get('unread')).toBe('simple'); expect(byId.get('impostor')).toBe('simple'); expect(byId.get('failed')).toBe('simple')
  expect(byId.get('interrupted')).toBe('simple'); expect(byId.get('notice')).toBe('simple')
})

it('switches the real shared consumer without hiding turn usage, deleting loaded originals or replacing the composer', async () => {
  const value = frame()
  await draw('simple', value)
  expect(host.textContent).toContain('输出 37 tokens')
  // Unread raw bodies remain lazy. Explicitly read the original carrier before
  // asserting that later preference changes preserve its already-mounted nodes.
  const usage = [...host.querySelectorAll<HTMLButtonElement>('.wf-head')].find(head => head.textContent?.includes('输出 37 tokens'))!
  if (usage.getAttribute('aria-expanded') === 'false') await act(async () => usage.click())
  const systemRow = node('system'), peerRow = node('peer'), answerRow = node('answer'), draft = host.querySelector('textarea')!
  draft.value = 'Preserve private unsent edit'
  expect(shown(systemRow), 'raw-system-is-hidden-at-simple').toBe(false); expect(shown(peerRow)).toBe(false)
  expect(shown(answerRow)).toBe(true); expect(host.textContent).toContain('输出 37 tokens')
  expect(host.querySelector('.conversation-detail-summary')?.textContent).toContain('3 条')
  await draw('snapshots', value); expect(shown(systemRow)).toBe(false); expect(shown(peerRow)).toBe(false)
  expect(host.querySelector('[data-captured-reply-observation]')?.closest('[hidden],[inert]')).toBeNull()
  await draw('collaboration', value); expect(shown(peerRow)).toBe(true); expect(shown(systemRow)).toBe(false)
  await draw('system', value); expect(shown(systemRow)).toBe(true)
  expect(node('system')).toBe(systemRow); expect(node('peer')).toBe(peerRow); expect(node('answer')).toBe(answerRow)
  expect(host.querySelector('textarea')).toBe(draft); expect(draft.value).toBe('Preserve private unsent edit')
  await draw('simple', value)
  const reveal = host.querySelector<HTMLButtonElement>('.conversation-detail-summary button')!
  await act(async () => reveal.click()); expect(shown(systemRow)).toBe(true); expect(shown(peerRow)).toBe(true)
  expect(reveal.getAttribute('aria-expanded')).toBe('true')
})

it('preserves an original open raw body and selected text when a preference would otherwise hide it', async () => {
  const value = frame([system], [])
  await draw('system', value)
  const row = node('system'), head = row.querySelector<HTMLButtonElement>('[data-observation-step-id]')!
  await act(async () => head.click())
  const body = row.querySelector('.log-turn__body')!, text = body.querySelector('p')!.firstChild!
  const range = document.createRange(); range.selectNodeContents(text)
  await act(async () => { getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange')) })
  await draw('simple', value)
  expect(shown(row), 'selected-original-remains-readable-after-tier-change').toBe(true)
  expect(row.querySelector('.log-turn__body')).toBe(body); expect(getSelection()!.getRangeAt(0)).toBe(range)
  expect(range.startContainer).toBe(text); expect(getSelection()!.toString()).toContain('Original system')
})
