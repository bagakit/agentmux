// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { StaticConversationView as ConversationView } from './helpers/conversation-static-fixture'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const sid = 'collected-reply-session', source = { providerId: 'codex', nativeSessionId: 'collected-native' }
const ref = { hostId: 'local', agentSessionId: sid, source: { kind: 'native' as const, ...source, recordId: 'original' } }
const page = (read: boolean): AgentSessionHistoryPage => ({ agentSessionId: sid, sourceHostId: 'local', source,
  items: read ? [{ id: 'original', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original native reply' }] }] : [], nextCursor: null })
const hook = (conversation?: AgentTimelineItem['conversation']): AgentTimelineItem => ({ id: 'hook', agentSessionId: sid, kind: 'assistant_message', source: 'native-hook', status: 'complete', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1), title: 'Observed original', eventName: 'Stop', content: 'Complete Hook reply', ...(conversation ? { conversation } : {}) })
let root: Root, host: HTMLDivElement
const copyText = vi.fn<ClientUiPlatform['copyText']>(async () => true)
const platform: ClientUiPlatform = { copyText, overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); copyText.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
async function render(item: AgentTimelineItem, read: boolean, nativeSource = true) {
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationView sessionId={sid} executionHostId="remote-route" page={nativeSource ? page(read) : null} timeline={{ agentSessionId: sid, sourceHostId: 'local', revision: 1, items: [item] }} /></ClientUiProvider>))
  const expand = host.querySelector<HTMLButtonElement>('[data-captured-reply-observation] button[aria-expanded="false"]')
  if (expand) await act(async () => expand.click())
}
it('explains an independent Hook collection in ordinary language and preserves its complete Copy', async () => {
  await render(hook(), true)
  const row = host.querySelector('[data-captured-reply-observation]')!
  expect(row.textContent).toContain('回复快照')
  expect(row.querySelector('.log-turn__who')?.textContent).toBe('作者未记录')
  expect(row.querySelector('.log-turn')?.getAttribute('data-conversation-author')).toBe('{"kind":"unknown"}')
  const provenance = row.querySelector('[data-conversation-source="native-hook"]')!
  expect(provenance.textContent).toBe('CLI 事件回报')
  expect(provenance.getAttribute('title')).toContain('原事件：Stop')
  expect(row.textContent).not.toContain('跨来源关联未确认')
  await act(async () => row.querySelector<HTMLButtonElement>('[aria-label="Message details"]')!.click())
  const details = row.querySelector('.conversation-input-details__body')!
  expect(details.textContent).toContain('原事件未记录回复作者')
  expect(details.textContent).toContain('具体回调及安装方式须查原始回执')
  expect(details.textContent).toContain('Stop')
  expect(row.querySelector('[data-conversation-source-role]')?.getAttribute('title')).toContain('事件回报附带的回复文本快照；不单独代表一次新发言。')
  expect(row.querySelector('.log-row__title, .conversation-reply-observation__notice')).toBeNull()
  expect(row.textContent).not.toContain('回复观察')
  await act(async () => row.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(copyText).toHaveBeenCalledTimes(1)
  expect(copyText.mock.calls[0]?.[0]).toBe('Complete Hook reply')
  expect(host.querySelectorAll('[data-conversation-event-id]')).toHaveLength(2)
})
it.each([true, false])('uses only Core recorded target coverage when the observed native target is read=%s', async read => {
  await render(hook({ observes: ref }), read)
  const notice = host.querySelector('[data-conversation-source-role]')!.getAttribute('title')!
  expect(notice).toContain('事件回报附带的回复文本快照；不单独代表一次新发言。')
  if (read) {
    expect(notice).not.toContain('尚未读到')
    expect(notice).not.toContain('尚未确认')
    expect(host.textContent).not.toContain('跨来源关联未确认')
  } else expect(notice).toContain('对应的原始记录尚未读到。')
  expect(host.textContent).toContain('Complete Hook reply')
})
it('a sole directly readable Hook collection does not invent an unconfirmed native counterpart', async () => {
  await render(hook(), false, false)
  expect(host.querySelector('[data-conversation-source-role]')?.getAttribute('title')).toBe('事件回报附带的回复文本快照；不单独代表一次新发言。')
  expect(host.textContent).toContain('Complete Hook reply')
})

it('preserves explicit Agent authors without promoting an unrecorded snapshot author', async () => {
  await render({ ...hook(), authorAgentSessionId: 'recorded-agent' }, true)
  expect(host.querySelector('[data-captured-reply-observation]')).toBeNull()
  const known = [...host.querySelectorAll<HTMLElement>('[data-conversation-author]')].find(row => row.dataset.conversationAuthor === '{"kind":"agent","agentSessionId":"recorded-agent"}')!
  expect(known).not.toBeUndefined()
  expect(known.getAttribute('data-speaker-role')).toBe('agent')
  expect(known.textContent).toContain('recorded-agent')
  expect(known.textContent).not.toContain('作者未记录')
})

it('keeps the original Core cycle diagnostic at its source scope with all bodies', async () => {
  const original = page(true).items[0]!
  const cycleRef = (recordId: string) => ({ ...ref, source: { ...ref.source, recordId } })
  const cyclic: AgentSessionHistoryPage = { ...page(true), items: [
    { ...original, id: 'cycle-a', conversation: { sameEvent: cycleRef('cycle-b') } },
    { ...original, id: 'cycle-b', contentParts: [{ kind: 'text', text: 'Other complete native original' }], conversation: { sameEvent: cycleRef('cycle-a') } }
  ] }
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationView sessionId={sid} executionHostId="remote-route" page={cyclic} timeline={{ agentSessionId: sid, sourceHostId: 'local', revision: 1, items: [hook()] }} /></ClientUiProvider>))
  expect(host.querySelector('[data-conversation-gap="CONVERSATION_RELATION_CYCLE"]')).not.toBeNull()
  expect(host.textContent).toContain('Original native reply')
  expect(host.textContent).toContain('Other complete native original')
  expect(host.textContent).not.toContain('跨来源关联未确认')
})
