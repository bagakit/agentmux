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
afterEach(async () => { getSelection()?.removeAllRanges(); for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const flush = (assertion: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }); assertion() }, { timeout: 8000 })

it('the actual Reader through IPC renders an unassociated A2A send row and a distinct exact native-primary event', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const body = 'Original addressed input with complete second paragraph.\n\nOriginal ending.'
  const f = await nativeHistoryFixture('claude', jsonl([
    { type: 'user', uuid: 'unassociated-native', sessionId: 'native-main', message: { role: 'user', content: body } },
    { type: 'user', uuid: 'exact-native', sessionId: 'native-main', message: { role: 'user', content: 'Exact related original body' } }
  ])); closes.push(f.close)
  const native = { hostId: 'local', agentSessionId: f.session.agentSessionId, source: { kind: 'native' as const, providerId: 'claude', nativeSessionId: 'native-main', recordId: 'exact-native' } }
  // These are explicit source facts of this private fixture. The UI neither
  // submits the input nor infers the relation from the equal text beside it.
  for (const [id, content, exact] of [['original-message', body, false], ['exact-message', 'Exact related original body', true]] as const) {
    await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: {
      id, agentSessionId: f.session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete', title: 'Original submission',
      createdAt: fixtureEpoch(0, 0, 2), updatedAt: fixtureEpoch(0, 0, 2), content, publicContent: 'confirmed', sourceChannel: 'message-tool', authorAgentSessionId: 'original-sender',
      inputRef: { kind: 'message', agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, messageId: id },
      ...(exact ? { conversation: { sameEvent: native } } : {})
    } })
  }
  await desktopConversationReadBridge(f, closes)
  const rawNative = vi.spyOn(api.sessions, 'historyPage'), rawCaptured = vi.spyOn(api.sessions, 'timeline')
  const read = vi.spyOn(f.client, 'readAgentConversation'), copied = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control: { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }, workspaceRoot: f.root })} />))
  await flush(() => expect(host.querySelectorAll('[data-native-record-id]')).toHaveLength(2))
  const row = host.querySelector<HTMLElement>('[data-submission-id="original-message"]')!
  expect(row, host.textContent).not.toBeNull(); expect(row.querySelector<HTMLDetailsElement>('details')!.open).toBe(false)
  expect(row.textContent).toContain('original-sender'); expect(row.textContent).toContain('提交已记录'); expect(row.querySelector('.log-turn')).toBeNull()
  const nativeCard = host.querySelector('[data-native-record-id="exact-native"]')!
  expect(nativeCard.querySelector('[data-submission-record]')).not.toBeNull()
  expect(host.querySelector('[data-submission-id="exact-message"]')).toBeNull()
  const originalRef = row.dataset.conversationItemRef, originalId = row.dataset.conversationEventId
  await act(async () => { const detail = row.querySelector<HTMLDetailsElement>('details')!; detail.open = true; detail.dispatchEvent(new Event('toggle')) })
  expect(row.querySelector('.log-turn__body')?.textContent).toContain('Original ending.')
  await act(async () => row.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(copied).toHaveBeenLastCalledWith(body)
  expect(row.dataset.conversationItemRef).toBe(originalRef); expect(row.dataset.conversationEventId).toBe(originalId)
  expect(read).toHaveBeenCalled(); expect(rawNative).not.toHaveBeenCalled(); expect(rawCaptured).not.toHaveBeenCalled()
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
