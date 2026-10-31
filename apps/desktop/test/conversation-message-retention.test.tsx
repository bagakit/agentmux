// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { StaticConversationView, StaticActivityView } from './helpers/conversation-static-fixture'
import type { AgentTimelineItem, AgentSessionHistoryPage } from '@agentmux/core'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'

const sid = 'message-retention-session', source = { providerId: 'codex', nativeSessionId: 'original-native-source' }
const original = '**Original readable input.**\n\nThe complete second paragraph remains available.'
const nativeRef = { hostId: 'original-host', agentSessionId: sid, source: { kind: 'native' as const, ...source, recordId: 'original-native-input' } }
const captured = (linked = false): AgentTimelineItem => ({ id: 'original-input', agentSessionId: sid, kind: 'user_message', source: 'user',
  title: 'Original input', content: original, authorHuman: true, publicContent: 'confirmed', status: 'complete',
  createdAt: fixtureEpoch(0, 0, 2), updatedAt: fixtureEpoch(0, 0, 2), sourceChannel: 'message-tool',
  inputRef: { kind: 'prompt', agentSessionId: sid, expectedRun: { runId: 'original-run' }, submissionId: 'original-input' },
  inputSubmission: { status: 'terminal-confirmed', observation: 'closed' }, ...(linked ? { conversation: { sameEvent: nativeRef } } : {}) })
const page = (kind: 'readable' | 'empty' | 'unread'): AgentSessionHistoryPage => ({ agentSessionId: sid, sourceHostId: nativeRef.hostId,
  source, items: kind === 'unread' ? [] : [{ id: nativeRef.source.recordId, kind: 'user-message', startedAt: fixtureEpoch(0, 0, 3),
    contentParts: kind === 'empty' ? [] : [{ kind: 'text', text: original }] }], nextCursor: null })
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
let host: HTMLDivElement, root: Root
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); getSelection()?.removeAllRanges(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function render(surface: 'shared' | 'desktop', native: 'readable' | 'empty' | 'unread' = 'unread', linked = false, active = true) {
  const item = captured(linked), timeline = { agentSessionId: sid, sourceHostId: nativeRef.hostId, revision: 1, items: [item] }
  await act(async () => root.render(<ClientUiProvider platform={platform}>{surface === 'shared'
    ? <StaticConversationView sessionId={sid} page={page(native)} timeline={timeline} active={active} />
    : <StaticActivityView sessionId={sid} items={timeline.items} timelineSnapshot={timeline} nativeHistoryPage={page(native)} capability="complete-events" conversationReading={{ reference: { hostId: nativeRef.hostId, agentSessionId: sid }, identity: sid, enabled: active }} />}</ClientUiProvider>))
}
it.each(['shared', 'desktop'] as const)('keeps the original readable input as a primary card after returning to %s', async surface => {
  await render(surface)
  expect(host.querySelector('.log-turn__body')?.textContent, 'A readable input must remain a message card, not a send-event preview').toContain('The complete second paragraph')
  expect(host.textContent).toContain('Agent 接收未确认')
  expect(host.querySelector('[data-submission-id] > .message-disclosure')).toBeNull()
  await render(surface, 'unread', false, false)
  await act(async () => root.unmount()); root = createRoot(host)
  await render(surface)
  expect(host.querySelector('.log-turn__body')?.textContent).toContain('The complete second paragraph')
  expect(host.querySelector('[aria-label="Copy message"]')).not.toBeNull()
})
it.each(['shared', 'desktop'] as const)('reads a confirmed original contribution as one primary card when the native body is empty in %s', async surface => {
  await render(surface, 'empty', true)
  expect(host.querySelectorAll('.log-turn__body')).toHaveLength(1)
  expect(host.querySelector('.log-turn__body')?.textContent).toContain('Original readable input')
  expect(host.querySelectorAll('.log-turn')).toHaveLength(1)
})

it.each(['resource', 'answers'] as const)('keeps a native %s-only reading face instead of replacing it with captured prose', async kind => {
  const native = page('empty'), item = native.items[0]!
  native.items = [{ ...item, ...(kind === 'resource'
    ? { contentParts: [{ kind: 'resource' as const, resourceType: 'text' as const, reference: 'native-original-resource', label: 'Native original resource' }] }
    : { questionAnswers: [{ questionId: 'original-question', answer: 'Native structured answer' }] }) }]
  const timeline = { agentSessionId: sid, sourceHostId: nativeRef.hostId, revision: 1, items: [captured(true)] }
  await act(async () => root.render(<ClientUiProvider platform={platform}><StaticConversationView sessionId={sid} page={native} timeline={timeline} /></ClientUiProvider>))
  expect(host.querySelector('[data-native-record-id="original-native-input"]')).not.toBeNull()
  const card = host.querySelector<HTMLElement>('.log-turn[data-message-source-key]')!
  expect(card.dataset.messageSourceKey).toContain('native')
  expect(card.querySelector('.log-turn__body')?.textContent).not.toContain('The complete second paragraph')
  if (kind === 'answers') expect(card.textContent).toContain('Native structured answer')
})
const contributions = () => [...host.querySelectorAll<HTMLElement>('[data-submission-record]')]
const inputPair = () => {
  const first = captured(true), second: AgentTimelineItem = { ...captured(true), id: 'second-input', content: 'Second complete contribution',
    inputRef: { ...captured().inputRef!, submissionId: 'second-input' }, inputSubmission: { status: 'unknown', observation: 'closed' } }
  return [first, second]
}
async function renderContributions(native: 'readable' | 'empty', detailsOnlyMetadata: boolean, locatedMessageKey?: string) {
  const timeline = { agentSessionId: sid, sourceHostId: nativeRef.hostId, revision: 1, items: inputPair() }
  await act(async () => root.render(<ClientUiProvider platform={platform}><StaticConversationView sessionId={sid} page={page(native)} timeline={timeline}
    detailsOnlyMetadata={detailsOnlyMetadata} sourceLabelsInDetails={detailsOnlyMetadata} showInputSource={!detailsOnlyMetadata}
    {...(locatedMessageKey ? { locatedMessageKey } : {})} /></ClientUiProvider>))
}
async function copyExactContribution(contribution: HTMLElement) {
  const body = contribution.querySelector('.log-turn__body')
  expect(body, 'Every associated input contribution must retain its independently readable original').not.toBeNull()
  const sourceKey = JSON.parse(contribution.dataset.messageSourceKey!) as string[]
  expect(sourceKey.slice(0, 2)).toEqual([sid, 'captured'])
  const expected = new Map(inputPair().map(input => [input.id, input])).get(sourceKey[2]!)
  expect(expected, 'The expanded original must name one exact confirmed contribution').toBeDefined()
  if (expected!.id === 'second-input') expect(body!.textContent).toBe(expected!.content)
  else expect(body!.textContent).toContain('The complete second paragraph remains available.')
  await act(async () => contribution.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(vi.mocked(platform.copyText).mock.calls.at(-1)?.[0]).toBe(expected!.content)
}
it.each([['empty', false], ['empty', true], ['readable', true]] as const)(
  'keeps all exact input contributions independently readable and copied with native=%s and detailsOnlyMetadata=%s', async (native, detailsOnlyMetadata) => {
  vi.spyOn(platform, 'copyText')
  await renderContributions(native, detailsOnlyMetadata)
  expect(host.querySelectorAll('.log-turn__body')).toHaveLength(1)
  const entries = contributions()
  expect(entries).toHaveLength(native === 'empty' ? 1 : 2)
  const main = host.querySelector<HTMLElement>('.log-turn')!, primary = main.dataset.messageSourceKey
  for (const contribution of entries) {
    expect(contribution.closest('.conversation-input-details__body'), 'Original-input controls must remain reachable without Info').toBeNull()
    expect(contribution.dataset.nativeReadable).toBe(String(native === 'readable'))
    const detail = contribution.querySelector<HTMLDetailsElement>('details')!
    await act(async () => { detail.open = true; detail.dispatchEvent(new Event('toggle')) })
    await copyExactContribution(contribution)
    expect(main.dataset.messageSourceKey).toBe(primary)
  }
  if (native === 'empty') expect(host.querySelector('[data-original-contribution]')).not.toBeNull()
})
it.each(['empty', 'readable'] as const)('locates only the exact original and preserves its explicit choice with native=%s in compact metadata mode', async native => {
  vi.spyOn(platform, 'copyText')
  await renderContributions(native, true, JSON.stringify([sid, 'captured', 'unrelated-source']))
  expect(contributions().length).toBeGreaterThan(0)
  expect(host.querySelector('[data-submission-record] details[open]')).toBeNull()
  const target = contributions()[0]!.dataset.messageSourceKey!
  await renderContributions(native, true, target)
  const contribution = contributions().find(entry => entry.dataset.messageSourceKey === target)!
  expect(contribution.querySelector<HTMLDetailsElement>('details')!.open).toBe(true)
  await copyExactContribution(contribution)
  await renderContributions(native, true)
  expect(contributions().find(entry => entry.dataset.messageSourceKey === target)).toBe(contribution)
  const detail = contribution.querySelector<HTMLDetailsElement>('details')!
  expect(detail.open).toBe(true)
  await act(async () => { detail.open = false; detail.dispatchEvent(new Event('toggle')) })
  await renderContributions(native, true)
  expect(detail.open).toBe(false)
})

it.each([false, true])('keeps original input uncertainty visible outside Info with detailsOnlyMetadata=%s', async detailsOnlyMetadata => {
  const timeline = { agentSessionId: sid, sourceHostId: nativeRef.hostId, revision: 1, items: [captured()] }
  await act(async () => root.render(<ClientUiProvider platform={platform}><StaticConversationView sessionId={sid}
    page={page('unread')} timeline={timeline} detailsOnlyMetadata={detailsOnlyMetadata} sourceLabelsInDetails={detailsOnlyMetadata} /></ClientUiProvider>))
  const card = host.querySelector<HTMLElement>('.log-turn')!
  expect(card.querySelector(':scope > .log-turn__meta .conversation-submission-summary')?.textContent).toContain('Agent 接收未确认')
  expect(card.querySelector('.log-turn__body')?.textContent).toContain('The complete second paragraph')
})
