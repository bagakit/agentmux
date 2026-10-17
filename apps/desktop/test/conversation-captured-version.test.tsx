// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem } from '@agentmux/core'
import type { ConversationChangesPage } from '@agentmux/core/conversation'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { createClientUiRoot } from './helpers/client-ui-render'
import { activityReadingProps } from './helpers/activity-reading-props'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { useAppStore } from '../src/renderer/src/store'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  window.getSelection()?.removeAllRanges()
  const failures: unknown[] = []
  for (const close of closes.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (failures.length) throw new AggregateError(failures, 'Private captured reading cleanup failed')
})
const pause = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const wait = (assertion: () => void) => vi.waitFor(async () => { await pause(); assertion() }, { timeout: 7000, interval: 20 })

it('actual Activity admits new neighbors around a selected captured version and holds only its replacement body', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const f = await nativeHistoryFixture('claude', jsonl([
    { type: 'user', uuid: 'original-native', sessionId: 'native-main', message: { role: 'user', content: 'Original native context' } }
  ]))
  closes.push(f.close)
  const original: AgentTimelineItem = { id: 'selected-captured', agentSessionId: f.session.agentSessionId,
    kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Original captured answer',
    content: 'Original captured words stay selected.', createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1) }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: original })
  const session = await f.store.readMetadata(f.session.agentSessionId), store = useAppStore.getState()
  useAppStore.setState({ agentComposerDrafts: { [f.session.agentSessionId]: 'Unsent original draft' } })
  closes.push(() => useAppStore.setState(store, true))
  await desktopConversationReadBridge(f, closes)
  const frames: ConversationChangesPage[] = [], readChanges = f.client.readConversationChanges.bind(f.client)
  vi.spyOn(f.client, 'readConversationChanges').mockImplementation(async (...args) => {
    const page = await readChanges(...args); if (page.window.complete) frames.push(page); return page
  })
  const host = document.createElement('div'); document.body.append(host)
  const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  await act(async () => root.render(<ActivityView {...activityReadingProps({
    control: { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }, workspaceRoot: f.root
  })} />))
  const selectedBody = () => host.querySelector<HTMLElement>('[data-message-id="selected-captured"] .log-turn__body')
  const disclosure = () => host.querySelector<HTMLButtonElement>('[data-captured-reply-observation="selected-captured"] .conversation-reply-observation__toggle')
  await wait(() => expect(disclosure(), host.textContent ?? '').not.toBeNull())
  await act(async () => disclosure()!.click())
  await wait(() => { expect(selectedBody()?.textContent).toBe(original.content); expect(frames.length).toBeGreaterThan(0) })
  const body = selectedBody()!, text = body.querySelector('p')!.firstChild!, range = document.createRange(), selection = window.getSelection()!
  range.selectNodeContents(text); selection.removeAllRanges(); selection.addRange(range)
  const publish = async (item: AgentTimelineItem) => Reflect.get(f.client, 'persistAndPublishTimeline').call(f.client,
    { type: 'upsert', agentSessionId: f.session.agentSessionId, item }, { source: 'agentmux', observedAt: item.updatedAt }, 'local')
  await act(async () => publish({ ...original, id: 'new-captured-neighbor', content: 'A new independent captured neighbor.',
    createdAt: fixtureEpoch(0, 0, 2), updatedAt: fixtureEpoch(0, 0, 2) }))
  await wait(() => expect(host.textContent, 'An unchanged selected version must not hold an unrelated neighbor').toContain('A new independent captured neighbor.'))
  expect(selectedBody()).toBe(body); expect(text.isConnected).toBe(true)
  expect(selection.getRangeAt(0)).toBe(range); expect(range.toString()).toBe(original.content)
  const changed = { ...original, content: 'A later body for the same captured record.', updatedAt: fixtureEpoch(0, 0, 3) }
  await act(async () => publish(changed))
  await wait(() => expect(frames.some(frame => frame.items.some(entry => entry.kind === 'item' && entry.item.records.some(record =>
    record.original.kind === 'captured' && record.original.item.id === original.id && record.original.item.content === changed.content))),
  'The real Core changes frame must contain the replacement before DOM protection is asserted').toBe(true))
  expect(selectedBody()).toBe(body); expect(body.textContent, 'The selected original version stays readable').toBe(original.content)
  expect(host.textContent).not.toContain(changed.content); expect(text.isConnected).toBe(true)
  expect(selection.getRangeAt(0)).toBe(range); expect(range.toString()).toBe(original.content)
  await act(async () => { selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  await wait(() => expect(selectedBody()?.textContent, 'Clearing the original Range admits the pending replacement').toBe(changed.content))
  expect(host.querySelectorAll('[data-message-id="selected-captured"]')).toHaveLength(1)
  expect(disclosure()?.getAttribute('aria-expanded')).toBe('true')
  expect(host.textContent).toContain('A new independent captured neighbor.')
  expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(session)
  expect(useAppStore.getState().agentComposerDrafts[f.session.agentSessionId]).toBe('Unsent original draft')
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
