// @vitest-environment happy-dom
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { createClientUiRoot } from './helpers/client-ui-render'
import { activityReadingProps } from './helpers/activity-reading-props'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { api } from '../src/renderer/src/lib/api'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const flush = (assertion: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }); assertion() }, { timeout: 8000 })

it('the original Reader and public IPC retain facts while the real Activity explains snapshot provenance', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const f = await nativeHistoryFixture('claude', jsonl([
    { type: 'assistant', uuid: 'native-original', sessionId: 'native-main', message: { role: 'assistant', content: [{ type: 'text', text: 'Original native response' }] } }
  ])); closes.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId, source: { kind: 'native' as const, providerId: 'claude', nativeSessionId: 'native-main', recordId: 'native-original' } }
  for (const [id, content, relation] of [
    ['unassociated-snapshot', 'Complete independent event reply.\n\nOriginal ending.', undefined],
    ['related-snapshot', 'Original captured contribution', { sameEvent: ref }]
  ] as const) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: {
    id, agentSessionId: f.session.agentSessionId, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Original event reply',
    createdAt: fixtureEpoch(0, 0, 2), updatedAt: fixtureEpoch(0, 0, 2), eventName: 'Stop', content, ...(relation ? { conversation: relation } : {})
  } })
  await desktopConversationReadBridge(f, closes)
  const rawNative = vi.spyOn(api.sessions, 'historyPage'), rawCaptured = vi.spyOn(api.sessions, 'timeline')
  const read = vi.spyOn(f.client, 'readAgentConversation'), copied = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control: { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }, workspaceRoot: f.root })} />))
  await flush(() => expect(host.querySelector('[data-captured-reply-observation="unassociated-snapshot"]')).not.toBeNull())
  const snapshot = host.querySelector<HTMLElement>('[data-captured-reply-observation="unassociated-snapshot"]')!
  const expand = snapshot.querySelector<HTMLButtonElement>('button[aria-expanded="false"]'); if (expand) await act(async () => expand.click())
  expect(snapshot.querySelector('.log-turn__who')?.textContent).toBe('作者未记录')
  expect(snapshot.querySelector('.log-turn')?.getAttribute('data-conversation-author')).toBe('{"kind":"unknown"}')
  expect(snapshot.textContent).toContain('回复快照'); expect(snapshot.textContent).toContain('CLI 事件回报')
  expect(snapshot.querySelector('[data-conversation-source="native-hook"]')?.getAttribute('title')).toContain('原事件：Stop')
  expect(host.textContent).not.toContain('跨来源关联未确认')
  await act(async () => snapshot.querySelector<HTMLButtonElement>('[aria-label="Message details"]')!.click())
  expect(snapshot.querySelector('.conversation-input-details__body')?.textContent).toContain('原事件未记录回复作者')
  await act(async () => snapshot.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(copied).toHaveBeenLastCalledWith('Complete independent event reply.\n\nOriginal ending.')
  const native = host.querySelector<HTMLElement>('[data-native-record-id="native-original"]')!
  expect(native).not.toBeNull(); expect(native.querySelector('[data-conversation-source="native"]')).not.toBeNull()
  expect(native.querySelector('[data-conversation-source="native-hook"]')).not.toBeNull()
  expect(native.querySelector('[data-conversation-author]')?.getAttribute('data-conversation-author')).toBe(JSON.stringify({ kind: 'agent', agentSessionId: f.session.agentSessionId }))
  expect(native.querySelector('.log-turn__who')?.textContent).not.toBe('作者未记录')
  expect(read).toHaveBeenCalled(); expect(rawNative).not.toHaveBeenCalled(); expect(rawCaptured).not.toHaveBeenCalled()
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
