import { fixtureEpoch as _followupFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { useSessionConversationWindow, type ConversationReadingIntent } from '../src/renderer/src/lib/session-conversation-window'
import { api } from '../src/renderer/src/lib/api'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of closes.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (failures.length) throw new AggregateError(failures, 'Private admission intent cleanup failed')
})
const pause = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const wait = (assertion: () => void) => vi.waitFor(async () => { await pause(); assertion() }, { timeout: 7000, interval: 20 })

/** Actual FileStore/Core/public RPC/IPC/Renderer Reader; only the native page,
 * admission hold and one explicit Current transport failure are controlled. */
async function fixture(expected: 'earlier' | 'coverage') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const reference = { hostId: 'local', agentSessionId: 'original-admission-intent' }
  const source = { providerId: 'claude', nativeSessionId: 'original-native' }
  const f = await conversationPagePortFixture(reference, source, async (_id, input = {}) => ({
    agentSessionId: reference.agentSessionId, source, nextCursor: input.cursor ? null : 'original-older-page',
    items: [{ id: input.cursor ? 'older-original' : 'current-original', kind: 'assistant-message',
      contentParts: [{ kind: 'text', text: input.cursor ? 'Older original body' : 'Current original body' }], startedAt: _followupFixtureEpoch(0, 0, 1) }]
  } satisfies AgentSessionHistoryPage))
  closes.push(f.close)
  const session = await f.store.readMetadata(reference.agentSessionId)
  const host = document.createElement('div'); document.body.append(host)
  const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  const calls: Array<{ intent: ConversationReadingIntent; ids: string[] }> = []
  let view!: ReturnType<typeof useSessionConversationWindow>, hold = true
  const reading = { reference, identity: 'original-reading-owner', enabled: true }
  function Consumer() {
    view = useSessionConversationWindow(reading, (page, intent) => {
      calls.push({ intent, ids: page.items.map(item => item.id) })
      return !(hold && intent === expected)
    }, expected === 'coverage' ? Infinity : 0)
    return <p>{view.page?.items.map(item => item.id).join(',')}</p>
  }
  await act(async () => root.render(<Consumer />))
  await wait(() => { expect(view.page?.items.map(item => item.id)).toEqual(['current-original']); expect(view.loading).toBe(false) })
  if (expected === 'earlier') await act(async () => view.readEarlier())
  await wait(() => { expect(view.held).toBe(true); expect(view.loading).toBe(false) })
  const pending = view.inspect().pending!
  expect(pending, 'The real older frame must complete before testing admission intent').toBeTruthy()
  expect(calls.at(-1)).toEqual({ intent: expected, ids: ['older-original', 'current-original'] })
  expect(view.page?.items.map(item => item.id), 'Held body remains the original displayed frame').toEqual(['current-original'])
  vi.spyOn(api.conversation, 'readAgentConversation').mockRejectedValueOnce(Object.assign(new Error('The explicit Current transport was interrupted'), { code: 'CONTROL_UNAVAILABLE' }))
  await act(async () => view.showCurrent())
  await wait(() => { expect(view.loading).toBe(false); expect(view.error).toContain('explicit Current transport') })
  expect(view.inspect().pending, 'A failed fresh request cannot rewrite the completed pending frame').toBe(pending)
  expect(view.held).toBe(true)
  hold = false
  await act(async () => view.showLatestAutomatically())
  expect(view.held).toBe(false)
  expect(view.page?.items.map(item => item.id)).toEqual(['older-original', 'current-original'])
  expect(calls.at(-1), 'Admission must retain the original host intent, not the later failed Current request').toEqual({ intent: expected, ids: ['older-original', 'current-original'] })
  expect(await f.store.readMetadata(reference.agentSessionId)).toEqual(session)
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
}

it('Desktop admits a held Earlier frame with its original intent after a later Current request fails', async () => {
  await fixture('earlier')
})
it('Desktop admits a held automatic coverage frame without converting it to Earlier or a failed Current intent', async () => {
  await fixture('coverage')
})

it('Desktop performs no native admission bookkeeping when captured admission rejects the complete frame', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const reference = { hostId: 'local', agentSessionId: 'original-admission-order' }
  const source = { providerId: 'claude', nativeSessionId: 'original-native' }
  const f = await conversationPagePortFixture(reference, source, async () => ({
    agentSessionId: reference.agentSessionId, source, nextCursor: null,
    items: [{ id: 'original-native', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original displayed body' }] }]
  }))
  closes.push(f.close)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: reference.agentSessionId, item: {
    id: 'original-captured', agentSessionId: reference.agentSessionId, kind: 'assistant_message', source: 'native-hook',
    status: 'complete', title: 'Original captured answer', content: 'Original captured body', createdAt: _followupFixtureEpoch(0, 0, 1), updatedAt: _followupFixtureEpoch(0, 0, 1)
  } })
  const host = document.createElement('div'); document.body.append(host)
  const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  let view!: ReturnType<typeof useSessionConversationWindow>, rejectCaptured = false, rejected = 0
  const nativeAdmissions: ConversationReadingIntent[] = []
  const reading = { reference, identity: 'original-reading-owner', enabled: true }
  function Consumer() {
    view = useSessionConversationWindow(reading, (_page, intent) => {
      nativeAdmissions.push(intent)
      return true
    }, 0, snapshot => {
      expect(snapshot.items.some(item => item.id === 'original-captured')).toBe(true)
      if (!rejectCaptured) return true
      rejected++
      return false
    })
    return <p>{view.page?.items.map(item => item.id).join(',')}</p>
  }
  await act(async () => root.render(<Consumer />))
  await wait(() => { expect(view.page?.items[0]?.id).toBe('original-native'); expect(view.loading).toBe(false); expect(view.inspect().dirty).toBe(false) })
  const displayed = view.snapshot, before = [...nativeAdmissions]
  rejectCaptured = true
  await act(async () => view.showCurrent())
  await wait(() => { expect(view.loading).toBe(false); expect(view.held).toBe(true) })
  expect(rejected, 'The actual complete frame must reach its captured admission predicate').toBeGreaterThan(0)
  expect(view.snapshot).toBe(displayed); expect(view.inspect().pending).toBeTruthy()
  expect(nativeAdmissions, 'A captured refusal cannot trigger native Current bookkeeping ahead of body admission').toEqual(before)
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
