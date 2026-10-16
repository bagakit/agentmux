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
import messageStyles from '../../../packages/client-ui/src/styles/conversation-message.css?raw'
import disclosureStyles from '../../../packages/client-ui/src/styles/conversation-message-disclosure.css?raw'

const sid = 'submission-presentation-session', source = { providerId: 'codex', nativeSessionId: 'original-source' }
const ref = { hostId: 'source-owner', agentSessionId: sid, source: { kind: 'native' as const, ...source, recordId: 'native-input' } }
const original = 'Original input stays complete.\n\nSecond paragraph.'
const page = (read = true): AgentSessionHistoryPage => ({ agentSessionId: sid, sourceHostId: ref.hostId, source,
  items: read ? [{ id: ref.source.recordId, kind: 'user-message', startedAt: _historyFixtureEpoch(0, 0, 5), contentParts: [{ kind: 'text', text: original }] }] : [], nextCursor: null })
const submission = (id = 'original-input', exact = true, status: AgentTimelineItem['status'] = 'complete'): AgentTimelineItem => ({
  id, agentSessionId: sid, kind: 'user_message', source: 'user', status, createdAt: _historyFixtureEpoch(0, 0, 2), updatedAt: _historyFixtureEpoch(0, 0, 3),
  title: 'Original submission', content: original, sourceChannel: 'message-tool', sourceDevice: { deviceId: 'original-device', hostId: 'sender-host', name: 'Original device' },
  ...(exact ? { conversation: { sameEvent: ref } } : {})
})
const snapshot = (items: AgentTimelineItem[]) => ({ agentSessionId: sid, sourceHostId: ref.hostId, revision: 1, items })
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
let host: HTMLDivElement, root: Root, stylesheet: HTMLStyleElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); stylesheet = document.createElement('style'); stylesheet.textContent = disclosureStyles + '\n' + messageStyles; document.head.append(stylesheet); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); stylesheet.remove(); getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const render = (body: ReactNode) => act(async () => root.render(<ClientUiProvider platform={platform}>{body}</ClientUiProvider>))
const paragraphs = (node: Element) => [...node.querySelectorAll('p')].map(p => p.textContent).join('\n\n')
const openDetails = async (node: HTMLDetailsElement) => act(async () => { node.open = true; node.dispatchEvent(new Event('toggle')) })
const matchingStyleRules = (node: Element) => [...stylesheet.textContent!.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].flatMap(([, selector, body]) => {
  try { return node.matches(selector!.trim()) ? [body!] : [] } catch { return [] }
}).join('\n')
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
    expect(summary.textContent).toContain('消息发送'); expect(summary.querySelector('time')?.textContent).toBe(formatClock(submission().createdAt))
    expect(summary.textContent).not.toContain('Original device'); expect(summary.textContent).not.toContain('Message Tool')
    expect(summary.textContent).not.toContain('source-owner'); expect(summary.querySelector('.log-turn__body')).toBeNull()
    const preview = summary.querySelector<HTMLElement>('.message-disclosure__preview')!
    expect(preview.textContent).toBe(original.replace(/\s+/gu, ' ').trim())
    expect(getComputedStyle(preview).whiteSpace).toBe('nowrap'); expect(getComputedStyle(preview).textOverflow).toBe('ellipsis')
    expect(getComputedStyle(preview).overflow).toBe('hidden')
  }
  expect(entries[0]!.querySelector('summary')!.textContent).toContain('已进入对话')
  expect(entries[1]!.dataset.status).toBe('failed'); expect(entries[1]!.querySelector('summary')!.textContent).toContain('提交失败')
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
  expect(metadata.textContent).toContain('提交未确认')
  expect(metadata.textContent).not.toContain('提交已记录')
  expect(metadata.textContent).not.toContain('已采用'); expect(metadata.textContent).not.toContain('已进入对话')
  expect(metadata.getAttribute('data-status')).toBe('streaming')
})
it.each(['shared', 'desktop'])('keeps an exactly related empty native body in the preview stage in %s', async surface => {
  const emptyNative: AgentSessionHistoryPage = { ...page(), items: page().items.map(item => ({ ...item, contentParts: [] })) }
  const t = snapshot([submission('native-empty-input')])
  await render(surface === 'shared' ? <ConversationView sessionId={sid} executionHostId="selected-route" page={emptyNative} timeline={t} />
    : <ActivityView sessionId={sid} executionHostId="selected-route" nativeHistoryPage={emptyNative} timelineSnapshot={t} items={t.items} capability="complete-events" />)
  const entry = host.querySelector<HTMLElement>('[data-submission-record]')!, detail = entry.querySelector<HTMLDetailsElement>('details')!
  expect(entry.dataset.nativeReadable).toBe('false'); expect(detail.open).toBe(false)
  const summary = detail.querySelector('summary')!, preview = summary.querySelector<HTMLElement>('.message-disclosure__preview')!
  expect(summary.textContent).toContain('消息发送'); expect(summary.textContent).toContain('提交已记录')
  expect(summary.textContent).not.toContain('已进入对话'); expect(summary.querySelector('time')?.textContent).toBe(formatClock(submission().createdAt))
  expect(preview.textContent).toBe(original.replace(/\s+/gu, ' ').trim())
  expect(matchingStyleRules(preview)).toMatch(/-webkit-line-clamp:\s*2\s*;/u)
  expect(getComputedStyle(preview).whiteSpace).not.toBe('nowrap'); expect(entry.querySelector('.log-turn__body')).toBeNull()
  await openDetails(detail); expect(paragraphs(entry.querySelector('.log-turn__body')!)).toBe(original)
  expect(entry.querySelector('[aria-label="Copy message"]')).not.toBeNull(); expect(entry.querySelector('[aria-label="Message details"]')).not.toBeNull()
})
it.each(['shared', 'desktop'])('keeps independent originals but only one full bubble until the send record is opened in %s', async surface => {
  const t = snapshot([submission('same-text', false)]), copy = vi.spyOn(platform, 'copyText')
  await render(surface === 'shared' ? <ConversationView sessionId={sid} page={page()} timeline={t} /> : <ActivityView sessionId={sid} items={t.items} nativeHistoryPage={page()} timelineSnapshot={t} capability="complete-events" />)
  expect(host.querySelectorAll('[data-conversation-event-id]')).toHaveLength(2)
  const row = host.querySelector<HTMLElement>('[data-submission-id="same-text"]')!
  expect(row).not.toBeNull()
  const detail = row.querySelector<HTMLDetailsElement>('.message-disclosure')!
  expect(detail.open).toBe(false)
  const summary = detail.querySelector('summary')!, preview = summary.querySelector<HTMLElement>('.message-disclosure__preview')!
  expect(summary.textContent).toContain('消息发送'); expect(summary.textContent).not.toContain('Original device'); expect(summary.textContent).not.toContain('Message Tool')
  expect(summary.textContent).toContain('提交已记录'); expect(summary.textContent).not.toContain('已进入对话')
  expect(summary.querySelector('time')?.textContent).toBe(formatClock(submission().createdAt))
  expect(preview.textContent).toBe(original.replace(/\s+/gu, ' ').trim())
  // happy-dom drops vendor clamp declarations from CSSOM. Bind the loaded
  // production rule to this real preview; browser review proves physical lines.
  expect(matchingStyleRules(preview)).toMatch(/-webkit-line-clamp:\s*2\s*;/u)
  expect(getComputedStyle(preview).overflow).toBe('hidden')
  expect(row.querySelector('.log-turn')).toBeNull()
  expect([...host.querySelectorAll('.log-turn__body')].map(paragraphs)).toEqual([original])
  expect(host.querySelector('.conversation-submissions')).toBeNull()
  const key = row.dataset.messageSourceKey, reference = row.dataset.conversationItemRef
  await openDetails(detail)
  expect([...host.querySelectorAll('.log-turn__body')].map(paragraphs)).toEqual([original, original])
  await act(async () => row.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(copy.mock.calls.at(-1)?.[0]).toBe(original)
  await act(async () => row.querySelector<HTMLButtonElement>('[aria-label="Message details"]')!.click())
  expect(row.textContent).toContain('same-text'); expect(row.textContent).toContain('Original device'); expect(row.textContent).toContain('Message Tool')
  expect(row.dataset.messageSourceKey).toBe(key); expect(row.dataset.conversationItemRef).toBe(reference)
  expect(host.textContent).not.toContain('已采用')
})

it('defaults to a compact send row without native content and keeps explicit choices across native availability', async () => {
  const draw = (native: boolean) => <ConversationView sessionId={sid} page={page(native)} timeline={snapshot([submission('auto-default', false)])} />
  await render(draw(false))
  const detail = host.querySelector<HTMLDetailsElement>('[data-submission-id] details')!
  expect(detail.open).toBe(false)
  // Browsers emit toggle after the controlled open attribute is synchronized.
  await act(async () => detail.dispatchEvent(new Event('toggle')))
  await render(draw(true)); expect(detail.open).toBe(false)
  await openDetails(detail); expect(detail.open).toBe(true)
  await act(async () => { detail.open = false; detail.dispatchEvent(new Event('toggle')) })
  await render(draw(false)); expect(detail.open).toBe(false)
  await openDetails(detail); await render(draw(true)); expect(detail.open).toBe(true)
})

it.each(['failed', 'streaming'] as const)('keeps the original %s submission state in the compact row and its complete input on expansion', async status => {
  await render(<ConversationView sessionId={sid} page={page()} timeline={snapshot([submission('status-input', false, status)])} />)
  const row = host.querySelector<HTMLElement>('[data-submission-id]')!
  const detail = row.querySelector<HTMLDetailsElement>('details')!
  expect(detail.open).toBe(false); expect(row.querySelector('.log-turn__body')).toBeNull()
  expect(detail.querySelector('.message-disclosure__preview')?.textContent).toContain('Second paragraph.')
  expect(row.textContent).toContain(status === 'failed' ? '提交失败' : '提交未确认')
  expect(row.textContent).not.toContain('提交已记录'); expect(row.textContent).not.toContain('已采用'); expect(row.textContent).not.toContain('已进入对话')
  expect(row.querySelector('[data-icon-animation]')).toBeNull()
  await openDetails(detail); expect(paragraphs(row.querySelector('.log-turn__body')!)).toBe(original)
})

it('preserves full original recovery for a real native read failure while an unread exact target stays compact', async () => {
  await render(<ConversationView sessionId={sid} page={page()} expandSubmissions timeline={snapshot([submission('retained-failure', false)])} />)
  expect(host.querySelector<HTMLDetailsElement>('[data-submission-id] details')!.open).toBe(true)
  expect(paragraphs(host.querySelector('[data-submission-id] .log-turn__body')!)).toBe(original)
  const unread = submission('unread-input'); unread.conversation = { sameEvent: { ...ref, source: { ...ref.source, recordId: 'unread-target' } } }
  await render(<ConversationView sessionId={sid} page={page()} timeline={snapshot([unread])} />)
  expect(host.querySelector<HTMLDetailsElement>('[data-submission-id] details')!.open).toBe(false)
  expect(host.querySelector('[data-conversation-gap="CONVERSATION_ANCHOR_UNREAD"]')).not.toBeNull()
})

it('keeps the selected original DOM and opened choice until a later exact relation can be applied', async () => {
  const draw = (exact: boolean) => <ConversationView sessionId={sid} executionHostId="selected-route" page={page()} timeline={snapshot([submission('late-input', exact)])} />
  await render(draw(false))
  const row = host.querySelector<HTMLElement>('[data-submission-id]')!, disclosure = row.querySelector<HTMLDetailsElement>('details')!
  await openDetails(disclosure)
  const body = row.querySelector('.log-turn__body')!, text = body.querySelector('p')!.firstChild!, range = document.createRange()
  range.setStart(text, 0); range.setEnd(text, 8); getSelection()!.addRange(range)
  await render(draw(true))
  expect(host.querySelector('[data-submission-id] .log-turn__body')).toBe(body); expect(getSelection()!.toString()).toBe('Original')
  expect(disclosure.open).toBe(true)
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  expect(host.querySelector('[data-submission-id]')).toBeNull()
  const contribution = host.querySelector<HTMLDetailsElement>('[data-original-contribution]')!
  expect(contribution.open).toBe(true); expect(paragraphs(contribution.querySelector('.log-turn__body')!)).toBe(original)
  expect(contribution.querySelector('[aria-label="Copy message"]')).not.toBeNull()
  expect(host.querySelector('.conversation-submissions')).not.toBeNull()
})

it('a located send record opens its original body without another read and retains it after collapse', async () => {
  const located = conversationMessageSourceKey(sid, { kind: 'captured', recordId: 'located-input' })
  await render(<ConversationView sessionId={sid} page={page()} timeline={snapshot([submission('located-input', false)])} locatedMessageKey={located ?? null} />)
  const row = host.querySelector<HTMLElement>('[data-submission-id]')!, detail = row.querySelector<HTMLDetailsElement>('details')!
  expect(detail.open).toBe(true); expect(row.dataset.messageSourceKey).toBe(located)
  const body = row.querySelector('.log-turn__body')!
  await render(<ConversationView sessionId={sid} page={page()} timeline={snapshot([submission('located-input', false)])} />)
  await act(async () => { detail.open = false; detail.dispatchEvent(new Event('toggle')) })
  expect(row.querySelector('.log-turn__body')).toBe(body); expect(row.querySelector('[hidden]')).not.toBeNull()
})

it('an accurately located submission keeps its original reader open at its captured identity after native adoption', async () => {
  const id = 'located-native-input', located = conversationMessageSourceKey(sid, { kind: 'captured', recordId: id })
  await render(<ConversationView sessionId={sid} executionHostId="selected-route" page={page()} timeline={snapshot([submission(id)])} locatedMessageKey={located ?? null} />)
  expect(host.querySelector('[data-submission-id]')).toBeNull()
  const originalRecord = host.querySelector<HTMLDetailsElement>('[data-original-contribution]')!
  expect(originalRecord.open).toBe(true); expect(originalRecord.dataset.messageSourceKey).toBe(located)
  expect(paragraphs(originalRecord.querySelector('.log-turn__body')!)).toBe(original)
  expect(originalRecord.querySelector('[aria-label="Copy message"]')).not.toBeNull()
  expect(host.querySelector<HTMLDetailsElement>('[data-submission-record] details')!.open).toBe(false)
})

it('retains a located native contribution owner and its Range after the locator leaves, including an explicit close', async () => {
  const id = 'retained-located-original', located = conversationMessageSourceKey(sid, { kind: 'captured', recordId: id })
  const t = snapshot([submission(id)]), nativePage = page()
  const draw = (locatedMessageKey: string | null) => <ConversationView sessionId={sid} executionHostId="selected-route" page={nativePage} timeline={t} locatedMessageKey={locatedMessageKey} />
  await render(draw(located ?? null))
  const owner = host.querySelector<HTMLDetailsElement>('[data-original-contribution]')!, body = owner.querySelector('.log-turn__body')!
  expect(owner.open).toBe(true); expect(owner.dataset.messageSourceKey).toBe(located)
  const text = body.querySelector('p')!.firstChild!, range = document.createRange()
  range.setStart(text, 0); range.setEnd(text, 8); getSelection()!.addRange(range)
  await act(async () => owner.focus())
  await render(draw(null))
  expect(host.querySelector('[data-original-contribution]')).toBe(owner)
  expect(owner.querySelector('.log-turn__body')).toBe(body); expect(owner.open).toBe(true)
  expect(getSelection()!.getRangeAt(0)).toBe(range); expect(range.toString()).toBe('Original'); expect(document.activeElement).toBe(owner)
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); owner.open = false; owner.dispatchEvent(new Event('toggle')) })
  await render(draw(null))
  expect(host.querySelector('[data-original-contribution]')).toBe(owner); expect(owner.open).toBe(false)
  expect(owner.querySelector('.log-turn__body')).toBe(body); expect(document.activeElement).toBe(owner)
  expect(host.querySelector<HTMLDetailsElement>('[data-submission-record] details')!.open).toBe(false)
})

it.each(['independent', 'native'] as const)('only opening the %s original submission reads its attachment and full Copy keeps that original reference', async kind => {
  const path = fixturePath('home/.agentmux/pasted/attachment.png'), content = `Original attached input\n\n@${path}`
  const input = { ...submission('resource-input', kind === 'native'), content }
  const read = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+3fVbWQAAAABJRU5ErkJggg==' })), copy = vi.spyOn(platform, 'copyText')
  await render(<ConversationView sessionId={sid} page={page()} timeline={snapshot([input])} readPastedImage={read} />)
  expect(read).not.toHaveBeenCalled()
  const row = host.querySelector<HTMLElement>(kind === 'native' ? '[data-submission-record]' : '[data-submission-id]')!
  await openDetails(row.querySelector<HTMLDetailsElement>('details')!)
  expect(read).toHaveBeenCalledExactlyOnceWith(path); expect(row.querySelector('img')).not.toBeNull()
  await act(async () => row.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(copy.mock.calls.at(-1)?.[0]).toBe(content)
})
it.each(['independent', 'native'] as const)('opening the %s send disclosure exposes a long original directly without another body fold', async kind => {
  const content = 'Original long input.\n\n' + '完整原文保持可读。'.repeat(180) + '\n\nOriginal long input ending.'
  expect(content.length).toBeGreaterThan(1200)
  const input = { ...submission('long-original-input', kind === 'native'), content }, copy = vi.spyOn(platform, 'copyText')
  await render(<ConversationView sessionId={sid} page={page()} timeline={snapshot([input])} />)
  const entry = host.querySelector<HTMLElement>(kind === 'native' ? '[data-submission-record]' : '[data-submission-id]')!, detail = entry.querySelector<HTMLDetailsElement>('details')!
  expect(detail.open).toBe(false); expect(entry.querySelector('.log-turn__body')).toBeNull()
  expect(entry.querySelector('.message-disclosure__preview')?.textContent).not.toContain('Original long input ending.')
  await openDetails(detail)
  const body = entry.querySelector<HTMLElement>('.log-turn__body')!
  expect(paragraphs(body)).toBe(content); expect(body.closest('details:not([open]), [hidden], [inert]')).toBeNull()
  expect(entry.querySelector('.log-turn .message-disclosure')).toBeNull()
  await act(async () => entry.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(copy.mock.calls.at(-1)?.[0]).toBe(content)
})
it.each(['missing', 'empty'])('retains the sole captured body and accurate unknown when native is %s', async kind => {
  await render(<ConversationView sessionId={sid} {...(kind === 'empty' ? { page: page(false) } : {})} timeline={snapshot([submission()])} />)
  const row = host.querySelector<HTMLElement>('[data-submission-id]')!, detail = row.querySelector<HTMLDetailsElement>('details')!
  expect(detail.open).toBe(false); expect(row.querySelector('.log-turn__body')).toBeNull()
  expect(detail.querySelector('.message-disclosure__preview')?.textContent).toContain('Original input stays complete.')
  await openDetails(detail)
  expect(paragraphs(host.querySelector('.log-turn__body')!)).toBe(original)
  expect(host.querySelector('.conversation-submissions')).toBeNull()
  expect(host.querySelector('[data-conversation-gap="CONVERSATION_ANCHOR_UNREAD"]')).not.toBeNull()
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
  expect(host.querySelector('.log-turn__sender-kind')).toBeNull()
  expect(host.querySelectorAll('[data-conversation-source-role="reply-observation"]')).toHaveLength(1)
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
