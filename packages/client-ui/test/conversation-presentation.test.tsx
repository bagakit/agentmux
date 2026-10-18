// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { projectConversationReading } from '../src/lib/conversation-records'
import { ConversationView } from '../src/components/ConversationView'
import { NativeProcessObservation } from '../src/components/NativeProcessObservation'
import * as coreConversation from '@agentmux/core/conversation'
import * as sequenceModule from '../src/lib/conversation-record-sequence'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform'

const source = { providerId: 'recorded-provider', nativeSessionId: 'original-native' }
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
let root: Root, host: HTMLElement
const item = (id: string, kind: 'activity' | 'assistant-message' = 'assistant-message', text = id) => ({ id, kind, contentParts: [{ kind: 'text' as const, text }] })
const page = (...items: AgentSessionHistoryPage['items']): AgentSessionHistoryPage => ({ agentSessionId: 'session', sourceHostId: 'local', source, nextCursor: null, items })
const frame = (page: AgentSessionHistoryPage) => {
  const reading = projectConversationReading({ agentSessionId: 'session', executionHostId: 'local', historyPage: page })
  return { page, records: reading.records, originalRecords: reading.originalRecords, coverage: reading.timeline.coverage }
}
async function draw(props: ReturnType<typeof frame>, extra: Partial<ComponentProps<typeof ConversationView>> = {}) {
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationView {...props} sessionId="session" executionHostId="local"
    renderProcess={props => <NativeProcessObservation {...props} />} {...extra} /></ClientUiProvider>))
}
function select(node: Node) {
  const range = document.createRange(); range.selectNodeContents(node); getSelection()!.removeAllRanges(); getSelection()!.addRange(range)
  return range
}
async function release() { await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }) }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('protects a direct-props selected record when a message splits its process parent', async () => {
  const a = item('first', 'activity'), b = item('selected', 'activity')
  await draw(frame(page(a, b)))
  await act(async () => host.querySelector<HTMLButtonElement>('[data-native-step-id="selected"] button')!.click())
  const text = host.querySelector('[data-native-record-id="selected"] .log-turn__body p')!.firstChild!
  const range = select(text)
  await draw(frame(page(a, item('between'), b)))
  expect(text.isConnected).toBe(true); expect(range.startContainer).toBe(text); expect(getSelection()!.toString()).toBe('selected')
  expect(host.querySelector('[data-native-record-id="between"]')).toBeNull()
  await release()
  expect(host.querySelectorAll('.conversation-record-process')).toHaveLength(2)
  expect(host.querySelector('[data-native-step-id="selected"] button')?.getAttribute('aria-expanded')).toBe('true')
})

it('protects canonical role changes although the exact raw source and body are unchanged', async () => {
  const captured = { id: 'same-raw', agentSessionId: 'session', kind: 'assistant_message' as const, source: 'native-hook' as const,
    status: 'complete' as const, title: 'Original captured', content: 'Original selected body', createdAt: 1, updatedAt: 1 }
  const reading = projectConversationReading({ agentSessionId: 'session', executionHostId: 'local', timeline: { agentSessionId: 'session', sourceHostId: 'local', revision: 1, items: [captured] } })
  const initial = { page: page(), records: reading.records.map(record => ({ ...record, role: 'message' as const })), originalRecords: reading.originalRecords, coverage: reading.timeline.coverage }
  await draw(initial)
  const text = host.querySelector('.log-turn__body p')!.firstChild!, range = select(text)
  const records = initial.records.map(record => ({ ...record, role: 'interaction' as const }))
  await draw({ ...initial, records })
  expect(text.isConnected).toBe(true); expect(range.startContainer).toBe(text)
  expect(host.querySelector('[data-captured-process-id]')).toBeNull()
  await release(); expect(host.querySelector('[data-captured-process-id]')).not.toBeNull()
})

it('holds coverage and original contributors in the same frame, while independent actions stay current', async () => {
  const first = frame(page(item('record', 'assistant-message', 'selected version')))
  await draw(first, { renderRecordActions: () => <button>Old qualification</button> })
  const text = host.querySelector('.log-turn__body p')!.firstChild!; select(text)
  const next = frame(page(item('record', 'assistant-message', 'new version')))
  next.coverage = next.coverage.map(row => ({ ...row, gaps: [...row.gaps, { code: 'SOURCE_NEW', message: 'New frame coverage' }] }))
  await draw(next, { renderRecordActions: () => <button>Current qualification</button> })
  expect(text.isConnected).toBe(true); expect(host.textContent).toContain('selected version')
  expect(host.textContent).not.toContain('New frame coverage'); expect(host.textContent).not.toContain('new version')
  expect(host.textContent).toContain('Current qualification'); expect(host.textContent).not.toContain('Old qualification')
  await release(); expect(host.textContent).toContain('new version'); expect(host.textContent).toContain('New frame coverage')
})

it('retains the visible reading anchor without a selection when the candidate evicts it', async () => {
  const initial = frame(page(item('visible'), item('later')))
  await draw(initial)
  Object.defineProperties(host, { clientHeight: { configurable: true, value: 300 }, scrollHeight: { configurable: true, value: 900 } })
  host.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300)
  const visible = host.querySelector<HTMLElement>('[data-native-record-id="visible"]')!
  visible.getBoundingClientRect = () => new DOMRect(0, 30, 400, 120)
  await draw(frame(page(item('later'))))
  expect(visible.isConnected).toBe(true); expect(host.querySelector('[data-native-record-id="visible"]')).toBe(visible)
  // Moving the reader away permits the current candidate; no automatic read is issued.
  visible.getBoundingClientRect = () => new DOMRect(0, -400, 400, 120)
  await act(async () => host.dispatchEvent(new Event('scroll')))
  expect(host.querySelector('[data-native-record-id="visible"]')).toBeNull()
})

it('uses the newest candidate after release and never replays another Session frame', async () => {
  await draw(frame(page(item('record', 'assistant-message', 'old'))))
  select(host.querySelector('.log-turn__body p')!.firstChild!)
  await draw(frame(page(item('record', 'assistant-message', 'superseded'))))
  await draw(frame(page(item('record', 'assistant-message', 'current'))))
  await release(); expect(host.textContent).toContain('current'); expect(host.textContent).not.toContain('superseded')
  select(host.querySelector('.log-turn__body p')!.firstChild!)
  const anotherPage = { ...page(item('other', 'assistant-message', 'Other Session')), agentSessionId: 'other-session' }
  const reading = projectConversationReading({ agentSessionId: 'other-session', executionHostId: 'local', historyPage: anotherPage })
  await draw({ page: anotherPage, records: reading.records, originalRecords: reading.originalRecords, coverage: reading.timeline.coverage }, { sessionId: 'other-session' })
  expect(host.textContent).toContain('Other Session'); expect(host.textContent).not.toContain('current')
})


it.each(['crossing', 'unknown-intersection'])('retains actual selected records for a %s Range', async mode => {
  await draw(frame(page(item('first'), item('middle'), item('last'))))
  const first = host.querySelector('[data-native-record-id="first"] .log-turn__body p')!.firstChild!
  const middle = host.querySelector('[data-native-record-id="middle"]')!
  const last = host.querySelector('[data-native-record-id="last"] .log-turn__body p')!.firstChild!
  const range = document.createRange(); range.setStart(first, 1); range.setEnd(last, 2); getSelection()!.addRange(range)
  if (mode === 'unknown-intersection') vi.spyOn(range, 'intersectsNode').mockImplementation(() => { throw new DOMException('Intersection unavailable') })
  await draw(frame(page(item('first'), item('last'))))
  expect(middle.isConnected).toBe(true); expect(range.startContainer).toBe(first); expect(range.endContainer).toBe(last)
})

it('does no frame or geometry work for ordinary scrolling while watching selection release', async () => {
  const controller = { current: null }, released = vi.fn()
  await draw(frame(page(item('visible'))), { presentation: { controller, pending: false, watchSelection: true, onRelease: released } })
  Object.defineProperties(host, { clientHeight: { configurable: true, value: 300 }, scrollHeight: { configurable: true, value: 900 } })
  const projected = vi.spyOn(sequenceModule, 'projectConversationRecordSequence')
  const viewportRect = vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 300))
  const recordRect = vi.spyOn(host.querySelector<HTMLElement>('[data-native-record-id="visible"]')!, 'getBoundingClientRect')
  await act(async () => { for (let index = 0; index < 30; index++) host.dispatchEvent(new Event('scroll')) })
  expect(viewportRect).not.toHaveBeenCalled(); expect(recordRect).not.toHaveBeenCalled(); expect(released).not.toHaveBeenCalled()
  await act(async () => document.dispatchEvent(new Event('selectionchange')))
  expect(released).toHaveBeenCalledOnce(); expect(projected).not.toHaveBeenCalled(); expect(viewportRect).not.toHaveBeenCalled(); expect(recordRect).not.toHaveBeenCalled()
})

it('compares committed canonical revisions without hashing 300 unrelated original bodies', async () => {
  const initial = frame(page(...Array.from({ length: 300 }, (_, i) => item('record-' + i))))
  await draw(initial)
  const text = host.querySelector('[data-native-record-id="record-37"] .log-turn__body p')!.firstChild!
  const range = select(text)
  const next = frame(page(...initial.page.items.map((record, index) => index === 299 ? item(record.id, 'assistant-message', 'Independent new body') : record)))
  const revisions = vi.spyOn(coreConversation, 'conversationRevision')
  await draw(next)
  expect(host.textContent).toContain('Independent new body'); expect(text.isConnected).toBe(true)
  expect(getSelection()!.getRangeAt(0)).toBe(range); expect(range.toString()).toBe('record-37')
  expect(revisions, 'Core has already supplied exact canonical event and contributor revisions').not.toHaveBeenCalled()
})

it('protects a visible process record even when its offscreen parent group remains mounted', async () => {
  await draw(frame(page(item('offscreen', 'activity'), item('visible-step', 'activity'))))
  Object.defineProperties(host, { clientHeight: { configurable: true, value: 300 }, scrollHeight: { configurable: true, value: 900 } })
  host.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300)
  host.querySelector<HTMLElement>('.conversation-record-process')!.getBoundingClientRect = () => new DOMRect(0, -600, 400, 900)
  host.querySelector<HTMLElement>('[data-native-record-id="offscreen"]')!.getBoundingClientRect = () => new DOMRect(0, -500, 400, 100)
  const visible = host.querySelector<HTMLElement>('[data-native-record-id="visible-step"]')!
  visible.getBoundingClientRect = () => new DOMRect(0, 30, 400, 100)
  await draw(frame(page(item('offscreen', 'activity'))))
  expect(visible.isConnected, 'A retained process shell cannot substitute for the current reading record').toBe(true)
})
