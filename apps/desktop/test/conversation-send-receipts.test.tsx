// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { StaticConversationView as ConversationView, StaticActivityView as ActivityView } from './helpers/conversation-static-fixture'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import { previewVisibility } from './helpers/preview-visibility'

const sid = 'receipt-session', hostId = 'receipt-host', nativeSource = { providerId: 'codex', nativeSessionId: 'receipt-native' }
const original = 'The complete submitted message.\n\nKeep this original final paragraph.'
const target = { hostId, agentSessionId: sid, source: { kind: 'native' as const, ...nativeSource, recordId: 'native-input' } }
function submission(status: NonNullable<AgentTimelineItem['inputSubmission']>['status'] = 'waiting', linked = false): AgentTimelineItem {
  return { id: 'original-send', agentSessionId: sid, kind: 'user_message', source: 'user', status: 'complete', title: 'Submitted input',
    createdAt: 1000, updatedAt: 1000, content: original, publicContent: 'confirmed', authorHuman: true,
    inputRef: { kind: 'prompt', agentSessionId: sid, expectedRun: { runId: 'receipt-run' }, submissionId: 'original-send' },
    inputSubmission: { status, observation: status === 'waiting' ? 'owned' : 'closed' },
    ...(linked ? { conversation: { sameEvent: target } } : {}) }
}
const page = (text = original): AgentSessionHistoryPage => ({ agentSessionId: sid, sourceHostId: hostId, source: nativeSource,
  items: [{ id: target.source.recordId, kind: 'user-message', startedAt: 2000, contentParts: text ? [{ kind: 'text', text }] : [] }], nextCursor: null })
const base: ClientUiPlatform = { copyText: vi.fn(async () => true), overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
let element: HTMLDivElement, root: Root, visibility: ReturnType<typeof previewVisibility>
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  visibility = previewVisibility()
  element = document.createElement('div'); document.body.append(element); root = createRoot(element) })
afterEach(async () => { getSelection()?.removeAllRanges(); await act(async () => root.unmount()); element.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function draw(item = submission(), preference: Partial<ClientUiPlatform> = {}, options: { native?: AgentSessionHistoryPage; desktop?: boolean; active?: boolean; located?: string } = {}) {
  const timeline = { agentSessionId: sid, sourceHostId: hostId, revision: 1, items: [item] }
  await act(async () => root.render(<ClientUiProvider platform={{ ...base, ...preference }}>{options.desktop
    ? <ActivityView sessionId={sid} executionHostId={hostId} items={timeline.items} timelineSnapshot={timeline} {...(options.native ? { nativeHistoryPage: options.native } : {})} capability="complete-events" />
    : <ConversationView sessionId={sid} executionHostId={hostId} timeline={timeline} {...(options.native ? { page: options.native } : {})}
      {...(options.active === undefined ? {} : { active: options.active })} {...(options.located === undefined ? {} : { locatedMessageKey: options.located })} />}</ClientUiProvider>))
}
const receipt = () => element.querySelector<HTMLElement>('.conversation-send-receipt')!
const disclosure = () => receipt().querySelector<HTMLDetailsElement>(':scope > details')!
const message = () => element.querySelector<HTMLElement>('.log-turn[data-send-receipt]')!
async function toggle(node: HTMLDetailsElement, open: boolean) { await act(async () => { node.open = open; node.dispatchEvent(new Event('toggle')) }) }

it.each([false, true])('actual shared/desktop consumer changes waiting to a static compact receipt and retains the same original reader (desktop=%s)', async desktop => {
  await draw(submission(), {}, { desktop })
  expect(message()).not.toBeNull(); expect(disclosure().open).toBe(true)
  expect(message().querySelector('.log-turn__body')?.textContent).toContain('Keep this original final paragraph.')
  expect(message().querySelector('[data-icon-animation="spin"]')).not.toBeNull()
  const body = message().querySelector('.log-turn__body')
  await draw(submission('admitted'), {}, { desktop })
  expect(receipt().dataset.receiptConfirmed).toBe('true'); expect(receipt().dataset.receiptMode).toBe('compact')
  expect(disclosure().open).toBe(false); expect(receipt().querySelector('[data-icon-animation]')).toBeNull()
  expect(message().querySelector('.log-turn__body')).toBe(body)
  await toggle(disclosure(), true)
  expect(message().querySelector('.log-turn__body')?.textContent).toContain('Keep this original final paragraph.')
  await act(async () => message().querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(base.copyText).toHaveBeenLastCalledWith(original, expect.any(Function))
  await act(async () => message().querySelector<HTMLButtonElement>('[aria-label="Message details"]')!.click())
  expect(message().textContent).toContain('original-send'); expect(message().textContent).toContain('admitted')
})

it.each(['terminal-confirmed', 'launch-carried', 'unknown', 'stopped', 'not-applied'] as const)('does not invent confirmation or pending motion from %s and unrelated equal native text', async status => {
  await draw(submission(status), { conversationShowSendReceipts: false, conversationConfirmedSendReceipt: 'hide' }, { native: page() })
  expect(receipt().dataset.receiptConfirmed).toBe('false'); expect(disclosure().hidden).toBe(false); expect(disclosure().open).toBe(false)
  expect(receipt().querySelector('[data-icon-animation]')).toBeNull()
  await toggle(disclosure(), true)
  expect(element.querySelectorAll('[data-conversation-event-id]')).toHaveLength(2)
  expect(message().querySelector('.log-turn__body')?.textContent).toContain('Keep this original final paragraph.')
  expect(message().querySelector('[data-icon-animation]')).toBeNull()
})

it('consumes only the accepted exact Core relationship and hides the receipt without hiding the native message', async () => {
  await draw(submission('terminal-confirmed', true), {}, { native: page() })
  expect(element.querySelectorAll('[data-conversation-event-id]')).toHaveLength(1)
  expect(receipt().dataset.receiptConfirmed).toBe('true'); expect(disclosure().open).toBe(false)
  expect(receipt().querySelector('summary')?.textContent).toContain('原生记录已对应')
  await draw(submission('terminal-confirmed', true), { conversationConfirmedSendReceipt: 'hide' }, { native: page() })
  expect(disclosure().hidden).toBe(true)
  expect(element.querySelector('[data-native-record-id="native-input"] > .log-turn > .log-turn__body')?.textContent).toContain('Keep this original final paragraph.')
  await draw(submission('terminal-confirmed', true), { conversationConfirmedSendReceipt: 'keep', conversationShowSendReceipts: false }, { native: page() })
  expect(disclosure().hidden).toBe(true)
})

it('keep leaves the light original card open while hide and off retain the sole readable original', async () => {
  await draw(submission('admitted'), { conversationConfirmedSendReceipt: 'keep' })
  expect(disclosure().open).toBe(true); expect(message()?.querySelector('.log-turn__body')).not.toBeNull()
  await draw(submission('admitted'), { conversationConfirmedSendReceipt: 'hide', conversationShowSendReceipts: false })
  expect(disclosure().hidden).toBe(false); expect(disclosure().open).toBe(false)
  await toggle(disclosure(), true)
  expect(message().querySelector('.log-turn__body')?.textContent).toContain('Keep this original final paragraph.')
})

it('does not suppress a failed or pending receipt even beside an exactly related native message', async () => {
  for (const item of [submission('waiting', true), submission('unknown', true), { ...submission('admitted', true), status: 'failed' as const }]) {
    await draw(item, { conversationConfirmedSendReceipt: 'hide', conversationShowSendReceipts: false }, { native: page() })
    expect(disclosure().hidden).toBe(false)
  }
})

it('keeps exact focus, selected original text and explicit location through compaction and hiding', async () => {
  const item = submission('admitted', true)
  await draw(item, { conversationConfirmedSendReceipt: 'keep' }, { native: page() })
  const body = message().querySelector('.log-turn__body')!, text = body.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8)
  await act(async () => { getSelection()!.addRange(range) })
  const copy = message().querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!
  await act(async () => copy.focus())
  await draw(item, { conversationConfirmedSendReceipt: 'hide', conversationShowSendReceipts: false }, { native: page() })
  expect(disclosure().hidden).toBe(false); expect(disclosure().open).toBe(true)
  expect(message().querySelector('.log-turn__body')).toBe(body); expect(getSelection()!.getRangeAt(0)).toBe(range); expect(document.activeElement).toBe(copy)
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); copy.blur() })
  const located = conversationMessageSourceKey(sid, { kind: 'captured', recordId: item.id })!
  await draw(item, { conversationConfirmedSendReceipt: 'hide', conversationShowSendReceipts: false }, { native: page(), located })
  expect(disclosure().hidden).toBe(false); expect(disclosure().open).toBe(true)
  expect(message().querySelector('.log-turn__body')?.textContent).toContain('Keep this original final paragraph.')
})

it('stops pending motion when inactive or when the original input observation is no longer owned', async () => {
  await draw(submission(), {}, { active: false })
  expect(message().querySelector('[data-icon-animation]')).toBeNull()
  await draw({ ...submission(), inputSubmission: { status: 'waiting', observation: 'rejoin-needed' } })
  expect(message().querySelector('[data-icon-animation]')).toBeNull()
})

it('an accepted native counterpart keeps the original stale waiting receipt readable without restarting its motion', async () => {
  await draw(submission('waiting', true), { conversationConfirmedSendReceipt: 'keep' }, { native: page() })
  expect(disclosure().open).toBe(true)
  expect(message().textContent).toContain('等待 Agent')
  expect(receipt().dataset.receiptConfirmed).toBe('true')
  expect(message().querySelector('[data-icon-animation]')).toBeNull()
})

it('a focused compact summary survives Hide without opening its body, then hides after focus leaves', async () => {
  const item = submission('admitted', true)
  await draw(item, {}, { native: page() })
  const summary = disclosure().querySelector<HTMLElement>('summary')!
  await act(async () => summary.focus())
  expect(disclosure().open).toBe(false)
  await draw(item, { conversationConfirmedSendReceipt: 'hide' }, { native: page() })
  expect(disclosure().hidden).toBe(false); expect(disclosure().open).toBe(false); expect(document.activeElement).toBe(summary)
  await act(async () => summary.blur())
  expect(disclosure().hidden).toBe(true)
})

it('Off compacts a waiting receipt to a static status line and retains full original access', async () => {
  await draw(submission(), { conversationShowSendReceipts: false })
  expect(receipt().dataset.receiptMode).toBe('compact'); expect(disclosure().open).toBe(false); expect(disclosure().hidden).toBe(false)
  expect(disclosure().querySelector('summary')?.textContent).toContain('等待 Agent')
  expect(receipt().querySelector('[data-icon-animation]')).toBeNull()
  await toggle(disclosure(), true)
  expect(message().querySelector('.log-turn__body')?.textContent).toContain('Keep this original final paragraph.')
  expect(receipt().querySelector('[data-icon-animation]')).toBeNull()
})

it('Off keeps a failed receipt reason visible in the compact status line', async () => {
  await draw({ ...submission('admitted'), status: 'failed' }, { conversationShowSendReceipts: false })
  expect(disclosure().open).toBe(false); expect(disclosure().hidden).toBe(false)
  expect(disclosure().querySelector('summary')?.textContent).toContain('原记录失败')
  await toggle(disclosure(), true)
  expect(message().querySelector('[data-status="failed"]')).not.toBeNull()
})

it('confirmed Keep reuses one original reader with receipt facts confined to its original Info', async () => {
  await draw(submission('admitted', true), { conversationConfirmedSendReceipt: 'keep' }, { native: page() })
  expect(disclosure().open).toBe(true)
  expect(receipt().querySelectorAll('.log-turn__body')).toHaveLength(1)
  expect(receipt().querySelector('dl.conversation-input-details__facts')).toBeNull()
  await act(async () => message().querySelector<HTMLButtonElement>('[aria-label="Message details"]')!.click())
  expect(receipt().querySelector('dl.conversation-input-details__facts')).not.toBeNull()
  expect(message().textContent).toContain('admitted')
})

it.each([false, true])('pending motion follows its actual document and viewport; admitted stays static after returning (desktop=%s)', async desktop => {
  await draw(submission(), {}, { desktop })
  const activity = message().querySelector('.conversation-send-receipt__activity')!, body = message().querySelector('.log-turn__body')!
  expect(activity.querySelector('[data-icon-animation="spin"]')).not.toBeNull()
  const observer = visibility.observers.find(observer => observer.target === activity)!
  expect(observer).toBeDefined()
  await act(async () => visibility.foreground(false))
  expect(message().querySelector('.conversation-send-receipt__activity')).toBe(activity)
  expect(activity.querySelector('[data-icon-animation]')).toBeNull(); expect(message().querySelector('.log-turn__body')).toBe(body)
  await act(async () => visibility.foreground(true))
  expect(activity.querySelector('[data-icon-animation="spin"]')).not.toBeNull()
  await act(async () => visibility.viewport(false))
  expect(activity.querySelector('[data-icon-animation]')).toBeNull()
  await act(async () => visibility.viewport(true))
  expect(activity.querySelector('[data-icon-animation="spin"]')).not.toBeNull()
  await draw(submission('admitted'), {}, { desktop })
  expect(message().querySelector('.conversation-send-receipt__activity')).toBeNull()
  expect(observer.active).toBe(false)
  await act(async () => { visibility.foreground(false); visibility.foreground(true) })
  expect(message().querySelector('[data-icon-animation]')).toBeNull(); expect(message().querySelector('.log-turn__body')).toBe(body)
})
