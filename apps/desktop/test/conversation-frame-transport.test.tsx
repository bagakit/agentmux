// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { CONVERSATION_MAX_READ_BYTES, type ConversationChangesPage } from '../../../packages/core/src/conversation-changes'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { activityReadingProps } from './helpers/activity-reading-props'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { api } from '../src/renderer/src/lib/api'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { useAppStore } from '../src/renderer/src/store'

// The owning loader observes completed real SHA-256 work; it does not replace
// the digest. A frozen frame's immutable unit bytes need hashing once.
const digestWork = { enabled: false, units: [] as string[] }

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  digestWork.enabled = false
  getSelection()?.removeAllRanges()
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const wait = (check: () => void) => vi.waitFor(async () => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) }); check()
}, { timeout: 10000, interval: 15 })
const native = (index: number) => ({ type: 'user', uuid: `native-${index}`, sessionId: 'native-main',
  message: { role: 'user', content: `Original **selected words** native input ${index}.` } })

it('transports a changed full frame with the existing byte budget and hashes each frozen unit once before one atomic Activity commit', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('__agentmuxFrameHash', (data: string | Uint8Array) => {
    if (!digestWork.enabled || typeof data !== 'string') return
    try {
      const unit = JSON.parse(data)
      if (unit && typeof unit.event?.id === 'string' && Array.isArray(unit.records)) digestWork.units.push(unit.event.id)
    } catch { /* Other real hash inputs are not protocol units. */ }
  })
  const f = await nativeHistoryFixture('claude', jsonl(Array.from({ length: 110 }, (_, index) => native(index))))
  closes.push(f.close)
  const captured = async (index: number) => Reflect.get(f.client, 'persistAndPublishTimeline').call(f.client, {
    type: 'append', agentSessionId: f.session.agentSessionId,
    item: { id: `captured-${index}`, agentSessionId: f.session.agentSessionId, kind: 'user_message', source: 'user',
      status: 'complete', title: 'Original captured input', content: `Original captured input ${index}.`, createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1) }
  }, { source: 'agentmux', observedAt: _tailFixtureEpoch(0, 0, 1) }, 'local')
  for (let index = 0; index < 100; index++) await captured(index)
  const sessionBefore = await f.store.readMetadata(f.session.agentSessionId), initialStore = useAppStore.getState()
  useAppStore.setState({ agentComposerDrafts: { [f.session.agentSessionId]: 'Original unsent draft' } })
  closes.push(() => useAppStore.setState(initialStore, true))
  await desktopConversationReadBridge(f, closes)
  const initialReads = vi.spyOn(f.client, 'readAgentConversation')
  const oldReads = [vi.spyOn(api.sessions, 'historyPage'), vi.spyOn(api.sessions, 'timeline')]
  const host = document.createElement('div'); document.body.append(host); const root: Root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  const target = { hostId: 'local', agentSessionId: f.session.agentSessionId,
    source: { kind: 'captured' as const, recordId: 'captured-100' } }
  const query = { hostId: 'local', agentSessionId: f.session.agentSessionId, records: [target] }
  const sample = () => inspectConversationConsumers(query).consumers[0]!
  const control = { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control, workspaceRoot: f.root })} />))
  await wait(() => {
    expect(sample()?.accepted?.unitCount).toBe(200)
    expect(sample().watch.bound).toBe(true)
    expect(sample().inFlight).toBe(false); expect(sample().dirty).toBe(false)
  })
  const original = sample().accepted!, originalReads = initialReads.mock.calls.length
  const selected = host.querySelector('[data-native-record-id="native-109"] strong')!
  expect(selected).not.toBeNull()
  const range = document.createRange(); range.selectNodeContents(selected); getSelection()!.addRange(range)
  const originalRows = [...host.querySelectorAll('[data-native-record-id], [data-submission-id]')]
  expect(originalRows).toHaveLength(200)
  const pages: ConversationChangesPage[] = [], changes = f.client.readConversationChanges.bind(f.client)
  let release!: () => void, lastPageReady!: () => void
  const lastPageGate = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { lastPageReady = resolve })
  closes.push(() => release())
  const requests = vi.spyOn(f.client, 'readConversationChanges').mockImplementation(async (...args) => {
    const page = await changes(...args)
    pages.push(page)
    expect(sample().accepted!.id).toBe(original.id)
    expect(sample().accepted!.revision).toBe(original.revision)
    expect(sample().accepted!.membership[0]!.present).toBe(false)
    expect(host.querySelector('[data-submission-id="captured-100"]')).toBeNull()
    expect(originalRows.every(row => row.isConnected)).toBe(true)
    if (page.window.complete) { lastPageReady(); await lastPageGate }
    return page
  })
  digestWork.units = []; digestWork.enabled = true
  await captured(100)
  await ready
  // Backend source cut has advanced; the client still retains the previous
  // accepted window until the original complete frame crosses Main/preload.
  expect(sample().accepted!.revision).toBe(original.revision)
  expect(sample().accepted!.membership[0]!.present).toBe(false)
  expect(sample().inFlight).toBe(true)
  expect(getSelection()!.getRangeAt(0)).toBe(range)
  expect(selected.isConnected).toBe(true)
  expect(pages, 'A small changed frame needs three 100-item pages with the existing 4 MiB budget').toHaveLength(3)
  expect(pages.map(page => page.items.length)).toEqual([100, 100, 1])
  expect(pages.map(page => page.window.complete)).toEqual([false, false, true])
  expect(new Set(pages.map(page => JSON.stringify([page.window.id, page.window.revision]))).size).toBe(1)
  expect(pages.every(page => page.window.itemCount === 201)).toBe(true)
  expect(digestWork.units, 'Continuation pages must reuse the frozen frame digest work').toHaveLength(201)
  expect(new Set(digestWork.units).size).toBe(201)
  const originalView = requests.mock.calls[0]![0].view
  expect(originalView).toBeTruthy()
  for (const [input] of requests.mock.calls) {
    expect(input.limit).toBe(100); expect(input.maxBytes).toBe(CONVERSATION_MAX_READ_BYTES)
    expect(input.view).toBe(originalView); expect(input.checkpoint).toEqual(original.checkpoint)
  }
  for (const page of pages) {
    expect(page.budgetBytes).toBe(CONVERSATION_MAX_READ_BYTES)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(page.budgetBytes)
    expect(page.items.length).toBeLessThanOrEqual(100)
  }
  await act(async () => release())
  await wait(() => {
    expect(sample().accepted!.unitCount).toBe(201)
    expect(sample().accepted!.membership[0]!.present).toBe(true)
    expect(sample().inFlight).toBe(false)
    expect(host.querySelectorAll('[data-submission-id="captured-100"]')).toHaveLength(1)
  })
  digestWork.enabled = false
  expect(sample().accepted!.id).toBe(original.id)
  expect(sample().accepted!.revision).toBe(pages[0]!.window.revision)
  expect(sample().accepted!.scope).toEqual(original.scope)
  expect(sample().accepted!.coverage.every(row => row.current === 'complete-through-cut')).toBe(true)
  expect(originalRows.every(row => row.isConnected)).toBe(true)
  for (let index = 10; index < 110; index++) expect(host.querySelector(`[data-native-record-id="native-${index}"]`)!.textContent).toContain(`native input ${index}.`)
  for (let index = 0; index <= 100; index++) expect(host.querySelector(`[data-submission-id="captured-${index}"]`)!.textContent).toContain(`Original captured input ${index}.`)
  expect(getSelection()!.getRangeAt(0)).toBe(range); expect(getSelection()!.toString()).toBe('selected words')
  expect(initialReads.mock.calls).toHaveLength(originalReads)
  expect(requests.mock.calls).toHaveLength(3)
  expect(oldReads.map(read => read.mock.calls.length)).toEqual([0, 0])
  expect(f.controls.map(read => read.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
  expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(sessionBefore)
  expect(useAppStore.getState().agentComposerDrafts[f.session.agentSessionId]).toBe('Original unsent draft')
}, 20000)
