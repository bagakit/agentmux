// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { StaticConversationView as ConversationView } from './helpers/conversation-static-fixture'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { StaticActivityView as ActivityView } from './helpers/conversation-static-fixture'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

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
  const body = host.querySelector('.log-turn__body')!, metadata = host.querySelector('.conversation-submissions')!
  expect(paragraphs(body)).toBe(original); expect(metadata).not.toBeNull()
  expect(body.compareDocumentPosition(metadata) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  const entries = metadata.querySelectorAll<HTMLDetailsElement>('[data-submission-record]'); expect(entries).toHaveLength(2)
  expect(entries[0]!.textContent).toContain('提交于'); expect(entries[0]!.textContent).toContain('Original device')
  expect(entries[1]!.dataset.status).toBe('failed'); expect(entries[1]!.textContent).toContain('提交失败')
  await openDetails(entries[0]!); expect(entries[0]!.textContent).toContain('original-input'); expect(entries[0]!.textContent).toContain('source-owner')
  expect(entries[0]!.textContent).toContain('不是原生接纳或执行完成时间')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click()); expect(copy.mock.calls.at(-1)?.[0]).toBe(original)
  const contributors = host.querySelectorAll<HTMLDetailsElement>('[data-original-contribution]'); expect(contributors).toHaveLength(2)
  await openDetails(contributors[1]!); expect(paragraphs(contributors[1]!.querySelector('.log-turn__body')!)).toBe(original)
  expect(host.querySelector('[data-submission-record]')).toBe(entries[0])
})
it('does not turn a streaming submission record into confirmed adoption or success', async () => {
  await render(<ConversationView sessionId={sid} page={page()} timeline={snapshot([submission('unconfirmed-submit', true, 'streaming')])} />)
  const metadata = host.querySelector('[data-submission-record]')!
  expect(metadata.textContent).toContain('提交未确认')
  expect(metadata.textContent).not.toContain('提交已记录')
  expect(metadata.textContent).not.toContain('已采用')
  expect(metadata.getAttribute('data-status')).toBe('streaming')
})
it('equal unconfirmed originals remain two complete inputs with no submission association', async () => {
  await render(<ConversationView sessionId={sid} page={page()} timeline={snapshot([submission('same-text', false)])} />)
  expect(host.querySelectorAll('[data-conversation-event-id]')).toHaveLength(2)
  expect([...host.querySelectorAll('.log-turn__body')].map(paragraphs)).toEqual([original, original])
  expect(host.querySelector('.conversation-submissions')).toBeNull()
})
it.each(['missing', 'empty'])('retains the sole captured body and accurate unknown when native is %s', async kind => {
  await render(<ConversationView sessionId={sid} {...(kind === 'empty' ? { page: page(false) } : {})} timeline={snapshot([submission()])} />)
  expect(paragraphs(host.querySelector('.log-turn__body')!)).toBe(original)
  expect(host.querySelector('.conversation-submissions')).toBeNull()
  expect(host.querySelector('[data-conversation-gap="CONVERSATION_ANCHOR_UNREAD"]')).not.toBeNull()
})
it('renders observations as ordinary provenance and keeps expanded body Range through a compact update', async () => {
  const item: AgentTimelineItem = { ...submission('reply', false), source: 'native-hook', kind: 'assistant_message', eventName: 'Stop' }
  const read = (p: AgentSessionHistoryPage) => <ConversationView sessionId={sid} page={p} timeline={snapshot([item])} />
  await render(read(page(false))); await act(async()=>host.querySelector<HTMLButtonElement>('[data-captured-reply-observation] [aria-expanded]')!.click()); const body = host.querySelector('.log-turn__body')!, text = body.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8); getSelection()!.addRange(range)
  await render(read(page()))
  expect(host.querySelector('[data-captured-reply-observation] .log-turn__body')).toBe(body); expect(getSelection()!.toString()).toBe('Original')
  expect(host.querySelector('[data-captured-reply-observation] .wf-tool-row')).toBeNull()
  expect(host.querySelector('.log-turn__sender-kind')).toBeNull()
  expect(host.querySelectorAll('[data-conversation-source-role="reply-observation"]')).toHaveLength(1)
  expect(host.querySelector('.conversation-reply-observation__notice')).toBeNull()
  expect(host.querySelector('[data-conversation-source-role]')!.getAttribute('title')).toContain('由 Hook 采集')
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
