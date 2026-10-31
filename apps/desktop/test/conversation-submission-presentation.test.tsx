// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { StaticConversationView as ConversationView } from './helpers/conversation-static-fixture'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { StaticActivityView as ActivityView } from './helpers/conversation-static-fixture'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'
import { formatClock } from '@agentmux/client-ui/conversation-time'

const sid = 'submission-presentation-session', source = { providerId: 'codex', nativeSessionId: 'original-source' }
const ref = { hostId: 'source-owner', agentSessionId: sid, source: { kind: 'native' as const, ...source, recordId: 'native-input' } }
const original = 'Original input stays complete.\n\nSecond paragraph.'
const page = (read = true): AgentSessionHistoryPage => ({ agentSessionId: sid, sourceHostId: ref.hostId, source,
  items: read ? [{ id: ref.source.recordId, kind: 'user-message', startedAt: _historyFixtureEpoch(0, 0, 5), contentParts: [{ kind: 'text', text: original }] }] : [], nextCursor: null })
const submission = (id = 'original-input', exact = true, status: AgentTimelineItem['status'] = 'complete'): AgentTimelineItem => ({
  id, agentSessionId: sid, kind: 'user_message', source: 'user', status, createdAt: _historyFixtureEpoch(0, 0, 2), updatedAt: _historyFixtureEpoch(0, 0, 3),
  title: 'Original submission', content: original,
  inputRef: { kind: 'prompt', agentSessionId: sid, expectedRun: { runId: 'original-run' }, submissionId: id },
  inputSubmission: { status: status === 'failed' ? 'unknown' : status === 'streaming' ? 'waiting' : 'terminal-confirmed', observation: 'closed' },
  sourceChannel: 'message-tool', sourceDevice: { deviceId: 'original-device', hostId: 'sender-host', name: 'Original device' },
  ...(exact ? { conversation: { sameEvent: ref } } : {})
})
const snapshot = (items: AgentTimelineItem[]) => ({ agentSessionId: sid, sourceHostId: ref.hostId, revision: 1, items })
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
let host: HTMLDivElement, root: Root
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const render = (body: ReactNode) => act(async () => root.render(<ClientUiProvider platform={platform}>{body}</ClientUiProvider>))
const paragraphs = (node: Element) => [...node.querySelectorAll('p')].map(p => p.textContent).join('\n\n')
const openDetails = async (node: HTMLDetailsElement) => act(async () => { node.open = true; node.dispatchEvent(new Event('toggle')) })
it.each(['shared', 'desktop'])('uses native primary and each exact submission fact in actual %s with full original Copy/details', async surface => {
  const t = snapshot([submission(), submission('failed-attempt', true, 'failed')]), copy = vi.spyOn(platform, 'copyText')
  await render(surface === 'shared' ? <ConversationView sessionId={sid} executionHostId="selected-route" page={page()} timeline={t} />
    : <ActivityView sessionId={sid} executionHostId="selected-route" nativeHistoryPage={page()} timelineSnapshot={t} items={t.items} capability="complete-events" />)
  expect(host.querySelectorAll('[data-conversation-event-id]')).toHaveLength(1)
  expect(host.querySelectorAll('[data-original-contribution]')).toHaveLength(0)
  const body = host.querySelector('.log-turn__body')!, metadata = host.querySelector('.conversation-submissions')!
  expect(paragraphs(body)).toBe(original); expect(metadata).not.toBeNull()
  expect(body.compareDocumentPosition(metadata) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  const entries = metadata.querySelectorAll<HTMLElement>('[data-submission-record]'); expect(entries).toHaveLength(2)
  for (const entry of entries) {
    expect(entry.dataset.nativeReadable).toBe('true')
    expect(entry.querySelector<HTMLDetailsElement>('details')!.open).toBe(false)
    const summary = entry.querySelector('summary')!
    expect(summary.textContent).toContain('消息输入'); expect(summary.querySelector('time')?.textContent).toBe(formatClock(submission().createdAt))
    expect(summary.textContent).not.toContain('Original device'); expect(summary.textContent).not.toContain('Message Tool')
    expect(summary.textContent).not.toContain('source-owner'); expect(summary.querySelector('.log-turn__body')).toBeNull()
    const preview = summary.querySelector<HTMLElement>('.message-disclosure__preview')!
    expect(preview.textContent).toBe(original.replace(/\s+/gu, ' ').trim())
  }
  expect(entries[0]!.querySelector('summary')!.textContent).toContain('Agent 接收未确认')
  expect(entries[1]!.dataset.status).toBe('failed'); expect(entries[1]!.querySelector('summary')!.textContent).toContain('送达 Agent 未确认')
  expect(entries[1]!.querySelector('summary')!.textContent).not.toContain('已进入对话')
  await openDetails(entries[0]!.querySelector<HTMLDetailsElement>('details')!); expect(entries[0]!.textContent).toContain('original-input'); expect(entries[0]!.textContent).toContain('source-owner')
  expect(entries[0]!.textContent).toContain('不是原生接纳或执行完成时间')
  expect(paragraphs(entries[0]!.querySelector('.log-turn__body')!)).toBe(original)
  await act(async () => entries[0]!.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click()); expect(copy.mock.calls.at(-1)?.[0]).toBe(original)
  await act(async () => entries[0]!.querySelector<HTMLButtonElement>('[aria-label="Message details"]')!.click())
  expect(entries[0]!.textContent).toContain('Original device'); expect(entries[0]!.textContent).toContain('Message Tool')
  const raw = [...entries[0]!.querySelectorAll<HTMLDetailsElement>('details')].find(detail => detail.firstElementChild?.textContent === 'Original record JSON')!
  expect(raw).toBeDefined(); await openDetails(raw)
  expect(JSON.parse(raw.querySelector('pre')!.textContent!)).toEqual(t.items[0])
  await act(async () => raw.querySelector<HTMLButtonElement>('[aria-label="Copy original record"]')!.click())
  expect(JSON.parse(copy.mock.calls.at(-1)![0])).toEqual(t.items[0])
  expect(entries[0]!.dataset.messageSourceKey).toBe(conversationMessageSourceKey(sid, { kind: 'captured', recordId: 'original-input' }))
  expect(host.querySelectorAll('[data-original-contribution]')).toHaveLength(0)
  await openDetails(entries[1]!.querySelector<HTMLDetailsElement>('details')!); expect(paragraphs(entries[1]!.querySelector('.log-turn__body')!)).toBe(original)
  expect(host.querySelector('[data-submission-record]')).toBe(entries[0])
})
it('does not turn a streaming submission record into confirmed adoption or success', async () => {
  await render(<ConversationView sessionId={sid} page={page()} timeline={snapshot([submission('unconfirmed-submit', true, 'streaming')])} />)
  const metadata = host.querySelector('[data-submission-record]')!
  expect(metadata.textContent).toContain('已保存 · 等待 Agent')
  expect(metadata.textContent).not.toContain('已送入终端')
  expect(metadata.textContent).not.toContain('已采用'); expect(metadata.textContent).not.toContain('已进入对话')
  expect(metadata.getAttribute('data-status')).toBe('streaming')
})

function capturedCard(id: string): HTMLElement {
  const key = conversationMessageSourceKey(sid, { kind: 'captured', recordId: id })
  return [...host.querySelectorAll<HTMLElement>('.log-turn[data-message-source-key]')].find(node => node.dataset.messageSourceKey === key)!
}
it.each(['shared', 'desktop'])('uses one original message card when the exactly related native body is empty in %s', async surface => {
  const emptyNative: AgentSessionHistoryPage = { ...page(), items: page().items.map(item => ({ ...item, contentParts: [] })) }
  const t = snapshot([submission('native-empty-input')])
  await render(surface === 'shared' ? <ConversationView sessionId={sid} executionHostId="selected-route" page={emptyNative} timeline={t} />
    : <ActivityView sessionId={sid} executionHostId="selected-route" nativeHistoryPage={emptyNative} timelineSnapshot={t} items={t.items} capability="complete-events" />)
  const card = capturedCard('native-empty-input')
  expect(paragraphs(card.querySelector('.log-turn__body')!)).toBe(original)
  expect(host.querySelectorAll('.log-turn')).toHaveLength(1)
  expect(card.textContent).toContain('Agent 接收未确认')
  expect(card.querySelector('[aria-label="Copy message"]')).not.toBeNull()
  const native = host.querySelector<HTMLDetailsElement>('[data-original-contribution]')!
  expect(native).not.toBeNull(); expect(native.open).toBe(false)
  await openDetails(native)
  const raw = [...native.querySelectorAll<HTMLDetailsElement>('details')].find(node => node.firstElementChild?.textContent === 'Original record JSON')!
  await openDetails(raw)
  expect(JSON.parse(raw.querySelector('pre')!.textContent!).contentParts).toEqual([])
})
it.each(['shared', 'desktop'])('keeps unassociated originals as independently readable cards in %s', async surface => {
  const t = snapshot([submission('same-text', false)]), copy = vi.spyOn(platform, 'copyText')
  await render(surface === 'shared' ? <ConversationView sessionId={sid} page={page()} timeline={t} />
    : <ActivityView sessionId={sid} items={t.items} nativeHistoryPage={page()} timelineSnapshot={t} capability="complete-events" />)
  expect(host.querySelectorAll('[data-conversation-event-id]')).toHaveLength(2)
  expect([...host.querySelectorAll('.log-turn__body')].map(paragraphs)).toEqual([original, original])
  const card = capturedCard('same-text'), key = card.dataset.messageSourceKey
  expect(card.textContent).toContain('Agent 接收未确认')
  await act(async () => card.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(copy.mock.calls.at(-1)?.[0]).toBe(original)
  await act(async () => card.querySelector<HTMLButtonElement>('[aria-label="Message details"]')!.click())
  expect(card.textContent).toContain('same-text'); expect(card.textContent).toContain('Original device'); expect(card.textContent).toContain('Message Tool')
  expect(card.dataset.messageSourceKey).toBe(key); expect(host.textContent).not.toContain('已采用')
})
it.each(['failed', 'streaming'] as const)('keeps the original %s input and actual phase visible without an outer send disclosure', async status => {
  await render(<ConversationView sessionId={sid} page={page(false)} timeline={snapshot([submission('status-input', false, status)])} />)
  const card = capturedCard('status-input')
  expect(paragraphs(card.querySelector('.log-turn__body')!)).toBe(original)
  expect(card.textContent).toContain(status === 'failed' ? '送达 Agent 未确认' : '已保存 · 等待 Agent')
  expect(card.textContent).not.toContain('已进入对话')
  expect(card.querySelector('[data-icon-animation]')).toBeNull()
})
it.each(['missing', 'unread'] as const)('keeps complete captured content and exact unknown when native is %s', async kind => {
  await render(<ConversationView sessionId={sid} {...(kind === 'unread' ? { page: page(false) } : {})} timeline={snapshot([submission()])} />)
  const card = capturedCard('original-input')
  expect(paragraphs(card.querySelector('.log-turn__body')!)).toBe(original)
  expect(card.textContent).toContain('Agent 接收未确认')
  expect(host.querySelector('[data-conversation-gap="CONVERSATION_ANCHOR_UNREAD"]')).not.toBeNull()
})
it('keeps the selected original body and focus when an exact native contribution arrives', async () => {
  const draw = (native: boolean) => <ConversationView sessionId={sid} page={page(native)} timeline={snapshot([submission('selected-input')])} />
  await render(draw(false))
  const card = capturedCard('selected-input'), body = card.querySelector('.log-turn__body')!, text = body.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8); getSelection()!.addRange(range)
  const action = card.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!; await act(async () => action.focus())
  await render(draw(true))
  expect(capturedCard('selected-input').querySelector('.log-turn__body')).toBe(body)
  expect(getSelection()!.getRangeAt(0)).toBe(range); expect(document.activeElement).toBe(action)
})
it('a located captured message reads its original body and exact source without another read', async () => {
  const id = 'located-input', located = conversationMessageSourceKey(sid, { kind: 'captured', recordId: id })
  await render(<ConversationView sessionId={sid} page={page(false)} timeline={snapshot([submission(id)])} locatedMessageKey={located} />)
  const card = capturedCard(id)
  expect(paragraphs(card.querySelector('.log-turn__body')!)).toBe(original)
  expect(card.textContent).toContain('已定位此消息')
})

it('an accurately located submission keeps its original reader open at its captured identity after native adoption', async () => {
  const id = 'located-native-input', located = conversationMessageSourceKey(sid, { kind: 'captured', recordId: id })
  await render(<ConversationView sessionId={sid} executionHostId="selected-route" page={page()} timeline={snapshot([submission(id)])} locatedMessageKey={located ?? null} />)
  expect(host.querySelector('[data-submission-id]')).toBeNull()
  const originalRecord = host.querySelector<HTMLDetailsElement>('[data-submission-record] details')!
  expect(originalRecord.open).toBe(true); expect(originalRecord.closest<HTMLElement>('[data-submission-record]')!.dataset.messageSourceKey).toBe(located)
  expect(paragraphs(originalRecord.querySelector('.log-turn__body')!)).toBe(original)
  expect(originalRecord.querySelector('[aria-label="Copy message"]')).not.toBeNull()
  expect(host.querySelector('[data-original-contribution]')).toBeNull()
})

it('retains a located native contribution owner and its Range after the locator leaves, including an explicit close', async () => {
  const id = 'retained-located-original', located = conversationMessageSourceKey(sid, { kind: 'captured', recordId: id })
  const t = snapshot([submission(id)]), nativePage = page()
  const draw = (locatedMessageKey: string | null) => <ConversationView sessionId={sid} executionHostId="selected-route" page={nativePage} timeline={t} locatedMessageKey={locatedMessageKey} />
  await render(draw(located ?? null))
  const owner = host.querySelector<HTMLDetailsElement>('[data-submission-record] details')!, body = owner.querySelector('.log-turn__body')!
  expect(owner.open).toBe(true); expect(owner.closest<HTMLElement>('[data-submission-record]')!.dataset.messageSourceKey).toBe(located)
  const text = body.querySelector('p')!.firstChild!, range = document.createRange()
  range.setStart(text, 0); range.setEnd(text, 8); getSelection()!.addRange(range)
  await act(async () => owner.focus())
  await render(draw(null))
  expect(host.querySelector('[data-submission-record] details')).toBe(owner)
  expect(owner.querySelector('.log-turn__body')).toBe(body); expect(owner.open).toBe(true)
  expect(getSelection()!.getRangeAt(0)).toBe(range); expect(range.toString()).toBe('Original'); expect(document.activeElement).toBe(owner)
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); owner.open = false; owner.dispatchEvent(new Event('toggle')) })
  await render(draw(null))
  expect(host.querySelector('[data-submission-record] details')).toBe(owner); expect(owner.open).toBe(false)
  expect(owner.querySelector('.log-turn__body')).toBe(body); expect(document.activeElement).toBe(owner)
  expect(owner.open).toBe(false)
})


it.each(['independent', 'native'] as const)('reads the %s attachment only with its displayed original and copies the exact reference', async kind => {
  const path = fixturePath('home/.agentmux/pasted/attachment.png'), content = `Original attached input

@${path}`
  const input = { ...submission('resource-input', kind === 'native'), content }
  const read = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+3fVbWQAAAABJRU5ErkJggg==' })), copy = vi.spyOn(platform, 'copyText')
  await render(<ConversationView sessionId={sid} page={page()} timeline={snapshot([input])} readPastedImage={read} />)
  let card: HTMLElement
  if (kind === 'native') {
    expect(read).not.toHaveBeenCalled()
    const entry = host.querySelector<HTMLElement>('[data-submission-record]')!
    await openDetails(entry.querySelector<HTMLDetailsElement>('details')!); card = entry
  } else card = capturedCard('resource-input')
  expect(read).toHaveBeenCalledExactlyOnceWith(path); expect(card.querySelector('img')).not.toBeNull()
  await act(async () => card.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(copy.mock.calls.at(-1)?.[0]).toBe(content)
})
it('keeps an explicitly expanded long original after blur and exact coalescence, then respects its close', async () => {
  const content = 'Original long input.\n\n' + 'Complete original prose remains available. '.repeat(40) + '\n\nOriginal long input ending.'
  const input = { ...submission('long-original-input', false), content, authorHuman: true }
  const draw = (linked: boolean) => <ConversationView sessionId={sid} page={page()} timeline={snapshot([{ ...input, ...(linked ? { conversation: { sameEvent: ref } } : {}) }])} />
  await render(draw(false))
  const card = capturedCard(input.id), detail = card.querySelector<HTMLDetailsElement>('.message-disclosure')!
  expect(detail.open).toBe(false); await openDetails(detail)
  expect(paragraphs(card.querySelector('.log-turn__body')!)).toBe(content.split('\n\n').map(paragraph => paragraph.trimEnd()).join('\n\n'))
  await act(async () => (document.activeElement as HTMLElement)?.blur()); getSelection()?.removeAllRanges()
  await render(draw(true))
  const original = host.querySelector<HTMLDetailsElement>('[data-submission-record] details')!
  expect(original.open).toBe(true)
  expect(paragraphs(original.querySelector('.log-turn__body')!)).toBe(content.split('\n\n').map(paragraph => paragraph.trimEnd()).join('\n\n'))
  expect(original.querySelector('.log-turn .message-disclosure')).toBeNull()
  await act(async () => { original.open = false; original.dispatchEvent(new Event('toggle')) })
  await render(draw(true)); expect(host.querySelector('[data-submission-record] details')).toBe(original); expect(original.open).toBe(false)
})
it('opens a related long original without another body fold and keeps exact Copy', async () => {
  const content = 'Original long input.\n\n' + 'Complete original prose remains available. '.repeat(40)
  const input = { ...submission('related-long-input'), content, authorHuman: true }, copy = vi.spyOn(platform, 'copyText')
  await render(<ConversationView sessionId={sid} page={page()} timeline={snapshot([input])} />)
  const entry = host.querySelector<HTMLElement>('[data-submission-record]')!, detail = entry.querySelector<HTMLDetailsElement>('details')!
  expect(detail.open).toBe(false); await openDetails(detail)
  expect(paragraphs(entry.querySelector('.log-turn__body')!)).toBe(content.split('\n\n').map(paragraph => paragraph.trimEnd()).join('\n\n'))
  expect(entry.querySelector('.log-turn .message-disclosure')).toBeNull()
  await act(async () => entry.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click()); expect(copy.mock.calls.at(-1)?.[0]).toBe(content)
})
it('renders observations as ordinary provenance and keeps expanded body Range through a compact update', async () => {
  const item: AgentTimelineItem = { ...submission('reply', false), source: 'native-hook', kind: 'assistant_message', eventName: 'Stop' }
  const read = (p: AgentSessionHistoryPage) => <ConversationView sessionId={sid} page={p} timeline={snapshot([item])} />
  await render(read(page(false)))
  expect(host.querySelector('[data-submission-id]')).toBeNull()
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-captured-reply-observation] [aria-expanded]')!.click()); const body = host.querySelector('.log-turn__body')!, text = body.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8); getSelection()!.addRange(range)
  await render(read(page()))
  expect(host.querySelector('[data-captured-reply-observation] .log-turn__body')).toBe(body); expect(getSelection()!.toString()).toBe('Original')
  expect(host.querySelector('[data-captured-reply-observation] .wf-tool-row')).toBeNull()
  expect(host.querySelectorAll('.conversation-reply-observation__controls [data-conversation-source-role="reply-observation"]')).toHaveLength(1)
  expect(host.querySelector('.conversation-reply-observation__notice')).toBeNull()
  expect(host.querySelector('[data-conversation-source-role]')!.getAttribute('title')).toContain('事件回报附带的回复文本快照')
  expect(host.querySelector('[data-captured-reply-observation] button[aria-expanded]')!.getAttribute('aria-expanded')).toBe('true')
})
it('retains local observation disclosure, exact source key and complete Copy without a highlighted title', async () => {
  const item: AgentTimelineItem = { ...submission('reply', false), source: 'native-hook', kind: 'assistant_message', eventName: 'Stop', content: 'Original observed reply' }
  const copy = vi.spyOn(platform, 'copyText')
  await render(<ConversationView sessionId={sid} page={page()} timeline={snapshot([item])} />)
  const shell = host.querySelector<HTMLElement>('[data-captured-reply-observation]')!, key = shell.dataset.messageSourceKey
  expect(shell.querySelector('.log-row__title, .wf-tool-row')).toBeNull()
  const toggle = shell.querySelector<HTMLButtonElement>('[aria-expanded]')!
  await act(async () => toggle.click()); expect(shell.dataset.messageSourceKey).toBe(key)
  await act(async () => shell.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click()); expect(copy.mock.calls.at(-1)?.[0]).toBe(item.content)
  await act(async () => toggle.click()); expect(shell.querySelector('.log-turn__body')).not.toBeNull()
  expect(shell.querySelector('[hidden]')).not.toBeNull()
})
